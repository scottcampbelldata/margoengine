import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsTriggerRumble, triggerRumble } from '../dist/haptics.js';
test('native effect carries independent trigger/handle intensities, delay and duration with documented defaults', async () => {
  const calls = [],
    pad = {
      connected: true,
      vibrationActuator: {
        effects: ['dual-rumble', 'trigger-rumble'],
        async playEffect(...args) {
          calls.push(args);
          return 'complete';
        },
      },
    };
  assert.equal(supportsTriggerRumble(pad), true);
  assert.equal(await triggerRumble(pad), true);
  assert.deepEqual(calls[0], [
    'trigger-rumble',
    { duration: 100, startDelay: 0, strongMagnitude: 0, weakMagnitude: 0, leftTrigger: 1, rightTrigger: 1 },
  ]);
  await triggerRumble(pad, {
    duration: 200,
    startDelay: 20,
    leftTrigger: 0.2,
    rightTrigger: 0.8,
    strongMagnitude: 0.4,
    weakMagnitude: 0.6,
  });
  assert.deepEqual(calls[1], [
    'trigger-rumble',
    { duration: 200, startDelay: 20, leftTrigger: 0.2, rightTrigger: 0.8, strongMagnitude: 0.4, weakMagnitude: 0.6 },
  ]);
});
test('unsupported, disconnected and preempted effects return false; unknown capability probes native once', async () => {
  assert.equal(await triggerRumble(null), false);
  assert.equal(
    await triggerRumble({
      connected: false,
      vibrationActuator: {
        effects: ['trigger-rumble'],
        playEffect() {
          throw new Error('must not call');
        },
      },
    }),
    false,
  );
  assert.equal(
    await triggerRumble({
      vibrationActuator: {
        effects: ['dual-rumble'],
        playEffect() {
          throw new Error('must not substitute dual-rumble');
        },
      },
    }),
    false,
  );
  let calls = 0;
  const pad = {
    vibrationActuator: {
      async playEffect() {
        calls++;
        throw new DOMException('unsupported', 'NotSupportedError');
      },
    },
  };
  assert.equal(supportsTriggerRumble(pad), undefined);
  assert.equal(await triggerRumble(pad), false);
  assert.equal(calls, 1);
  pad.vibrationActuator.playEffect = async () => 'preempted';
  assert.equal(await triggerRumble(pad), false);
});
test('permission/device failures and malformed native completions are never hidden', async () => {
  const error = new DOMException('focus', 'InvalidStateError'),
    pad = {
      vibrationActuator: {
        async playEffect() {
          throw error;
        },
      },
    };
  await assert.rejects(triggerRumble(pad), error);
  pad.vibrationActuator.playEffect = async () => undefined;
  await assert.rejects(triggerRumble(pad), TypeError);
});
test('invalid parameters and pre-abort fail before touching any hardware', async () => {
  let calls = 0;
  const pad = {
    vibrationActuator: {
      async playEffect() {
        calls++;
        return 'complete';
      },
    },
  };
  for (const value of [-1, NaN, Infinity, 1.1])
    for (const name of ['leftTrigger', 'rightTrigger', 'strongMagnitude', 'weakMagnitude'])
      await assert.rejects(triggerRumble(pad, { [name]: value }), RangeError);
  for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
    for (const name of ['duration', 'startDelay'])
      await assert.rejects(triggerRumble(pad, { [name]: value }), RangeError);
  for (const timeout of [0, -1, NaN, Infinity, 2147483648])
    await assert.rejects(triggerRumble(pad, { timeout }), RangeError);
  await assert.rejects(triggerRumble(pad, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls, 0);
});
test('abort resets the active actuator, timeout is bounded, and no-reset actuators stop with a zero effect', async () => {
  let resets = 0;
  const pad = {
      vibrationActuator: {
        playEffect: () => new Promise(() => {}),
        async reset() {
          resets++;
          return 'complete';
        },
      },
    },
    controller = new AbortController();
  const p = triggerRumble(pad, { signal: controller.signal });
  controller.abort();
  await assert.rejects(p, { name: 'AbortError' });
  assert.equal(resets, 1);
  await assert.rejects(triggerRumble(pad, { timeout: 5 }), { name: 'TimeoutError' });
  assert.equal(resets, 2);
  const calls = [],
    legacy = {
      vibrationActuator: {
        playEffect(type, params) {
          calls.push([type, params]);
          return calls.length === 1 ? new Promise(() => {}) : Promise.resolve('complete');
        },
      },
    },
    abort = new AbortController();
  const pending = triggerRumble(legacy, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(calls[1], [
    'trigger-rumble',
    { duration: 0, startDelay: 0, strongMagnitude: 0, weakMagnitude: 0, leftTrigger: 0, rightTrigger: 0 },
  ]);
});
test('aborting an older call cannot reset a newer effect on the same actuator', async () => {
  const completions = [];
  let resets = 0;
  const pad = {
    vibrationActuator: {
      playEffect: () => new Promise((resolve) => completions.push(resolve)),
      async reset() {
        resets++;
        return 'complete';
      },
    },
  };
  const oldController = new AbortController(),
    old = triggerRumble(pad, { signal: oldController.signal }),
    newest = triggerRumble(pad);
  oldController.abort();
  await assert.rejects(old, { name: 'AbortError' });
  assert.equal(resets, 0);
  completions[1]('complete');
  assert.equal(await newest, true);
  completions[0]('preempted');
});
test('reset failure remains observable alongside the original abort', async () => {
  const stopError = new DOMException('reset unavailable', 'InvalidStateError'),
    controller = new AbortController(),
    pad = {
      vibrationActuator: {
        playEffect: () => new Promise(() => {}),
        async reset() {
          throw stopError;
        },
      },
    };
  const pending = triggerRumble(pad, { signal: controller.signal });
  controller.abort();
  await assert.rejects(
    pending,
    (error) =>
      error instanceof AggregateError && error.errors[0].name === 'AbortError' && error.errors[1] === stopError,
  );
});
