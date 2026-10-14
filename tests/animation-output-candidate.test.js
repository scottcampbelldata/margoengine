import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine, TransformStore} from '../packages/core/dist/extension.js';
import {GLTFAsset, PBRModel} from '../packages/gltf-pro/dist/index.js';
import {animationSources, importAnimationSources} from '../scripts/support/animation-output-candidate.js';
import {animationOutputFixture} from './support/animation-output-fixture.js';

const sources = await animationSources(), original = await importAnimationSources(sources.original), candidate = await importAnimationSources(sources.candidate), arithmetic = await importAnimationSources(sources.arithmetic), minimal = await importAnimationSources(sources.minimal);
const outcome = operation => {try {return {bytes: [...new Uint32Array(operation().buffer)]};} catch (error) {return {error: error.constructor.name, message: error.message};}};

test('private sampling candidate preserves Float32 bits, errors and fresh public results', () => {
  let seed = 54731;
  const random = () => {seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 0xffffffff * 2 - 1;};
  const times = new Float32Array([0, 0.3, 1.7, 4]);
  for (const interpolation of ['STEP', 'LINEAR', 'CUBICSPLINE']) for (const width of [1, 3, 4, 7]) for (const quaternion of [false, true]) {
    const values = Float32Array.from({length: times.length * width * (interpolation === 'CUBICSPLINE' ? 3 : 1)}, random), out = new Float32Array(width);
    for (const time of [-3, 0, 0.02, 0.3, 0.71, 1.7, 3.12, 4, 10]) {
      const arguments_ = [times, values, width, time, interpolation, quaternion];
      assert.deepEqual(outcome(() => candidate.sampling.sampleTrack(...arguments_)), outcome(() => original.sampleTrack(...arguments_)));
      assert.deepEqual(outcome(() => arithmetic.sampleTrack(...arguments_)), outcome(() => original.sampleTrack(...arguments_)));
      assert.deepEqual(outcome(() => minimal.sampleTrack(...arguments_)), outcome(() => original.sampleTrack(...arguments_)));
      // Width 4 is Animation's only quaternion path. Wider public calls keep fresh zero-filled output.
      if (!quaternion || width === 4) assert.deepEqual(outcome(() => candidate.sampling.sampleTrackInto(...arguments_, out)), outcome(() => original.sampleTrack(...arguments_)));
    }
    const a = candidate.sampleTrack(times, values, width, 0.1, interpolation, false), b = candidate.sampleTrack(times, values, width, 0.1, interpolation, false);
    assert.notEqual(a, b); assert.notEqual(a.buffer, b.buffer);
    const first = arithmetic.sampleTrack(times, values, width, 0.1, interpolation, false), next = arithmetic.sampleTrack(times, values, width, 0.1, interpolation, false);
    assert.notEqual(first, next); assert.notEqual(first.buffer, next.buffer);
    const small = minimal.sampleTrack(times, values, width, 0.1, interpolation, false), fresh = minimal.sampleTrack(times, values, width, 0.1, interpolation, false);
    assert.notEqual(small, fresh); assert.notEqual(small.buffer, fresh.buffer);
  }
  for (const arguments_ of [
    [new Float32Array(), new Float32Array(), 1, 0, 'LINEAR'],
    [times, new Float32Array(4), 0, 0, 'LINEAR'], [times, new Float32Array(4), 1.5, 0, 'LINEAR'],
    [times, new Float32Array(4), 1, NaN, 'LINEAR'], [times, new Float32Array(4), 1, 0, 'UNKNOWN'],
    [times, new Float32Array(3), 1, 0, 'LINEAR'], [times, new Float32Array(4).fill(Infinity), 1, 0, 'LINEAR'],
    [times, new Float32Array(16), 4, 0.3, 'LINEAR', true]
  ]) {for(const implementation of [candidate,arithmetic,minimal])assert.deepEqual(outcome(() => implementation.sampleTrack(...arguments_)), outcome(() => original.sampleTrack(...arguments_)));}
});

async function pair() {
  const records = [];
  for (const implementation of [original, candidate, arithmetic, minimal]) {
    const store = await TransformStore.create(32), engine = new Engine({width: 256, height: 256, clientWidth: 256, clientHeight: 256}, store,
      {backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {}});
    const fixture = animationOutputFixture(), model = new PBRModel(engine, new GLTFAsset(fixture.doc, fixture.buffers)), animation = new implementation.Animation(model, {loop: false});
    records.push({engine, store, model, animation});
  }
  return {records, close() {for (const record of records) {record.animation.dispose(); record.model.dispose(); record.engine.dispose();}}};
}
const snapshot = record => ({transforms: Object.fromEntries(Object.entries(record.store.transforms).map(([key, value]) => [key, Array.from(value)])),
  euler: Array.from(record.store.rotations), morphs: record.model.primitives.map(primitive => Array.from(primitive.weights)),
  time: record.animation.time, playing: record.animation.playing, clip: record.animation.clip});

test('private Animation cache preserves actual Core normalization, Euler angles, looping and morphs', async () => {
  const p = await pair();
  try {
    for (const clip of ['STEP', 'LINEAR', 'CUBICSPLINE']) {
      for (const record of p.records) record.animation.play(clip);
      for (const time of [0, 0.07, 0.2, 0.61, 0.99, 1, 2.7]) {
        for (const record of p.records) record.animation.seek(time); for (const record of p.records.slice(1)) assert.deepEqual(snapshot(record), snapshot(p.records[0]));
      }
      for (const record of p.records) {record.animation.options.loop = true; record.animation.options.speed = 0.7; record.animation.play(clip);}
      for (let i = 0; i < 43; i++) {for (const record of p.records) record.animation.onPreUpdate(0.07); for (const record of p.records.slice(1)) assert.deepEqual(snapshot(record), snapshot(p.records[0]));}
    }
    for (const record of p.records) record.animation.setMorph(0, 0, 0.43); for (const record of p.records.slice(1)) assert.deepEqual(snapshot(record), snapshot(p.records[0]));
    for (const record of p.records) assert.throws(() => record.animation.seek(-1), /Invalid animation time/);
  } finally {p.close();}
});

test('private steady sampling removes typed-output and rotation-copy allocations without altering Core', async () => {
  const p = await pair(), allocations = [];
  try {
    for (const record of p.records) {
      record.animation.play('LINEAR'); const Float32 = globalThis.Float32Array, from = Array.from; let typed = 0, copies = 0;
      try {
        globalThis.Float32Array = new Proxy(Float32, {construct(target, args) {typed++; return Reflect.construct(target, args);}});
        Array.from = function(...arguments_) {copies++; return from.apply(this, arguments_);};
        for (let i = 0; i < 128; i++) record.animation.seek(i / 127);
      } finally {globalThis.Float32Array = Float32; Array.from = from;}
      allocations.push({typed, copies});
    }
    assert.deepEqual(allocations, [{typed: 128 * 4, copies: 128}, {typed: 0, copies: 0}, {typed: 128 * 4, copies: 128}, {typed: 128 * 4, copies: 128}]);
    for (const record of p.records.slice(1)) assert.deepEqual(snapshot(record), snapshot(p.records[0]));
  } finally {p.close();}
});

test('mutated exposed tracks preserve invalid-width and output-overflow error outcomes', async () => {
  const p = await pair(), result = operation => {try {operation(); return null;} catch (error) {return {type: error.constructor.name, message: error.message};}};
  try {
    for (const width of [3, 5]) {
      for (const record of p.records) {
        const track = record.animation.clips[1].tracks.find(track => track.path === 'rotation'); track.width = width;
        track.values = new Float32Array(width * 2).fill(0.3); record.animation.clip = 1;
      }
      const expected = result(() => p.records[0].animation.seek(0.2)); for (const record of p.records.slice(1)) assert.deepEqual(result(() => record.animation.seek(0.2)), expected);
    }
    for (const record of p.records) {const track = record.animation.clips[0].tracks[0]; track.values[0] = Infinity; record.animation.clip = 0;}
    const expected = result(() => p.records[0].animation.seek(0.2)); for (const record of p.records.slice(1)) assert.deepEqual(result(() => record.animation.seek(0.2)), expected);
  } finally {p.close();}
});
