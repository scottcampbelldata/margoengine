// AR Quick Look shows a USDZ at real size, so the numbers in the file are what a phone shows. A real iPhone showed Fox-Run 79
// metres tall: these tests hold the real models to the size glTF's own maths gives. Expected numbers were measured by a script
// that shares no code with the writer, with node transforms and skinning applied at every frame of the clip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { exportAnimatedUSDZ } from '@margoengine/exporters/usdz-anim';
import { exportUSDZ, measureUSDZ } from '@margoengine/exporters/usdz';
import { sceneOfGLB } from '../dist/glb-scene.js';

const asset = (path) => new Uint8Array(readFileSync(new URL(`../../../examples/assets/${path}`, import.meta.url)));
const FOX = 'khronos/Fox/Fox.glb',
  FIGURE = 'khronos/RiggedFigure/RiggedFigure.glb',
  ROBOT = 'robot-expressive.glb';
const usda = async (usdz) => new TextDecoder().decode(await readZipEntry(usdz, readZipDirectory(usdz)[0]));
const near = (actual, expected, bound, label) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${label}: ${actual} against ${expected}, bound ${bound}`);
const nearAll = (actual, expected, bound, label) =>
  expected.forEach((value, i) => near(actual[i], value, bound, `${label} ${i}`));
const numbers = (text) => (text.match(/-?\d+\.?\d*(?:e[-+]?\d+)?/gi) ?? []).map(Number);
/** The box of every `point3f[] points` line of a Mesh in the text. */
function boxOfPoints(text) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const [, list] of text.matchAll(/point3f\[\] points = (.*)/g))
    numbers(list).forEach((value, i) => {
      min[i % 3] = Math.min(min[i % 3], value);
      max[i % 3] = Math.max(max[i % 3], value);
    });
  return { min, max };
}
/** Each frame of the SkelRoot's extent as [min x, y, z, max x, y, z], skin by skin. */
const extents = (text) =>
  [...text.matchAll(/float3\[\] extent\.timeSamples = \{\r?\n([\s\S]*?)\n\s*\}/g)].map(([, block]) =>
    block.split('\n').map((line) => numbers(line.slice(line.indexOf(':') + 1))),
  );

test('the result says the Fox is 79 metres tall, so nobody finds out on a phone', async () => {
  const { size, bounds, scale, usdz } = await exportAnimatedUSDZ(asset(FOX), { clip: 'Run' }),
    text = await usda(usdz);
  nearAll(size, [25.185, 79.029, 154.72], 0.01, 'rest size');
  const held = boxOfPoints(text);
  nearAll(held.max.map((value, i) => value - held.min[i]), size, 0.01, 'the file\'s own points say the size the result says');
  // Run reaches past the rest pose: the feet go below the floor and the body stretches.
  nearAll(bounds.min, [-17.5, -3.722, -98.26], 0.05, 'clip min');
  nearAll(bounds.max, [17.02, 77.13, 75.19], 0.05, 'clip max');
  assert.equal(scale, 1);
  assert.match(text, /metersPerUnit = 1\b/);
  assert.doesNotMatch(text, /def Xform "Margo" \{\r?\n\s+matrix4d/, 'true size is the default: no transform on the root');
});

test('height sets the size in metres, keeps the proportions and leaves the animation alone', async () => {
  const bytes = asset(FOX),
    plain = await exportAnimatedUSDZ(bytes, { clip: 'Run' }),
    small = await exportAnimatedUSDZ(bytes, { clip: 'Run', height: 0.45, ground: true }),
    [before, after] = [await usda(plain.usdz), await usda(small.usdz)],
    scale = 0.45 / plain.size[1];
  near(small.size[1], 0.45, 1e-9, 'height');
  near(small.scale, scale, 1e-12, 'scale');
  nearAll(small.size, plain.size.map((v) => v * scale), 1e-9, 'proportions');
  near(small.bounds.min[1], (plain.bounds.min[1] + 0.12174) * scale, 1e-5, 'the rest pose stands on the floor');
  const root = /def Xform "Margo" \{\r?\n\s+matrix4d xformOp:transform = (.*)/.exec(after)[1],
    m = numbers(root);
  near(m[0], scale, 1e-6, 'x scale');
  near(m[5], scale, 1e-6, 'y scale');
  near(m[10], scale, 1e-6, 'z scale');
  near(m[13], 0.12174 * scale, 1e-6, 'lift');
  assert.match(after, /uniform token\[\] xformOpOrder = \["xformOp:transform"\]/);
  assert.equal(
    after.replace(/def Xform "Margo" \{\r?\n\s+matrix4d.*\r?\n.*xformOpOrder.*\r?\n/, 'def Xform "Margo" {\n'),
    before,
    'everything below the root is the same file',
  );
});

test('every frame of a skin says how far it reaches, past the rest pose', async () => {
  const { bounds, frames, usdz } = await exportAnimatedUSDZ(asset(FOX), { clip: 'Run' }),
    [skin, none] = extents(await usda(usdz));
  assert.equal(none, undefined, 'the Fox has one skin');
  assert.equal(skin.length, frames);
  const union = [0, 1, 2].map((k) => Math.min(...skin.map((box) => box[k])));
  nearAll(union, bounds.min, 1e-3, 'lowest reach');
  nearAll([0, 1, 2].map((k) => Math.max(...skin.map((box) => box[3 + k]))), bounds.max, 1e-3, 'highest reach');
  assert.ok(new Set(skin.map(String)).size > 1, 'the box moves with the clip');
});

test('a skin stored lying down is written standing, as Apple sizes a model from its points', async () => {
  // RiggedFigure's vertices run along Z and its joints stand it up: read without the skeleton it was a figure on its back.
  const { size, usdz } = await exportAnimatedUSDZ(asset(FIGURE)),
    text = await usda(usdz),
    { min, max } = boxOfPoints(text);
  nearAll(size, [1.179, 1.45, 0.326], 1e-3, 'size');
  nearAll(min, [-0.5895, 0, -0.1309], 1e-3, 'points min');
  nearAll(max, [0.5895, 1.4499, 0.195], 1e-3, 'points max');
});

test('a skin stored in millimetres is written in metres', async () => {
  // robot-expressive's hands are 6 cm of mesh under a joint scale of 100; with the bind pose out of them they span arm to arm.
  const { size, usdz } = await exportAnimatedUSDZ(asset(ROBOT), { clip: 'Idle' }),
    text = await usda(usdz),
    meshes = [...text.matchAll(/primvars:skel:jointIndices/g)].length;
  nearAll(size, [3.1, 4.461, 2.687], 0.01, 'size');
  assert.equal(meshes, 4);
  const skinned = text.slice(text.indexOf('def SkelRoot')),
    { min, max } = boxOfPoints(skinned);
  assert.ok(max[0] - min[0] > 6, `the hands are ${max[0] - min[0]} apart`);
  near(min[1], 2.057, 0.01, 'hands stand at arm height');
});

test('the static writer takes the same size, and measureUSDZ reads it first', async () => {
  const { scene } = sceneOfGLB(asset(FOX)),
    measured = measureUSDZ(scene),
    set = measureUSDZ(scene, { height: 0.45, ground: true }),
    plain = await usda(exportUSDZ(scene)),
    small = await usda(exportUSDZ(scene, { height: 0.45, ground: true }));
  near(measured.size[1], 79.029, 0.01, 'real height');
  near(set.size[1], 0.45, 1e-9, 'set height');
  near(set.bounds.min[1], 0, 1e-9, 'on the floor');
  near(set.scale, 0.45 / measured.size[1], 1e-12, 'scale');
  assert.doesNotMatch(plain, /def Xform "Margo" \{\r?\n\s+matrix4d/);
  near(numbers(/def Xform "Margo" \{\r?\n\s+matrix4d xformOp:transform = (.*)/.exec(small)[1])[5], set.scale, 1e-6, 'root');
});

test('a size that cannot be met is refused with what to do', async () => {
  const flat = {
    nodes: [
      {
        geometry: {
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1]),
          normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
          indices: [0, 1, 2],
        },
      },
    ],
  };
  for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
    assert.throws(() => exportUSDZ(flat, { height }), /height in metres/);
    await assert.rejects(exportAnimatedUSDZ(asset(FOX), { height }), /height in metres/);
  }
  assert.throws(() => exportUSDZ(flat, { ground: 'yes' }), /ground must be boolean/);
  assert.throws(() => exportUSDZ(flat, { height: 1 }), /flat in Y/);
  assert.throws(() => measureUSDZ({ nodes: [] }), /at least one mesh/);
});
