import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cutscene } from '../dist/index.js';
import { TimelineModel, MARKERS } from '../dist/editor.js';
import { discreteTrack, discreteOf } from '../dist/nested-editor.js';
const scene = () => ({
  format: 'margo-cutscene',
  version: 1,
  duration: 10,
  tracks: [
    { type: 'timeline', id: 'nest', clips: [{ start: 2, duration: 4, timeline: 'child', speed: 2, offset: 1 }] },
  ],
  timelines: {
    child: {
      duration: 10,
      tracks: [
        {
          type: 'property',
          id: 'value',
          target: 'box',
          property: 'x',
          keys: [
            { time: 0, value: 0 },
            { time: 10, value: 10 },
          ],
        },
        {
          type: 'discrete',
          id: 'flag',
          target: 'box',
          property: 'visible',
          keys: [
            { time: 0, value: false },
            { time: 3, value: true },
            { time: 7, value: false },
          ],
        },
        {
          type: 'discrete',
          id: 'label',
          target: 'box',
          property: 'text',
          keys: [
            { time: 0, value: 'start' },
            { time: 4, value: 'middle' },
            { time: 8, value: 'end' },
          ],
        },
      ],
    },
  },
});
const options = () => ({ tracks: [discreteTrack()] });
test('discrete values hold to exact key boundaries, nested offset/speed and arbitrary seek order', () => {
  const cutscene = new Cutscene(scene(), options());
  for (const [time, flag, label] of [
    [2, false, 'start'],
    [3, true, 'start'],
    [3.5, true, 'middle'],
    [5, false, 'middle'],
    [5.5, false, 'end'],
    [2.999999, false, 'start'],
  ]) {
    const state = discreteOf(cutscene.evaluate(time));
    assert.equal(state.box.visible, flag);
    assert.equal(state.box.text, label);
  }
  assert.equal(discreteOf(cutscene.evaluate(6)).box, undefined, 'nested clip end is exclusive');
  const d = scene();
  d.timelines.child.tracks[1].keys.push({ time: 7, value: true });
  assert.equal(discreteOf(new Cutscene(d, options()).evaluate(5)).box.visible, true, 'last duplicate wins');
});
test('nested views edit the root definition with one history and global undo/redo', () => {
  const root = new TimelineModel(scene(), options()),
    child = root.nested('child'),
    before = root.save();
  let changes = 0;
  const off = child.on('change', () => changes++);
  assert.equal(child.history, root.history);
  child.begin('nested gesture');
  child.moveItems([{ track: 'value', index: 0 }], 1);
  child.setItem({ track: 'value', index: 0 }, { value: 2 });
  child.commit();
  assert.equal(root.history.undoCount, 1);
  assert.equal(root.document.timelines.child.tracks[0].keys[0].value, 2);
  assert.equal(root.cutscene().evaluate(2).properties.box.x, 2);
  root.undo();
  assert.equal(root.save(), before);
  assert.equal(child.document.tracks[0].keys[0].time, 0);
  root.redo();
  assert.equal(child.document.tracks[0].keys[0].value, 2);
  assert.ok(changes >= 4);
  off();
  child.addKey(MARKERS, 5, { name: 'local' });
  assert.equal(root.document.timelines.child.markers[0].time, 5);
  root.undo();
  assert.equal(child.document.markers, undefined);
});
test('nested keying samples discrete values and every rejected change preserves the root', () => {
  const root = new TimelineModel(scene(), options()),
    child = root.nested('child');
  const ref = child.addKey('label', 5);
  assert.equal(child.document.tracks[2].keys[ref.index].value, 'middle');
  const before = root.save();
  assert.equal(child.setItem(ref, { value: true }), false);
  assert.equal(root.save(), before);
  assert.equal(child.setDuration(5), false);
  assert.equal(root.save(), before);
  assert.equal(
    root.setTimeline('child', {
      duration: 10,
      tracks: [{ type: 'timeline', id: 'cycle', clips: [{ start: 0, duration: 2, timeline: 'child' }] }],
    }),
    false,
  );
  assert.equal(root.save(), before);
  assert.throws(() => root.nested('missing'), /No nested/);
});
test('discrete validation rejects mixed types, unordered/empty keys, easing and invalid times', () => {
  for (const keys of [
    [
      { time: 0, value: false },
      { time: 2, value: 'text' },
    ],
    [],
    [
      { time: 2, value: 'a' },
      { time: 1, value: 'b' },
    ],
    [{ time: 0, value: 1 }],
    [{ time: 0, value: 'a', ease: 'linear' }],
    [{ time: -1, value: 'a' }],
  ]) {
    const doc = scene();
    doc.timelines.child.tracks[2].keys = keys;
    assert.throws(() => new Cutscene(doc, options()));
  }
});
test('literal dictionary names remain own data and scopes ignore removed definitions', () => {
  const root = new TimelineModel({ format: 'margo-cutscene', version: 1, duration: 10, tracks: [] }, options());
  assert.throws(() => root.nested('toString'), /No nested/);
  assert.equal(root.setTimeline('__proto__', { duration: 2, tracks: [] }), true);
  const child = root.nested('__proto__');
  let calls = 0;
  child.on('change', () => calls++);
  root.undo();
  assert.equal(calls, 0);
  assert.throws(() => child.duration, /removed/);
  const doc = {
    format: 'margo-cutscene',
    version: 1,
    duration: 2,
    tracks: [
      {
        type: 'discrete',
        id: 'd',
        target: '__proto__',
        property: 'constructor',
        keys: [{ time: 0, value: 'literal' }],
      },
    ],
  };
  const values = discreteOf(new Cutscene(doc, options()).evaluate(0));
  assert.equal(values.__proto__.constructor, 'literal');
  assert.equal(Object.getPrototypeOf(values), null);
});
