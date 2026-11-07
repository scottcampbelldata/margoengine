import test from 'node:test';
import assert from 'node:assert/strict';
import { checkXRRun, runDeviceCheck, xrRunGaps, XR_RUN_MIN_FRAMES, XR_RUN_TARGETS } from '../dist/device-check.js';

/** A session and host that step `frames` frames 10 ms apart, with `views` views. */
function host({ frames = 500, views = 2, inputs = [], stop } = {}) {
  const session = new EventTarget();
  session.enabledFeatures = ['local', 'webgpu'];
  let ended = 0;
  return {
    get ended() {
      return ended;
    },
    async requestSession(mode, options) {
      this.options = { mode, ...options };
      setTimeout(() => {
        for (let i = 0; i < frames; i++) {
          if (i === stop) return session.dispatchEvent(new Event('end'));
          options.onFrame({
            time: i * 10,
            delta: 0.01,
            frame: {},
            inputs,
            viewer: { emulatedPosition: i % 2 === 0, views: Array(views).fill({}) },
          });
        }
      }, 0);
      return session;
    },
    async end() {
      ended++;
    },
  };
}
const source = (handedness) => ({
  handedness,
  targetRayMode: 'tracked-pointer',
  profiles: ['generic-trigger'],
  gamepad: { buttons: [{}, {}], axes: [0, 0] },
  hand: new Map(),
});
const yes = async () => ({ scene: true, tracking: true, input: true, exit: true });

test('one session gives frames, poses, timing, inputs and features, then ends', async () => {
  const xr = host({ inputs: [{ source: source('left') }, { source: source('right') }], frames: 401 }),
    run = await runDeviceCheck(xr, { seconds: 4 });
  assert.equal(run.frames, 401, 'the frame that reaches 4 seconds is counted');
  assert.equal(run.tracked, 401);
  assert.equal(run.emulated, 201);
  assert.equal(run.views, 2);
  assert.deepEqual(run.frameMs, { median: 10, p95: 10, max: 10 });
  assert.deepEqual(run.features, ['local', 'webgpu']);
  assert.deepEqual(
    run.inputs.map((input) => [input.handedness, input.buttons, input.axes, input.hand]),
    [
      ['left', 2, 2, true],
      ['right', 2, 2, true],
    ],
  );
  assert.equal(run.endedEarly, false);
  assert.equal(xr.ended, 1);
  assert.deepEqual(checkXRRun(run), []);
});

test('the same input source in many frames is one input', async () => {
  const one = source('left'),
    run = await runDeviceCheck(host({ inputs: [{ source: one }] }), { seconds: 1 });
  assert.equal(run.inputs.length, 1);
});

test('a session the browser ends is an early end, and what it did is kept', async () => {
  const run = await runDeviceCheck(host({ stop: 50 }), { seconds: 4 });
  assert.equal(run.frames, 50);
  assert.equal(run.endedEarly, true);
});

test('a failure in the page is recorded and the run goes on', async () => {
  let calls = 0;
  const run = await runDeviceCheck(host({ frames: 200 }), {
    seconds: 1,
    onFrame() {
      if (++calls === 3) throw new Error('page bug');
    },
  });
  assert.equal(run.errors.length, 1);
  assert.match(run.errors[0], /page bug/);
  assert.ok(run.frames > 3);
});

test('features are asked for as optional, so a device without them still runs', async () => {
  const xr = host();
  await runDeviceCheck(xr, { seconds: 1, mode: 'immersive-ar' });
  assert.equal(xr.options.mode, 'immersive-ar');
  assert.ok(xr.options.optionalFeatures.includes('hit-test'));
  assert.equal(xr.options.requiredFeatures, undefined);
});

test('an abort ends the session and rejects with the reason', async () => {
  const controller = new AbortController(),
    xr = host({ frames: 0 }),
    running = runDeviceCheck(xr, { seconds: 1, signal: controller.signal });
  await Promise.resolve();
  await Promise.resolve();
  controller.abort(new Error('stopped'));
  await assert.rejects(running, /stopped/);
  assert.equal(xr.ended, 1);
});

test('seconds must be above 0', async () => {
  for (const seconds of [0, -1, Number.NaN, Infinity])
    await assert.rejects(runDeviceCheck(host(), { seconds }), /above 0; pass the session length/);
});

const proved = {
  schema: 1,
  date: '2026-11-07T00:00:00.000Z',
  userAgent: 'headset',
  native: true,
  mode: 'immersive-vr',
  route: 'webgpu',
  features: ['webgpu'],
  views: 2,
  frames: XR_RUN_MIN_FRAMES,
  tracked: XR_RUN_MIN_FRAMES,
  emulated: 0,
  frameMs: { median: 13.9, p95: 14, max: 30 },
  inputs: [{ handedness: 'left', targetRayMode: 'tracked-pointer', profiles: [], hand: false, buttons: 1, axes: 0 }],
  endedEarly: false,
  errors: [],
  observed: { scene: true, tracking: true, input: true, exit: true },
};
const target = XR_RUN_TARGETS.find((entry) => entry.id === 'vr-webgpu');

test('a run on the browser with everything confirmed proves its route and no other', () => {
  assert.deepEqual(checkXRRun(proved), []);
  assert.deepEqual(xrRunGaps(proved, target), []);
  assert.ok(xrRunGaps(proved, XR_RUN_TARGETS.find((entry) => entry.id === 'ar-webgpu')).length);
});

test('each thing a real run needs is checked on its own', () => {
  for (const [change, gap] of [
    [{ native: false }, /stand-in/],
    [{ tracked: XR_RUN_MIN_FRAMES - 1 }, /tracked frames/],
    [{ views: 1 }, /1 views/],
    [{ errors: ['x'] }, /1 errors/],
    [{ endedEarly: true }, /ended early/],
    [{ inputs: [] }, /input source/],
    [{ observed: undefined }, /did not confirm scene/],
    [{ observed: { ...proved.observed, tracking: false } }, /did not confirm tracking/],
    [{ route: 'webgl2' }, /route was webgl2/],
  ])
    assert.match(xrRunGaps({ ...proved, ...change }, target).join('\n'), gap);
});

test('a stand-in session cannot claim the browser: this run has no navigator.xr of its own', async () => {
  const run = await runDeviceCheck(host(), { seconds: 4, observe: yes });
  assert.equal(run.native, false);
  assert.match(xrRunGaps(run, target).join('\n'), /stand-in/);
});

test('a JavaScript navigator.xr is a stand-in; only browser code counts', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'x', xr: { requestSession() {} } },
  });
  try {
    assert.equal((await runDeviceCheck(host(), { seconds: 1 })).native, false);
    // `Array.prototype.push` stands for any function the runtime wrote.
    globalThis.navigator.xr.requestSession = Array.prototype.push;
    assert.equal((await runDeviceCheck(host(), { seconds: 1 })).native, true);
  } finally {
    Object.defineProperty(globalThis, 'navigator', previous);
  }
});

test('a broken record names what is wrong', () => {
  assert.deepEqual(checkXRRun(null), ['the run is not an object']);
  assert.match(checkXRRun({ ...proved, frames: -1 }).join(), /frames/);
  assert.match(checkXRRun({ ...proved, tracked: proved.frames + 1 }).join(), /tracked/);
  assert.match(checkXRRun({ ...proved, observed: { scene: 'yes' } }).join(), /observed.scene/);
  assert.match(checkXRRun({ ...proved, inputs: [{}] }).join(), /inputs/);
});
