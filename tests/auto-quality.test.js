import test from 'node:test';
import assert from 'node:assert/strict';
import {watchFrameRate, capFrameRate} from '../packages/shared/auto-quality.js';
import {Engine} from '../packages/core/dist/engine.js';
import {TransformStore} from '../packages/core/dist/kernel.js';

// Drive the watcher with synthetic frame timestamps; `gaps` lists [interval ms, frame count] runs.
function run(gaps) {
  const queue = [], calls = {store: 0, reload: 0}, light = globalThis.margoLow;
  delete globalThis.margoLow; // the full tier is the one that watches frame rate
  try {watchFrameRate({request: callback => queue.push(callback), store: () => calls.store++, reload: () => calls.reload++});} finally {if (light) globalThis.margoLow = light;}
  let now = 1000;
  for (const [interval, count] of gaps) for (let i = 0; i < count && queue.length; i++) queue.shift()(now += interval);
  return {...calls, watching: queue.length > 0};
}

test('sustained slow desktop frames switch to the light tier once; fast or interrupted frames do not', () => {
  assert.deepEqual(run([[25, 400]]), {store: 1, reload: 1, watching: false}, '40 FPS for ten seconds');
  assert.deepEqual(run([[1000 / 60, 3000]]), {store: 0, reload: 0, watching: false}, '60 FPS stops watching after 30 s');
  assert.deepEqual(run([[25, 150], [5000, 1], [1000 / 60, 300]]), {store: 0, reload: 0, watching: true}, 'a hidden-tab gap resets the count');
});

// Drive the light-tier probe: each rAF frame submits once and the GPU finishes `gpu` ms later.
function probe(gpu) {
  const frames = [], stored = [], pending = [];
  let clock = 0, reloads = 0;
  const queue = {submit() {}, onSubmittedWorkDone() {return new Promise(resolve => pending.push(() => {clock += gpu; resolve();}));}};
  globalThis.margoLow = 1;
  try {watchFrameRate({request: callback => frames.push(callback), queue, now: () => clock, store: value => stored.push(value), reload: () => reloads++});}
  finally {delete globalThis.margoLow;}
  return {frames, pending, queue, stored, reloads};
}
test('the light tier remembers the full tier only when the GPU has clear headroom, and never reloads', async () => {
  for (const [gpu, expected] of [[2, 'high'], [9, 'low']]) {
    const run = probe(gpu), {submit} = run.queue;
    for (let i = 0; i < 400 && run.frames.length; i++) {
      run.frames.shift()(i * 16.7); run.queue.submit([]);
      while (run.pending.length) {run.pending.shift()(); await null;}
    }
    await null;
    assert.deepEqual(run.stored, [expected], `${gpu} ms`); assert.equal(run.reloads, 0); assert.notEqual(run.queue.submit, submit, 'the original submit is restored after measuring');
  }
});

test('the light tier renders HiDPI desktops single-sampled at DPR 1', async () => {
  const density = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
  Object.defineProperty(globalThis, 'devicePixelRatio', {configurable: true, value: 2});
  globalThis.margoLow = 1;
  const canvas = {width: 1, height: 1, clientWidth: 1440, clientHeight: 900};
  const engine = new Engine(canvas, await TransformStore.create(1), {backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {}}, undefined, null);
  try {
    const {sceneSamples} = await import('../packages/core/dist/quality.js');
    engine.render(); assert.equal(sceneSamples(), 1); assert.deepEqual([canvas.width, canvas.height], [1440, 900]);
  } finally {
    engine.dispose(); delete globalThis.margoLow;
    if (density) Object.defineProperty(globalThis, 'devicePixelRatio', density); else delete globalThis.devicePixelRatio;
  }
});

test('the light-tier cap runs every other refresh of a 120 Hz display and every refresh at 60 Hz', () => {
  for (const [hz, expected] of [[120, 60], [60, 60], [144, 72]]) {
    const queue = [], target = {requestAnimationFrame: callback => queue.push(callback)};
    capFrameRate(60, target);
    let runs = 0; const loop = () => {runs++; target.requestAnimationFrame(loop);}; target.requestAnimationFrame(loop);
    for (let frame = 1; frame <= hz; frame++) for (const callback of queue.splice(0)) callback(frame * 1000 / hz);
    assert.equal(runs, expected, `${hz} Hz`);
  }
});
