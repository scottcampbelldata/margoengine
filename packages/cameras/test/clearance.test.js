// The sight check: the three ways a shot camera was blocked (a trunk in the middle of the frame, ground between a long
// low lens and its subject, leaves across the lens) each fail it, and the choice that clears them is picked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearestShot, sightClearance } from '../dist/clearance.js';

const view = (position = [0, 1.7, 200], fov = 20) => ({
  position,
  target: [0, 2, 0],
  fov,
  subject: { centre: [0, 0, 0], width: 20, height: 8 },
});
const flat = () => 0;

test('open flat ground is clear', () => {
  const c = sightClearance(view(), { ground: flat });
  assert.equal(c.subject, 1);
  assert.equal(c.foreground, 0);
  assert.equal(c.lens, Infinity);
  assert.equal(c.clear, true);
  assert.equal(c.penalty, 0);
});

test('a trunk a few metres off the lens, mid frame, is not clear', () => {
  const trunk = { x: 0, z: 190, bottom: 0, top: 12, radius: 0.5 },
    c = sightClearance(view(), { ground: flat, occluders: [trunk] });
  assert.equal(c.clear, false);
  assert.ok(c.centre > 0.1, `centre ${c.centre}`);
  assert.ok(c.lens > 9 && c.lens < 10, `lens ${c.lens}`);
  // The same trunk off to the side, outside the frame, does not matter.
  assert.equal(sightClearance(view(), { occluders: [{ ...trunk, x: 20 }] }).clear, true);
});

test('rising ground between a low long lens and its subject hides it, and a lift clears it', () => {
  const bank = (x, z) => (z > 60 && z < 140 ? 5 : 0),
    low = sightClearance(view([0, 1.7, 297], 6), { ground: bank });
  assert.equal(low.subject, 0);
  assert.equal(low.clear, false);
  const picked = clearestShot([1.7, 4, 9, 15, 30], (h) => [view([0, h, 297], 6)], { ground: bank });
  assert.equal(picked.clearance.clear, true);
  assert.equal(picked.choice, 9, 'the lowest height that sees over the bank');
});

test('leaves across the lens fail the lens clearance even outside the middle', () => {
  const leaves = { x: 0.5, z: 197.5, bottom: 1.8, top: 3, radius: 0.4, opacity: 0.8 },
    c = sightClearance(view([0, 1.7, 200], 40), { ground: flat, occluders: [leaves] });
  assert.ok(c.lens < 4, `lens ${c.lens}`);
  assert.equal(c.clear, false);
});

test('a bare crown hides part, what stands inside the subject is the subject, buried cylinders hide nothing', () => {
  const crown = { x: 0, z: 100, bottom: 0, top: 30, radius: 15, opacity: 0.4 };
  const c = sightClearance(view(), { occluders: [crown] });
  assert.ok(Math.abs(c.subject - 0.6) < 1e-9, `subject ${c.subject}`);
  assert.equal(sightClearance(view(), { occluders: [{ ...crown, z: 0, radius: 9, opacity: 1 }] }).subject, 1);
  const buried = { x: 0, z: 190, bottom: -20, top: -10, radius: 1 };
  assert.equal(sightClearance(view(), { ground: flat, occluders: [buried] }).lens, Infinity);
});

test('a turn is taken before a lift, and the least bad choice answers when none is clear', () => {
  const occluders = [{ x: 0, z: 190, bottom: 0, top: 40, radius: 1 }],
    choices = [
      { x: 0, h: 1.7 },
      { x: 25, h: 1.7 },
      { x: 25, h: 20 },
    ],
    views = ({ x, h }) => [view([x, h, 200])];
  assert.deepEqual(clearestShot(choices, views, { occluders }).choice, choices[1]);
  const wall = { x: 0, z: 100, bottom: -100, top: 500, radius: 99 },
    none = clearestShot(choices, views, { occluders: [wall] });
  assert.equal(none.clearance.clear, false);
  assert.ok(none.choice);
});

test('bad input throws a RangeError with a help link', () => {
  const coded = (e) => e instanceof RangeError && /errors#camera-clearance/.test(e.message);
  assert.throws(() => sightClearance({ position: [0, 5, 0], target: [0, 0, 0], fov: 30 }), coded);
  assert.throws(() => sightClearance(view([0, 2, 100], 180)), coded);
  assert.throws(() => sightClearance(view(), { occluders: [{ x: 0, z: 0, bottom: 1, top: 0, radius: 1 }] }), coded);
  assert.throws(() => clearestShot([], () => [view()]), coded);
});
