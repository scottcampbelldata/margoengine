// The paths of `startEngine` that need no GPU. Drawing through each path: scripts/web-demos/controls.mjs on both backends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../dist/auto.js';

const canvas = () => ({ width: 4, height: 4, getContext: () => null });

function withNavigator(t, value) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value });
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  });
}

test('a browser without WebGPU falls back to the full layer, installed with force', async (t) => {
  withNavigator(t, { userAgent: 'test' });
  const calls = [];
  const stop = new Error('layer reached');
  await assert.rejects(
    startEngine(canvas(), {
      loadCompat: async () => ({
        install: async (options) => {
          calls.push(options);
          throw stop;
        },
      }),
    }),
    (error) => error === stop,
  );
  assert.deepEqual(calls, [{ force: true }]);
});

test('forceCompat goes to the layer without asking WebGPU for an adapter', async (t) => {
  withNavigator(t, { userAgent: 'test', gpu: { requestAdapter: () => assert.fail('WebGPU is not asked') } });
  const stop = new Error('layer reached');
  let loads = 0;
  await assert.rejects(
    startEngine(canvas(), {
      forceCompat: true,
      loadCompat: async () => {
        loads++;
        return {
          install: async () => {
            throw stop;
          },
        };
      },
    }),
    (error) => error === stop,
  );
  assert.equal(loads, 1);
});

test('an error that is not a missing or silent WebGPU rejects and never loads the layer', async (t) => {
  const broken = new Error('adapter broke');
  withNavigator(t, {
    userAgent: 'test',
    gpu: {
      requestAdapter: async () => {
        throw broken;
      },
    },
  });
  await assert.rejects(
    startEngine(canvas(), { loadCompat: () => assert.fail('no layer for other errors') }),
    (error) => error !== null && error?.code !== 'unsupported' && error?.code !== 'timeout',
  );
});

test('an aborted signal stops before the layer installs', async (t) => {
  withNavigator(t, { userAgent: 'test' });
  const stop = new AbortController();
  stop.abort(new Error('left the page'));
  await assert.rejects(
    startEngine(canvas(), {
      signal: stop.signal,
      loadCompat: async () => ({ install: () => assert.fail('no install after abort') }),
    }),
  );
});
