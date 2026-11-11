import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environmentScene } from '../scripts/reference-rendering/environment-scene.mjs';
import { displayImage } from '../scripts/reference-rendering/linear-image.mjs';
import { readPathReference, sha256 } from '../scripts/reference-rendering/path-reference.mjs';

test('linear reference has top-down little-endian RGB order and the unchanged display curve', () => {
  const bytes = Buffer.alloc(24);
  [0, 0.25, 1, 2, 0, -1].forEach((x, i) => bytes.writeFloatLE(x, i * 4));
  assert.deepEqual(Array.from(displayImage(bytes, 1, 2).data), [33, 132, 241, 255, 251, 101, 101, 255]);
  assert.throws(() => displayImage(bytes, 2, 2));
  for (const value of [NaN, Infinity, -Infinity]) {
    bytes.writeFloatLE(value, 0);
    assert.throws(() => displayImage(bytes, 1, 2), /Non-finite/);
  }
});

test('a changed path-traced raw reference cannot overwrite its frozen PNG', () => {
  const folder = mkdtempSync(join(tmpdir(), 'margo-path-160-'));
  try {
    const bytes = Buffer.alloc(12);
    bytes.writeFloatLE(0.5, 0);
    writeFileSync(join(folder, 'trace-rgb.f32'), bytes);
    writeFileSync(join(folder, 'trace-meta.json'), '{}');
    const first = readPathReference(folder, 'trace', 1, 1),
      picture = readFileSync(join(folder, 'trace.png'));
    assert.equal(first.linearSha256, sha256(bytes));
    bytes.writeFloatLE(0.51, 0);
    writeFileSync(join(folder, 'trace-rgb.f32'), bytes);
    assert.throws(() => readPathReference(folder, 'trace', 1, 1, first), /frozen files preserved/);
    assert.deepEqual(readFileSync(join(folder, 'trace.png')), picture);
  } finally {
    rmSync(folder, { recursive: true });
  }
});

test('IBL furnace preserves all source material and mesh data and uses no direct light', () => {
  const input = readFileSync(new URL('../packages/gltf-pro/tests/fixtures/pointer-show.glb', import.meta.url));
  const doc = JSON.parse(input.subarray(20, 20 + input.readUInt32LE(12)));
  const result = environmentScene(input);
  assert.deepEqual(result.doc.materials, doc.materials);
  assert.deepEqual(result.doc.meshes, doc.meshes);
  assert.deepEqual(result.doc.nodes.slice(0, doc.nodes.length), doc.nodes);
  assert.deepEqual(result.settings.environment, [0.3, 0.5, 0.7]);
  assert.equal(result.settings.light.intensity, 0);
});

test('IBL has exact first-measured direct/full budgets on each actual backend', () => {
  const b = JSON.parse(readFileSync(new URL('../docs/whitepaper/results/batch-160-environment.json', import.meta.url)));
  for (const [row, abs, square] of [
    [b, [2294442, 1482507], [76817356, 31967589]],
    [b.compat, [2294432, 1482506], [76816910, 31967280]],
  ]) {
    assert.equal(row.margo.primitives, 123);
    assert.equal(row.nativeWebGL2.code, 'unsupported');
    for (const [i, mode] of ['direct', 'full'].entries()) {
      const r = row.rows[mode];
      assert.equal(r.metrics.absolute, abs[i]);
      assert.equal(r.metrics.square, square[i]);
      assert.equal(r.metrics.mae, abs[i] / (512 * 512 * 3));
      assert.equal(r.meta.primitives, 123);
      assert.equal(r.meta.triangles, 1040409);
      assert.equal(r.meta.samples, 128);
      assert.equal(r.meta.seed, 160);
      assert.equal(r.meta.maxDepth, mode === 'direct' ? 2 : 8);
      assert.equal(r.linearSha256, b.rows[mode].linearSha256);
      assert.equal(r.referenceSha256, b.rows[mode].referenceSha256);
    }
  }
  assert.equal(b.compat.hardware.webgpu.vendor, 'margo-webgl2');
  assert.equal(b.sceneSha256, b.compat.sceneSha256);
});

// KB3563 accepted difference: the frozen direct residual split by difference (docs/limits.md, batch 160 job 7).
test('IBL furnace residual decomposes into noise, visibility, BSDF model, multiple scattering and edges (KB3563)', () => {
  const b = JSON.parse(readFileSync(new URL('../docs/whitepaper/results/batch-160-environment.json', import.meta.url)));
  const d = JSON.parse(
    readFileSync(new URL('../docs/whitepaper/results/batch-160-environment-decomposition.json', import.meta.url)),
  );
  assert.equal(d.sceneSha256, b.sceneSha256);
  assert.equal(d.frozenDirect.linearSha256, b.rows.direct.linearSha256);
  assert.equal(d.frozenDirect.native.absolute, b.rows.direct.metrics.absolute);
  assert.equal(d.compat.hardware.webgpu.vendor, 'margo-webgl2');
  const names = ['principled-direct-1024', 'principled-unoccluded-1024', 'gltf-unoccluded-1024', 'split-model-unoccluded-1024'];
  assert.deepEqual(Object.keys(d.references), names);
  for (const [i, name] of names.entries()) {
    const meta = d.references[name].meta;
    assert.equal(meta.samples, 1024);
    assert.equal(meta.triangles, 1040409);
    assert.equal(meta.variant, 'cuda_ad_rgb');
    assert.equal(meta.visibility, i === 0);
  }
  for (const [side, absolute] of [
    ['native', [2253028, 1269809, 1017910, 484953]],
    ['compat', [2252974, 1269851, 1017870, 484989]],
  ])
    names.forEach((name, i) => {
      assert.equal(d[side][name].absolute, absolute[i]);
      assert.equal(d[side][name].edge + d[side][name].flat, absolute[i]);
    });
  const base = d.frozenDirect.native.absolute,
    rows = d.native,
    share = (x) => Math.round((1000 * x) / base) / 10;
  assert.equal(share(base - rows['principled-direct-1024'].absolute), 1.8); // 128-spp reference noise
  assert.equal(share(rows['principled-direct-1024'].absolute - rows['principled-unoccluded-1024'].absolute), 42.9); // visibility
  assert.equal(share(rows['principled-unoccluded-1024'].absolute - rows['gltf-unoccluded-1024'].absolute), 11); // BSDF model
  assert.equal(share(rows['gltf-unoccluded-1024'].absolute - rows['split-model-unoccluded-1024'].absolute), 23.2); // multiple scattering
  // What is left against the model's own exact integrals: silhouettes, and 1.7 % of numerics with no bias.
  assert.equal(share(rows['split-model-unoccluded-1024'].edge), 19.4);
  assert.equal(share(rows['split-model-unoccluded-1024'].flat), 1.7);
  assert.ok(Math.abs(rows['split-model-unoccluded-1024'].flatSigned) < rows['split-model-unoccluded-1024'].flat / 5);
});
