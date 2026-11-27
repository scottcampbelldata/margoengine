// packages/shared/ambient-veil.js: the veils and the covered-depth handshake between Scatter and SSAO/GTAO
// (KB-SCATTER-AOFRINGE1). Each package bundles its own copy, so every state lives on the device.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addAmbientVeil,
  coverMarked,
  drawAmbientVeils,
  markCover,
  underWanted,
  wantUnder,
} from '../packages/shared/ambient-veil.js';

test('drawAmbientVeils skips the veils given and reports the ones that drew', () => {
  const device = {},
    calls = [],
    a = { veil: () => (calls.push('a'), true) },
    b = { veil: () => (calls.push('b'), false) },
    c = { veil: () => (calls.push('c'), true) };
  addAmbientVeil(device, a);
  addAmbientVeil(device, b);
  const leave = addAmbientVeil(device, c),
    drew = new Set();
  drawAmbientVeils({ device }, 'rgba16float', undefined, drew);
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual([...drew], [a, c]);
  calls.length = 0;
  drawAmbientVeils({ device }, 'rgba16float', drew);
  assert.deepEqual(calls, ['b'], 'the veils that drew earlier are not drawn twice');
  leave();
  calls.length = 0;
  drawAmbientVeils({ device }, 'rgba16float');
  assert.deepEqual(calls, ['a', 'b']);
});

test('wantUnder counts readers and its remover is idempotent', () => {
  const device = {};
  assert.equal(underWanted(device), false);
  const one = wantUnder(device),
    two = wantUnder(device);
  assert.equal(underWanted(device), true);
  one();
  one();
  assert.equal(underWanted(device), true, 'a second call of one remover does not remove the other reader');
  two();
  assert.equal(underWanted(device), false);
});

test('markCover holds for one frame, view and depth only', () => {
  const device = {},
    view = {},
    frame = { device, encoder: {}, view, depth: {} };
  assert.equal(coverMarked(frame), false);
  markCover(frame);
  assert.equal(coverMarked(frame), true);
  assert.equal(coverMarked({ ...frame, encoder: {} }), false, 'the next frame');
  assert.equal(coverMarked({ ...frame, view: {} }), false, 'another view');
  assert.equal(coverMarked({ ...frame, depth: {} }), false, 'another depth target');
});
