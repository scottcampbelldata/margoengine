import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { CurveEditor, CurveModel } from '../dist/curve-editor.js';
import { TimelineEditor, TimelineModel } from '../dist/editor.js';
const scene = () => ({
  format: 'margo-cutscene',
  version: 1,
  duration: 10,
  tracks: [
    {
      type: 'property',
      id: 'opacity',
      target: 'screen',
      property: 'opacity',
      keys: [
        { time: 0, value: 0 },
        { time: 4, value: 4 },
        { time: 8, value: 8 },
      ],
    },
    {
      type: 'transform',
      id: 'move',
      target: 'box',
      keys: [
        { time: 0, position: [0, 1, 2] },
        { time: 1, scale: [1, 1, 1] },
        { time: 8, position: [8, 9, 10] },
      ],
    },
    { type: 'audio', id: 'music', clips: [{ start: 2, duration: 4, sound: 'tone' }] },
  ],
});
test('curve moves time and value atomically across keys, with one undo and sparse component preservation', () => {
  const timeline = new TimelineModel(scene()),
    curve = new CurveModel(timeline),
    c = { track: 'move', field: 'position', component: 1 };
  assert.deepEqual(
    curve.points(c).map((p) => p.index),
    [0, 2],
  );
  const before = timeline.save(),
    ref = curve.moveKey(c, 0, 9, 12);
  assert.equal(ref.index, 2);
  assert.deepEqual(timeline.document.tracks[1].keys[2].position, [0, 12, 2]);
  assert.equal(timeline.history.undoCount, 1);
  timeline.undo();
  assert.equal(timeline.save(), before);
  timeline.redo();
  assert.equal(curve.points(c).at(-1).value, 12);
  assert.throws(() => curve.moveKey(c, 2, NaN, 0), /finite/);
});
test('Bezier control points shape the runtime, allow overshoot and clamp only x', () => {
  const timeline = new TimelineModel(scene()),
    curve = new CurveModel(timeline),
    c = { track: 'opacity', field: 'value' };
  curve.setHandle(c, 1, 0, -1, 2);
  curve.setHandle(c, 1, 1, 2, 2);
  assert.deepEqual(timeline.document.tracks[0].keys[1].ease, [0, 2, 1, 2]);
  assert.ok(timeline.cutscene().evaluate(2).properties.screen.opacity > 4);
  assert.throws(() => curve.setHandle(c, 0, 0, 0, 0), /preceding/);
  assert.throws(() => curve.setHandle(c, 1, 0, Infinity, 0), /finite/);
  timeline.undo();
  timeline.undo();
  assert.equal(timeline.document.tracks[0].keys[1].ease, undefined);
});
test('clip edge trims keep the opposite edge and validate before recording history', () => {
  const timeline = new TimelineModel(scene()),
    curve = new CurveModel(timeline),
    ref = { track: 'music', index: 0 };
  assert.equal(curve.resizeClip(ref, 'start', 3), true);
  assert.deepEqual(timeline.document.tracks[2].clips[0], { start: 3, duration: 3, sound: 'tone' });
  const before = timeline.save(),
    count = timeline.history.undoCount;
  assert.equal(curve.resizeClip(ref, 'end', 2), false);
  assert.equal(timeline.save(), before);
  assert.equal(timeline.history.undoCount, count);
  curve.resizeClip(ref, 'end', 20);
  assert.equal(timeline.document.tracks[2].clips[0].duration, 7);
  timeline.undo();
  timeline.undo();
  assert.equal(timeline.document.tracks[2].clips[0].start, 2);
});
test('graph channels include scalar camera and vector properties without easing coordinates', () => {
  const timeline = new TimelineModel(scene()),
    curve = new CurveModel(timeline);
  assert.equal(curve.channels.length, 7);
  assert.ok(curve.channels.every((c) => c.field !== 'ease' && c.field !== 'time'));
});

test('graph reconciles channels after undo, redo and removal of the selected track', (t) => {
  const dom = new JSDOM('<!doctype html><body></body>');
  for (const name of ['window', 'document', 'AbortController']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
    t.after(() => (previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]));
  }
  const editor = new TimelineEditor({ ...scene(), tracks: [] }, { parent: document.body });
  const opacity = scene().tracks[0];
  editor.model.addTrack(opacity);
  const graph = new CurveEditor(editor);
  t.after(() => {
    graph.dispose();
    editor.dispose();
    dom.window.close();
  });
  assert.equal(graph.channel?.track, 'opacity', 'new numeric channels become selectable');
  assert.equal(graph.element.querySelectorAll('[data-kind="key"]').length, 3);
  assert.doesNotThrow(() => editor.model.undo());
  assert.equal(graph.channel, undefined);
  assert.equal(graph.element.querySelector('select').selectedIndex, -1);
  assert.equal(graph.element.querySelectorAll('[data-kind="key"]').length, 0);
  assert.doesNotThrow(() => editor.model.redo());
  assert.equal(graph.channel?.track, 'opacity');
  editor.model.addTrack(scene().tracks[1]);
  graph.channel = { track: 'move', field: 'position', component: 1 };
  assert.doesNotThrow(() => editor.model.undo());
  assert.equal(graph.channel?.track, 'opacity', 'removed selection falls back to a remaining channel');
  assert.equal(graph.element.querySelector('select').selectedIndex, 0);
  graph.fit();
  assert.ok(
    [...graph.element.querySelectorAll('circle')].every((circle) => Number.isFinite(Number(circle.getAttribute('cy')))),
  );
});
