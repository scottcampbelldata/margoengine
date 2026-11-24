import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../dist/index.js';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} vs ${b}`);

test('replaying a finished yoyo timeline runs forward with its full repeat budget again', () => {
  const o = { x: 0 };
  let done = 0;
  const timeline = new Timeline({ repeat: 1, yoyo: true, onComplete: () => done++ }).to(o, 'x', 10, { duration: 1 }).play();
  timeline.update(1);
  near(o.x, 10);
  timeline.update(1);
  near(o.x, 0);
  assert.equal(done, 1);
  timeline.play();
  timeline.update(0.25);
  near(o.x, 2.5);
  timeline.update(0.75);
  near(o.x, 10);
  assert.equal(done, 1);
  timeline.update(1);
  near(o.x, 0);
  assert.equal(done, 2);
});
