// The scene change recorder: diffSave and applyDelta round trips, the delta's shape, and failures on a wrong base.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSave, applyDelta, isEmptyDelta, SaveRecorder } from '../dist/delta.js';

const base = () => ({
  format: 'margo-save',
  version: 3,
  entities: [
    { id: 'door', name: 'Door', transform: { position: [1, 0, 0], scale: [1, 1, 1] }, components: { hinge: { angle: 0, limit: [0, 90] }, mesh: { url: 'door.glb' } } },
    { id: 'lamp', parent: 'door', components: { light: { color: [1, 1, 1], intensity: 2 } } },
    { id: 'crate', components: {} },
  ],
  meta: { title: 'Level 1', played: 10 },
});

test('an unchanged document gives an empty delta', () => {
  const delta = diffSave(base(), base());
  assert.ok(isEmptyDelta(delta));
  assert.deepEqual(delta, { format: 'margo-save-delta', version: 1, baseVersion: 3, added: [], removed: [], changed: {} });
});

test('edits are recorded as the smallest merge patches, and apply back to the edited document', () => {
  const edited = base();
  edited.entities[0].transform.position = [2, 0, 0]; // moved
  edited.entities[0].components.hinge.angle = 45; // one nested number
  delete edited.entities[0].components.mesh; // a component removed
  edited.entities[1].components.light.color = [1, 0, 0]; // an array replaced whole
  edited.entities.splice(2, 1); // crate deleted
  edited.entities.push({ id: 'key', name: 'Key', components: { pickup: { id: 7 } } }); // added
  edited.meta.played = 11;
  delete edited.meta.title;
  const delta = diffSave(base(), edited);
  assert.deepEqual(delta.changed, {
    door: { transform: { position: [2, 0, 0] }, components: { hinge: { angle: 45 }, mesh: null } },
    lamp: { components: { light: { color: [1, 0, 0] } } },
  });
  assert.deepEqual(delta.removed, ['crate']);
  assert.deepEqual(delta.added.map((e) => e.id), ['key']);
  assert.deepEqual(delta.meta, { played: 11, title: null });
  assert.ok(JSON.stringify(delta).length < JSON.stringify(edited).length, 'the delta is smaller than the document');
  assert.deepEqual(applyDelta(base(), JSON.parse(JSON.stringify(delta))), edited);
});

test('renames, reparenting and prefab overrides diff and apply', () => {
  const doc = { ...base(), prefabs: { chair: { entities: [{ id: 'seat', components: { a: 1 } }] } } };
  doc.entities.push({ id: 'c1', prefab: 'chair', overrides: { seat: { components: { a: 2 } } } });
  const edited = structuredClone(doc);
  edited.entities[1].parent = undefined;
  delete edited.entities[1].parent;
  edited.entities[0].name = 'Front door';
  edited.entities[3].overrides.seat.components.a = 3;
  const delta = diffSave(doc, edited);
  assert.deepEqual(delta.changed.lamp, { parent: null });
  assert.deepEqual(delta.changed.door, { name: 'Front door' });
  assert.deepEqual(delta.changed.c1, { overrides: { seat: { components: { a: 3 } } } });
  assert.deepEqual(applyDelta(doc, delta), edited);
});

test('the base is not modified, and a delta re-applies on a fresh copy of the base', () => {
  const edited = base();
  edited.entities[2].components.crate = { opened: true };
  const snapshot = JSON.stringify(base());
  const b = base();
  const delta = diffSave(b, edited);
  applyDelta(b, delta);
  assert.equal(JSON.stringify(b), snapshot);
  assert.deepEqual(applyDelta(base(), delta), edited);
});

test('a delta from another base, a wrong version, a null value or a bad result fails loudly', () => {
  const edited = base();
  edited.entities[0].name = 'x';
  const delta = diffSave(base(), edited);
  const other = base();
  other.entities.shift();
  assert.throws(() => applyDelta(other, delta), /changes "door"/);
  assert.throws(() => applyDelta({ ...base(), version: 4 }, delta), /version 3, not 4/);
  assert.throws(() => applyDelta(base(), { ...delta, format: 'x' }), /made by diffSave/);
  const adds = { ...delta, added: [{ id: 'door' }] };
  assert.throws(() => applyDelta(base(), adds), /already has/);
  const removes = { ...delta, removed: ['ghost'] };
  assert.throws(() => applyDelta(base(), removes), /removes "ghost"/);
  const nulled = base();
  nulled.entities[0].components.hinge.limit = null;
  assert.throws(() => diffSave(base(), nulled), /null/);
  const dup = base();
  dup.entities.push({ id: 'crate' });
  assert.throws(() => diffSave(base(), dup), /two entities with id "crate"/);
  const orphan = { ...delta, changed: { lamp: { parent: 'nobody' } } };
  assert.throws(() => applyDelta(base(), orphan), TypeError); // parseSave names the dangling parent
  assert.doesNotThrow(() => applyDelta(base(), orphan, { validate: false }));
});

test('SaveRecorder measures from its base, commits, and re-applies saved deltas', () => {
  const recorder = new SaveRecorder(base());
  const edited = base();
  edited.entities[0].components.hinge.angle = 90;
  const first = recorder.changes(edited);
  assert.deepEqual(first.changed.door, { components: { hinge: { angle: 90 } } });
  recorder.commit(edited);
  assert.ok(isEmptyDelta(recorder.changes(edited)));
  edited.entities[2].name = 'Crate';
  const second = recorder.changes(edited);
  assert.deepEqual(Object.keys(second.changed), ['crate']);
  assert.deepEqual(recorder.apply(second), edited);
  base().entities[0].components.hinge.angle; // the original document function is untouched by commit
  assert.equal(recorder.base.entities[0].components.hinge.angle, 90);
});
