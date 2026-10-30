// Regression: the flythrough check's slow-machine flight counted time the page thread did not run inside the check's
// own busy waits as the view's work. On an Intel Arc 140V laptop the thread stopped 2.9 ms inside the wait that stood
// for a 16 kB r32float write's cost; the frame read 4.0 ms against the 3.5 ms limit (2 ms sends plus 1.5 ms) though the
// view's work was about 1.1 ms. The clock leaves such a stop out, and nothing else: time lost in the view's own code or
// inside a real write still counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOCK_STEP, STALL_MS, stallClock } from './flythrough-clock.mjs';

const LIMIT = 2 + 1.5;

/** A fake performance.now: each read moves 1 microsecond; `after(n, ms)` makes the n-th read from now jump ms more. */
function fakeNow() {
  let t = 0,
    reads = 0;
  const jumps = new Map(),
    now = () => {
      reads++;
      t += 0.001 + (jumps.get(reads) ?? 0);
      return t;
    };
  now.after = (n, ms) => jumps.set(reads + n, ms);
  now.pass = (ms) => {
    t += ms;
  };
  return now;
}

test('frame 77 on the Arc laptop: a 2.9 ms stop inside the r32float wait is not view time', () => {
  const now = fakeNow(),
    clock = stallClock(now),
    frame = clock.time(() => {
      now.pass(0.1); // 15 objects steps
      now.after(5, 2.9); // the thread stops inside the wait for the r32float write's cost
      clock.wait(0.32); // 16 kB at 0.02 ms per kB
      now.pass(0.0); // the r32float write itself
      for (let i = 0; i < 2; i++) {
        clock.wait(0.32); // two 16 kB rgba8unorm writes
        now.pass(0.08);
      }
    });
  assert.ok(frame.total > LIMIT, `the clock reads ${frame.total} ms, as the check measured before`);
  assert.ok(frame.own <= LIMIT, `the view's time ${frame.own} ms is within ${LIMIT} ms`);
  assert.ok(Math.abs(frame.stalled - (2.9 - CLOCK_STEP)) < 0.01, `stalled ${frame.stalled} ms`);
  // Every simulated cost is still paid in full: 3 waits of 0.32 ms, 0.1 ms of objects steps, 0.16 ms of writes.
  assert.ok(frame.own >= 0.1 + 3 * 0.32 + 0.16, `own ${frame.own} ms`);
});

test('a wait runs its full time around a stop', () => {
  const now = fakeNow(),
    clock = stallClock(now),
    frame = clock.time(() => {
      now.after(3, 2);
      clock.wait(0.5);
    });
  assert.ok(frame.own >= 0.5, `the wait ran ${frame.own} ms of its 0.5`);
  assert.ok(frame.total >= 2.4, `the clock read ${frame.total} ms`);
});

test('a slow write or a stop in the view itself still counts', () => {
  const now = fakeNow(),
    clock = stallClock(now),
    slowWrite = clock.time(() => {
      clock.wait(0.32);
      now.pass(3.4); // a writeTexture call that blocks for 3.4 ms
    }),
    viewStop = clock.time(() => {
      now.pass(0.4);
      now.pass(2.9); // the thread stops while the view's own code runs: not inside the check's wait, so it counts
      clock.wait(0.32);
    });
  assert.equal(slowWrite.stalled, 0);
  assert.ok(slowWrite.own > LIMIT, `a 3.4 ms write gives ${slowWrite.own} ms and fails the check`);
  assert.equal(viewStop.stalled, 0);
  assert.ok(viewStop.own > LIMIT, `a stop in the view gives ${viewStop.own} ms and fails the check`);
});

test('gaps up to the stall threshold count as running', () => {
  const now = fakeNow(),
    clock = stallClock(now),
    frame = clock.time(() => {
      now.after(2, STALL_MS - 0.01);
      clock.wait(0.2);
    });
  assert.equal(frame.stalled, 0);
  assert.equal(frame.own, frame.total);
});
