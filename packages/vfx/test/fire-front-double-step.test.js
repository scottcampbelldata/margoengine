// A FireFront run by an engine and also stepped with advanceTime between its frames burns faster than the engine clock
// (KB-LOOK-TV-SHIMMER2: the timber-valley shot page called scene.advanceTime each sub-frame, so the fire spread at twice
// the shot's speed). The front refuses a doubled clock with a coded error, and still takes one burst of steps between
// frames (rolling its past) and a seek after resetTime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FireFront } from '../dist/fire-front.js';

// An engine with no GPU: the front's setup keeps it and draws nothing; its frames are onPreUpdate calls.
const running = () => {
  const front = FireFront.create({
    size: [400, 400],
    cell: 10,
    seed: 5,
    wind: [6, 2],
    ignitions: [{ at: [0, 0] }],
    columns: 0,
    flames: 0,
    buildingFlames: 0,
  });
  front.setup({ use: () => {} });
  return front;
};

test('regression KB-LOOK-TV-SHIMMER2: an engine-run fire also stepped every frame throws a state error', () => {
  const front = running(),
    frame = () => {
      // The page's own step, then the engine's frame.
      front.advanceTime(1 / 30);
      front.onPreUpdate(1 / 30);
    };
  frame();
  assert.throws(
    () => {
      frame();
      frame();
    },
    (error) => error.code === 'state' && /stepped with advanceTime between engine frames/.test(error.message),
  );
});

test("the engine's own steps, one burst between frames and a seek after resetTime are allowed", () => {
  const front = running();
  for (let i = 0; i < 20; i++) front.onPreUpdate(1 / 30);
  for (let i = 0; i < 30; i++) front.advanceTime(10); // its past, rolled once
  for (let i = 0; i < 20; i++) front.onPreUpdate(1 / 30);
  for (let f = 0; f < 5; f++) {
    front.resetTime();
    for (let i = 0; i < 4; i++) front.advanceTime(0.5);
    front.onPreUpdate(1 / 30);
  }
  assert.ok(front.time > 0);
  // Without an engine nothing counts: a front stepped by hand is the only clock.
  const alone = FireFront.create({ size: [400, 400], cell: 10, ignitions: [{ at: [0, 0] }] });
  for (let i = 0; i < 10; i++) alone.advanceTime(1 / 30);
});
