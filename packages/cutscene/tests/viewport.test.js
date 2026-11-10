import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyTransform, ViewportKeying } from '../dist/viewport.js';
import { TimelineModel } from '../dist/editor.js';
const document = () => ({ format: 'margo-cutscene', version: 1, duration: 10, tracks: [] });
test('viewport attachment checks cancellation before loading or owning resources', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancel attach'));
  await assert.rejects(ViewportKeying.attach(null, null, null, { signal: controller.signal }), /cancel attach/);
  let disposed = false;
  await assert.rejects(ViewportKeying.attach({}, {}, {}, { gizmo: { engine: {}, inspector: {}, dispose() { disposed = true; } } }), /belong/);
  assert.equal(disposed, false, 'a refused borrowed gizmo is never disposed');
});
test('viewport keying creates, inserts, replaces exact times and undoes each whole key', () => {
  const model = new TimelineModel(document()),
    key = { time: 4, position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1], ease: 'smoothstep' };
  keyTransform(model, 'hero', 'hero', key);
  key.position[0] = 9;
  assert.equal(model.document.tracks[0].keys[0].position[0], 1);
  keyTransform(model, 'hero', 'hero', { time: 2, position: [3, 2, 1] });
  assert.deepEqual(
    model.document.tracks[0].keys.map((k) => k.time),
    [2, 4],
  );
  keyTransform(model, 'hero', 'hero', { time: 4, position: [4, 5, 6] });
  assert.equal(model.document.tracks[0].keys.length, 2);
  assert.equal(model.document.tracks[0].keys[1].ease, 'smoothstep');
  model.undo();
  assert.deepEqual(model.document.tracks[0].keys[1].position, [1, 2, 3]);
  model.undo();
  model.undo();
  assert.deepEqual(model.document.tracks, []);
  model.redo();
  assert.equal(model.document.tracks.length, 1);
});
test('invalid transforms and mismatched targets refuse without editing history', () => {
  const model = new TimelineModel(document());
  assert.throws(() => keyTransform(model, 'bad', 'hero', { time: 1, rotation: [0, 0, 0, 0] }), /refused/);
  assert.deepEqual(model.document.tracks, []);
  assert.equal(model.history.undoCount, 0);
  keyTransform(model, 'hero', 'hero', { time: 0, position: [0, 0, 0] });
  const before = model.save();
  assert.throws(() => keyTransform(model, 'hero', 'other', { time: 0, position: [1, 0, 0] }), /matching/);
  assert.throws(() => keyTransform(model, 'hero', 'hero', { time: 0, scale: [NaN, 1, 1] }), /refused/);
  assert.equal(model.save(), before);
});
