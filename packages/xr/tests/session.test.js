import test from 'node:test';
import assert from 'node:assert/strict';
import { XRSessionState } from '../dist/session.js';

function rig(extra = {}) {
  const space = Object.assign(new EventTarget(), {
      boundsGeometry: [
        { x: -1, z: -2 },
        { x: 1, z: -2 },
        { x: 1, z: 2 },
        { x: -1, z: 2 },
      ],
    }),
    session = Object.assign(new EventTarget(), {
      environmentBlendMode: 'alpha-blend',
      visibilityState: 'visible',
      frameRate: 72,
      supportedFrameRates: [90, 72, 120],
      updateTargetFrameRate: async function (rate) {
        this.frameRate = rate;
      },
      ...extra,
    });
  return { session, space, xr: { session, referenceSpace: space } };
}

test('XRSessionState reads blend mode, frame rates, visibility and the play area', () => {
  const { xr } = rig();
  const state = XRSessionState.attach(xr);
  assert.equal(state.environmentBlendMode, 'alpha-blend');
  assert.equal(state.interactionMode, undefined);
  assert.equal(state.visibility, 'visible');
  assert.equal(state.frameRate, 72);
  assert.deepEqual(state.supportedFrameRates, [72, 90, 120]);
  assert.deepEqual(Array.from(state.bounds), [-1, -2, 1, -2, 1, 2, -1, 2]);
  const bare = XRSessionState.attach({ session: {}, referenceSpace: {} });
  assert.equal(bare.bounds, null);
  assert.equal(bare.frameRate, null);
  assert.deepEqual(bare.supportedFrameRates, []);
  assert.equal(bare.visibility, 'visible');
});

test('setFrameRate asks the device only for a supported rate', async () => {
  const { xr, session } = rig();
  const state = XRSessionState.attach(xr);
  await state.setFrameRate(90);
  assert.equal(session.frameRate, 90);
  await assert.rejects(state.setFrameRate(60), RangeError);
  assert.equal(session.frameRate, 90);
  const none = XRSessionState.attach({ session: {}, referenceSpace: undefined });
  await assert.rejects(none.setFrameRate(72), { code: 'unsupported' });
});

test('visibility and reset events reach their callbacks until disposed', () => {
  const { xr, session, space } = rig();
  const state = XRSessionState.attach(xr);
  const seen = [],
    resets = [];
  state.onVisibilityChange((v) => seen.push(v));
  state.onReset((t) => resets.push(t));
  session.visibilityState = 'hidden';
  session.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(seen, ['hidden']);
  const reset = new Event('reset');
  reset.transform = { name: 'moved' };
  space.dispatchEvent(reset);
  assert.deepEqual(resets, [{ name: 'moved' }]);
  state[Symbol.dispose]();
  session.dispatchEvent(new Event('visibilitychange'));
  space.dispatchEvent(new Event('reset'));
  assert.equal(seen.length, 1);
  assert.equal(resets.length, 1);
});

test('XRSessionState needs a session and stops when its signal aborts', () => {
  assert.throws(() => XRSessionState.attach({ session: null }), { code: 'state' });
  const { xr, session } = rig();
  const controller = new AbortController(),
    state = XRSessionState.attach(xr, { signal: controller.signal });
  let count = 0;
  state.onVisibilityChange(() => count++);
  controller.abort();
  session.dispatchEvent(new Event('visibilitychange'));
  assert.equal(count, 0);
});
