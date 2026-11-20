// A node may scale an axis to 0 (glTF 2.0 section 3.5.3): the exporters write it, and only 3MF, whose items are solids
// to print, refuses it with a coded error that says why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { animatePlacements, exportGLB, exportOBJ, exportPLY, exportSTL } from '../dist/index.js';
import { exportUSDZ } from '../dist/usdz.js';
import { export3MF } from '../dist/threemf.js';
import { readGLB, validate } from './helpers.js';

// A quad facing +Z; scale y 0 flattens it onto the x axis.
const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
// A quad facing +Y; scale y 0 keeps it in its plane, and its normal stays +Y.
const floor = {
  positions: [0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0],
  normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  indices: [0, 1, 2, 0, 2, 3],
};
const flattenedMatrix = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 4, 5, 6, 1];

test('glTF writes a partial zero scale, and a matrix with a zero column as its TRS, and both validate', async () => {
  const scene = {
      nodes: [
        { name: 'Flat', geometry: quad, scale: [1, 0, 1] },
        { name: 'Matrix', geometry: quad, matrix: flattenedMatrix },
        { name: 'Unscaled', geometry: quad, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1] },
      ],
    },
    glb = exportGLB(scene),
    report = await validate(glb),
    { nodes } = readGLB(glb).json;
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
  assert.deepEqual(nodes[0].scale, [1, 0, 1]);
  // The validator reads a matrix with a zero column as not decomposable (NODE_MATRIX_NON_TRS), so it is written as TRS.
  assert.equal(nodes[1].matrix, undefined);
  assert.deepEqual([nodes[1].translation, nodes[1].rotation, nodes[1].scale], [[4, 5, 6], undefined, [2, 0, 3]]);
  assert.deepEqual(nodes[2].matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1], 'other matrices as given');
  const flattened = readGLB(exportGLB(scene, { flatten: true })).json.nodes;
  assert.deepEqual(flattened[0].scale, [1, 0, 1]);
  assert.deepEqual(flattened[1].scale, [2, 0, 3]);
  assert.deepEqual(flattened[1].translation, [4, 5, 6]);
});

test('the mesh formats bake a flattened node with unit normals: the flattened axis, or +Y where it maps to zero', () => {
  const obj = exportOBJ({
      nodes: [
        { geometry: floor, scale: [2, 0, 3] },
        { geometry: quad, scale: [1, 0, 1] },
      ],
    }).obj,
    normals = [...obj.matchAll(/^vn (\S+) (\S+) (\S+)/gm)].map((m) => m.slice(1).map(Number));
  assert.ok(normals.length > 0);
  for (const n of normals) assert.deepEqual(n, [0, 1, 0]);
  assert.match(obj, /^v 2 0 3$/m);
  const stl = exportSTL({ nodes: [{ geometry: quad, scale: [1, 0, 1] }] }, { binary: true });
  assert.equal(stl.length, 84 + 2 * 50, 'two STL triangles');
  assert.match(exportPLY({ nodes: [{ geometry: quad, matrix: flattenedMatrix }] }), /^element vertex 4$/m);
});

test('USDZ writes a flattened node with its matrix as the transform', () => {
  const file = exportUSDZ({ nodes: [{ geometry: quad, scale: [1, 0, 1] }] }),
    text = new TextDecoder().decode(file);
  assert.match(text, /matrix4d xformOp:transform = \(\(1, 0, 0, 0\), \(0, 0, 0, 0\), \(0, 0, 1, 0\)/);
});

test('instance placements key a zero column as a zero scale on that axis only', () => {
  const node = {},
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    channels = animatePlacements(node, { fps: 10, frames: [0, 1] }, [identity, flattenedMatrix]),
    scale = channels.find((c) => c.path === 'scale');
  assert.deepEqual([...scale.values].slice(-3), [2, 0, 3]);
});

test('3MF refuses a zero scale with a coded error naming the reason', async () => {
  await assert.rejects(
    export3MF({ nodes: [{ geometry: quad, scale: [1, 0, 1] }] }),
    (error) => error.code === 'unsupported' && /3MF holds solids to print/.test(error.message),
  );
  await assert.rejects(
    export3MF({ nodes: [{ geometry: quad, scale: [1, 0, 1] }] }, { assembly: false }),
    (error) => error.code === 'unsupported',
  );
});
