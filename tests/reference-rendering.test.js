import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pictureError, assertBudget } from '../scripts/reference-rendering/compare.mjs';
import { lookMatrix, prepareScene } from '../scripts/reference-rendering/scene.mjs';
import { referenceCase } from '../scripts/reference-rendering/cases.mjs';
import { saveReference } from '../scripts/reference-rendering/reference.mjs';
import { displayImage } from '../scripts/reference-rendering/transport-image.mjs';

test('changed outside deployment cannot overwrite the frozen reference', () => {
  const folder = mkdtempSync(join(tmpdir(), 'margo-reference-160-'));
  const path = join(folder, 'reference.png');
  try {
    const original = Buffer.from('frozen PNG bytes');
    const hash = saveReference(path, original);
    assert.throws(() => saveReference(path, Buffer.from('changed deployment'), hash), /frozen picture preserved/);
    assert.deepEqual(readFileSync(path), original);
    assert.equal(saveReference(path, original, hash), hash);
  } finally {
    rmSync(folder, { recursive: true });
  }
});

test('outside picture comparison counts every RGB pixel and silhouette without alpha or fitted exposure', () => {
  const picture = (data) => ({ width: 2, height: 1, data });
  const actual = picture([10, 20, 30, 0, 0, 0, 0, 255]);
  const reference = picture([0, 20, 40, 255, 30, 0, 0, 0]);
  const result = pictureError(actual, reference);
  assert.deepEqual(result, {
    pixels: 2,
    absolute: 50,
    square: 1100,
    max: 30,
    mae: 50 / 6,
    rmse: Math.sqrt(1100 / 6),
    foreground: 2,
    foregroundAbsolute: 50,
    foregroundMae: 50 / 6,
    changed: 2,
  });
  assertBudget(result, result);
  assert.throws(() => assertBudget({ ...result, absolute: 51 }, result));
  assert.throws(() => assertBudget({ ...result, square: 1101 }, result));
  assert.throws(() => assertBudget({ ...result, max: 31 }, result));
  assert.throws(() => assertBudget({ ...result, foreground: 1 }, result));
  assert.throws(() => pictureError(picture([0, 0, 0, 0, 0, 0, 0, 0]), picture([0, 0, 0, 0, 0, 0, 0, 0])));
  assert.throws(() => pictureError({ ...actual, width: 1 }, reference));
});

test('camera node looks down negative Z with the same world translation as Margo', () => {
  assert.deepEqual(lookMatrix([0, 0, 5], [0, 0, 0]), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]);
  const m = lookMatrix([12, 9, 18], [3, 3, -1.5]);
  for (const c of [0, 4, 8]) assert.ok(Math.abs(Math.hypot(...m.slice(c, c + 3)) - 1) < 1e-15);
  const forward = m.slice(8, 11).map((v) => -v);
  const to = [3 - 12, 3 - 9, -1.5 - 18];
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(forward[i] - to[i] / Math.hypot(...to)) < 1e-15);
});

test('metallic-roughness budget is the measured unrounded result, with real WebGL2 evidence', () => {
  const baseline = JSON.parse(
    readFileSync(new URL('../docs/whitepaper/results/batch-160-metallic-roughness.json', import.meta.url), 'utf8'),
  );
  for (const row of [baseline, baseline.compat]) {
    assert.equal(row.metrics.mae, row.metrics.absolute / (512 * 512 * 3));
    assert.equal(row.metrics.foregroundMae, row.metrics.absolute / (row.metrics.foreground * 3));
    assert.equal(row.nativeWebGL2.code, 'unsupported');
    assert.equal(row.margo.primitives, 123);
  }
  assert.equal(baseline.compat.hardware.webgpu.vendor, 'margo-webgl2');
  assert.equal(baseline.referenceSha256, baseline.compat.referenceSha256);
});

test('material-family camera preparation preserves source materials, geometry and nodes', () => {
  const original = readFileSync(new URL('../packages/gltf-pro/tests/fixtures/pointer-show.glb', import.meta.url));
  const source = JSON.parse(original.subarray(20, 20 + original.readUInt32LE(12)).toString());
  const scene = prepareScene(original, referenceCase('clearcoat'));
  assert.deepEqual(scene.doc.materials, source.materials);
  assert.deepEqual(scene.doc.meshes, source.meshes);
  assert.deepEqual(scene.doc.nodes.slice(0, source.nodes.length), source.nodes);
  assert.deepEqual(scene.doc.nodes[source.nodes.length].children, source.scenes[source.scene ?? 0].nodes);
  assert.deepEqual(scene.doc.nodes[source.nodes.length].scale, [1, 1, 1]);
  assert.deepEqual(scene.doc.nodes.at(-2).matrix, lookMatrix([-1.5, 0.3, 25], [-1.5, 0.3, 0]));
  assert.throws(() => referenceCase('not-a-scene'), /Unknown reference case/);
});

test('clearcoat has frozen all-pixel budgets on both supported PBR backends', () => {
  const baseline = JSON.parse(
    readFileSync(new URL('../docs/whitepaper/results/batch-160-clearcoat.json', import.meta.url)),
  );
  for (const row of [baseline, baseline.compat]) {
    assert.equal(row.metrics.mae, row.metrics.absolute / (512 * 512 * 3));
    assert.equal(row.metrics.pixels, 512 * 512);
    assert.equal(row.margo.primitives, 27);
    assert.equal(row.nativeWebGL2.code, 'unsupported');
    assert.equal(row.sourceSha256, referenceCase('clearcoat').sourceSha256);
  }
  assert.equal(baseline.referenceSha256, baseline.compat.referenceSha256);
  assert.equal(baseline.sceneSha256, baseline.compat.sceneSha256);
  assert.equal(baseline.compat.hardware.webgpu.vendor, 'margo-webgl2');
  assert.equal(baseline.metrics.absolute, 1322815);
  assert.equal(baseline.compat.metrics.absolute, 1322815);
});

test('sheen has measured budgets for its entire twenty-primitive scene on both backends', () => {
  const baseline = JSON.parse(
    readFileSync(new URL('../docs/whitepaper/results/batch-160-sheen.json', import.meta.url)),
  );
  for (const row of [baseline, baseline.compat]) {
    assert.equal(row.metrics.absolute, 1119468);
    assert.equal(row.metrics.square, 33899646);
    assert.equal(row.metrics.max, 167);
    assert.equal(row.metrics.mae, row.metrics.absolute / (512 * 512 * 3));
    assert.equal(row.margo.primitives, 20);
    assert.equal(row.nativeWebGL2.code, 'unsupported');
    assert.equal(row.sourceSha256, referenceCase('sheen').sourceSha256);
  }
  assert.equal(baseline.referenceSha256, baseline.compat.referenceSha256);
  assert.equal(baseline.sceneSha256, baseline.compat.sceneSha256);
  assert.equal(baseline.compat.hardware.webgpu.vendor, 'margo-webgl2');
});

for (const [family, primitives, absolute, compatAbsolute, square, compatSquare, max] of [
  ['anisotropy', 50, 811914, 811911, 29877972, 29877969, 254],
  ['iridescence', 346, 613669, 613668, 18117459, 18117470, 127],
])
  test(`${family} retains every primitive and its own measured backend budgets`, () => {
    const b = JSON.parse(readFileSync(new URL(`../docs/whitepaper/results/batch-160-${family}.json`, import.meta.url)));
    assert.deepEqual(
      [b.metrics.absolute, b.compat.metrics.absolute, b.metrics.square, b.compat.metrics.square],
      [absolute, compatAbsolute, square, compatSquare],
    );
    for (const row of [b, b.compat]) {
      assert.equal(row.margo.primitives, primitives);
      assert.equal(row.metrics.pixels, 512 * 512);
      assert.equal(row.metrics.mae, row.metrics.absolute / (512 * 512 * 3));
      assert.equal(row.metrics.max, max);
      assert.equal(row.sourceSha256, referenceCase(family).sourceSha256);
      assert.equal(row.nativeWebGL2.code, 'unsupported');
    }
    assert.equal(b.referenceSha256, b.compat.referenceSha256);
    assert.equal(b.sceneSha256, b.compat.sceneSha256);
    assert.equal(b.viewer.referenceSha256, b.referenceSha256);
    assert.equal(b.compat.hardware.webgpu.vendor, 'margo-webgl2');
  });
test('path-traced floats keep their row order, byte order and fixed display transform', () => {
  const bytes = Buffer.alloc(24);
  for (const offset of [12, 16, 20]) bytes.writeFloatLE(0.5, offset);
  assert.deepEqual([...displayImage(bytes, 1, 2).data], [0, 0, 0, 255, 181, 181, 181, 255]);
  assert.throws(() => displayImage(bytes, 2, 2));
  bytes.writeFloatLE(Infinity, 0);
  assert.throws(() => displayImage(bytes, 1, 2), /Non-finite/);
});

for (const [family, primitives, absolute, square, max] of [
  ['transmission', 22, 1590947, 66568819, 254],
  ['volume', 23, 1471401, 22496007, 110],
])
  test(`${family} preserves the full sample and exact viewer and path-transport budgets`, () => {
    const read = (suffix) =>
      JSON.parse(
        readFileSync(new URL(`../docs/whitepaper/results/batch-160-${family}${suffix}.json`, import.meta.url)),
      );
    const viewer = read('');
    assert.deepEqual([viewer.metrics.absolute, viewer.metrics.square, viewer.metrics.max], [absolute, square, max]);
    for (const row of [viewer, viewer.compat]) {
      assert.equal(row.margo.primitives, primitives);
      assert.equal(row.metrics.mae, row.metrics.absolute / (512 * 512 * 3));
      assert.equal(row.nativeWebGL2.code, 'unsupported');
      assert.equal(row.sourceSha256, referenceCase(family).sourceSha256);
    }
    const transport = read('-transport');
    assert.equal(transport.sceneSha256, viewer.sceneSha256);
    assert.equal(transport.sourceSha256, viewer.sourceSha256);
    assert.deepEqual(Object.keys(transport.rows), ['full', 'direct']);
    for (const [mode, row] of Object.entries(transport.rows)) {
      assert.equal(row.meta.samples, 128);
      assert.equal(row.meta.seed, 160);
      assert.equal(row.meta.sunIrradiance, 3);
      assert.equal(row.meta.mode.startsWith(mode === 'full' ? 'full path' : 'direct-lit'), true);
      for (const result of [row, row.compat]) {
        assert.equal(result.metrics.pixels, 512 * 512);
        assert.equal(result.metrics.mae, result.metrics.absolute / (512 * 512 * 3));
      }
      assert.match(row.referenceSha256, /^[0-9a-f]{64}$/);
      assert.match(row.linearSha256, /^[0-9a-f]{64}$/);
    }
  });

test('volume transport budgets are the 2026-11-11 re-recorded measurements', () => {
  const budget = JSON.parse(
    readFileSync(new URL('../docs/whitepaper/results/batch-160-volume-transport.json', import.meta.url)),
  );
  assert.equal(budget.rows.full.metrics.absolute, 13794699);
  assert.equal(budget.rows.full.compat.metrics.absolute, 13794699);
  assert.equal(budget.rows.direct.metrics.absolute, 1807380);
  assert.equal(budget.rows.direct.compat.metrics.absolute, 1807380);
});

// Batch 160 job 5, measured on main's area-filter mip chain (65098f33fe): NVIDIA rows are the shared budget, the AMD
// rows gate AMD proofs. Each row: native absolute, compat absolute, native square, compat square.
for (const [family, primitives, nvidia, amd] of [
  ['specular', 24, [877623, 877629, 45728851, 45729151], [879167, 873364, 45728589, 45667350]],
  ['ior', 23, [2411082, 2411082, 72778266, 72778266], [2424867, 2426643, 72838947, 72986541]],
])
  test(`${family} freezes the measured full-scene error on each adapter and PBR backend`, () => {
    const b = JSON.parse(readFileSync(new URL(`../docs/whitepaper/results/batch-160-${family}.json`, import.meta.url)));
    const rows = [b, b.compat, b.amd.native, b.amd.compat];
    const budgets = (native, compat) => [
      native.metrics.absolute,
      compat.metrics.absolute,
      native.metrics.square,
      compat.metrics.square,
    ];
    assert.deepEqual(budgets(rows[0], rows[1]), nvidia);
    assert.deepEqual(budgets(rows[2], rows[3]), amd);
    for (const row of rows) {
      assert.equal(row.metrics.pixels, 512 * 512);
      assert.equal(row.metrics.mae, row.metrics.absolute / (512 * 512 * 3));
      assert.equal(row.margo.primitives, primitives);
      assert.equal(row.nativeWebGL2.code, 'unsupported');
      assert.equal(row.sourceSha256, referenceCase(family).sourceSha256);
      assert.equal(row.sceneSha256, b.sceneSha256);
      assert.equal(row.referenceSha256, b.referenceSha256);
    }
    assert.equal(b.viewer.referenceSha256, b.referenceSha256);
    assert.deepEqual(
      rows.map((row) => row.hardware.webgpu.vendor),
      ['nvidia', 'margo-webgl2', 'amd', 'margo-webgl2'],
    );
    assert.match(b.compat.hardware.webglRenderer, /NVIDIA/);
    assert.match(b.amd.compat.hardware.webglRenderer, /AMD Radeon/);
  });
