import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { exportSceneSVG } from '../dist/scene-svg.js';

/** A square in the XY plane at depth z, facing +z, `half` wide. */
const quad = (z, half = 1) => ({
  positions: new Float32Array([-half, -half, z, half, -half, z, half, half, z, -half, half, z]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: [0, 1, 2, 0, 2, 3],
});
const mat = (r, g, b) => ({ color: [r, g, b, 1], doubleSided: false });
const camera = () => new Camera({ position: [0, 0, 6], target: [0, 0, 0] });
const view = { width: 200, height: 200 };
const fills = (svg) => [...svg.matchAll(/fill="rgb\((\d+) (\d+) (\d+)\)"/g)].map((m) => m.slice(1, 4).map(Number));
const reddish = ([r, g, b]) => r > g && r > b;
const greenish = ([r, g, b]) => g > r && g > b;

test('the painter paints the far surface first, whatever order the nodes come in', async () => {
  const near = { name: 'near', geometry: quad(1), material: mat(1, 0, 0) };
  const far = { name: 'far', geometry: quad(-1, 2), material: mat(0, 1, 0) };
  for (const nodes of [
    [near, far],
    [far, near],
  ]) {
    const out = await exportSceneSVG({ nodes }, { ...view, camera: camera(), shade: false });
    assert.equal(out.mode, 'vector');
    const painted = fills(out.svg);
    assert.ok(painted.length >= 2);
    assert.ok(greenish(painted[0]), 'far green first');
    assert.ok(reddish(painted[painted.length - 1]), 'near red last');
  }
});

test('crossing surfaces are split so each shows where it is nearer', async () => {
  // A red square through the middle of a green one: the red is in front on one side of the crossing and behind on the other.
  const tilted = {
    positions: new Float32Array([-1.5, -1.5, -1, 1.5, -1.5, -1, 1.5, 1.5, 1, -1.5, 1.5, 1]),
    normals: new Float32Array(12).fill(0),
    indices: [0, 1, 2, 0, 2, 3],
  };
  const out = await exportSceneSVG(
    {
      nodes: [
        { geometry: quad(0, 1.5), material: mat(0, 1, 0) },
        { geometry: tilted, material: mat(1, 0, 0) },
      ],
    },
    { ...view, camera: camera(), shade: false, cullBackFaces: false },
  );
  const painted = fills(out.svg);
  assert.ok(out.fragments >= 3, `split into ${out.fragments} fragments`);
  assert.ok(painted.some(reddish) && painted.some(greenish));
});

test('a single-sided triangle facing away from the camera is dropped; double-sided is kept', async () => {
  const away = { ...quad(0), indices: [0, 2, 1, 0, 3, 2] };
  const nodes = (material) => ({
    nodes: [
      { geometry: quad(0), material: mat(0, 1, 0) },
      { geometry: { ...away, positions: away.positions.map((x, i) => (i % 3 === 2 ? -0.5 : x)) }, material },
    ],
  });
  const one = await exportSceneSVG(nodes(mat(1, 0, 0)), { ...view, camera: camera(), shade: false });
  assert.ok(!fills(one.svg).some(reddish), 'the back face leaves no red');
  const two = await exportSceneSVG(nodes({ color: [1, 0, 0, 1], doubleSided: true }), {
    ...view,
    camera: camera(),
    shade: false,
  });
  assert.ok(fills(two.svg).some(reddish) || fills(two.svg).some(greenish));
  const kept = await exportSceneSVG(nodes(mat(1, 0, 0)), {
    ...view,
    camera: camera(),
    shade: false,
    cullBackFaces: false,
  });
  assert.ok(kept.triangles > one.triangles);
});

test('shading darkens a surface seen at a slant', async () => {
  const flat = await exportSceneSVG(
    { nodes: [{ geometry: quad(0), material: mat(1, 1, 1) }] },
    { ...view, camera: camera() },
  );
  const light = fills(flat.svg)[0][0];
  const cam = new Camera({ position: [4, 0, 4], target: [0, 0, 0] });
  const slant = await exportSceneSVG(
    { nodes: [{ geometry: quad(0), material: mat(1, 1, 1) }] },
    { ...view, camera: cam },
  );
  assert.ok(fills(slant.svg)[0][0] < light);
});

test('lines and points are drawn, and a matrix can stand in for the camera', async () => {
  const cam = camera();
  cam.update(1, true);
  const line = { positions: new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0]), indices: [0, 1, 1, 2] };
  const dot = { positions: new Float32Array([0, -1, 0]), indices: [0] };
  const scene = {
    nodes: [
      {
        primitives: [
          { geometry: line, mode: 'LINES', material: { color: [0, 0, 1, 1] } },
          { geometry: dot, mode: 'POINTS', material: { color: [1, 0, 0, 1] } },
        ],
      },
    ],
  };
  const out = await exportSceneSVG(scene, { ...view, camera: { matrix: cam.matrix }, background: '#fff' });
  const painted = fills(out.svg);
  assert.ok(
    painted.some(([r, g, b]) => b > r && b > g),
    'the line is blue',
  );
  assert.ok(painted.some(reddish), 'the point is red');
  assert.match(out.svg, /#fff/);
});

test('bad input is refused', async () => {
  const scene = { nodes: [{ geometry: quad(0), material: mat(1, 0, 0) }] };
  await assert.rejects(exportSceneSVG(scene, { ...view }), RangeError); // no camera
  await assert.rejects(exportSceneSVG(scene, { camera: camera(), width: 0, height: 10 }), RangeError);
  await assert.rejects(exportSceneSVG(scene, { camera: camera(), ...view, ambient: 2 }), RangeError);
  await assert.rejects(exportSceneSVG(scene, { camera: { matrix: [1, 2] }, ...view }), RangeError);
});
