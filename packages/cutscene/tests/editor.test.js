import assert from 'node:assert/strict';
import test from 'node:test';
import { Cutscene, EASING_NAMES, validateCutscene } from '@margoengine/cutscene';
import { MARKERS, TimelineModel } from '@margoengine/cutscene/editor';
import { shotTrack } from '@margoengine/cutscene/shots';

const scene = () => ({
  format: 'margo-cutscene',
  version: 1,
  duration: 10,
  markers: [{ time: 5, name: 'reveal' }],
  tracks: [
    {
      type: 'camera',
      id: 'cam',
      path: 'linear',
      keys: [
        { time: 0, position: [0, 0, 5], target: [0, 0, 0] },
        { time: 4, position: [4, 0, 5], target: [0, 0, 0], fov: 40 },
      ],
    },
    { type: 'transform', id: 'door', target: 'door', keys: [{ time: 1, position: [0, 0, 0] }, { time: 3, position: [2, 0, 0] }] },
    { type: 'property', id: 'fade', target: 'screen', property: 'opacity', keys: [{ time: 0, value: 1 }, { time: 2, value: 0 }] },
    { type: 'event', id: 'cues', events: [{ time: 2, name: 'bang' }] },
    { type: 'audio', id: 'music', clips: [{ start: 1, duration: 3, sound: 'theme' }] },
  ],
});
const rowOf = (model, track) => model.rows.find((row) => row.track === track);
const times = (model, track) => rowOf(model, track).items.map((item) => item.time);

test('rows show every track and the markers, with what each item is', () => {
  const rows = new TimelineModel(scene()).rows;
  assert.deepEqual(rows.map((row) => row.track), ['cam', 'door', 'fade', 'cues', 'music', MARKERS]);
  assert.deepEqual(rows.map((row) => row.keyable), [true, true, true, true, false, true]);
  assert.deepEqual(rows[3].items[0], { track: 'cues', index: 0, kind: 'event', time: 2, duration: 0, label: 'bang' });
  assert.deepEqual(rows[4].items[0], { track: 'music', index: 0, kind: 'clip', time: 1, duration: 3, label: 'theme' });
  assert.deepEqual(rows[5].items[0], { track: MARKERS, index: 0, kind: 'marker', time: 5, duration: 0, label: 'reveal' });
  assert.equal(rows[1].label, 'door');
});

test('a new key holds what the track gives there, so the scene does not change', () => {
  const model = new TimelineModel(scene()),
    before = model.cutscene();
  const door = model.addKey('door', 2),
    fade = model.addKey('fade', 0.5),
    cam = model.addKey('cam', 1);
  assert.deepEqual(door, { track: 'door', index: 1 });
  assert.deepEqual(fade, { track: 'fade', index: 1 });
  assert.deepEqual(cam, { track: 'cam', index: 1 });
  const after = model.cutscene();
  // Keys on straight lines leave every time as it was, not only their own; 1e-12 is rounding on these sizes.
  for (let t = 0; t <= 10; t += 0.25) {
    const a = before.evaluate(t),
      b = after.evaluate(t);
    a.camera.position.forEach((value, i) => assert.ok(Math.abs(value - b.camera.position[i]) < 1e-12, `camera at ${t}`));
    assert.ok(Math.abs(a.camera.fov - b.camera.fov) < 1e-12, `fov at ${t}`);
    a.transforms.door.position.forEach((value, i) => assert.ok(Math.abs(value - b.transforms.door.position[i]) < 1e-12, `door at ${t}`));
    assert.ok(Math.abs(a.properties.screen.opacity - b.properties.screen.opacity) < 1e-12, `fade at ${t}`);
  }
  assert.deepEqual(times(model, 'door'), [1, 2, 3]);
  // Fields replace what was sampled.
  const set = model.addKey('fade', 1, { value: 0.25 });
  assert.equal(model.document.tracks[2].keys[set.index].value, 0.25);
});

test('events and markers add with a name; clips add whole', () => {
  const model = new TimelineModel(scene());
  assert.deepEqual(model.addKey('cues', 1, { name: 'flash' }), { track: 'cues', index: 0 });
  assert.deepEqual(model.addKey(MARKERS, 7, { name: 'end' }), { track: MARKERS, index: 1 });
  assert.throws(() => model.addKey('music', 2), /holds clips/);
  assert.deepEqual(model.addItem('music', { start: 5, duration: 1, sound: 'sting' }), { track: 'music', index: 1 });
  assert.throws(() => model.addItem('music', { start: 5, duration: -1, sound: 'x' }), /refused/);
  assert.throws(() => model.addKey('nope', 1), /No track/);
  assert.throws(() => model.addKey('cam', 11), /outside the timeline/);
  assert.throws(() => model.addKey('cam', Number.NaN), /finite/);
  assert.deepEqual(model.document.markers.map((marker) => marker.name), ['reveal', 'end']);
});

test('moves keep lists sorted and give refs that follow the items', () => {
  const model = new TimelineModel(scene()),
    [moved] = model.moveItems([{ track: 'door', index: 0 }], 3);
  assert.deepEqual(moved, { track: 'door', index: 1 });
  assert.deepEqual(times(model, 'door'), [3, 4]);
  // Clips move by their start, markers and events by their time, all at once.
  model.moveItems([{ track: 'music', index: 0 }, { track: MARKERS, index: 0 }, { track: 'cues', index: 0 }], 1);
  assert.deepEqual([times(model, 'music'), times(model, MARKERS), times(model, 'cues')], [[2], [6], [3]]);
});

test('a group stops at the ends of the timeline together, keeping its shape', () => {
  const model = new TimelineModel(scene()),
    group = [{ track: 'door', index: 0 }, { track: 'door', index: 1 }];
  model.moveItems(group, -5);
  assert.deepEqual(times(model, 'door'), [0, 2]);
  model.moveItems(group, 50);
  assert.deepEqual(times(model, 'door'), [8, 10]);
  // A clip stops with its end on the end of the timeline.
  model.moveItems([{ track: 'music', index: 0 }], 50);
  assert.deepEqual(times(model, 'music'), [7]);
});

test('undo and redo walk every kind of edit, and the document stays valid at each step', () => {
  const model = new TimelineModel(scene()),
    states = [model.save()],
    step = (edit) => {
      edit();
      states.push(model.save());
    };
  step(() => model.addKey('door', 2));
  step(() => model.moveItems([{ track: 'door', index: 0 }], 0.5));
  step(() => model.deleteItems([{ track: 'cues', index: 0 }]));
  step(() => model.setItem({ track: 'fade', index: 1 }, { value: 0.5, ease: 'easeInOutCubic' }));
  step(() => model.setDuration(12));
  for (let i = states.length - 2; i >= 0; i--) {
    model.undo();
    assert.equal(model.save(), states[i]);
    assert.deepEqual(validateCutscene(model.document, EASING_NAMES), []);
  }
  for (let i = 1; i < states.length; i++) {
    model.redo();
    assert.equal(model.save(), states[i]);
  }
});

test('a begun run undoes as one, and one that changed nothing leaves no step', () => {
  const model = new TimelineModel(scene());
  model.begin('Move');
  let refs = [{ track: 'door', index: 0 }];
  for (let i = 0; i < 20; i++) refs = model.moveItems(refs, 0.05);
  model.commit();
  assert.deepEqual(times(model, 'door'), [2, 3]);
  assert.equal(model.history.undoCount, 1);
  assert.equal(model.history.nextUndo, 'Move');
  model.undo();
  assert.deepEqual(times(model, 'door'), [1, 3]);
  model.begin('Nothing');
  model.commit();
  assert.equal(model.history.undoCount, 0);
  assert.throws(() => model.commit(), /No edit is open/);
  model.begin('Twice');
  assert.throws(() => model.begin('Again'), /already open/);
});

test('what the document refuses is refused whole: two shots may not overlap, a track keeps a key', () => {
  const document = {
    format: 'margo-cutscene',
    version: 1,
    duration: 10,
    tracks: [
      {
        type: 'shot',
        id: 'edit',
        cameras: { a: { position: [0, 0, 5], target: [0, 0, 0] }, b: { position: [5, 0, 0], target: [0, 0, 0] } },
        clips: [{ start: 0, duration: 2, camera: 'a' }, { start: 2, duration: 2, camera: 'b' }],
      },
    ],
  };
  const model = new TimelineModel(document, { tracks: [shotTrack()] }),
    ref = { track: 'edit', index: 0 },
    text = model.save();
  assert.deepEqual(model.moveItems([ref], 1), [ref], 'the refs come back as they were');
  assert.equal(model.save(), text);
  assert.equal(model.history.undoCount, 0);
  assert.equal(model.setItem(ref, { duration: 5 }), false);
  assert.equal(model.save(), text);
  assert.equal(model.setDuration(1), false, 'a clip would fall outside');
  assert.equal(model.setItem(ref, { duration: 1 }), true);
  assert.equal(model.cutscene().evaluate(1).camera !== null, true);
  const plain = new TimelineModel(scene());
  assert.equal(plain.deleteItems([{ track: 'door', index: 0 }, { track: 'door', index: 1 }]), false, 'a key track needs a key');
  assert.equal(plain.history.undoCount, 0);
});

test('snap pulls to items, then the grid, and leaves out what is dragged', () => {
  const model = new TimelineModel(scene());
  assert.equal(model.snap(2.97), 3, 'a key');
  assert.equal(model.snap(1.04), 1, 'a clip start');
  assert.equal(model.snap(4.03), 4, 'a clip end');
  assert.equal(model.snap(9.98), 10, 'the end of the timeline');
  assert.equal(model.snap(6.72), 6.7, 'the grid');
  assert.equal(model.snap(6.72, { step: 0 }), 6.72, 'no grid');
  assert.equal(model.snap(2.97, { reach: 0, step: 0.5 }), 3, 'no pull, a coarser grid');
  assert.equal(model.snap(2.97, { ignore: [{ track: 'door', index: 1 }], step: 0.25 }), 3, 'the clip end pulls no more, the grid does');
  assert.equal(model.snap(6.52, { times: [6.5] }), 6.5, 'a given time');
  assert.equal(model.snap(0.3), 0.3, 'grid times stay tidy');
});

test('change fires for each edit, undo and redo included, and stops on unsubscribe', () => {
  const model = new TimelineModel(scene()),
    seen = [],
    off = model.on('change', (label) => seen.push(label));
  model.addKey('door', 2);
  model.moveItems([{ track: 'door', index: 1 }], 0.25);
  model.undo();
  model.redo();
  model.moveItems([{ track: 'door', index: 1 }], 0);
  assert.deepEqual(seen, ['Add', 'Move', 'Move', 'Move']);
  off();
  model.undo();
  assert.equal(seen.length, 4);
  assert.throws(() => model.on('nope', () => {}), /no 'nope' event/);
});

test('the file reads back as the same cutscene, and the input is left alone', () => {
  const source = scene(),
    frozen = JSON.stringify(source),
    model = new TimelineModel(source);
  model.moveItems([{ track: 'door', index: 0 }], 0.1);
  assert.equal(JSON.stringify(source), frozen);
  const saved = new Cutscene(model.save());
  assert.deepEqual(saved.evaluate(2), model.cutscene().evaluate(2));
  assert.deepEqual(JSON.parse(JSON.stringify(model)), model.document);
  assert.equal(model.document.tracks[1].keys[0].time, 1.1);
  // A copy: changing it changes nothing here.
  model.document.tracks[1].keys[0].time = 9;
  assert.equal(times(model, 'door')[0], 1.1);
});

test('any run of edits keeps the document valid, and undoing them all gives the start back', () => {
  let seed = 12345;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff,
    model = new TimelineModel(scene()),
    start = model.save(),
    tracks = ['cam', 'door', 'fade', 'cues', MARKERS, 'music'],
    pick = () => {
      const row = rowOf(model, tracks[Math.floor(random() * tracks.length)]);
      return row.items.length ? { track: row.track, index: Math.floor(random() * row.items.length) } : null;
    };
  for (let i = 0; i < 300; i++) {
    const ref = pick(),
      roll = random();
    if (roll < 0.4 && ref) model.moveItems([ref], (random() - 0.5) * 6);
    else if (roll < 0.7) {
      const track = tracks[Math.floor(random() * 5)];
      model.addKey(track, random() * 10);
    } else if (ref) model.deleteItems([ref]);
    assert.deepEqual(validateCutscene(model.document), [], `edit ${i}`);
    for (const row of model.rows)
      row.items.forEach((item, k) => {
        assert.ok(item.time >= 0 && item.time + item.duration <= 10 + 1e-9, `${row.track} in range after edit ${i}`);
        if (k) assert.ok(item.time >= row.items[k - 1].time, `${row.track} sorted after edit ${i}`);
      });
  }
  // The stack keeps the last 200, so go back in a model with room.
  const roomy = new TimelineModel(scene());
  for (let i = 0; i < 100; i++) roomy.moveItems([{ track: 'door', index: 0 }], 0.01);
  for (let i = 0; i < 100; i++) roomy.undo();
  assert.equal(roomy.save(), start);
});
