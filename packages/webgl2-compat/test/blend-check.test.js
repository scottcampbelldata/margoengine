// The compressed-blend comparison of test/blend-check.mjs on synthetic probes (the GPU run is features-browser.mjs):
// a linear driver is classified linear, the AMD D3D11 curve compressed, and the comparison accepts only native's LOD
// through the driver's own blend and equal sweeps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyBlend, compressedFailures, PROBE_LODS } from './blend-check.mjs';

const bits = (values) => [...new Uint32Array(Float32Array.from(values).buffer)];
/** A probe between a white even level and a black odd level: 4 equal channels per LOD k/256. */
const probe = (weight) =>
  bits(Array.from({ length: PROBE_LODS }, (_, k) => {
    const level = Math.floor(k / 256), w = weight((k % 256) / 256);
    const v = level % 2 ? w : 1 - w;
    return [v, v, v, v];
  }).flat());
const linear = (f) => f;
/** The Radeon 680M curve under ANGLE D3D11 (measured 2026-11-10): weight clamp((f - 0.1) / 0.8, 0, 1) on a 1/64 grid. */
const compressed = (f) => Math.floor(Math.min(Math.max((f - 0.1) / 0.8, 0), 1) * 64) / 64;

test('classifyBlend: a linear driver is linear, the AMD D3D11 curve compressed', () => {
  assert.equal(classifyBlend(probe(linear)).blend, 'linear');
  // NVIDIA-sized filter error (2^-19) stays linear.
  assert.equal(classifyBlend(probe((f) => f + 2 ** -19)).blend, 'linear');
  const amd = classifyBlend(probe(compressed));
  assert.equal(amd.blend, 'compressed');
  assert.ok(amd.worst.error >= 0.09, `worst weight error ${amd.worst.error}`);
});

test('compressedFailures: only native LOD through the driver blend, and equal sweeps, pass', () => {
  const probes = { p: { native: probe(linear), gl: probe(compressed) } };
  const at = (p, k) => p.slice(k * 4, k * 4 + 4);
  const row = (p, ks) => ks.flatMap((k) => at(p, k));
  const sweep = bits([0.1, 0.1, 0.1, 0.1, 0.3, 0.3, 0.3, 0.3]);
  const ks = [256 + 235, 256 + 25, 512 + 71];
  const native = { 'linear/x': row(probes.p.native, ks), 'sweep/s': sweep };
  const spec = { rows: { 'linear/x': 'p' }, sweeps: ['sweep/s'], probes };
  assert.deepEqual(compressedFailures(native, { 'linear/x': row(probes.p.gl, ks), 'sweep/s': sweep }, spec), []);
  // A wrong LOD inside the band changes the blend.
  const off = compressedFailures(native, { 'linear/x': row(probes.p.gl, [256 + 140, 256 + 25, 512 + 71]), 'sweep/s': sweep }, spec);
  assert.match(off[0], /^linear\/x\[0\]: compat .* is not the driver's blend/);
  // The native blend where the driver clamps hides a small LOD error; the sweep catches it.
  const clamp = compressedFailures(native, { 'linear/x': row(probes.p.gl, [256 + 240, 256 + 25, 512 + 71]), 'sweep/s': bits([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]) }, spec);
  assert.deepEqual(clamp, ['sweep/s[1]: nearest-mip LOD sweep differs (native 0.3, compat 0.1): another LOD']);
  // Native's plain linear value is not compat's answer on a compressed driver.
  assert.match(compressedFailures(native, { 'linear/x': row(probes.p.native, ks), 'sweep/s': sweep }, spec)[0], /not the driver's blend/);
  // A sweep that never changes level proves nothing.
  const flat = bits([0.1, 0.1, 0.1, 0.1]);
  assert.deepEqual(compressedFailures({ 'sweep/s': flat }, { 'sweep/s': flat }, { rows: {}, sweeps: ['sweep/s'], probes }), ['sweep/s: the sweep never changes level, so it proves nothing']);
  // Rows given as numbers (mipFiltering) are compared as f32 bits.
  const asFloats = (b) => [...new Float32Array(Uint32Array.from(b).buffer)];
  assert.deepEqual(compressedFailures({ 'linear/x': asFloats(native['linear/x']), 'sweep/s': asFloats(sweep) }, { 'linear/x': asFloats(row(probes.p.gl, ks)), 'sweep/s': asFloats(sweep) }, { ...spec, floats: true }), []);
});
