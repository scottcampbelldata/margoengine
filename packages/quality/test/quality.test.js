import test from 'node:test';
import assert from 'node:assert/strict';
import {applyQualityTier, watchQuality, capFrameRate} from '../dist/index.js';
import {Engine} from '../../core/dist/engine.js';
import {TransformStore} from '../../core/dist/kernel.js';
import {sceneSamples} from '../../core/dist/quality.js';

const memory = (values = {}) => ({values, getItem: key => values[key] ?? null, setItem(key, value) {values[key] = value;}});
const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155', phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) Mobile';

test('desktops start light unless a measured or forced tier says otherwise; phones keep their own path', () => {
  try {
    assert.equal(applyQualityTier({search: '', storage: memory(), userAgent: desktop}), 'light'); assert.equal(globalThis.margoLow, 1);
    assert.equal(applyQualityTier({search: '?scale=1.5', storage: memory(), userAgent: desktop}), 'light'); assert.equal(globalThis.margoLow, 1.5);
    assert.equal(applyQualityTier({search: '', storage: memory({margoQuality: 'high'}), userAgent: desktop}), 'high'); assert.equal(globalThis.margoLow, undefined);
    assert.equal(applyQualityTier({search: '?quality=low', storage: memory({margoQuality: 'high'}), userAgent: desktop}), 'light');
    assert.equal(applyQualityTier({search: '', storage: memory({margoLow: '1'}), userAgent: desktop}), 'light', 'older key still means low');
    assert.equal(applyQualityTier({search: '', storage: memory(), userAgent: phone}), 'phone'); assert.equal(globalThis.margoLow, undefined);
  } finally {delete globalThis.margoLow;}
});

// Drive the full-tier watcher with synthetic frame timestamps; `gaps` lists [interval ms, frame count] runs.
function fullTier(gaps) {
  const frames = [], calls = {store: [], reload: 0};
  applyQualityTier({search: '', storage: memory({margoQuality: 'high'}), userAgent: desktop});
  watchQuality({request: callback => frames.push(callback), store: value => calls.store.push(value), reload: () => calls.reload++});
  let now = 1000;
  for (const [interval, count] of gaps) for (let i = 0; i < count && frames.length; i++) frames.shift()(now += interval);
  return {...calls, watching: frames.length > 0};
}
test('on the full tier, sustained slow frames store low and reload once; fast or interrupted frames do not', () => {
  assert.deepEqual(fullTier([[25, 400]]), {store: ['low'], reload: 1, watching: false}, '40 FPS for ten seconds');
  assert.deepEqual(fullTier([[1000 / 60, 3000]]), {store: [], reload: 0, watching: false}, '60 FPS stops watching after 30 s');
  assert.deepEqual(fullTier([[25, 150], [5000, 1], [1000 / 60, 300]]), {store: [], reload: 0, watching: true}, 'a hidden-tab gap resets the count');
});

test('the light tier remembers the full tier only when the GPU has clear headroom, and never reloads', async () => {
  try {
    for (const [gpu, expected] of [[2, 'high'], [9, 'low']]) {
      const frames = [], pending = [], stored = [];
      let clock = 0, reloads = 0;
      const queue = {submit() {}, onSubmittedWorkDone() {return new Promise(resolve => pending.push(() => {clock += gpu; resolve();}));}}, submit = queue.submit;
      applyQualityTier({search: '', storage: memory(), userAgent: desktop});
      watchQuality({request: callback => frames.push(callback), queue, now: () => clock, store: value => stored.push(value), reload: () => reloads++});
      for (let i = 0; i < 400 && frames.length; i++) {frames.shift()(i * 16.7); queue.submit([]); while (pending.length) {pending.shift()(); await null;}}
      await null;
      assert.deepEqual(stored, [expected], `${gpu} ms`); assert.equal(reloads, 0); assert.equal(queue.submit, submit, 'the original submit is restored');
    }
  } finally {delete globalThis.margoLow;}
});

test('a forced tier is for testing: it never stores or reloads', () => {
  const frames = [];
  try {
    applyQualityTier({search: '?quality=high', storage: memory(), userAgent: desktop});
    watchQuality({request: callback => frames.push(callback), store: () => assert.fail('stored'), reload: () => assert.fail('reloaded')});
    assert.equal(frames.length, 0);
  } finally {delete globalThis.margoLow;}
});

test('the light tier renders HiDPI desktops single-sampled at its pixel ratio', async () => {
  const density = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
  Object.defineProperty(globalThis, 'devicePixelRatio', {configurable: true, value: 2});
  const canvas = {width: 1, height: 1, clientWidth: 1440, clientHeight: 900};
  const engine = new Engine(canvas, await TransformStore.create(1), {backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {}}, undefined, null);
  try {
    globalThis.margoLow = 1; engine.render(); assert.equal(sceneSamples(), 1); assert.deepEqual([canvas.width, canvas.height], [1440, 900]);
    globalThis.margoLow = 1.5; engine.render(); assert.deepEqual([canvas.width, canvas.height], [2160, 1350]);
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
