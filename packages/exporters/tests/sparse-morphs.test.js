// A Character Creator man imported from FBX carries 160 face shapes; written dense they took 231 MB of a 272 MB GLB,
// though each shape moves only part of the face. exportGLB now writes each target's deltas sparse (glTF 2.0 section
// 3.6.2.3) when that is smaller, and a target that moves nothing with no buffer view (section 3.6.2.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGLTFAsync } from '@margoengine/gltf/pbr';
import { exportGLB, readAccessor, splitGLB } from '../dist/index.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { validate } from './helpers.js';

const grid = 64,
  count = grid * grid,
  targets = 40;

/** A 64 x 64 vertex sheet with 40 targets: target t moves a 6-vertex patch, the last target moves nothing. */
function face() {
  const positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3),
    tangents = new Float32Array(count * 4),
    indices = [];
  for (let y = 0; y < grid; y++)
    for (let x = 0; x < grid; x++) {
      const v = y * grid + x;
      positions.set([x / grid, y / grid, 0], v * 3);
      normals[v * 3 + 2] = 1;
      tangents.set([1, 0, 0, 1], v * 4);
      if (x < grid - 1 && y < grid - 1) indices.push(v, v + 1, v + grid, v + 1, v + grid + 1, v + grid);
    }
  const morphs = [];
  for (let t = 0; t < targets; t++) {
    const dp = new Float32Array(count * 3),
      dn = new Float32Array(count * 3),
      dt = new Float32Array(count * 3);
    if (t < targets - 1)
      for (let k = 0; k < 6; k++) {
        const v = (t * 97 + k * 11) % count;
        dp.set([0.01 * (k + 1), -0.02 * t, 0.003], v * 3);
        dn.set([0.1, 0, -0.05], v * 3);
        dt.set([0, 0.2, 0], v * 3);
      }
    // A -0 delta must survive: it decodes to -0, not the +0 an implicit sparse zero reads as.
    if (t === 1) dn[5 * 3 + 1] = -0;
    morphs.push({ name: 'shape' + t, positions: dp, normals: dn, tangents: dt });
  }
  // One target moving every vertex stays dense: sparse would be larger.
  morphs.push({
    name: 'everything',
    positions: Float32Array.from({ length: count * 3 }, (_, i) => (i % 7) * 0.01 + 0.001),
  });
  return { positions, normals, tangents, indices: Uint32Array.from(indices), morphs };
}

const source = () => ({ nodes: [{ geometry: face(), morphWeights: new Array(targets + 1).fill(0) }] });
const bits = (values) => new Uint32Array(Float32Array.from(values).buffer);

test('exportGLB writes mostly-zero morph targets sparse, smaller, with identical decoded deltas', async () => {
  const dense = exportGLB(source(), { sparseMorphs: false }),
    sparse = exportGLB(source()),
    before = splitGLB(dense),
    after = splitGLB(sparse),
    morphs = face().morphs;
  assert.ok(sparse.length * 10 < dense.length, `sparse ${sparse.length} B against dense ${dense.length} B`);
  const was = before.json.meshes[0].primitives[0].targets,
    now = after.json.meshes[0].primitives[0].targets;
  assert.equal(now.length, targets + 1);
  const kinds = { sparse: 0, zero: 0, dense: 0 },
    widths = new Set();
  now.forEach((target, t) => {
    for (const name of ['POSITION', 'NORMAL', 'TANGENT']) {
      if (target[name] === undefined) continue;
      const accessor = after.json.accessors[target[name]];
      if (accessor.sparse) {
        kinds.sparse++;
        assert.equal(accessor.bufferView, undefined);
        // The last moved row picks the index width: 8 bits up to row 255, else 16 (4096 vertices).
        const rows = readAccessor(after, target[name]).values;
        let last = 0;
        for (let i = 0; i < rows.length; i++) if (!Object.is(rows[i], 0)) last = Math.floor(i / 3);
        assert.equal(accessor.sparse.indices.componentType, last <= 255 ? 5121 : 5123, `target ${t} ${name} indices`);
        widths.add(accessor.sparse.indices.componentType);
        for (const side of ['indices', 'values'])
          assert.equal(after.json.bufferViews[accessor.sparse[side].bufferView].target, undefined);
      } else if (accessor.bufferView === undefined) kinds.zero++;
      else kinds.dense++;
      const expected =
        name === 'POSITION' ? morphs[t].positions : name === 'NORMAL' ? morphs[t].normals : morphs[t].tangents;
      assert.deepEqual(bits(readAccessor(after, target[name]).values), bits(expected), `target ${t} ${name}`);
      assert.deepEqual(bits(readAccessor(before, was[t][name]).values), bits(expected), `dense target ${t} ${name}`);
      if (name === 'POSITION') {
        const old = before.json.accessors[was[t].POSITION];
        assert.deepEqual([accessor.min, accessor.max], [old.min, old.max]);
      }
    }
  });
  assert.deepEqual(kinds, { sparse: (targets - 1) * 3, zero: 3, dense: 1 });
  assert.deepEqual([...widths].sort(), [5121, 5123]);
  const report = await validate(sparse);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
});

test('the engine glTF reader decodes sparse and all-zero morph targets to the dense values bit for bit', () =>
  headlessModels(async () => {
    const dense = await parseGLTFAsync(await headless(), exportGLB(source(), { sparseMorphs: false })),
      sparse = await parseGLTFAsync(await headless(), exportGLB(source()));
    const was = dense.asset.doc.meshes[0].primitives[0].targets,
      now = sparse.asset.doc.meshes[0].primitives[0].targets;
    assert.equal(now.length, was.length);
    now.forEach((target, t) => {
      for (const name of Object.keys(was[t]))
        assert.deepEqual(
          bits(sparse.asset.accessor(target[name])),
          bits(dense.asset.accessor(was[t][name])),
          `target ${t} ${name}`,
        );
    });
  }));

test('sparseMorphs must be boolean', () => {
  assert.throws(() => exportGLB(source(), { sparseMorphs: 'yes' }), /sparseMorphs must be boolean/);
});

test('exportSparseGLB with sparse: false keeps every morph target dense', async () => {
  const { exportSparseGLB } = await import('../dist/sparse.js'),
    out = splitGLB(exportSparseGLB(source(), { sparse: false, interleave: false }));
  for (const target of out.json.meshes[0].primitives[0].targets)
    for (const index of Object.values(target)) {
      assert.equal(out.json.accessors[index].sparse, undefined);
      assert.notEqual(out.json.accessors[index].bufferView, undefined);
    }
});
