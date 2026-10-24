import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAudioContext } from './fake-web-audio.js';

globalThis.AudioContext = FakeAudioContext;
const { AudioListener, Audio } = await import('../dist/index.js');
const close = (a, b, epsilon = 1e-9) => Math.abs(a - b) <= epsilon;

// Playhead vectors (audio-pause spec), replayed on the fake context (running, smoothing 0). Each row is
// [step, isPlaying, currentTime, sourcesCreated, live node or null, onEnded count, error class?], the live node as
// [start when, start offset, start duration (null when omitted), loop, loopStart, loopEnd, rate].
const runs = [
  {
    label: 'plain pause/resume',
    options: {},
    duration: 10,
    log: [
      [['play'], true, 0, 1, [0, 0, null, false, 0, 0, 1], 0],
      [['time', 1.5], true, 1.5, 1, [0, 0, null, false, 0, 0, 1], 0],
      [['pause'], false, 1.5, 1, null, 0],
      [['time', 3], false, 1.5, 1, null, 0],
      [['play'], true, 1.5, 2, [3, 1.5, null, false, 0, 0, 1], 0],
      [['time', 4], true, 2.5, 2, [3, 1.5, null, false, 0, 0, 1], 0],
      [['pause'], false, 2.5, 2, null, 0],
      [['pause'], false, 2.5, 2, null, 0],
      [['play'], true, 2.5, 3, [4, 2.5, null, false, 0, 0, 1], 0],
    ],
  },
  {
    label: 'offset 1, duration 5, rate 2',
    options: { 'offset': 1, 'duration': 5, 'playbackRate': 2 },
    duration: 10,
    log: [
      [['play'], true, 1, 1, [0, 1, 5, false, 0, 0, 2], 0],
      [['time', 1.5], true, 4, 1, [0, 1, 5, false, 0, 0, 2], 0],
      [['pause'], false, 4, 1, null, 0],
      [['play'], true, 4, 2, [1.5, 4, 2, false, 0, 0, 2], 0],
      [['time', 2], true, 5, 2, [1.5, 4, 2, false, 0, 0, 2], 0],
      [['pause'], false, 5, 2, null, 0],
      [['stop'], false, 1, 2, null, 0],
      [['play', 0.5], true, 1, 3, [2.5, 1, 5, false, 0, 0, 2], 0],
      [['stop'], false, 1, 3, null, 0],
    ],
  },
  {
    label: 'pause before the delayed start time',
    options: {},
    duration: 10,
    log: [
      [['play', 2], true, 0, 1, [2, 0, null, false, 0, 0, 1], 0],
      [['time', 1], true, 0, 1, [2, 0, null, false, 0, 0, 1], 0],
      [['pause'], false, 0, 1, null, 0],
      [['play'], true, 0, 2, [1, 0, null, false, 0, 0, 1], 0],
      [['time', 3], true, 2, 2, [1, 0, null, false, 0, 0, 1], 0],
    ],
  },
  {
    label: 'loop region 2..4',
    options: { 'loop': true, 'loopStart': 2, 'loopEnd': 4 },
    duration: 10,
    log: [
      [['play'], true, 0, 1, [0, 0, null, true, 2, 4, 1], 0],
      [['time', 5], true, 3, 1, [0, 0, null, true, 2, 4, 1], 0],
      [['pause'], false, 3, 1, null, 0],
      [['play'], true, 3, 2, [5, 3, null, true, 2, 4, 1], 0],
      [['time', 6.5], true, 2.5, 2, [5, 3, null, true, 2, 4, 1], 0],
      [['pause'], false, 2.5, 2, null, 0],
    ],
  },
  {
    label: 'loop whole buffer (loopEnd 0)',
    options: { 'loop': true },
    duration: 3,
    log: [
      [['play'], true, 0, 1, [0, 0, null, true, 0, 0, 1], 0],
      [['time', 7.25], true, 1.25, 1, [0, 0, null, true, 0, 0, 1], 0],
      [['pause'], false, 1.25, 1, null, 0],
      [['play'], true, 1.25, 2, [7.25, 1.25, null, true, 0, 0, 1], 0],
    ],
  },
  {
    label: 'loop with loopEnd beyond the buffer clamps to the buffer',
    options: { 'loop': true, 'loopStart': 1, 'loopEnd': 50 },
    duration: 4,
    log: [
      [['play'], true, 0, 1, [0, 0, null, true, 1, 50, 1], 0],
      [['time', 9], true, 3, 1, [0, 0, null, true, 1, 50, 1], 0],
      [['pause'], false, 3, 1, null, 0],
    ],
  },
  {
    label: 'loop with loopStart >= loopEnd wraps the whole buffer',
    options: { 'loop': true, 'loopStart': 3, 'loopEnd': 2 },
    duration: 5,
    log: [
      [['play'], true, 0, 1, [0, 0, null, true, 3, 2, 1], 0],
      [['time', 12], true, 2, 1, [0, 0, null, true, 3, 2, 1], 0],
      [['pause'], false, 2, 1, null, 0],
    ],
  },
  {
    label: 'offset inside a loop region',
    options: { 'loop': true, 'loopStart': 2, 'loopEnd': 4, 'offset': 3 },
    duration: 10,
    log: [
      [['play'], true, 3, 1, [0, 3, null, true, 2, 4, 1], 0],
      [['time', 0.5], true, 3.5, 1, [0, 3, null, true, 2, 4, 1], 0],
      [['pause'], false, 3.5, 1, null, 0],
      [['time', 1], false, 3.5, 1, null, 0],
      [['play'], true, 3.5, 2, [1, 3.5, null, true, 2, 4, 1], 0],
      [['time', 3], true, 3.5, 2, [1, 3.5, null, true, 2, 4, 1], 0],
      [['pause'], false, 3.5, 2, null, 0],
    ],
  },
  {
    label: 'rate change mid play',
    options: {},
    duration: 100,
    log: [
      [['play'], true, 0, 1, [0, 0, null, false, 0, 0, 1], 0],
      [['time', 2], true, 2, 1, [0, 0, null, false, 0, 0, 1], 0],
      [['rate', 3], true, 2, 1, [0, 0, null, false, 0, 0, 3], 0],
      [['time', 4], true, 8, 1, [0, 0, null, false, 0, 0, 3], 0],
      [['pause'], false, 8, 1, null, 0],
      [['rate', 0.5], false, 8, 1, null, 0],
      [['play'], true, 8, 2, [4, 8, null, false, 0, 0, 0.5], 0],
      [['time', 6], true, 9, 2, [4, 8, null, false, 0, 0, 0.5], 0],
      [['pause'], false, 9, 2, null, 0],
    ],
  },
  {
    label: 'rate change before a delayed start',
    options: {},
    duration: 100,
    log: [
      [['play', 2], true, 0, 1, [2, 0, null, false, 0, 0, 1], 0],
      [['time', 1], true, 0, 1, [2, 0, null, false, 0, 0, 1], 0],
      [['rate', 2], true, 0, 1, [2, 0, null, false, 0, 0, 2], 0],
      [['time', 3], true, 2, 1, [2, 0, null, false, 0, 0, 2], 0],
      [['pause'], false, 2, 1, null, 0],
    ],
  },
  {
    label: 'non-loop clamps at the end; natural end',
    options: {},
    duration: 2,
    log: [
      [['play'], true, 0, 1, [0, 0, null, false, 0, 0, 1], 0],
      [['time', 5], true, 2, 1, [0, 0, null, false, 0, 0, 1], 0],
      [['pause'], false, 2, 1, null, 0],
      [['play'], true, 2, 2, [5, 2, null, false, 0, 0, 1], 0],
      [['end'], false, 0, 2, null, 1],
      [['play'], true, 0, 3, [5, 0, null, false, 0, 0, 1], 1],
    ],
  },
  {
    label: 'natural end fires onEnded and rewinds',
    options: {},
    duration: 2,
    log: [
      [['play'], true, 0, 1, [0, 0, null, false, 0, 0, 1], 0],
      [['time', 2], true, 2, 1, [0, 0, null, false, 0, 0, 1], 0],
      [['end'], false, 0, 1, null, 1],
      [['time', 3], false, 0, 1, null, 1],
    ],
  },
  {
    label: 'duration with a resume: remaining shrinks',
    options: { 'duration': 3 },
    duration: 10,
    log: [
      [['play'], true, 0, 1, [0, 0, 3, false, 0, 0, 1], 0],
      [['time', 1], true, 1, 1, [0, 0, 3, false, 0, 0, 1], 0],
      [['pause'], false, 1, 1, null, 0],
      [['play'], true, 1, 2, [1, 1, 2, false, 0, 0, 1], 0],
      [['time', 2.5], true, 2.5, 2, [1, 1, 2, false, 0, 0, 1], 0],
      [['pause'], false, 2.5, 2, null, 0],
      [['play'], true, 2.5, 3, [2.5, 2.5, 0.5, false, 0, 0, 1], 0],
    ],
  },
  {
    label: 'seek while playing, paused and stopped',
    options: {},
    duration: 10,
    log: [
      [['play'], true, 0, 1, [0, 0, null, false, 0, 0, 1], 0],
      [['time', 1], true, 1, 1, [0, 0, null, false, 0, 0, 1], 0],
      [['seek', 6], true, 6, 2, [1, 6, null, false, 0, 0, 1], 0],
      [['time', 2], true, 7, 2, [1, 6, null, false, 0, 0, 1], 0],
      [['rate', 2], true, 7, 2, [1, 6, null, false, 0, 0, 2], 0],
      [['time', 3], true, 9, 2, [1, 6, null, false, 0, 0, 2], 0],
      [['pause'], false, 9, 2, null, 0],
      [['play'], true, 9, 3, [3, 9, null, false, 0, 0, 2], 0],
      [['pause'], false, 9, 3, null, 0],
      [['seek', 2], false, 2, 3, null, 0],
      [['play'], true, 2, 4, [3, 2, null, false, 0, 0, 2], 0],
      [['stop'], false, 0, 4, null, 0],
      [['seek', 4], false, 4, 4, null, 0],
      [['play'], true, 4, 5, [3, 4, null, false, 0, 0, 2], 0],
      [['seek', 25], true, 10, 6, [3, 10, null, false, 0, 0, 2], 0],
      [['end'], false, 0, 6, null, 1],
      [['set', 'loop', true], false, 0, 6, null, 1],
      [['set', 'loopStart', 2], false, 0, 6, null, 1],
      [['set', 'loopEnd', 4], false, 0, 6, null, 1],
      [['seek', 5], false, 3, 6, null, 1],
      [['seek', -1], false, 3, 6, null, 1, 'RangeError'],
    ],
  },
  {
    label: 'offset changed while paused',
    options: {},
    duration: 10,
    log: [
      [['play'], true, 0, 1, [0, 0, null, false, 0, 0, 1], 0],
      [['time', 2], true, 2, 1, [0, 0, null, false, 0, 0, 1], 0],
      [['pause'], false, 2, 1, null, 0],
      [['set', 'offset', 3], false, 5, 1, null, 0],
      [['play'], true, 5, 2, [2, 5, null, false, 0, 0, 1], 0],
      [['time', 3], true, 6, 2, [2, 5, null, false, 0, 0, 1], 0],
      [['pause'], false, 6, 2, null, 0],
    ],
  },
  {
    label: 'loop toggled off while paused past the end',
    options: { 'loop': true },
    duration: 2,
    log: [
      [['play'], true, 0, 1, [0, 0, null, true, 0, 0, 1], 0],
      [['time', 5], true, 1, 1, [0, 0, null, true, 0, 0, 1], 0],
      [['pause'], false, 1, 1, null, 0],
      [['set', 'loop', false], false, 1, 1, null, 0],
      [['play'], true, 1, 2, [5, 1, null, false, 0, 0, 1], 0],
    ],
  },
  {
    label: 'play(-1) and stop(NaN) throw',
    options: {},
    duration: 10,
    log: [
      [['play', -1], false, 0, 0, null, 0, 'RangeError'],
      [['play'], true, 0, 1, [0, 0, null, false, 0, 0, 1], 0],
      [['stop', null], true, 0, 1, [0, 0, null, false, 0, 0, 1], 0, 'RangeError'],
    ],
  },
];

function apply(audio, context, step) {
  const [kind, ...args] = step;
  if (kind === 'time') context.currentTime = args[0];
  else if (kind === 'rate') audio.playbackRate = args[0];
  else if (kind === 'set') audio[args[0]] = args[1];
  else if (kind === 'end') audio.source.end();
  else if (kind === 'stop' && args[0] === null) audio.stop(Number.NaN);
  else audio[kind](...args);
}

for (const { label, options, duration, log } of runs)
  test(`playhead vectors: ${label}`, () => {
    const context = new FakeAudioContext({ state: 'running' }),
      listener = new AudioListener({ context, smoothing: 0 });
    let ended = 0;
    const audio = new Audio(listener, { ...options, onEnded: () => ended++ });
    audio.setBuffer({ duration, length: duration * 48000 });
    log.forEach(([step, playing, time, sources, live, endedCount, error], k) => {
      const at = `step ${k} ${JSON.stringify(step)}`;
      let thrown = null;
      try {
        apply(audio, context, step);
      } catch (e) {
        thrown = e;
      }
      assert.equal(thrown?.constructor.name, error, `${at}: error`);
      assert.equal(audio.isPlaying, playing, `${at}: isPlaying`);
      assert.ok(close(audio.currentTime, time), `${at}: currentTime ${audio.currentTime} vs ${time}`);
      assert.equal(context.bufferSources.length, sources, `${at}: sources created`);
      assert.equal(ended, endedCount, `${at}: onEnded`);
      if (!live) return assert.equal(audio.source, null, `${at}: no live node`);
      const node = audio.source,
        [when, offset, length, loop, loopStart, loopEnd, rate] = live;
      assert.ok(close(node.started.when, when) && close(node.started.offset, offset), `${at}: start`);
      if (length === null) assert.equal(node.started.duration, undefined, `${at}: start without a duration`);
      else assert.ok(close(node.started.duration, length), `${at}: start duration`);
      assert.deepEqual([node.loop, node.loopStart, node.loopEnd], [loop, loopStart, loopEnd], `${at}: loop fields`);
      assert.ok(close(node.playbackRate.value, rate), `${at}: rate`);
      assert.equal(node.outputs.size, 1, `${at}: live node connected`);
    });
    listener.dispose();
  });

test('only the live node stays connected and stale or paused nodes never end the sound', () => {
  const context = new FakeAudioContext({ state: 'running' }),
    listener = new AudioListener({ context, smoothing: 0 });
  let ended = 0;
  const audio = new Audio(listener, { loop: true, onEnded: () => ended++ });
  audio.setBuffer({ duration: 4, length: 4 * 48000 }).play();
  for (let k = 1; k <= 50; k++) {
    context.currentTime = k * 0.37;
    if (k % 3 === 0) audio.pause();
    else if (k % 3 === 1) audio.play();
    else audio.seek((k * 0.61) % 4);
    if (k % 7 === 0) audio.playbackRate = 0.5 + (k % 4) * 0.5;
  }
  const live = audio.source;
  assert.equal(context.bufferSources.filter((node) => node.outputs.size > 0).length, live ? 1 : 0);
  for (const node of context.bufferSources) if (node !== live) node.end();
  assert.equal(ended, 0, 'released nodes never fire onEnded');
  assert.equal(audio.source, live);
  // The playhead is continuous across pause and resume: resuming starts where pausing stopped.
  if (!audio.isPlaying) audio.play();
  const position = audio.currentTime;
  audio.pause();
  assert.ok(close(audio.currentTime, position));
  audio.play();
  assert.ok(close(audio.source.started.offset, position));
  assert.ok(position >= 0 && position < 4, 'looped position stays in the buffer');
  listener.dispose();
});

test('a delayed stop keeps the node until it ends by itself, without onEnded', () => {
  const context = new FakeAudioContext({ state: 'running' }),
    listener = new AudioListener({ context, smoothing: 0 });
  let ended = 0;
  const audio = new Audio(listener, { onEnded: () => ended++ }).setBuffer({ duration: 10, length: 480000 }).play();
  context.currentTime = 1;
  audio.stop(2);
  const node = audio.source;
  assert.deepEqual(node.stopped, { when: 3 });
  assert.equal(audio.isPlaying, false);
  assert.equal(audio.currentTime, 0, 'stop rewinds to offset');
  node.end();
  assert.deepEqual([audio.source, node.outputs.size, ended], [null, 0, 0]);
  listener.dispose();
});
