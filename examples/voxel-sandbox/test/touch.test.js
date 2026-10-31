import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEAD_ZONE,
  hotbarWindow,
  pressKind,
  slotsThatFit,
  STICK_RADIUS,
  stickKeys,
  stickVector,
  swipedSlot,
} from '../src/touch.ts';

test('the stick does nothing inside its dead zone', () => {
  const inside = STICK_RADIUS * DEAD_ZONE * 0.99;
  assert.deepEqual(stickVector(0, 0), { x: 0, y: 0 });
  assert.deepEqual(stickVector(inside, 0), { x: 0, y: 0 });
  assert.deepEqual(stickVector(0, -inside), { x: 0, y: 0 });
  assert.ok(stickVector(STICK_RADIUS * DEAD_ZONE * 1.1, 0).x > 0);
});

test('the stick reaches 1 at its radius, stays there past it, and keeps the drag direction', () => {
  assert.equal(stickVector(STICK_RADIUS, 0).x, 1);
  assert.equal(stickVector(STICK_RADIUS * 3, 0).x, 1);
  // Screen up is forward.
  assert.equal(stickVector(0, -STICK_RADIUS).y, 1);
  assert.equal(stickVector(0, STICK_RADIUS).y, -1);
  const { x, y } = stickVector(STICK_RADIUS, -STICK_RADIUS);
  assert.ok(Math.abs(Math.hypot(x, y) - 1) < 1e-9);
  assert.ok(Math.abs(x - y) < 1e-9);
  // Halfway through the live travel is half strength.
  const half = STICK_RADIUS * (DEAD_ZONE + (1 - DEAD_ZONE) / 2);
  assert.ok(Math.abs(stickVector(half, 0).x - 0.5) < 1e-9);
});

test('the stick holds keys in eight directions', () => {
  assert.deepEqual(stickKeys(0, 0), []);
  assert.deepEqual(stickKeys(0, 1), ['KeyW']);
  assert.deepEqual(stickKeys(0, -1), ['KeyS']);
  assert.deepEqual(stickKeys(1, 0), ['KeyD']);
  assert.deepEqual(stickKeys(-1, 0), ['KeyA']);
  assert.deepEqual(stickKeys(0.7, 0.7), ['KeyW', 'KeyD']);
  assert.deepEqual(stickKeys(-0.7, -0.7), ['KeyS', 'KeyA']);
  // A weak push counts as much as a strong one: the direction decides.
  assert.deepEqual(stickKeys(0, 0.05), ['KeyW']);
  // Nearly straight ahead holds one key.
  assert.deepEqual(stickKeys(0.2, 1), ['KeyW']);
});

test('a press is a tap, a hold or a drag', () => {
  assert.equal(pressKind(100, 2), 'tap');
  assert.equal(pressKind(399, 0), 'tap');
  assert.equal(pressKind(400, 0), 'hold');
  assert.equal(pressKind(100, 40), 'drag');
  assert.equal(pressKind(900, 40), 'drag');
});

test('the hotbar shows a run of slots around the selected one, moved inward at the ends', () => {
  assert.deepEqual(hotbarWindow(4, 9, 9), [0, 8]);
  assert.deepEqual(hotbarWindow(0, 9, 7), [0, 6]);
  assert.deepEqual(hotbarWindow(8, 9, 7), [2, 8]);
  assert.deepEqual(hotbarWindow(4, 9, 7), [1, 7]);
  assert.deepEqual(hotbarWindow(4, 9, 20), [0, 8]);
});

test('44 px slots fit a phone without a horizontal scroll', () => {
  for (const width of [320, 360, 390, 412, 844]) {
    const fit = slotsThatFit(width);
    assert.ok(fit * 44 + (fit - 1) * 2 + 8 <= width - 16, `${fit} slots at ${width} px`);
    assert.ok(fit >= 5, `${fit} slots at ${width} px`);
  }
  assert.equal(slotsThatFit(844), 9);
});

test('a hotbar swipe moves one slot per 44 px and stops at the ends', () => {
  assert.equal(swipedSlot(4, 0, 9), 4);
  assert.equal(swipedSlot(4, -44, 9), 5);
  assert.equal(swipedSlot(4, 88, 9), 2);
  assert.equal(swipedSlot(0, 440, 9), 0);
  assert.equal(swipedSlot(8, -440, 9), 8);
});
