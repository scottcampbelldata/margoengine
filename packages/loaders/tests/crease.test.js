// createMeshes and createPBRMeshes: sharp edges of a mesh without normals stay sharp, and a vertex-colored mesh with a
// group for each color is drawn as one part.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { createMeshes } from '../dist/index.js';
import { createPBRMeshes } from '../dist/render.js';
import { parse3MF } from '../dist/threemf.js';
import { box, zip } from './threemf-surface.js';

/** A unit box of 8 shared vertices and no normals, with a color and a scalar for each vertex. */
function cube() {
  const { vertices, triangles } = box([0, 0, 0], [1, 1, 1]);
  return {
    kind: 'mesh',
    positions: new Float32Array(vertices.flat()),
    indices: new Uint32Array(triangles.flat()),
    colors: new Float32Array(vertices.flatMap((p) => p)),
    attributes: { id: Float32Array.from(vertices.keys()) },
  };
}
const mockEngine = () => ({
  createMesh() {
    return {
      setGeometry() {
        return this;
      },
      setMaterial() {
        return this;
      },
      dispose() {},
    };
  },
});
/** Whether every normal of the interleaved position and normal vertices lies along an axis. */
const axial = ({ vertices }) => {
  for (let v = 0; v < vertices.length; v += 6) {
    const normal = [...vertices.subarray(v + 3, v + 6)].map(Math.abs).sort();
    if (!(normal[0] < 1e-6 && normal[1] < 1e-6 && Math.abs(normal[2] - 1) < 1e-6)) return false;
  }
  return true;
};
async function engineFor(t) {
  const gpu = optionalGPU(),
    store = await TransformStore.create(64),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  t.after(() => {
    engine.dispose();
    gpu.cleanup();
  });
  return engine;
}

test('regression: createMeshes keeps the edges of a box without normals sharp', () => {
  const input = cube(),
    before = structuredClone(input),
    [sharp] = createMeshes(mockEngine(), input).geometries;
  assert.equal(sharp.vertices.length / 6, 24);
  assert.ok(axial(sharp));
  for (const options of [{ creaseAngle: 180 }, { normals: 'smooth' }]) {
    const [smooth] = createMeshes(mockEngine(), input, options).geometries;
    assert.equal(smooth.vertices.length / 6, 8);
    assert.ok(!axial(smooth));
  }
  assert.deepEqual(input, before, 'the input is not changed');
  // A crease angle past the box's right angles smooths them.
  assert.equal(createMeshes(mockEngine(), input, { creaseAngle: 91 }).geometries[0].vertices.length / 6, 8);
  assert.throws(() => createMeshes(mockEngine(), input, { creaseAngle: -1 }), { code: 'range' });
});

test('regression: createPBRMeshes keeps box edges sharp, each copy with its vertex color', async (t) => {
  const model = createPBRMeshes(await engineFor(t), cube()),
    [{ vertices }] = model.primitives;
  assert.equal(vertices.length / 20, 24);
  for (let v = 0; v < vertices.length; v += 20) {
    const normal = [...vertices.subarray(v + 4, v + 7)].map(Math.abs).sort();
    assert.ok(normal[0] < 1e-6 && normal[1] < 1e-6, `${normal}`);
    // The color was the position, in sRGB: a 0 or 1 stays itself in linear light.
    assert.deepEqual([...vertices.subarray(v + 16, v + 19)], [...vertices.subarray(v, v + 3)]);
  }
  model.dispose();
});

/** A strip of `count` triangles in a 3MF package, each corner a color of its own: a scan's kind of coloring. */
function scan(count) {
  const hex = (n) => `#${n.toString(16).padStart(6, '0')}`,
    colours = Array.from({ length: count + 2 }, (_, i) => `<m:color color="${hex(i + 1)}"/>`).join(''),
    vertices = Array.from({ length: count + 2 }, (_, i) => `<vertex x="${i >> 1}" y="${i & 1}" z="0"/>`).join(''),
    triangles = Array.from({ length: count }, (_, i) => {
      const [a, b, c] = i & 1 ? [i + 1, i, i + 2] : [i, i + 1, i + 2];
      return `<triangle v1="${a}" v2="${b}" v3="${c}" pid="1" p1="${a}" p2="${b}" p3="${c}"/>`;
    }).join('');
  return zip({
    '3D/3dmodel.model': `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"><resources><m:colorgroup id="1">${colours}</m:colorgroup><object id="2" type="model"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object></resources><build><item objectid="2"/></build></model>`,
  });
}

test('regression: createPBRMeshes draws a scan with more color groups than 4,096 parts', async (t) => {
  const loaded = await parse3MF(scan(9000), { units: 'file' }),
    engine = await engineFor(t);
  assert.ok(loaded.groups.length > 4096, `${loaded.groups.length} groups`);
  const model = createPBRMeshes(engine, loaded);
  assert.equal(model.primitives.length, 1);
  assert.equal(model.primitives[0].indices.length, 27_000);
  model.dispose();
  // Without vertex colors the group colors are all there is, so each stays a part and the limit stands.
  const { colors: _, ...plain } = loaded;
  assert.throws(() => createPBRMeshes(engine, plain), { code: 'limit', message: /4096 parts/ });
});

test('color groups of different objects, names or opacity stay apart', async (t) => {
  const loaded = {
      kind: 'mesh',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2]),
      colors: new Float32Array(9).fill(1),
      groups: [
        { start: 0, count: 3, objectId: '1', color: [1, 0, 0, 1] },
        { start: 3, count: 3, objectId: '1', color: [0, 1, 0, 1] },
        { start: 6, count: 3, objectId: '1', color: [0, 0, 1, 0.5] },
        { start: 9, count: 3, objectId: '2', color: [0, 0, 1, 0.5] },
        { start: 12, count: 3, objectId: '2', name: 'lid', color: [0, 0, 1, 0.5] },
      ],
    },
    model = createPBRMeshes(await engineFor(t), loaded);
  assert.deepEqual(
    model.primitives.map((p) => p.indices.length),
    [6, 3, 3, 3],
  );
  assert.equal(loaded.groups.length, 5);
  model.dispose();
});
