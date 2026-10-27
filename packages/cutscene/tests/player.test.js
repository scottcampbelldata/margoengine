// CutscenePlayer: play, pause, reverse, speed, loop, seek (scrub, fires nothing), skip and fast-forward (fire every
// event in order), the finish promise and AbortSignal, listeners that take over, the async event stream and dispose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cutscene, CutscenePlayer } from '../dist/index.js';

const scene = () => ({
  format: 'margo-cutscene',
  version: 1,
  duration: 4,
  markers: [{ time: 2, name: 'middle' }],
  tracks: [
    {
      type: 'event',
      id: 'cues',
      events: [
        { time: 0, name: 'a' },
        { time: 1, name: 'b' },
        { time: 3, name: 'c' },
        { time: 4, name: 'd' },
      ],
    },
    { type: 'subtitle', id: 'subs', clips: [{ start: 1, duration: 2, text: 'Hi' }] },
    {
      type: 'transform',
      id: 'box',
      target: 'box',
      keys: [
        { time: 0, position: [0, 0, 0] },
        { time: 4, position: [4, 0, 0] },
      ],
    },
  ],
});
const names = (events) => events.map((e) => `${e.kind}:${e.name}`);

test('playing forward fires each instant once, in order, whatever the frame size', () => {
  for (const step of [1 / 60, 0.25, 0.7, 5]) {
    const player = new CutscenePlayer(scene()),
      fired = [];
    player.on('*', (event) => fired.push(event));
    player.play();
    for (let i = 0; i < 1000 && player.playing; i++) player.update(step);
    assert.deepEqual(
      names(fired),
      ['event:a', 'event:b', 'enter:Hi', 'marker:middle', 'exit:Hi', 'event:c', 'event:d'],
      `step ${step}`,
    );
    assert.equal(player.time, 4);
    assert.equal(player.playing, false);
  }
});

test('the state at a time is the same whether played, scrubbed or skipped there', () => {
  const played = new CutscenePlayer(scene());
  played.play();
  for (let i = 0; i < 10; i++) played.update(0.13);
  const t = played.time;
  const scrubbed = new CutscenePlayer(scene()).seek(3.9).seek(0.2).seek(t);
  const skipped = new CutscenePlayer(scene()).skip(t);
  assert.deepEqual(scrubbed.state, played.state);
  assert.deepEqual(skipped.state, played.state);
  assert.deepEqual(played.state, new Cutscene(scene()).evaluate(t));
});

test('seek fires nothing; skip and fastForward fire what they pass, in order', () => {
  const player = new CutscenePlayer(scene()),
    fired = [];
  player.on('*', (event) => fired.push(event));
  player.seek(2.5);
  assert.deepEqual(fired, []);
  player.fastForward(1);
  assert.deepEqual(names(fired), ['exit:Hi', 'event:c']);
  player.skip();
  assert.deepEqual(names(fired).slice(2), ['event:d']);
  assert.throws(() => player.fastForward(-1), RangeError);
});

test('reverse and negative speed play backwards, firing instants latest first', () => {
  const player = new CutscenePlayer(scene(), { time: 4, speed: -2 }),
    fired = [];
  player.on('*', (event) => fired.push(event.name));
  player.play();
  for (let i = 0; i < 100 && player.playing; i++) player.update(0.1);
  assert.deepEqual(fired, ['d', 'c', 'Hi', 'middle', 'Hi', 'b', 'a']);
  assert.equal(player.time, 0);
  player.reverse();
  assert.equal(player.speed, 2);
});

test('loop wraps and keeps firing; a huge delta is refused', () => {
  const player = new CutscenePlayer(scene(), { loop: true }),
    fired = [];
  player.on('event', (event) => fired.push(event.name));
  player.play();
  player.update(9);
  assert.deepEqual(fired, ['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd', 'a']);
  near(player.time, 1);
  assert.equal(player.playing, true);
  assert.throws(() => player.update(1e6), RangeError);
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('play() resolves true at the end, false when paused, and rejects on abort', async () => {
  const player = new CutscenePlayer(scene());
  const done = player.play();
  player.update(5);
  assert.equal(await done, true);
  const paused = player.play(); // restarts from 0
  assert.equal(player.time, 0);
  player.update(1);
  player.pause();
  assert.equal(await paused, false);
  const controller = new AbortController();
  const aborted = player.play({ signal: controller.signal });
  controller.abort(new Error('menu opened'));
  await assert.rejects(aborted, /menu opened/);
  assert.equal(player.playing, false);
  assert.throws(() => player.play({ signal: controller.signal }), /menu opened/);
});

test('a listener that seeks takes over; update from a listener is refused', () => {
  const player = new CutscenePlayer(scene()),
    fired = [];
  player.on('event', (event) => {
    fired.push(event.name);
    if (event.name === 'b') player.seek(3.5);
  });
  player.play();
  player.update(3);
  assert.deepEqual(fired, ['a', 'b'], 'the rest of that step was dropped');
  assert.equal(player.time, 3.5);
  player.update(1);
  assert.deepEqual(fired, ['a', 'b', 'd']);
  const nested = new CutscenePlayer(scene());
  nested.on('event', () => nested.update(0.1));
  nested.play();
  assert.throws(
    () => nested.update(1),
    (error) => error.code === 'state',
  );
});

test('events() streams instants and ends on finish; dispose ends everything', async () => {
  const player = new CutscenePlayer(scene());
  const seen = [];
  const reading = (async () => {
    for await (const event of player.events()) seen.push(event.name);
  })();
  player.play();
  player.update(2.5);
  player.update(2);
  await reading;
  assert.deepEqual(seen, ['a', 'b', 'Hi', 'middle', 'Hi', 'c', 'd']);
  const controller = new AbortController();
  const stopped = (async () => {
    for await (const _ of player.events({ signal: controller.signal })) assert.fail('nothing fires');
  })();
  controller.abort();
  await stopped;
  let finished = 0;
  player.on('finish', () => finished++);
  {
    using scoped = player;
    scoped.skip(0);
  }
  assert.throws(
    () => player.update(0.1),
    (error) => error.code === 'disposed',
  );
  assert.equal(finished, 0);
  assert.throws(() => new CutscenePlayer(scene(), { speed: Number.NaN }), RangeError);
});
