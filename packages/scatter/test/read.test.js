import test from 'node:test';
import assert from 'node:assert/strict';
import { instanceMatrix, poseFrame, poseKernel, readScatter } from '../dist/read.js';
import { grassPoseCode } from '../dist/grass.js';
import { plantStatePoseCode } from '../dist/states.js';
import { trampledPoseCode } from '../dist/interact.js';
import { readdirSync } from 'node:fs';

// The unpatched pose functions the root entry hands readScatter (`velocityParts().poseSource`), from the build's
// entries and shared chunks: the strings that define windBend and scatterPose.
const chunks = await Promise.all(
  readdirSync(new URL('../dist/', import.meta.url))
    .filter((f) => f.endsWith('.js'))
    .map((f) => import(new URL(`../dist/${f}`, import.meta.url))),
);
const strings = chunks.flatMap((m) => Object.values(m).filter((v) => typeof v === 'string'));
const pick = (head) => {
  const found = [...new Set(strings.filter((s) => s.includes(head)))];
  assert.equal(found.length, 1, head);
  return found[0];
};
const source = pick('fn windBend(') + pick('fn scatterPose(p:vec3f');

// The vertex stage's placement (pose.ts scatterGround and scatterTurn), written out again: the matrix must give the
// same world point for any local point.
function shaderPlace(v, instance, align) {
  const [px, py, pz, scale, yaw, packed] = instance,
    gz = Math.floor(packed / 4096),
    gx = (packed - gz * 4096) / 2047.5 - 1,
    gzz = gz / 2047.5 - 1,
    g = [gx, Math.sqrt(Math.max(0, 1 - gx * gx - gzz * gzz)), gzz],
    m = [g[0] * align, 1 + (g[1] - 1) * align, g[2] * align],
    l = Math.hypot(...m),
    up = m.map((x) => x / l),
    c = Math.cos(yaw),
    s = Math.sin(yaw),
    r = [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]],
    k = [up[2], 0, -up[0]],
    cross = [k[1] * r[2] - k[2] * r[1], k[2] * r[0] - k[0] * r[2], k[0] * r[1] - k[1] * r[0]],
    kr = k[0] * r[0] + k[2] * r[2],
    t = [0, 1, 2].map((a) => r[a] * up[1] + cross[a] + (k[a] * kr) / (1 + up[1]));
  return [t[0] * scale + px, t[1] * scale + py, t[2] * scale + pz];
}
const pack = (nx, nz) => Math.round((nx * 0.5 + 0.5) * 4095) + Math.round((nz * 0.5 + 0.5) * 4095) * 4096;

test('instanceMatrix places a local point where the vertex stage does, for yaw, scale and ground tilt', () => {
  const out = new Float32Array(32);
  for (const [instance, align] of [
    [[1, 2, 3, 1.5, 0.7, pack(0, 0), 0, 0], 1],
    [[-4, 0.5, 2, 0.8, 2.9, pack(0.4, -0.3), 0, 0], 1],
    [[-4, 0.5, 2, 0.8, 2.9, pack(0.4, -0.3), 0, 0], 0.35],
    [[0, 0, 0, 2, -1.2, pack(-0.6, 0.5), 0.3, 1], 0],
  ]) {
    instanceMatrix(instance, 0, align, out, 16);
    for (const v of [
      [0.3, 1.2, -0.4],
      [0, 0, 0],
      [-1, 0.2, 0.9],
    ]) {
      const want = shaderPlace(v, instance, align),
        got = [0, 1, 2].map((a) => out[16 + a] * v[0] + out[20 + a] * v[1] + out[24 + a] * v[2] + out[28 + a]);
      for (let a = 0; a < 3; a++) assert.ok(Math.abs(got[a] - want[a]) < 1e-5, `${got} vs ${want}`);
    }
    assert.deepEqual([out[19], out[23], out[27], out[31]], [0, 0, 0, 1]);
  }
  assert.deepEqual([...out.subarray(0, 16)], new Array(16).fill(0), 'writes only at the offset');
});

test('poseFrame lays out the pose kernel uniform from the frame values, with no pixel floor or widening', () => {
  const values = new Float32Array(96).map((_, i) => i + 0.5),
    before = [0.6, 0.8, 0.9, 3.25],
    frame = poseFrame(values, before, 24),
    f = new Float32Array(frame),
    u = new Uint32Array(frame);
  assert.equal(frame.byteLength, 128);
  assert.deepEqual([...f.subarray(0, 4)], [16.5, 17.5, 18.5, 0], 'eye, pixel footprint 0');
  assert.deepEqual([...f.subarray(4, 8)], [68.5, 69.5, 70.5, 71.5], 'the wind now');
  assert.deepEqual([...f.subarray(8, 12)], before.map(Math.fround), 'the wind before');
  assert.deepEqual([...f.subarray(12, 16)], [72.5, 73.5, 74.5, 75.5], 'ground fit');
  assert.deepEqual([...f.subarray(16, 20)], [76.5, 0, 78.5, 79.5], 'blades, widening 0');
  assert.deepEqual([u[20], u[21], u[22], u[23]], [0, 24, 6, 0], 'counts: per chunk, vertices, floats a vertex, first');
  assert.deepEqual([...f.subarray(24, 28)], [84.5, 85.5, 86.5, 87.5], 'the sway now');
  assert.deepEqual([...f.subarray(28, 32)], [84.5, 85.5, 86.5, 87.5], 'the sway before defaults to the sway now');
  const swayed = new Float32Array(poseFrame(values, before, 24, [2, 1.2, 0.5, 3]));
  assert.deepEqual([...swayed.subarray(28, 32)], [2, 1.2, 0.5, 3].map(Math.fround), 'the sway before');
});

test('poseKernel calls the scatter pose twice and takes every pose patch the scatter applies', () => {
  const plain = poseKernel(source, (code) => code);
  assert.match(plain, /@compute @workgroup_size\(64\) fn main/);
  assert.equal(plain.split('scatterPose(p,n,data.position').length, 3, 'now and before');
  assert.match(plain, /f\.windBefore/);
  const bindings = [];
  for (const patch of [
    (code, binding) => grassPoseCode(code),
    (code, binding) => plantStatePoseCode(code, 0, binding),
    (code, binding) => trampledPoseCode(code, 0, binding),
    (code, binding) => trampledPoseCode(plantStatePoseCode(code, 0, binding), 0, binding + 2),
  ]) {
    const code = poseKernel(source, (code, binding) => {
      bindings.push(binding);
      return patch(code, binding);
    });
    assert.notEqual(code, plain, 'the patch changed the pose');
    assert.equal(code.split('@compute').length, 2, 'one entry point');
    // The patches bind in group 0 from 2 on; the kernel keeps its own group 0 bindings 0 and 1 and group 1.
    for (const [, group, binding] of code.matchAll(/@group\((\d)\) @binding\((\d+)\)/g))
      if (group === '0' && binding !== '0' && binding !== '1') assert.ok(+binding >= 2);
  }
  assert.deepEqual(bindings, [2, 2, 2, 2]);
});

test('readScatter refuses a pose that is not a boolean', async () => {
  await assert.rejects(readScatter({}, {}, { pose: 'yes' }), TypeError);
  await assert.rejects(readScatter({}, {}, { pose: 1 }), TypeError);
});

test('readScatter without a drawn scatter on a WebGPU engine is a state error', async () => {
  await assert.rejects(readScatter({}, { velocityParts: () => undefined }), { code: 'state' });
  await assert.rejects(readScatter(undefined, undefined), { code: 'state' });
  const signal = AbortSignal.abort(new Error('stop'));
  await assert.rejects(readScatter({}, {}, { signal }), /stop/);
});
