import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runScene } from '../dist/auto.js';
const sceneURL = new URL('./auto-scene-fixture.js', import.meta.url);
const data = () => ({ calls: [], disposals: 0 });

test('auto falls back without transferring a canvas and runs the exact same scene module', {
  timeout: 3000,
}, async () => {
  const canvas = new EventTarget(),
    state = data();
  const scene = await runScene(canvas, sceneURL, { data: state });
  assert.equal(scene.mode, 'page');
  assert.equal(scene.fallbackReason.code, 'unsupported');
  assert.equal(scene.canvas, canvas);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].canvas, canvas);
  assert.equal(state.calls[0].mode, 'page');
  assert.equal(state.calls[0].signal.aborted, false);
  await Promise.all([scene.dispose(), scene.dispose()]);
  assert.equal(state.disposals, 1);
  assert.equal(state.calls[0].signal.aborted, true);
});

test('page mode bypasses worker creation and disposes attached engines', { timeout: 3000 }, async () => {
  let disposed = 0;
  const state = {
    ...data(),
    engine: {
      dispose() {
        disposed++;
      },
    },
  };
  const scene = await runScene(new EventTarget(), sceneURL, {
    mode: 'page',
    data: state,
    worker() {
      assert.fail('page never creates a worker');
    },
  });
  assert.equal(scene.fallbackReason, undefined);
  await scene[Symbol.asyncDispose]();
  assert.equal(disposed, 1);
});

test('lifetime signal cleans up; startup abort never imports or starts the scene', { timeout: 3000 }, async () => {
  const controller = new AbortController(),
    state = data();
  const scene = await runScene(new EventTarget(), sceneURL, { mode: 'page', data: state, signal: controller.signal });
  controller.abort();
  await scene.dispose();
  assert.equal(state.disposals, 1);
  const early = data();
  await assert.rejects(runScene(new EventTarget(), sceneURL, { data: early, signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(early.calls.length, 0);
});

test('startup deadline rejects promptly and cleans up a late-created page scene', { timeout: 3000 }, async () => {
  const waiting = Promise.withResolvers();
  const state = { ...data(), wait: waiting.promise };
  await assert.rejects(runScene(new EventTarget(), sceneURL, { data: state, mode: 'page', timeout: 20 }), {
    code: 'timeout',
  });
  assert.equal(state.calls[0].signal.aborted, true);
  waiting.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.disposals, 1);
});

test('invalid options, missing modules, missing exports and runtime errors reject without rerunning a scene', {
  timeout: 3000,
}, async () => {
  for (const timeout of [0, NaN, Infinity, -1])
    await assert.rejects(runScene(new EventTarget(), sceneURL, { timeout }), RangeError);
  await assert.rejects(runScene(new EventTarget(), sceneURL, { mode: 'wrong' }), { code: 'state' });
  await assert.rejects(runScene(new EventTarget(), sceneURL, { mode: 'worker' }), { code: 'unsupported' });
  await assert.rejects(runScene(new EventTarget(), new URL('./missing-scene.js', import.meta.url), { mode: 'page' }), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
  await assert.rejects(
    runScene(new EventTarget(), new URL('data:text/javascript,export const nothing=1'), { mode: 'page' }),
    { code: 'state' },
  );
  const state = { ...data(), error: new Error('scene failed') };
  await assert.rejects(runScene(new EventTarget(), sceneURL, { data: state }), /scene failed/);
  assert.equal(state.calls.length, 1);
});
