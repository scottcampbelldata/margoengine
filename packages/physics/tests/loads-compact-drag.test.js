import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleHooks } from '../../../scripts/support/node-compat.mjs';

await moduleHooks([{ source: new URL('../src/', import.meta.url).href }]);
const { compactDragArea, compactDragGeometry, compactSpinTorque, compactWindLoad, emergedSilhouette } = await import(
  '../src/loads/compact-drag.ts'
);
const { boxSurface } = await import('../src/loads/buoyancy.ts');

const FRAME = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const IDENTITY = [0, 0, 0, 1];
const ZERO = [0, 0, 0];

function close(actual, expected, error = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= error, `got ${actual}, expected ${expected} ± ${error}`);
}

function boxGeometry(half) {
  return compactDragGeometry(
    8 * half[0] * half[1] * half[2],
    half.map((x) => x * Math.sqrt(5 / 3)),
    FRAME,
    boxSurface(half),
    half,
  );
}

test('SEA-12 clips the actual rotated box and evaluates the wind and point velocity at its area centroid', () => {
  const geometry = boxGeometry([0.5, 1, 1]);
  const rotation = [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)];
  const expectedHeight = Math.sqrt(2) / 3;
  const cut = emergedSilhouette(geometry, FRAME, rotation, 0, [1, 0, 0]);
  close(cut.fullArea, 4);
  close(cut.area, 2);
  close(cut.offset[1], expectedHeight);
  const calls = [];
  const wind = compactWindLoad(
    geometry,
    FRAME,
    rotation,
    0,
    [1, 0, 0],
    [0, 0, 4],
    ZERO,
    (position) => {
      calls.push(position);
      return { velocity: [2 + 3 * position[1], 0, 0], density: 2, temperature: 280 };
    },
    false,
    1.2,
  );
  assert.equal(calls.length, 1);
  close(calls[0][1], expectedHeight);
  close(wind.offset[1], expectedHeight);
  close(wind.force[0], 2.4 * (1 + 7 * expectedHeight) ** 2);
  close(wind.force[1], 0);
  close(wind.force[2], 0);
  assert.ok(calls[0][1] < Math.sqrt(2));
  assert.equal(
    compactWindLoad(geometry, FRAME, rotation, 2, ZERO, ZERO, ZERO, () => assert.fail('submerged'), false),
    undefined,
  );
});

test('SEA-12 elliptical silhouette gives analytic segment area and world centroid under heel', () => {
  const axes = [2, 1, 0.5];
  const s = Math.SQRT1_2;
  const rotation = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
  const worldFrame = [
    [s, s, 0],
    [-s, s, 0],
    [0, 0, 1],
  ];
  const geometry = compactDragGeometry((4 * Math.PI) / 3, axes, FRAME);
  const top = Math.sqrt(2.5);
  const cut = emergedSilhouette(geometry, worldFrame, rotation, top / 2, [0, 0, 1]);
  const segment = Math.PI / 3 - Math.sqrt(3) / 4;
  const y = (top * Math.sqrt(3)) / (4 * segment);
  close(cut.fullArea, 2 * Math.PI);
  close(cut.area, 2 * segment);
  close(cut.offset[0], 0.6 * y);
  close(cut.offset[1], y);
  close(cut.offset[2], 0);
  const tip = emergedSilhouette(geometry, worldFrame, rotation, top * (1 - 1e-10), [0, 0, 1]);
  assert.ok(tip.area > 0);
  assert.ok(tip.offset[1] <= top && tip.offset[1] >= top * (1 - 1e-10));
});

function boxesMesh(boxes) {
  const vertices = [],
    indices = [];
  for (const {
    half,
    centre: [ox, oy, oz],
    angle = 0,
  } of boxes) {
    const box = boxSurface(half);
    const count = vertices.length / 3;
    for (let i = 0; i < box.vertices.length; i += 3) {
      const [x, y, z] = box.vertices.slice(i, i + 3);
      vertices.push(
        ox + x,
        oy + y * Math.cos(angle) - z * Math.sin(angle),
        oz + y * Math.sin(angle) + z * Math.cos(angle),
      );
    }
    indices.push(...box.indices.map((index) => index + count));
  }
  return { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
}

test('SEA-12 mesh projection counts occluded and intersecting projections once', () => {
  const mesh = boxesMesh([
    { half: [0.5, 1, 1], centre: [-2, 0, 0] },
    { half: [0.5, 1, 1], centre: [2, 1, 1] },
  ]);
  const geometry = compactDragGeometry(8, [2, 1, 1], FRAME, mesh);
  const cut = emergedSilhouette(geometry, FRAME, IDENTITY, 0.5, [1, 0, 0]);
  // Two rectangles, with overlap subtracted. Emerged area is 1 + 3 − 0.5.
  close(geometry.areas[0], 7);
  close(cut.fullArea, 7);
  close(cut.area, 3.5);
  close(cut.offset[1], 4.125 / 3.5);
  close(cut.offset[2], 2.75 / 3.5);

  const crossed = boxesMesh([
    { half: [0.5, 1.5, 0.5], centre: [-2, 0, 0], angle: Math.PI / 4 },
    { half: [0.5, 1.5, 0.5], centre: [2, 0, 0], angle: (3 * Math.PI) / 4 },
  ]);
  const rotated = compactDragGeometry(6, [2, 1, 1], FRAME, crossed);
  const clipped = emergedSilhouette(rotated, FRAME, IDENTITY, 0, [1, 0, 0]);
  close(clipped.fullArea, 5);
  close(clipped.area, 2.5);
  close(clipped.offset[2], 0);
});

test('SEA-12 box drag improves over fixed unity on the independent Khan cube wake measurements', (context) => {
  const cube = boxGeometry([0.5, 0.5, 0.5]);
  const bar = boxGeometry([2, 1, 0.5]);
  assert.deepEqual(bar.areas, [2, 4, 8]);
  close(cube.sphericity, (Math.PI * (6 / Math.PI) ** (2 / 3)) / 6);
  // Khan, Sooraj, Sharma and Agrawal (2018), Figure 15 inset, white square markers of
  // the modified wake survey. Digitized at 1829 px image width, axes x=(459,753) for
  // Re=(10³,10⁴) and y=(114,289) for Cd=(1,0.6); no values are inputs to the model.
  // https://doi.org/10.1016/j.expthermflusci.2017.12.013
  const centers = [
    [373, 269],
    [427, 215],
    [459, 164],
    [489, 183],
    [512, 217],
    [529, 245],
    [546, 243],
    [559, 252],
    [571, 262],
    [582, 267],
    [674, 275],
    [743, 262],
    [836, 250],
    [886, 261],
    [926, 247],
    [953, 256],
  ];
  const nu = 1e-6;
  let corrected = 0,
    old = 0,
    values = 0,
    maxError = 0;
  for (const [x, y] of centers) {
    const reEdge = 1000 * 10 ** ((x - 459) / 294);
    const measured = 1 + (114 - y) / 437.5;
    const cd = compactDragArea(cube, reEdge * nu, nu, 1, false, undefined, 0);
    corrected += (cd - measured) ** 2;
    old += (1 - measured) ** 2;
    values += measured * measured;
    maxError = Math.max(maxError, Math.abs(cd - measured));
  }
  const rms = (sum) => Math.sqrt(sum / centers.length);
  // The paper gives up to 7% uncertainty. Allow another 0.005 Cd for two-pixel digitization
  // error, and compare the model and fixed-unity residuals under opposing perturbations.
  const observationError = 0.07 * rms(values) + 0.005;
  assert.ok(rms(corrected) + 2 * observationError < rms(old));
  context.diagnostic(JSON.stringify({ rms: rms(corrected), fixedUnityRms: rms(old), maxError }));
  assert.equal(compactDragArea(bar, 0.001, nu, bar.areas[2], false, 0.25), 2);
});

test('SEA-12 spin uses the Jeffery/Stokes and Dennis rotating-sphere laws without translational Cd', () => {
  const radius = 0.05;
  const waterDensity = 1000;
  const nu = 1e-6;
  const ball = compactDragGeometry((4 * Math.PI * radius ** 3) / 3, [radius, radius, radius], FRAME);
  const low = 1e-8;
  const stokes = -8 * Math.PI * waterDensity * nu * radius ** 3 * low;
  close(compactSpinTorque(ball, 0, low, 1, waterDensity, nu) / stokes, 1, 1e-9);
  const spin = (20 * nu) / (radius * radius);
  // Dennis et al. Table 3, R=20: dimensionless torque M=3.048.
  const expected = 0.5 * waterDensity * radius ** 5 * spin ** 2 * 3.048;
  close(compactSpinTorque(ball, 1, spin, 1, waterDensity, nu), -expected, 1e-15);
  close(compactSpinTorque(ball, 1, -spin, 0.5, waterDensity, nu), expected / 2, 1e-15);
  assert.equal(compactSpinTorque(ball, 2, spin, 1, waterDensity, nu, 0), 0);
});
