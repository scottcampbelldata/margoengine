import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HeightLight2D,
  checkHeightOccluder,
  createHeightOccluder,
  inHeightShadow,
  heightShadowFactor,
  heightLightAt,
  HeightLighting2D,
} from '../dist/height.js';

test('checkHeightOccluder validates shape, dimensions and heights', () => {
  const box = createHeightOccluder({
    shape: 'box',
    height: 16,
    elevation: 0,
    width: 20,
    depth: 10,
    offset: [5, 5],
  });
  assert.equal(box.shape, 'box');
  assert.equal(box.height, 16);
  assert.equal(box.width, 20);
  assert.equal(box.depth, 10);
  assert.deepEqual(box.offset, [5, 5]);

  const circle = createHeightOccluder({
    shape: 'circle',
    height: 12,
    radius: 6,
    offset: [0, 0],
  });
  assert.equal(circle.shape, 'circle');
  assert.equal(circle.radius, 6);

  const segment = createHeightOccluder({
    shape: 'segment',
    height: 8,
    offset: [0, 0],
    to: [10, 0],
  });
  assert.equal(segment.shape, 'segment');
  assert.deepEqual(segment.to, [10, 0]);

  assert.throws(() => checkHeightOccluder({ shape: 'triangle', height: 10 }), /Unknown occluder shape/);
  assert.throws(() => checkHeightOccluder({ shape: 'box', height: -5 }), /Invalid occluder height/);
  assert.throws(() => checkHeightOccluder({ shape: 'box', height: 10, width: -2 }), /Invalid box dimensions/);
  assert.throws(() => checkHeightOccluder({ shape: 'circle', height: 10, radius: 0 }), /Invalid circle radius/);
});

test('HeightLight2D inherits Light2D with top-down defaults', () => {
  const light = new HeightLight2D({
    x: 10,
    y: 20,
    height: 48,
    color: '#ffaa00',
    intensity: 1.5,
  });
  assert.equal(light.x, 10);
  assert.equal(light.y, 20);
  assert.equal(light.height, 48);
  assert.equal(light.color, '#ffaa00');
  assert.equal(light.intensity, 1.5);
  assert.equal(light.shadows, true);
});

test('Point light casts height shadows based on light elevation and occluder height', () => {
  // Light at (0, 0) with height 20.
  // Box occluder centered at (0, 0) with width 10, depth 10 (bounds [-5, 5] in x and y), height 10, elevation 0.
  const light = new HeightLight2D({
    x: 0,
    y: 0,
    height: 20,
    radius: 100,
  });
  const occluder = createHeightOccluder({
    shape: 'box',
    offset: [0, 0],
    width: 10,
    depth: 10,
    height: 10,
    elevation: 0,
  });

  // At receiver (7.5, 0) on ground (z=0):
  // Ray towards light at (0, 0, 20) enters box at x=5 (distance 2.5 of 7.5).
  // Ray height at x=5 is (2.5 / 7.5) * 20 = 6.67 < 10 -> in shadow!
  assert.equal(inHeightShadow(light, [occluder], 7.5, 0, 0), true);
  assert.equal(heightShadowFactor(light, [occluder], 7.5, 0, 0), 0);

  // At receiver (15, 0) on ground (z=0):
  // Ray towards light at (0, 0, 20) enters box at x=5 (distance 10 of 15).
  // Ray height at x=5 is (10 / 15) * 20 = 13.33 > 10 -> light shines over the box!
  assert.equal(inHeightShadow(light, [occluder], 15, 0, 0), false);
  assert.equal(heightShadowFactor(light, [occluder], 15, 0, 0), 1);

  // Receiver on top of the roof at (0, 0, 10):
  // Light is at (0, 0, 20). Point is at z=10. Not in shadow from itself!
  assert.equal(inHeightShadow(light, [occluder], 0, 0, 10), false);
});

test('Directional light casts top-down shadows with length proportional to height', () => {
  // Directional light with elevation PI / 4 (45 degrees, tan = 1).
  // Shining towards +x (angle = 0, so light comes from -x).
  const sun = new HeightLight2D({
    kind: 'directional',
    angle: 0,
    elevation: Math.PI / 4,
    color: '#ffffff',
  });

  // Box occluder from x=-5 to x=5 with height 10, elevation 0.
  const wall = createHeightOccluder({
    shape: 'box',
    offset: [0, 0],
    width: 10,
    depth: 20,
    height: 10,
    elevation: 0,
  });

  // Receiver on ground at x=10 (behind the wall relative to light):
  // Distance from wall edge at x=5 to receiver is 5.
  // Ray heading towards sun (in -x direction) hits wall at x=5 with height 5 * tan(45 deg) = 5 <= 10.
  // In shadow!
  assert.equal(inHeightShadow(sun, [wall], 10, 0, 0), true);

  // Receiver on ground at x=20 (farther behind wall):
  // Distance from wall edge at x=5 is 15.
  // Ray height at x=5 is 15 > 10.
  // Lit!
  assert.equal(inHeightShadow(sun, [wall], 20, 0, 0), false);
});

test('Self-shadowing handles walls and roofs correctly', () => {
  const sun = new HeightLight2D({
    kind: 'directional',
    angle: 0,
    elevation: Math.PI / 4,
  });

  const pillar = createHeightOccluder({
    shape: 'circle',
    offset: [0, 0],
    radius: 10,
    height: 20,
    elevation: 0,
    selfShadow: true,
  });

  // Receiver at ground level z=0 inside the pillar footprint:
  // With selfShadow: true, it is shadowed by the pillar's own height.
  assert.equal(inHeightShadow(sun, [pillar], 0, 0, 0), true);

  // Receiver on the pillar roof at elevation z=20:
  // Not shadowed by the pillar!
  assert.equal(inHeightShadow(sun, [pillar], 0, 0, 20), false);

  // With selfShadow: false:
  const noSelf = createHeightOccluder({
    shape: 'circle',
    offset: [0, 0],
    radius: 10,
    height: 20,
    elevation: 0,
    selfShadow: false,
  });
  assert.equal(inHeightShadow(sun, [noSelf], 0, 0, 0), false);
});

test('heightLightAt computes direct shading attenuated by height shadows', () => {
  const light = new HeightLight2D({
    x: 0,
    y: 0,
    height: 32,
    color: '#ffffff',
    intensity: 1.0,
    radius: 64,
  });
  const occluder = createHeightOccluder({
    shape: 'box',
    offset: [0, 0],
    width: 10,
    depth: 10,
    height: 16,
  });

  // Lit point outside shadow
  const litColor = heightLightAt(light, [occluder], 25, 0, 0);
  assert.ok(litColor[0] > 0);
  assert.equal(litColor[0], litColor[1]);
  assert.equal(litColor[1], litColor[2]);

  // Point in shadow
  const shadowColor = heightLightAt(light, [occluder], 8, 0, 0);
  assert.deepEqual(shadowColor, [0, 0, 0]);
});

test('HeightLighting2D lifecycle and WebGL2 rejection', () => {
  const plugin = new HeightLighting2D();
  const light = plugin.addLight({ x: 5, y: 10, height: 20 });
  assert.ok(light instanceof HeightLight2D);
  assert.equal(plugin.removeLight(light), true);

  // WebGL2 mock refusal
  const mockWebgl = {
    backend: 'webgl2',
    gpu: null,
  };
  const mockKernel = {
    [Symbol.for('margo.engine')]: mockWebgl,
  };
  assert.throws(
    () => HeightLighting2D.attach(mockKernel, {}),
    /WebGL2 is not supported for @margoengine\/lighting2d\/height; use WebGPU/,
  );

  plugin[Symbol.dispose]();
  assert.throws(() => plugin.addLight(), /HeightLighting2D has been disposed/);
});
