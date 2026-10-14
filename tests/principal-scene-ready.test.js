import test from 'node:test';
import assert from 'node:assert/strict';
import {submitPrincipalScene} from '../packages/shared/demo-frame.js';

function harness() {
  let time = 100, index = 0, finish, waits = 0; const frames = new Map(), calls = [];
  const queue = {submit(...args) {assert.equal(this, queue); calls.push(args);}, onSubmittedWorkDone: () => {waits++; return new Promise(resolve => {finish = resolve;});}};
  const options = {now: () => time, request(callback) {frames.set(++index, callback); return index;}, cancel: id => frames.delete(id)};
  return {queue, options, frames, calls, waits: () => waits, complete: () => finish(), at: value => {time = value;}, frame() {const [id, callback] = frames.entries().next().value; frames.delete(id); callback();}};
}
const flush = async () => {await Promise.resolve(); await Promise.resolve();};

test('principal readiness follows its own submit, GPU completion and two later frame opportunities', async () => {
  const h = harness(), original = Object.getOwnPropertyDescriptor(h.queue, 'submit'); h.queue.submit(['earlier sky']);
  const pending = submitPrincipalScene(() => {h.at(200); h.queue.submit(['complete scene']);}, h.queue, h.options);
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.queue, 'submit'), original); assert.deepEqual(h.calls, [[['earlier sky']], [['complete scene']]]);
  assert.equal(h.frames.size, 0); h.at(250); h.complete(); await flush(); assert.equal(h.frames.size, 1);
  h.at(270); h.frame(); assert.equal(h.frames.size, 1); h.at(290); h.frame();
  assert.deepEqual(await pending, {principalSceneSubmitted: 200, principalSceneGpuComplete: 250, principalScenePresentedOpportunity: 290, correlation: 'identified-webgpu-submit'});
});

test('a preparatory submission cannot outrun the final assembled-scene submission', async () => {
  const h = harness(), original = h.queue.submit;
  const pending = submitPrincipalScene(() => {
    h.at(130); h.queue.submit(['preparatory copy']); assert.equal(h.waits(), 0);
    h.at(190); h.queue.submit(['assembled scene']); assert.equal(h.waits(), 0);
  }, h.queue, h.options);
  assert.equal(h.waits(), 1); assert.equal(h.queue.submit, original);
  h.at(230); h.complete(); await flush(); h.frame(); h.at(260); h.frame();
  assert.equal((await pending).principalSceneSubmitted, 190);
});

test('empty/failed renders restore hooks and do not claim a principal GPU scene', async () => {
  const h = harness(), original = Object.getOwnPropertyDescriptor(h.queue, 'submit');
  await assert.rejects(submitPrincipalScene(() => {}, h.queue, h.options), /did not submit/);
  await assert.rejects(submitPrincipalScene(() => {throw new Error('Render failed');}, h.queue, h.options), /Render failed/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.queue, 'submit'), original); assert.equal(h.frames.size, 0);
});

test('page cancellation clears pending frames and cannot publish a late completion', async () => {
  for (const afterGpu of [false, true]) {
    const h = harness(), controller = new AbortController(); h.options.signal = controller.signal;
    const pending = submitPrincipalScene(() => h.queue.submit(['scene']), h.queue, h.options);
    if (afterGpu) {h.complete(); await flush(); h.frame();}
    const failed = assert.rejects(pending, /Page closed/); controller.abort(new Error('Page closed')); await failed;
    if (!afterGpu) {h.complete(); await flush();} assert.equal(h.frames.size, 0);
  }
});

test('WebGL fallback records a frame opportunity without inventing a GPU submission/completion', async () => {
  const h = harness(); let renders = 0; const pending = submitPrincipalScene(() => renders++, undefined, h.options);
  await flush(); h.frame(); h.at(150); h.frame(); const result = await pending;
  assert.equal(renders, 1); assert.equal(result.principalSceneSubmitted, null); assert.equal(result.principalSceneGpuComplete, null);
  assert.equal(result.principalScenePresentedOpportunity, 150); assert.equal(result.correlation, 'webgl-render-return');
});
