import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RadianceCascade2D,
  evaluate2DGI,
  GILighting2D,
} from '../dist/gi.js';
import { Light2D } from '../dist/index.js';

test('RadianceCascade2D options validation and defaults', () => {
  const rc = new RadianceCascade2D();
  assert.equal(rc.cascades, 4);
  assert.equal(rc.baseRays, 4);
  assert.equal(rc.baseDistance, 16);
  assert.equal(rc.intervalRatio, 4);
  assert.equal(rc.angularRatio, 4);
  assert.equal(rc.bounces, 1);
  assert.equal(rc.albedo, 0.5);
  assert.equal(rc.intensity, 1.0);

  assert.throws(() => new RadianceCascade2D({ cascades: 0 }), /cascades must be an integer from 1 to 8/);
  assert.throws(() => new RadianceCascade2D({ cascades: 9 }), /cascades must be an integer from 1 to 8/);
  assert.throws(() => new RadianceCascade2D({ baseRays: 0 }), /baseRays must be an integer from 1 to 32/);
  assert.throws(() => new RadianceCascade2D({ baseDistance: 0 }), /baseDistance must be a positive number/);
  assert.throws(() => new RadianceCascade2D({ intervalRatio: 0.5 }), /intervalRatio must be greater than 1/);
  assert.throws(() => new RadianceCascade2D({ angularRatio: 0 }), /angularRatio must be an integer from 1 to 8/);
  assert.throws(() => new RadianceCascade2D({ bounces: -1 }), /bounces must be an integer from 0 to 4/);
  assert.throws(() => new RadianceCascade2D({ albedo: 1.5 }), /albedo must be from 0 to 1/);
  assert.throws(() => new RadianceCascade2D({ intensity: -0.5 }), /intensity must be a nonnegative number/);
});

test('Direct emissive sprite illumination', () => {
  const emitter = {
    x: 50,
    y: 50,
    radius: 10,
    color: [1, 0.5, 0.25],
    intensity: 2.0,
  };
  const scene = { emitters: [emitter] };
  const rc = new RadianceCascade2D({ cascades: 2, baseDistance: 64, bounces: 0 });

  // Point close to the emitter (x=40, y=50)
  const irrNear = rc.evaluateAt([40, 50], undefined, scene);
  assert.ok(irrNear[0] > 0, 'Red channel should be positive');
  assert.ok(irrNear[1] > 0, 'Green channel should be positive');
  assert.ok(irrNear[2] > 0, 'Blue channel should be positive');

  // Verify color proportions match emitter
  const ratioG = irrNear[1] / irrNear[0];
  const ratioB = irrNear[2] / irrNear[0];
  assert.ok(Math.abs(ratioG - 0.5) < 1e-3, `Green ratio should be 0.5, got ${ratioG}`);
  assert.ok(Math.abs(ratioB - 0.25) < 1e-3, `Blue ratio should be 0.25, got ${ratioB}`);

  // Point far away outside interval reach receives 0 radiance
  const irrFar = rc.evaluateAt([500, 500], undefined, scene);
  assert.deepEqual(irrFar, [0, 0, 0]);
});

test('Occlusion blocks direct light and casts GI shadows', () => {
  const emitter = {
    x: 80,
    y: 50,
    radius: 10,
    color: [1, 1, 1],
    intensity: 2.0,
  };
  // Vertical wall at x=50
  const wall = {
    shape: 'segment',
    from: [50, 0],
    to: [50, 100],
  };
  const scene = { emitters: [emitter], occluders: [wall] };
  const rc = new RadianceCascade2D({ cascades: 2, baseDistance: 64, bounces: 0 });

  // Point at (20, 50) is behind wall from emitter at (80, 50)
  const irrOccluded = rc.evaluateAt([20, 50], undefined, scene);
  assert.deepEqual(irrOccluded, [0, 0, 0], 'Behind wall with bounces=0 should be 0');

  // Point at (70, 50) has clear line of sight
  const irrVisible = rc.evaluateAt([70, 50], undefined, scene);
  assert.ok(irrVisible[0] > 0, 'Point in line of sight should receive light');
});

test('Diffuse bounce reflects light into occluded areas', () => {
  const emitter = {
    x: 70,
    y: 20,
    radius: 10,
    color: [1, 0.5, 0.2],
    intensity: 4.0,
  };
  const backWall = {
    shape: 'segment',
    from: [50, 0],
    to: [50, 100],
  };
  const partition = {
    shape: 'segment',
    from: [60, 50],
    to: [100, 50],
  };
  const scene = {
    emitters: [emitter],
    occluders: [backWall, partition],
  };

  // With bounces = 0: point at (70, 80) receives 0 light
  const rcNoBounce = new RadianceCascade2D({
    cascades: 2,
    baseDistance: 64,
    bounces: 0,
    albedo: 0.8,
  });
  const irrNoBounce = rcNoBounce.evaluateAt([70, 80], undefined, scene);
  assert.deepEqual(irrNoBounce, [0, 0, 0]);

  // With bounces = 1: point at (70, 80) receives indirect bounce light from backWall
  const rcBounce = new RadianceCascade2D({
    cascades: 2,
    baseDistance: 64,
    bounces: 1,
    albedo: 0.8,
  });
  const irrBounce = rcBounce.evaluateAt([70, 80], undefined, scene);
  assert.ok(irrBounce[0] > 0, `Bounce R should be positive, got ${irrBounce[0]}`);
  assert.ok(irrBounce[1] > 0, `Bounce G should be positive, got ${irrBounce[1]}`);
  assert.ok(irrBounce[2] > 0, `Bounce B should be positive, got ${irrBounce[2]}`);

  // Test higher albedo produces proportionally more bounce light
  const rcLowAlbedo = new RadianceCascade2D({
    cascades: 2,
    baseDistance: 64,
    bounces: 1,
    albedo: 0.4,
  });
  const irrLowAlbedo = rcLowAlbedo.evaluateAt([70, 80], undefined, scene);
  assert.ok(Math.abs(irrBounce[0] - irrLowAlbedo[0] * 2) < 1e-4, 'Bounce light should scale with albedo');
});

test('Surface normal cosine weighting', () => {
  const root2_2 = Math.cos(Math.PI / 4);
  const emitter = {
    x: 50 + 30 * root2_2,
    y: 50 + 30 * root2_2,
    radius: 10,
    color: [1, 1, 1],
    intensity: 1.0,
  };
  const scene = { emitters: [emitter] };
  const rc = new RadianceCascade2D({ cascades: 1, baseDistance: 100, bounces: 0 });

  // Normal pointing towards incoming light (+X, +Y direction, towards emitter)
  const irrFacing = rc.evaluateAt([50, 50], [1, 1], scene);
  // Normal pointing away from incoming light (-X, -Y direction)
  const irrBack = rc.evaluateAt([50, 50], [-1, -1], scene);

  assert.ok(irrFacing[0] > 0, 'Surface facing light receives positive irradiance');
  assert.equal(irrBack[0], 0, 'Surface facing away from light receives 0 irradiance');
});

test('computeGrid generates a 2D irradiance probe field', () => {
  const emitter = {
    x: 5,
    y: 5,
    radius: 3,
    color: [1, 1, 1],
    intensity: 2.0,
  };
  const scene = { emitters: [emitter] };
  const rc = new RadianceCascade2D({ cascades: 2, baseDistance: 16 });

  const grid = rc.computeGrid(8, 8, scene, 2);
  assert.equal(grid.length, 8 * 8 * 3);
  assert.ok(grid instanceof Float32Array);

  // Center cell (x=2, y=2 -> world [4, 4], close to emitter at [5, 5])
  const centerIdx = (2 * 8 + 2) * 3;
  assert.ok(grid[centerIdx] > 0, 'Center grid cell should be illuminated');

  // Edge cell (x=7, y=7 -> world [14, 14])
  const edgeIdx = (7 * 8 + 7) * 3;
  assert.ok(grid[centerIdx] > grid[edgeIdx], 'Center cell should be brighter than far edge cell');

  assert.throws(() => rc.computeGrid(0, 8), /Grid dimensions must be positive integers/);
  assert.throws(() => rc.computeGrid(8, -1), /Grid dimensions must be positive integers/);
});

test('GILighting2D plugin validation and WebGL2 rejection', () => {
  assert.throws(() => new GILighting2D({}), /target is required for GILighting2D/);

  const fakeTexture = { width: 256, height: 256, format: 'rgba8unorm' };
  const gi = new GILighting2D({ target: fakeTexture });

  assert.equal(gi.name.startsWith('gi-lighting2d-'), true);
  assert.equal(gi.order, 20);

  // WebGL2 engine refusal
  const fakeWebGLEngine = { backend: 'webgl2', frameGraph: { add: () => {} } };
  assert.throws(() => gi.setup(fakeWebGLEngine), /GILighting2D needs WebGPU/);

  // Dispose
  gi.dispose();
  assert.throws(() => gi.setup(fakeWebGLEngine), /GILighting2D disposed/);
});
