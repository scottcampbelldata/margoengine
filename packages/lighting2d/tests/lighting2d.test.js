// Node checks of @margoengine/lighting2d: the CPU light against hand-worked values, the shadow test, occluder edges, errors.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tileMapColliders } from '../../physics2d/dist/index.js';
import { inShadow, Light2D, lightAt, Lighting2D, occluderEdges } from '../dist/index.js';

const near = (actual, expected, label) => {
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[i] - expected[i]) < 1e-9, `${label}: ${actual} vs ${expected}`);
};

test('a point light falls off as (1 - distance / radius) ^ falloff, times the cosine to the surface', () => {
  const light = new Light2D({ x: 0, y: 0, radius: 10, falloff: 2, height: 0.0001 });
  // Height 3, distance 4: the way to the light is 5 long, so a flat surface gets 3 / 5.
  const lit = new Light2D({ x: 4, y: 0, radius: 8, falloff: 2, height: 3 });
  near(lightAt(lit, 0, 0), [0.25 * 0.6, 0.25 * 0.6, 0.25 * 0.6], 'worked by hand');
  // A normal turned towards the light gets the rest of the cosine: (0.8, 0, 0.6) is the way to it, cosine 1.
  near(lightAt(lit, 0, 0, [0.8, 0, 0.6]), [0.25, 0.25, 0.25], 'facing the light');
  // A normal turned away gets nothing.
  near(lightAt(lit, 0, 0, [-1, 0, 0]), [0, 0, 0], 'facing away');
  // Past the radius nothing arrives, and a normal need not be unit length.
  near(lightAt(light, 11, 0), [0, 0, 0], 'past the radius');
  near(lightAt(lit, 0, 0, [8, 0, 6]), [0.25, 0.25, 0.25], 'normalised');
});

test('y runs down the screen, in the position and the normal alike', () => {
  const below = new Light2D({ x: 0, y: 4, radius: 8, falloff: 1, height: 3 });
  near(lightAt(below, 0, 0, [0, 0.8, 0.6]), [0.5, 0.5, 0.5], 'a normal down the screen faces a light below');
  near(lightAt(below, 0, 0, [0, -1, 0]), [0, 0, 0], 'a normal up the screen faces away');
});

test('colour and intensity scale the result', () => {
  const light = new Light2D({ x: 0, y: 0, height: 1, color: '#ff0000', intensity: 2 });
  near(lightAt(light, 0, 0), [2, 0, 0], 'at the light, straight above');
});

test('a light with no height over its own spot does not divide by zero', () => {
  near(lightAt(new Light2D({ x: 1, y: 1, height: 0 }), 1, 1), [1, 1, 1], 'the surface faces it by definition');
  near(lightAt(new Light2D({ x: 1, y: 1, height: 0 }), 5, 1), [0, 0, 0], 'a flat surface grazed by the light');
});

test('a spot lights its cone only, with a hard or fading edge', () => {
  const hard = new Light2D({
    kind: 'spot',
    x: 0,
    y: 0,
    angle: 0,
    cone: Math.PI / 4,
    radius: 100,
    falloff: 1,
    height: 0,
  });
  // Points on the +x axis are in the cone; on the +y axis they are out. A flat surface at height 0 gets nothing, so turn
  // the normal to the light.
  const toLight = (x, y) => [-x, -y, 0];
  assert.ok(lightAt(hard, 10, 0, toLight(10, 0))[0] > 0.8, 'inside');
  assert.equal(lightAt(hard, 0, 10, toLight(0, 10))[0], 0, 'outside');
  assert.equal(lightAt(hard, -10, 0, toLight(-10, 0))[0], 0, 'behind');
  const soft = new Light2D({ ...hard, softness: 1 });
  // Softness 1: strength runs from the axis (1) to the edge (0) by the cosine.
  const c = Math.cos(Math.PI / 8),
    edge = Math.cos(Math.PI / 4),
    at = [10 * Math.cos(Math.PI / 8), 10 * Math.sin(Math.PI / 8)],
    value = lightAt(soft, at[0], at[1], toLight(at[0], at[1]))[0];
  assert.ok(Math.abs(value - 0.9 * ((c - edge) / (1 - edge))) < 1e-9, `${value}`);
});

test('a directional light has no falloff and comes from where it does not shine', () => {
  const light = new Light2D({ kind: 'directional', angle: 0, elevation: Math.PI / 6 });
  // Shining towards +x at 30 degrees: flat surfaces get sin 30.
  near(lightAt(light, 1000, -1000), [0.5, 0.5, 0.5], 'flat');
  const c = Math.cos(Math.PI / 6);
  near(lightAt(light, 0, 0, [-c, 0, 0.5]), [1, 1, 1], 'facing it');
});

test('occluder edges: each shape as its edges', () => {
  assert.deepEqual([...occluderEdges([{ shape: 'segment', from: [1, 2], to: [3, 4] }])], [1, 2, 3, 4]);
  assert.deepEqual(
    [
      ...occluderEdges([
        {
          shape: 'polyline',
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
      ]),
    ],
    [0, 0, 1, 0, 1, 0, 1, 1],
  );
  assert.deepEqual(
    [
      ...occluderEdges([
        {
          shape: 'polygon',
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
      ]),
    ],
    [0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0],
  );
  assert.deepEqual(
    [...occluderEdges([{ shape: 'box', width: 2, height: 4, offset: [10, 20] }])],
    [9, 18, 11, 18, 11, 18, 11, 22, 11, 22, 9, 22, 9, 22, 9, 18],
  );
  const turned = occluderEdges([{ shape: 'box', width: 2, height: 2, rotation: Math.PI / 2 }]);
  assert.ok(Math.abs(turned[0] - 1) < 1e-6 && Math.abs(turned[1] + 1) < 1e-6, `${turned[0]}, ${turned[1]}`);
  const circle = occluderEdges([{ shape: 'circle', radius: 5, offset: [1, 1] }]);
  assert.equal(circle.length, 24 * 4);
  assert.ok(Math.abs(circle[0] - 6) < 1e-6 && Math.abs(circle[1] - 1) < 1e-6);
  assert.throws(() => occluderEdges([{ shape: 'capsule' }]), RangeError);
  assert.throws(() => occluderEdges([{ shape: 'segment', from: [0, NaN], to: [1, 1] }]), RangeError);
});

test('a tile map shadows through the collider list from physics2d, every tile shape included', () => {
  const collision = (id, shape) => ({ id, collision: [shape] }),
    map = {
      tileWidth: 16,
      tileHeight: 16,
      tilesets: [
        {
          firstGid: 1,
          tileCount: 5,
          tileWidth: 16,
          tileHeight: 16,
          tiles: [
            { id: 0, properties: { solid: true } },
            collision(1, { kind: 'rect', x: 2, y: 2, width: 4, height: 4 }),
            collision(2, { kind: 'ellipse', x: 2, y: 2, width: 8, height: 4 }),
            collision(3, {
              kind: 'polygon',
              x: 0,
              y: 0,
              points: [
                [0, 0],
                [8, 0],
                [0, 8],
              ],
            }),
            collision(4, {
              kind: 'polyline',
              x: 0,
              y: 0,
              points: [
                [0, 0],
                [8, 8],
              ],
            }),
          ],
        },
      ],
      layers: [{ type: 'tile', name: 'walls', width: 6, height: 1, data: new Uint32Array([1, 0, 2, 3, 4, 5]) }],
    },
    edges = occluderEdges(tileMapColliders(map)),
    light = new Light2D({ x: 8, y: -16 });
  assert.ok(edges.length >= 5 * 4, `${edges.length / 4} edges`);
  // The solid cell runs from x 0 to 16 and y 0 to 16: its top edge stands between the light and a point straight below.
  assert.equal(inShadow(light, edges, 8, 32), true, 'below the solid tile');
  assert.equal(inShadow(light, edges, 8, -8), false, 'above it');
});

test('in shadow means an edge lies between the point and the light', () => {
  const wall = occluderEdges([{ shape: 'segment', from: [5, -5], to: [5, 5] }]),
    light = new Light2D({ x: 0, y: 0 });
  assert.equal(inShadow(light, wall, 10, 0), true, 'behind the wall');
  assert.equal(inShadow(light, wall, 4, 0), false, 'before the wall');
  assert.equal(inShadow(light, wall, -10, 0), false, 'behind the light');
  assert.equal(inShadow(light, wall, 10, 11), false, 'past its end: the ray crosses x = 5 at y = 5.5');
  assert.equal(inShadow(light, wall, 10, 9), true, 'inside the wedge: the ray crosses x = 5 at y = 4.5');
  assert.equal(inShadow(new Light2D({ x: 0, y: 0, shadows: false }), wall, 10, 0), false, 'shadows off');
  const sun = new Light2D({ kind: 'directional', angle: 0 });
  assert.equal(inShadow(sun, wall, 100, 0), true, 'a far light shadows everything down the way it shines');
  assert.equal(inShadow(sun, wall, 4, 0), false, 'and nothing before the wall');
  assert.equal(inShadow(sun, wall, 100, 6), false, 'a far light keeps the wall its own width');
});

test('invalid values throw with their fix on the help page', () => {
  for (const bad of [
    { kind: 'area' },
    { x: NaN },
    { intensity: -1 },
    { radius: 0 },
    { falloff: 0 },
    { height: -1 },
    { cone: 0 },
    { softness: 2 },
    { color: 'red' },
    { elevation: Infinity },
  ])
    assert.throws(
      () => new Light2D(bad),
      { name: 'RangeError', message: /errors#pixel-lighting/ },
      JSON.stringify(bad),
    );
  assert.throws(() => new Lighting2D({}), { name: 'TypeError', message: /errors#pixel-lighting/ });
  assert.throws(() => new Lighting2D({ target: {}, order: NaN }), RangeError);
});

test('lights come and go, and a disposed plugin refuses to attach', () => {
  const lighting = new Lighting2D({ target: {} }),
    a = lighting.addLight(),
    b = lighting.addLight({ x: 1 });
  assert.deepEqual(lighting.lights, [a, b]);
  lighting.removeLight(a);
  lighting.removeLight(a);
  assert.deepEqual(lighting.lights, [b]);
  lighting.dispose();
  assert.throws(() => lighting.setup({ backend: 'webgpu' }), { name: 'MargoError', code: 'disposed' });
  assert.throws(() => new Lighting2D({ target: {} }).setup({ backend: 'webgl2' }), {
    name: 'MargoError',
    code: 'unsupported',
  });
});
