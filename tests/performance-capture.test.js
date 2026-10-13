import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';

const source = readFileSync(new URL('../scripts/collect-performance.js', import.meta.url), 'utf8');
function browser({gpu = true, failObserver = false, failDownload = false, inheritedRequest = false} = {}) {
  let now = 0, serial = 0, clicked = 0;
  const frames = new Map(), timers = new Map(), events = new Map(), observers = [];
  const listen = {addEventListener(type, callback) {events.set(type, callback);}, removeEventListener(type) {events.delete(type);}};
  class GPUQueue {submit() {return 'submitted';}}
  const device = {...listen, features: new Set(['depth32float-stencil8']), queue: new GPUQueue(),
    adapterInfo: {vendor: 'actual-vendor', architecture: 'actual-architecture', description: 'actual-device'}};
  class GPUCanvasContext {getConfiguration() {return {device};} getCurrentTexture() {return 'texture';}}
  const context = new GPUCanvasContext(), canvas = {width: 800, height: 600, closest: () => null,
    getBoundingClientRect: () => ({width: 800, height: 600}), getContext: () => gpu ? context : null};
  class PerformanceObserver {
    static supportedEntryTypes = ['longtask', 'long-animation-frame'];
    constructor(callback) {this.callback = callback; observers.push(this);}
    observe({type}) {this.type = type; if (failObserver) throw new Error('Observer failed');}
    disconnect() {}
  }
  class BrowserURL extends URL {static createObjectURL() {return 'blob:local';} static revokeObjectURL() {}}
  const request = callback => {frames.set(++serial, callback); return serial;}, cancel = id => frames.delete(id);
  const window = {...listen, requestAnimationFrame: request, cancelAnimationFrame: cancel,
    matchMedia: () => ({matches: false}), nightCitadel: {stats: {fps: 60, samples: 4, frames: 70, privateValue: 999}},
    sandbox: {timing: new Float32Array([1/60, 123])}};
  if (inheritedRequest) {delete window.requestAnimationFrame; Object.setPrototypeOf(window, {requestAnimationFrame: request});}
  const globals = {window, GPUQueue, GPUCanvasContext, PerformanceObserver, URL: BrowserURL, Blob,
    console: {info() {}}, location: {href: 'https://margoengine.com/demo?secret=yes#private'},
    navigator: {userAgent: 'test', gpu: {requestAdapter() {assert.fail('Must inspect the active device');}}},
    document: {...listen, visibilityState: 'visible', hasFocus: () => true, querySelector: selector => selector === '#quality' ? {textContent: 'Desktop 4x MSAA'} :
      selector === '#status' ? {textContent: 'World paused https://margoengine.com/?secret=yes#private'} :
      selector === '#error, #error-message' ? {textContent: 'GPU failed https://margoengine.com/shader?token=yes'} : canvas,
      scripts: [{src: '/assets/demo.js?secret=yes#private'}],
      createElement: () => ({click() {if (failDownload) throw new Error('Download failed'); clicked++;}})},
    innerWidth: 800, innerHeight: 600, devicePixelRatio: 2,
    performance: {now: () => now, getEntriesByType: () => [{initiatorType: 'script', name: 'https://margoengine.com/assets/shared.js?token=yes'}]},
    setTimeout(callback, delay) {timers.set(++serial, {callback, delay}); return serial;}, clearTimeout: id => timers.delete(id)};
  const originals = {request, cancel, submit: GPUQueue.prototype.submit, texture: GPUCanvasContext.prototype.getCurrentTexture};
  runInNewContext(source, globals);
  return {window, device, context, events, frames, originals, GPUQueue, GPUCanvasContext, document: globals.document, clicked: () => clicked,
    emit(type, entries) {observers.find(observer => observer.type === type).callback({getEntries: () => entries});},
    advance(time) {now = time;},
    frame(time) {now = time; for (const [id, callback] of [...frames]) {frames.delete(id); callback.call(window, time);}},
    finish() {now = 20000; [...timers.values()].find(timer => timer.delay === 20000)?.callback();}};
}
function restored(b) {
  assert.equal(b.window.requestAnimationFrame, b.originals.request);
  assert.equal(b.window.cancelAnimationFrame, b.originals.cancel);
  assert.equal(b.GPUQueue.prototype.submit, b.originals.submit);
  assert.equal(b.GPUCanvasContext.prototype.getCurrentTexture, b.originals.texture);
  assert.equal(b.events.size, 0);
}
test('captures active device and counters, redacts URLs, preserves callbacks/cancellation and restores hooks', async () => {
  const b = browser(); let called = 0;
  const cancelled = b.window.requestAnimationFrame(() => assert.fail('Cancelled callback ran'));
  b.window.cancelAnimationFrame(cancelled);
  b.window.requestAnimationFrame(function() {assert.equal(this, b.window); called++; b.advance(12); return 42;});
  b.frame(10); b.frame(20); b.frame(30);
  assert.equal(called, 1);
  assert.equal(b.context.getCurrentTexture(), 'texture'); assert.equal(b.device.queue.submit([]), 'submitted');
  b.document.visibilityState = 'hidden'; b.events.get('visibilitychange')({type: 'visibilitychange'});
  b.document.visibilityState = 'visible'; b.events.get('visibilitychange')({type: 'visibilitychange'});
  b.emit('long-animation-frame', [{startTime: 30, duration: 70, blockingDuration: 50,
    scripts: Array.from({length: 10}, () => ({sourceURL: '/assets/demo.js?secret=yes#private', sourceFunctionName: 'render', duration: 60, forcedStyleAndLayoutDuration: 2}))}]);
  const failure = new Error('App error'); b.window.requestAnimationFrame(() => {throw failure;});
  const [id, callback] = [...b.frames].at(-1); b.frames.delete(id);
  assert.throws(() => callback.call(b.window, 40), reason => reason === failure);
  b.window.requestAnimationFrame(() => called++); b.finish();
  const report = await b.window.margoPerformanceCapture;
  assert.equal(report.initial.activeWebgpu.adapterInfo.vendor, 'actual-vendor');
  assert.equal(report.initial.sceneStats.fps, 60); assert.equal('privateValue' in report.initial.sceneStats, false);
  assert.equal(report.initial.sceneStats.frames, 70); assert.equal(report.initial.sceneTiming.frames, 123);
  assert.match(report.initial.pageStatus, /^World paused/); assert.match(report.initial.pageError, /^GPU failed/);
  assert.equal(report.initial.quality, 'Desktop 4x MSAA'); assert.equal(report.initial.reducedMotion, false);
  assert.equal(report.hiddenDuringCapture, true); assert.equal(report.stateChanges.length, 3);
  assert.equal(report.longAnimationFrames[0].scripts.length, 8); assert.equal(report.longAnimationFrames[0].scripts[0].sourceFunctionName, 'render');
  assert.equal(report.nativeCallbackHz, 100); assert.equal(report.callbackIntervals.medianMs, 10);
  assert.equal(report.canvasTextureAcquisitionsPerSecond, .05); assert.equal(report.queueSubmissions, 1);
  assert.equal(report.appCallbackCpu.maxMs, 2); assert.equal(b.clicked(), 1);
  assert.equal(JSON.stringify(report).includes('secret'), false); assert.equal(JSON.stringify(report).includes('token'), false);
  restored(b); b.frame(21000); assert.equal(called, 2); assert.equal(report.appCallbackCpu.samples, 2);
});
test('unsupported WebGPU stays unavailable and setup/download failures still restore hooks', async () => {
  for (const options of [{gpu: false, inheritedRequest: true}, {failObserver: true}, {failDownload: true}]) {
    const b = browser(options); b.finish(); const report = await b.window.margoPerformanceCapture;
    restored(b); assert.equal(report.nativeCallbackHz, null); assert.equal(report.callbackIntervals.medianMs, null);
    if (options.gpu === false) {assert.equal(report.initial.activeWebgpu, null); assert.equal(report.queueSubmissions, null);}
    if (options.failObserver) {assert.match(report.captureError, /Observer failed/); assert.equal(report.queueSubmissionsPerSecond, null);}
    if (options.failDownload) assert.match(report.downloadError, /Download failed/);
    assert.equal('gpuTime' in report, false);
  }
});
