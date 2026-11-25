// What the 2D debug render adds to shapes, joints, contacts and boxes: each body's axes, the solver's contacts apart from the touching
// ones, colours by kind, and a filter that leaves bodies out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();
const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);

function scene() {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, -10] });
  const floor = physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5],
    colliders: { shape: 'box', width: 20, height: 1 },
  });
  const crate = physics.addBody(null, {
    position: [0, 0.5],
    canSleep: false,
    colliders: { shape: 'box', width: 1, height: 1 },
  });
  const zone = physics.addBody(null, {
    type: 'fixed',
    position: [5, 0.5],
    colliders: { shape: 'box', width: 2, height: 2, sensor: true },
  });
  for (let i = 0; i < 60; i++) physics.step();
  return { physics, floor, crate, zone };
}
const count = (lines, code) => lines.colors.filter((c) => c === code).length;

test('axes draw two lines a body, from its centre of mass along its own x and y', () => {
  const { physics, crate } = scene();
  const lines = physics.debugRender({ axes: true });
  assert.equal(count(lines, 9), 3, 'one x axis for each of the three bodies');
  assert.equal(count(lines, 10), 3);
  assert.equal(lines.colors.length, 6, 'and nothing else when only axes are asked');
  const i = lines.colors.findIndex(
    (c, n) =>
      c === 9 &&
      Math.abs(lines.vertices[4 * n] - crate.position[0]) < 1e-3 &&
      Math.abs(lines.vertices[4 * n + 1] - crate.position[1]) < 1e-3,
  );
  assert.ok(i >= 0, "the crate's x axis starts at its centre");
  near(lines.vertices[4 * i + 2] - lines.vertices[4 * i], 0.5, 1e-3, 'half a metre long, along x for an unturned body');
});

test("solver contacts are drawn on their own, and a sensor's overlap is not one", () => {
  const { physics } = scene();
  const solver = physics.debugRender({ solverContacts: true });
  assert.ok(count(solver, 11) >= 2 && count(solver, 12) >= 1, 'the crate on the floor: points and a normal');
  assert.equal(count(solver, 6) + count(solver, 7), 0, 'none of the touching-contact kind');
  const touching = physics.debugRender({ contacts: true });
  assert.ok(count(touching, 6) > 0 && count(touching, 11) === 0);
});

test('a style gives the colour of each kind, and the default is a palette', () => {
  const { physics } = scene();
  const lines = physics.debugRender({ shapes: true, style: { sensor: [0, 0, 1, 0.5] } });
  const sensor = lines.colors.indexOf(4);
  assert.deepEqual([...lines.rgba.subarray(4 * sensor, 4 * sensor + 4)], [0, 0, 1, 0.5], "the style's colour");
  const awake = lines.colors.indexOf(1);
  assert.deepEqual(
    [...lines.rgba.subarray(4 * awake, 4 * awake + 3)].map((v) => +v.toFixed(2)),
    [0.2, 0.9, 0.3],
    'the default green for a body that moves',
  );
  assert.equal(lines.rgba.length, 4 * lines.colors.length);
});

test('a filter leaves out every line of the bodies it rejects', () => {
  const { physics, floor, crate, zone } = scene();
  const without = physics.debugRender({ filter: (body) => body !== crate });
  const everything = physics.debugRender();
  assert.ok(without.colors.length < everything.colors.length);
  assert.equal(count(without, 1), 0, 'no outline of the awake crate');
  assert.equal(count(without, 6) + count(without, 7), 0, 'and none of its contacts');
  assert.ok(count(without, 0) > 0 && count(without, 4) > 0, 'the floor and the zone stay');
  const only = physics.debugRender({ axes: true, filter: (body) => body === zone });
  assert.equal(only.colors.length, 2);
  void floor;
});
