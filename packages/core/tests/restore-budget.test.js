import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../dist/extension.js';

// A renderer that keeps losing its device: every restore is counted and none succeeds in drawing for long.
async function engine() {
  const store = await TransformStore.create(8),
    renderer = { backend: 'webgpu', gpu: null, add() {}, remove() {}, render() {}, dispose() {} },
    e = new Engine({ width: 32, height: 32, clientWidth: 32, clientHeight: 32 }, store, renderer, undefined, null),
    restores = [],
    errors = [];
  e.rebootDevice = () => (restores.push(restores.length), Promise.resolve());
  e.onError = (error) => errors.push(error);
  return { e, renderer, restores, errors };
}

test('a device lost again and again is restored 3 times, then reported once with a coded error', async () => {
  const { e, renderer, restores, errors } = await engine();
  try {
    for (let k = 0; k < 6; k++) renderer.onLost(new Error('lost'));
    assert.equal(restores.length, 3, 'no fourth device is asked for');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, 'MargoError');
    assert.equal(errors[0].code, 'failed');
    assert.match(errors[0].message, /reload the page/);
  } finally {
    e.dispose();
  }
});

test('120 drawn frames after a restore give the device its 3 restores back', async () => {
  const { e, renderer, restores, errors } = await engine();
  try {
    for (let k = 0; k < 3; k++) renderer.onLost(new Error('lost'));
    for (let f = 0; f < 119; f++) e.render();
    renderer.onLost(new Error('lost'));
    assert.equal(restores.length, 3, '119 frames do not reset the count');
    assert.equal(errors.length, 1);
    const fresh = await engine();
    for (let k = 0; k < 2; k++) fresh.renderer.onLost(new Error('lost'));
    for (let f = 0; f < 120; f++) fresh.e.render();
    for (let k = 0; k < 3; k++) fresh.renderer.onLost(new Error('lost'));
    assert.equal(fresh.restores.length, 5, 'a full run of frames resets the count');
    assert.equal(fresh.errors.length, 0);
    fresh.e.dispose();
  } finally {
    e.dispose();
  }
});
