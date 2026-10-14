import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {FakeAudioContext} from '../../packages/audio/tests/fake-web-audio.js';
import {optionalGPU} from '../../tests/support/optional-gpu.js';
import {createWorkload as audio} from './audio.js';
import {createWorkload as video} from './video.js';

const flush = async () => {await Promise.resolve(); await Promise.resolve();};
function mountScene(t) {
  const dom = new JSDOM('<canvas></canvas><section></section>'), h = optionalGPU(), parent = dom.window.document.querySelector('section');
  h.engine.canvas = dom.window.document.querySelector('canvas');
  const meshes = Array.from({length: 4}, (_, id) => {const matrix = h.engine.store.matrices.subarray(id * 16, id * 16 + 16); matrix.set([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]); const mesh = {id, matrix}; h.engine.meshes.set(id, mesh); return mesh;});
  t.after(() => {h.cleanup(); dom.window.close();});
  return {...h, meshes, dom, parent, context: {engine: h.engine, meshes, parent, render: h.frame}};
}

test('Audio demo starts silent, follows actual positional source graph, reuses FFT data and closes owned context', async t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  globalThis.AudioContext = class extends FakeAudioContext {createBuffer(channels, length, sampleRate) {const data = new Float32Array(length); return {length, sampleRate, duration: length / sampleRate, getChannelData: () => data};}};
  t.after(() => {if (prior) Object.defineProperty(globalThis, 'AudioContext', prior); else delete globalThis.AudioContext;});
  const h = mountScene(t), w = audio(4); t.after(() => w.dispose()); w.mount(h.context); h.frame();
  assert.equal(w.listener.volume, 0); assert.equal(w.details().enabled, false); assert.equal(w.details().sources, 4); assert.equal(w.details().contextState, 'suspended');
  const context = w.listener.context, samples = w.sounds[0].buffer.getChannelData(0); assert.ok(samples.some(value => Math.abs(value) > 0.9)); assert.equal(context.bufferSources.length, 4);
  h.engine.store.matrices[12] = 1.25; h.engine.store.matrices[14] = -0.75; h.frame(); assert.equal(w.details().firstSourceX, 1.25); assert.equal(w.details().firstSourceZ, -0.75);
  h.parent.querySelector('[data-ui-audio]').click(); await flush(); assert.equal(w.details().enabled, true); assert.equal(context.state, 'running');
  const points = w.points, before = w.details().analyserReads; w.step(0.1); assert.equal(w.points, points); assert.equal(w.details().analyserReads, before + 1); assert.ok(w.details().averageFrequencyByte > 0);
  w.pause(); await flush(); assert.equal(context.state, 'suspended'); assert.equal(w.listener.volume, 0);
  w.dispose(); w.dispose(); await flush(); assert.equal(context.state, 'closed'); assert.equal(h.engine.hasPlugin('margoengine-audio'), false); assert.equal(h.parent.children.length, 0); assert.ok(context.bufferSources.every(source => source.stopped));
});

function media(t, h, {ready = true} = {}) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'HTMLVideoElement'); globalThis.HTMLVideoElement = h.dom.window.HTMLVideoElement;
  let requests = 0, stopped = 0, draws = 0, next = 0, source, paused = true; const callbacks = new Map();
  const track = {requestFrame() {requests++;}, stop() {stopped++;}}, stream = {getTracks: () => [track], getVideoTracks: () => [track]};
  h.dom.window.HTMLCanvasElement.prototype.getContext = () => ({fillRect() {draws++;}, fillText() {}});
  h.dom.window.HTMLCanvasElement.prototype.captureStream = () => stream;
  Object.defineProperties(h.dom.window.HTMLVideoElement.prototype, {
    videoWidth: {get: () => ready ? 256 : 0}, readyState: {get: () => ready ? 2 : 0}, paused: {get: () => paused},
    play: {value() {source = this; paused = false; if (ready) {this.dispatchEvent(new h.dom.window.Event('loadeddata')); queueMicrotask(() => {if (callbacks.size) {const [id, callback] = callbacks.entries().next().value; callbacks.delete(id); callback();}});} return Promise.resolve();}},
    pause: {value() {paused = true;}},
    requestVideoFrameCallback: {value(callback) {callbacks.set(++next, callback); return next;}},
    cancelVideoFrameCallback: {value(id) {callbacks.delete(id);}}
  });
  t.after(() => {if (prior) Object.defineProperty(globalThis, 'HTMLVideoElement', prior); else delete globalThis.HTMLVideoElement;});
  return {stream, callbacks, frame() {const [id, callback] = callbacks.entries().next().value; callbacks.delete(id); callback();}, stats: () => ({requests, stopped, draws, source, paused})};
}

test('Video demo waits for source data, uses actual external-texture surfaces and cancels tracks/frame callbacks', async t => {
  const h = mountScene(t), m = media(t, h), w = video(4); t.after(() => w.dispose()); await w.mount(h.context); h.frame();
  assert.equal(w.details().surfaces, 4); assert.equal(w.details().sourceReady, true); assert.equal(h.counts.draws, 4);
  const buffers = h.counts.buffers, requested = m.stats().requests; w.step(0.1); m.frame(); h.frame(); assert.ok(m.stats().requests > requested); assert.equal(w.details().receivedFrames, 2); assert.equal(h.counts.buffers, buffers, 'Steady media frames must not reattach GPU plugins');
  const source = w.source; h.parent.querySelector('[data-ui-video]').click(); assert.equal(w.details().sourceEnabled, false); w.step(0.1); assert.equal(m.stats().requests, requested + 1);
  w.dispose(); w.dispose(); assert.equal(m.stats().stopped, 1); assert.equal(m.callbacks.size, 0); assert.equal(source.srcObject, null); assert.equal(m.stats().paused, true); assert.equal(h.parent.children.length, 0); assert.ok(h.resources.every(resource => resource.destroyed));
});

test('Late video data after page abort cannot attach surfaces or retain media/timer ownership', async t => {
  const h = mountScene(t), m = media(t, h, {ready: false}), controller = new AbortController(), w = video(1, {signal: controller.signal});
  const pending = w.mount(h.context); controller.abort(); await assert.rejects(pending, /disposed/); m.stats().source.dispatchEvent(new h.dom.window.Event('loadeddata'));
  assert.equal(w.surfaces.length, 0); assert.equal(m.stats().stopped, 1); assert.equal(m.callbacks.size, 0); assert.equal(m.stats().source.srcObject, null);
  w.dispose(); assert.equal(m.stats().stopped, 1);
});

test('Media workloads reject unsupported counts and cannot mount after terminal disposal', async () => {
  for (const factory of [audio, video]) {assert.throws(() => factory(0), /count/); assert.throws(() => factory(10), /count/); const w = factory(1); w.dispose(); if (factory === audio) assert.throws(() => w.mount({}), /disposed/); else await assert.rejects(w.mount({}), /disposed/);}
});
