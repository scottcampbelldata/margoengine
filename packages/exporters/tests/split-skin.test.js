// A skinned, morphed primitive gltf/pbr split into parts (maxPartVertices) exports as one primitive per part whose
// JOINTS_0, WEIGHTS_0 and morph target deltas are the part's own vertices', through part.vertexMap: exportModel (the
// loaded file's accessors) and exportGLB (the scene collector). Before the fix the targets kept the whole primitive's
// vertex count, which the glTF Validator rejects, and the collector wrote the whole primitive's joints and weights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGLTF } from '@margoengine/gltf/pbr';
import { exportModel } from '../dist/model.js';
import { exportGLB } from '../dist/gltf.js';
import { materialEngine as headless, readGLB, validate } from './helpers.js';
import { splitSkinGrid } from '../../../tests/support/split-skin-fixture.js';

const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function read(json, bin, index) {
  const a = json.accessors[index],
    v = json.bufferViews[a.bufferView],
    n = a.count * WIDTH[a.type],
    at = bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0),
    Type = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[a.componentType];
  return new Type(bin.buffer.slice(at, at + n * Type.BYTES_PER_ELEMENT));
}
const gather = (values, width, map) => {
  const out = new Float32Array(map.length * width);
  map.forEach((v, k) => {
    for (let c = 0; c < width; c++) out[k * width + c] = values[v * width + c];
  });
  return out;
};
function close(actual, expected, label, eps = 1e-6) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < actual.length; i++)
    if (!(Math.abs(actual[i] - expected[i]) <= eps)) assert.fail(`${label}: element ${i} is ${actual[i]}, expected ${expected[i]}`);
}
/** Every exported primitive k holds part k's joints, weights and morph deltas. */
function checkParts(json, bin, model, grid) {
  const primitives = json.meshes[0].primitives;
  assert.equal(primitives.length, model.primitives.length);
  primitives.forEach((p, k) => {
    const map = model.primitives[k].part.vertexMap;
    close(read(json, bin, p.attributes.JOINTS_0), gather(grid.arrays.JOINTS_0, 4, map), `part ${k} JOINTS_0`);
    close(read(json, bin, p.attributes.WEIGHTS_0), gather(grid.arrays.WEIGHTS_0, 4, map), `part ${k} WEIGHTS_0`);
    assert.equal(p.targets.length, 1);
    close(read(json, bin, p.targets[0].POSITION), gather(grid.arrays.lift, 3, map), `part ${k} target POSITION`);
    close(read(json, bin, p.targets[0].NORMAL), gather(grid.arrays.tilt, 3, map), `part ${k} target NORMAL`);
  });
}

test('exportModel writes each part of a split skinned, morphed primitive with its own skin and morph data', async () => {
  const engine = await headless(),
    grid = splitSkinGrid(90, 90),
    model = parseGLTF(engine, grid.doc, grid.buffers, [], {}, { maxPartVertices: 4096 });
  assert.ok(model.primitives.length >= 2, `${model.primitives.length} parts`);
  const bytes = new Uint8Array(await exportModel(model, { binary: true })),
    { json, bin } = readGLB(bytes);
  checkParts(json, bin, model, grid);
  const report = await validate(bytes);
  assert.equal(report.errors, 0, JSON.stringify(report.messages.slice(0, 3)));
  model.dispose();
});

test('exportGLB of the scene writes each part with its own joints, weights and morph deltas', async () => {
  const engine = await headless(),
    grid = splitSkinGrid(90, 90),
    model = parseGLTF(engine, grid.doc, grid.buffers, [], {}, { maxPartVertices: 4096 });
  const { json, bin } = readGLB(exportGLB(engine));
  const mesh = json.meshes.find((m) => m.primitives.length === model.primitives.length);
  assert.ok(mesh, `a mesh of ${model.primitives.length} primitives`);
  checkParts({ ...json, meshes: [mesh] }, bin, model, grid);
  model.dispose();
});
