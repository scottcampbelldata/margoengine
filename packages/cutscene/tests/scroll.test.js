import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CutscenePlayer } from '../dist/index.js';
import { RangePlayback, ScrollPlayback } from '../dist/scroll.js';
const player = () =>
  new CutscenePlayer({
    format: 'margo-cutscene',
    version: 1,
    duration: 10,
    tracks: [
      {
        type: 'event',
        id: 'events',
        events: [
          { time: 2.5, name: 'a' },
          { time: 3.5, name: 'b' },
        ],
      },
    ],
  });
test('range crosses alternate iterations with exact endpoints, ordered events and one completion', async () => {
  const p = player(),
    range = new RangePlayback(p, { range: [2, 4], iterationCount: 3, direction: 'alternate' }),
    events = [],
    turns = [];
  p.on('event', (e) => events.push(e.name));
  range.on('iteration', (e) => turns.push(e.direction));
  const done = range.play();
  range.update(5);
  assert.equal(p.time, 3);
  assert.equal(range.iteration, 2);
  range.update(1);
  assert.equal(await done, true);
  assert.equal(p.time, 4);
  assert.equal(range.playing, false);
  assert.deepEqual(events, ['a', 'b', 'b', 'a', 'a', 'b']);
  assert.deepEqual(turns, [1, -1, 1]);
});
test('fractional, zero, reverse and infinite repetitions hold their correct endpoints', async () => {
  for (const [direction, end] of [
    ['normal', 3],
    ['reverse', 3],
    ['alternate', 3],
    ['alternateReverse', 3],
  ]) {
    const p = player(),
      r = new RangePlayback(p, { range: [2, 4], iterationCount: 2.5, direction });
    const done = r.play();
    r.update(100);
    assert.equal(await done, true);
    assert.equal(p.time, end);
  }
  const p = player(),
    r = new RangePlayback(p, { range: [2, 4], iterationCount: 0 });
  assert.equal(await r.play(), true);
  assert.equal(p.time, 2);
  const infinite = new RangePlayback(p, { range: [2, 4], iterationCount: Infinity });
  const paused = infinite.play();
  infinite.update(10);
  assert.equal(infinite.iteration, 5);
  infinite.pause();
  assert.equal(await paused, false);
});
test('partitioned updates have the same events and state; pause resumes and stop resets', async () => {
  const a = player(),
    b = player(),
    ra = new RangePlayback(a, { range: [2, 4], iterationCount: 4, direction: 'alternateReverse' }),
    rb = new RangePlayback(b, { range: [2, 4], iterationCount: 4, direction: 'alternateReverse' }),
    ea = [],
    eb = [];
  a.on('event', (e) => ea.push(e.name));
  b.on('event', (e) => eb.push(e.name));
  const da = ra.play(),
    db = rb.play();
  ra.update(8);
  for (let i = 0; i < 32; i++) rb.update(0.25);
  assert.equal(await da, true);
  assert.equal(await db, true);
  assert.equal(a.time, b.time);
  assert.deepEqual(ea, eb);
  const dc = rb.play();
  rb.update(0.5);
  rb.pause();
  assert.equal(await dc, false);
  const at = b.time,
    dd = rb.play();
  assert.equal(b.time, at);
  rb.stop();
  assert.equal(await dd, false);
  assert.equal(b.time, 4);
});
test('abort, reentrant changes and hard bounds leave borrowed players usable', async () => {
  const p = player(),
    r = new RangePlayback(p, { range: [2, 4], iterationCount: Infinity }),
    abort = new AbortController();
  const done = r.play({ signal: abort.signal });
  abort.abort(new Error('cancelled'));
  await assert.rejects(done, /cancelled/);
  const next = r.play();
  p.on('event', () => r.pause());
  r.update(1.5);
  assert.equal(await next, false);
  assert.equal(r.playing, false);
  r.dispose();
  p.seek(1);
  assert.equal(p.time, 1);
  assert.throws(() => r.update(0), /disposed/);
  assert.throws(() => new RangePlayback(p, { range: [5, 2] }), /range/);
  assert.throws(() => new RangePlayback(p, { iterationCount: -1 }), /count/);
  const huge = new RangePlayback(p, { iterationCount: Infinity });
  const big = huge.play();
  assert.throws(() => huge.update(100000), /smaller/);
  assert.equal(p.time, 0);
  huge.pause();
  await big;
});
const source = () => ({
  ownerDocument: { defaultView: {} },
  scrollTop: 0,
  scrollLeft: 0,
  scrollHeight: 1100,
  clientHeight: 100,
  scrollWidth: 600,
  clientWidth: 100,
});
test('scroll clamps explicit offsets and ranges, refreshes size, and never fires instants', () => {
  const p = player(),
    s = source(),
    events = [];
  p.on('event', (e) => events.push(e));
  const binding = new ScrollPlayback(p, { source: s, automatic: false, start: 100, end: 500, range: [2, 4] });
  for (const [offset, time] of [
    [0, 2],
    [100, 2],
    [300, 3],
    [500, 4],
    [900, 4],
  ]) {
    s.scrollTop = offset;
    binding.update(0);
    assert.equal(p.time, time);
  }
  assert.deepEqual(events, []);
  binding.dispose();
  assert.throws(() => binding.update(0), /disposed/);
  p.seek(0);
  const horizontal = new ScrollPlayback(p, { source: s, automatic: false, axis: 'x' });
  s.scrollLeft = 250;
  horizontal.update(0);
  assert.equal(p.time, 5);
  s.scrollWidth = 1100;
  horizontal.update(0);
  assert.equal(p.time, 2.5);
  horizontal.dispose();
});
test('exponential scrub is partition invariant for a fixed scroll target', () => {
  const a = player(),
    b = player(),
    sa = source(),
    sb = source();
  const ca = new ScrollPlayback(a, { source: sa, automatic: false, scrub: 1 }),
    cb = new ScrollPlayback(b, { source: sb, automatic: false, scrub: 1 });
  sa.scrollTop = 1000;
  sb.scrollTop = 1000;
  ca.update(1);
  for (let i = 0; i < 4; i++) cb.update(0.25);
  assert.ok(Math.abs(a.time - b.time) < 1e-12);
  assert.ok(Math.abs(a.time - 10 * (1 - Math.exp(-1))) < 1e-12);
  ca.dispose();
  cb.dispose();
});
