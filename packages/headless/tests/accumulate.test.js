import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAccumulated, subFrameSteps, subFrames } from '../dist/accumulate.js';

const all = (options) => [...subFrames(options)];

test('subFrames: samples per frame, ascending times, deltas that add up to the frame interval', () => {
  const frames = all({ frames: 3, fps: 24, samples: 8, shutter: 0.5 });
  assert.equal(frames.length, 24);
  assert.deepEqual(
    frames.map((f) => [f.frame, f.sample, f.last]).filter((_, i) => i % 8 === 7),
    [
      [0, 7, true],
      [1, 7, true],
      [2, 7, true],
    ],
  );
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].time > frames[i - 1].time, 'ascending');
  assert.equal(frames[0].delta, frames[0].time, 'fresh clocks move to the first render');
  // Slice k of the open shutter is sampled at its middle: (k + 0.5) / samples of 0.5 / fps.
  for (const f of frames)
    assert.ok(Math.abs(f.time - (f.frame + (0.5 * (f.sample + 0.5)) / 8) / 24) < 1e-12, 'mid-slice times');
  let clock = 0;
  for (const f of frames) {
    clock += f.delta;
    assert.ok(Math.abs(clock - f.time) < 1e-12, 'the clocks read each render time');
  }
  assert.ok(Math.abs(frames.slice(1, 9).reduce((s, f) => s + f.delta, 0) - 1 / 24) < 1e-12, 'one frame interval');
});

test("subFrames: samples 1 and shutter 0 give renderFrames' times and deltas exactly, with no offset", () => {
  const fps = 30;
  for (const f of all({ frames: 7, fps, samples: 1, shutter: 0 })) {
    assert.equal(f.time, f.frame / fps);
    assert.equal(f.delta, f.frame ? 1 / fps : 0);
    assert.deepEqual(f.offset, [0, 0]);
  }
});

test('subFrames: shutter phases place the open shutter from, around or up to the frame time', () => {
  const at = (shutterPhase) => all({ frames: 2, fps: 10, samples: 2, shutter: 1, shutterPhase }).map((f) => f.time);
  assert.deepEqual(at('start'), [0.025, 0.075, 0.125, 0.175]);
  assert.deepEqual(
    at('center').map((t) => Math.round(t * 1e9) / 1e9),
    [-0.025, 0.025, 0.075, 0.125],
  );
  assert.deepEqual(
    at('end').map((t) => Math.round(t * 1e9) / 1e9),
    [-0.075, -0.025, 0.025, 0.075],
  );
});

test('subFrames: box offsets are stratified, every filter stays in its width, the pattern is seeded', () => {
  const n = 64,
    box = all({ frames: 1, samples: n, filter: 'box' });
  for (const axis of [0, 1]) {
    const strata = new Set(box.map((f) => Math.floor((f.offset[axis] + 0.5) * n)));
    assert.equal(strata.size, n, `one point per 1/${n} stratum on axis ${axis}`);
  }
  for (const filter of ['blackman-harris', 'gaussian'])
    for (const filterWidth of [1, 2, 3]) {
      const offsets = all({ frames: 1, samples: 256, filter, filterWidth }).map((f) => f.offset);
      assert.ok(offsets.every(([x, y]) => Math.abs(x) <= filterWidth / 2 && Math.abs(y) <= filterWidth / 2));
      const mean = offsets.reduce((s, [x]) => s + x, 0) / offsets.length;
      assert.ok(Math.abs(mean) < 0.02 * filterWidth, `${filter} is centred: ${mean}`);
      // A tapered filter puts fewer points near its edges than a box of the same width.
      const outer = offsets.filter(([x]) => Math.abs(x) > filterWidth / 4).length / offsets.length;
      assert.ok(outer < 0.4, `${filter} ${filterWidth}: ${outer}`);
    }
  const key = (o) => JSON.stringify(all(o).map((f) => f.offset));
  assert.equal(key({ frames: 2, samples: 16 }), key({ frames: 2, samples: 16 }), 'repeatable');
  assert.notEqual(key({ frames: 1, samples: 16, seed: 1 }), key({ frames: 1, samples: 16, seed: 2 }), 'seeded');
  const fixed = all({ frames: 2, samples: 16 }),
    perFrame = all({ frames: 2, samples: 16, pattern: 'per-frame' });
  assert.deepEqual(
    fixed.slice(0, 16).map((f) => f.offset),
    fixed.slice(16).map((f) => f.offset),
  );
  assert.notDeepEqual(
    perFrame.slice(0, 16).map((f) => f.offset),
    perFrame.slice(16).map((f) => f.offset),
  );
  // Space is shuffled against time: the time order is not the Sobol order.
  const order = all({ frames: 1, samples: 16, filter: 'box' }).map((f) => f.offset[0]);
  assert.notDeepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
});

test('subFrames and renderAccumulated reject options out of range before any render', async () => {
  const bad = [
    { frames: 0 },
    { frames: 1.5 },
    { frames: 1, fps: 0 },
    { frames: 1, fps: Infinity },
    { frames: 1, samples: 0 },
    { frames: 1, samples: 4097 },
    { frames: 1, shutter: -0.1 },
    { frames: 1, shutter: 1.1 },
    { frames: 1, shutter: NaN },
    { frames: 1, shutterPhase: 'middle' },
    { frames: 1, filter: 'mitchell' },
    { frames: 1, filterWidth: 0 },
    { frames: 1, seed: -1 },
    { frames: 1, seed: 2 ** 32 },
    { frames: 1, pattern: 'random' },
  ];
  for (const options of bad) {
    assert.throws(() => all(options), /RangeError|TypeError|Invalid|must|:/, JSON.stringify(options));
    let rendered = 0;
    const engine = { render: () => rendered++ };
    await assert.rejects(renderAccumulated(engine, options).next(), undefined, JSON.stringify(options));
    assert.equal(rendered, 0);
  }
  await assert.rejects(renderAccumulated({}, { frames: 1, output: 'hdr' }).next(), /Output/);
  const controller = new AbortController();
  controller.abort(new Error('early'));
  await assert.rejects(renderAccumulated({}, { frames: 1, signal: controller.signal }).next(), /early/);
});

test('subFrames: a shutter open before 0 leaves fresh clocks at 0 until time passes 0', () => {
  for (const shutterPhase of ['center', 'end']) {
    let clock = 0;
    for (const f of all({ frames: 3, fps: 24, samples: 4, shutter: 1, shutterPhase })) {
      clock += f.delta;
      assert.ok(f.delta >= 0);
      assert.ok(Math.abs(clock - Math.max(0, f.time)) < 1e-12, `${shutterPhase}: clocks read max(0, time)`);
    }
  }
});

test('subFrames: a span from startFrame after subFrameSteps repeats the whole film, bit for bit', () => {
  for (const framing of [
    { fps: 24, samples: 8, shutter: 0.5 },
    { fps: 30, samples: 3, shutter: 1, shutterPhase: 'center', pattern: 'per-frame', seed: 7 },
    { fps: 25, samples: 1, shutter: 0 },
  ]) {
    const whole = all({ ...framing, frames: 10 }),
      steps = subFrameSteps({ ...framing, startFrame: 6 }),
      span = all({ ...framing, frames: 4, startFrame: 6 });
    assert.equal(steps.length, 6 * (framing.samples ?? 16));
    assert.deepEqual(
      steps,
      whole.slice(0, steps.length).map((f) => f.delta),
      'the seek replays the deltas',
    );
    assert.deepEqual(span, whole.slice(steps.length), 'then the span is the same renders');
  }
  assert.deepEqual(subFrameSteps({ startFrame: 0 }), []);
  assert.throws(() => subFrameSteps({ startFrame: -1 }), /startFrame/);
  assert.throws(() => all({ frames: 1, startFrame: 0.5 }), /startFrame/);
});
