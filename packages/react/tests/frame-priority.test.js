import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceFrames, bridgeFrames, FrameCallbacks, frameTakeover, subscribeFrame, xrFrameScope } from '../src/frame-priority.ts';

function fixture() {
  const calls = [], callbacks = new Set();
  class Engine {
    render(options) { calls.push(options?.tag ?? 'draw'); }
    onFrame(callback) { callbacks.add(callback); return () => callbacks.delete(callback); }
    tick() { for (const callback of callbacks) callback(this, 0.016); this.render({ tag: 'automatic' }); }
  }
  const engine = new Engine(), frames = { callbacks: new FrameCallbacks(), elapsed: 0 };
  const release = bridgeFrames(engine, frames);
  engine.onFrame((engine, delta) => advanceFrames(frames, engine, delta, true));
  return { engine, frames, calls, release };
}
test('priorities ascend, ties retain registration order, negatives leave automatic rendering enabled', () => {
  const { engine, frames, calls, release } = fixture();
  subscribeFrame(frames, () => calls.push('zero-a'));
  subscribeFrame(frames, () => calls.push('before'), -2);
  subscribeFrame(frames, () => calls.push('zero-b'));
  subscribeFrame(frames, () => calls.push('negative'), -1);
  engine.tick();
  assert.deepEqual(calls, ['before', 'negative', 'zero-a', 'zero-b', 'automatic']);
  assert.equal(frameTakeover(frames), false);
  release(); assert.equal(Object.hasOwn(engine, 'render'), false); assert.equal(Object.hasOwn(engine, 'onFrame'), false);
});
test('multiple positive subscribers own rendering, permit explicit passes and restore only after the last leaves', () => {
  const { engine, frames, calls } = fixture();
  const first = subscribeFrame(frames, (engine) => { calls.push('main'); engine.render({ tag: 'scene' }); }, 1);
  const second = subscribeFrame(frames, (engine) => { calls.push('hud'); engine.render({ tag: 'overlay' }); }, 2);
  engine.tick(); assert.deepEqual(calls, ['main', 'scene', 'hud', 'overlay']);
  calls.length = 0; first(); engine.tick(); assert.deepEqual(calls, ['hud', 'overlay']);
  calls.length = 0; second(); engine.tick(); assert.deepEqual(calls, ['automatic']);
});
test('a positive callback that draws nothing suppresses automatic render; independent native callbacks may still render', () => {
  const { engine, frames, calls } = fixture();
  subscribeFrame(frames, () => calls.push('takeover'), 1);
  engine.onFrame(() => engine.render({ tag: 'native-manual' }));
  engine.tick(); assert.deepEqual(calls, ['takeover', 'native-manual']);
});
test('demand dispatch returns the automatic-render decision without starting a loop, and XR manual draws route to eyes', () => {
  const { engine, frames, calls } = fixture();
  const remove = subscribeFrame(frames, (engine) => engine.render(), 1);
  assert.equal(advanceFrames(frames, engine, 0.02), false);
  assert.deepEqual(calls, ['draw']); calls.length = 0;
  let eyes = 0;
  xrFrameScope(frames, () => { eyes++; engine.render({ tag: 'tracked-eyes' }); }, () => advanceFrames(frames, engine, 0.03));
  assert.equal(eyes, 1); assert.deepEqual(calls, ['tracked-eyes']);
  remove(); assert.equal(advanceFrames(frames, engine, 0), true);
});
test('dispatch snapshots additions, honours removals and restores scope after an exception', () => {
  const { engine, frames, calls } = fixture();
  let removeLast;
  const removeFirst = subscribeFrame(frames, () => { calls.push('first'); removeLast(); subscribeFrame(frames, () => calls.push('new'), -4); }, -2);
  removeLast = subscribeFrame(frames, () => calls.push('removed'), -1);
  advanceFrames(frames, engine, 0); assert.deepEqual(calls, ['first']);
  removeFirst(); calls.length = 0; advanceFrames(frames, engine, 0); assert.deepEqual(calls, ['new']);
  const remove = subscribeFrame(frames, () => { throw new Error('intentional'); }, 1);
  assert.throws(() => advanceFrames(frames, engine, 0), /intentional/);
  remove(); calls.length = 0; engine.render(); assert.deepEqual(calls, ['draw']);
});
test('invalid priorities reject before a subscriber joins', () => {
  const { frames } = fixture();
  for (const priority of [NaN, Infinity, -Infinity]) assert.throws(() => subscribeFrame(frames, () => {}, priority), /finite/);
  assert.equal(frames.callbacks.size, 0);
});

test('the native Engine loop suppresses its trailing render, keeps its clock, and resumes after takeover', async () => {
  const { Engine } = await import('@margoengine/core/extension');
  const previous = new Map(['requestAnimationFrame', 'cancelAnimationFrame'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const pending = new Map(); let serial = 0, draws = 0;
  globalThis.requestAnimationFrame = (callback) => { pending.set(++serial, callback); return serial; };
  globalThis.cancelAnimationFrame = (id) => pending.delete(id);
  let engine;
  try {
    engine = await Engine.create({ width: 64, height: 64, clientWidth: 64, clientHeight: 64, getContext() {} }, { backend: 'webgl2', fallback: () => ({ backend: 'webgl2', add() {}, remove() {}, render() { draws++; }, dispose() {} }) });
    const frames = { callbacks: new Set(), elapsed: 0 };
    const restore = bridgeFrames(engine, frames);
    engine.onFrame((engine, delta) => advanceFrames(frames, engine, delta, true));
    let manual = false;
    const remove = subscribeFrame(frames, (engine) => { if (manual) engine.render(); }, 1);
    const tick = (time) => { const callbacks = [...pending.values()]; pending.clear(); for (const callback of callbacks) callback(time); };
    engine.start(); tick(1000); assert.equal(draws, 0); assert.equal(pending.size, 1);
    manual = true; tick(1016); assert.equal(draws, 1); assert.equal(pending.size, 1);
    remove(); tick(1032); assert.equal(draws, 2); assert.equal(pending.size, 1);
    assert.equal(frames.elapsed, 0.032);
    engine.stop(); restore(); assert.equal(pending.size, 0);
  } finally {
    engine?.dispose();
    for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
