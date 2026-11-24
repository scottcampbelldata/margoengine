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
  const input = readFileSync(new URL('../packages/gltf/test/fixtures/pointer-show.glb', import.meta.url));
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

// KB6016b accepted difference (docs/limits.md): the rows above stay the published record of the separable-G table;
// the height-correlated G2 picture is gated on its own exact first measurements against the same frozen references.
test('IBL G2 table: exact accepted-difference budgets beside the unmoved published record (KB6016b)', () => {
  const b = JSON.parse(readFileSync(new URL('../docs/whitepaper/results/batch-160-environment.json', import.meta.url)));
  const accepted = b.acceptedKB6016b;
  assert.equal(accepted.issue, 'KB6016b');
  assert.equal(accepted.hardware.compat.webgpu.vendor, 'margo-webgl2');
  for (const [side, abs, square] of [
    ['native', [2326991, 1510119], [78217549, 32969063]],
    ['compat', [2326940, 1510078], [78215460, 32967762]],
  ])
    for (const [i, mode] of ['direct', 'full'].entries()) {
      const m = accepted[side][mode];
      assert.equal(m.absolute, abs[i]);
      assert.equal(m.square, square[i]);
      assert.equal(m.mae, abs[i] / (512 * 512 * 3));
    }
  // Published record unmoved: +1.4 % on the direct row, all of it the separable G of Mitsuba principled.
  assert.equal(b.rows.direct.metrics.absolute, 2294442);
  assert.equal(Math.round((1000 * accepted.native.direct.absolute) / b.rows.direct.metrics.absolute) / 10, 101.4);
});

// KB6016b: the decomposition script's GGX D cancelled in float32 near the normal (albedo 0.896 at alpha 1e-3).
test('the decomposition references write the GGX D denominator without float32 cancellation (KB6016b)', () => {
  const script = readFileSync(
    new URL('../scripts/reference-rendering/mitsuba-environment-decompose.py', import.meta.url),
    'utf8',
  );
  assert.match(script, /t = m\.x \* m\.x \+ m\.y \* m\.y \+ a2 \* m\.z \* m\.z/);
  assert.doesNotMatch(script, /t = \w+ \* \w+ \* \(a2 - 1\)/);
  assert.doesNotMatch(script, /ggx_d\(alpha, \w+\.z\)/);
});

// KB3563 accepted difference: the frozen direct residual split by difference (docs/limits.md, batch 160 job 7).
test('IBL furnace residual decomposes into noise, visibility, BSDF model, multiple scattering and edges (KB3563)', () => {
  const b = JSON.parse(readFileSync(new URL('../docs/whitepaper/results/batch-160-environment.json', import.meta.url)));
  const d = JSON.parse(
    readFileSync(new URL('../docs/whitepaper/results/batch-160-environment-decomposition.json', import.meta.url)),
  );
  assert.equal(d.sceneSha256, b.sceneSha256);
  assert.equal(d.frozenDirect.linearSha256, b.rows.direct.linearSha256);
  assert.equal(d.frozenDirect.native.absolute, b.acceptedKB6016b.native.direct.absolute);
  assert.equal(d.compat.hardware.webgpu.vendor, 'margo-webgl2');
  const names = [
    'principled-direct-1024',
    'principled-unoccluded-1024',
    'gltf-unoccluded-1024',
    'split-model-unoccluded-1024',
  ];
  assert.deepEqual(Object.keys(d.references), names);
  for (const [i, name] of names.entries()) {
    const meta = d.references[name].meta;
    assert.equal(meta.samples, 1024);
    assert.equal(meta.triangles, 1040409);
    assert.equal(meta.variant, 'cuda_ad_rgb');
    assert.equal(meta.visibility, i === 0);
  }
  for (const [side, absolute] of [
    ['native', [2285851, 1276741, 1045571, 447308]],
    ['compat', [2285792, 1276742, 1045530, 447309]],
  ])
    names.forEach((name, i) => {
      assert.equal(d[side][name].absolute, absolute[i]);
      assert.equal(d[side][name].edge + d[side][name].flat, absolute[i]);
    });
  const base = d.frozenDirect.native.absolute,
    rows = d.native,
    share = (x) => Math.round((1000 * x) / base) / 10;
  assert.equal(share(base - rows['principled-direct-1024'].absolute), 1.8); // 128-spp reference noise
  assert.equal(share(rows['principled-direct-1024'].absolute - rows['principled-unoccluded-1024'].absolute), 43.4); // visibility
  assert.equal(share(rows['principled-unoccluded-1024'].absolute - rows['gltf-unoccluded-1024'].absolute), 9.9); // BSDF model
  assert.equal(share(rows['gltf-unoccluded-1024'].absolute - rows['split-model-unoccluded-1024'].absolute), 25.7); // multiple scattering
  // What is left against the model's own exact integrals: silhouettes, and 0.8 % of numerics with no bias.
  assert.equal(share(rows['split-model-unoccluded-1024'].edge), 18.5);
  assert.equal(share(rows['split-model-unoccluded-1024'].flat), 0.8);
  assert.ok(Math.abs(rows['split-model-unoccluded-1024'].flatSigned) < rows['split-model-unoccluded-1024'].flat / 5);
  // KB6016b gates on this row: no budget looser than the KB3563 record of the separable table (2026-11-11).
  for (const [side, before] of [
    ['native', { absolute: 484953, square: 12933485, max: 106, edge: 445796, flat: 39157 }],
    ['compat', { absolute: 484989, square: 12933615, max: 106, edge: 445806, flat: 39183 }],
  ]) {
    const row = d[side]['split-model-unoccluded-1024'];
    for (const [key, value] of Object.entries(before))
      assert.ok(row[key] <= value, `${side} ${key} ${row[key]} > ${value}`);
    assert.ok(row.foreground >= 47776);
  }
});
