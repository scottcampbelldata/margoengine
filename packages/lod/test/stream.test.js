// LevelStream with loaders held open by hand: what is fetched, when, and what the LODSystem shows meanwhile. Over HTTP on a real GPU: stream-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { LODSystem } from '@margoengine/lod';
import { LevelStream } from '@margoengine/lod/stream';

const headless = async () =>
  new Engine({ width: 64, height: 64, clientWidth: 64, clientHeight: 64 }, await TransformStore.create(256), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
/** A loader that waits for `finish()` or `fail()`, and records its signal. */
const held = (engine) => {
  const calls = [],
    load = (signal) =>
      new Promise((resolve, reject) => {
        const call = { signal, finish: () => resolve(engine.createMesh()), fail: (error) => reject(error) };
        signal.addEventListener('abort', () => reject(signal.reason));
        calls.push(call);
      });
  return { calls, load };
};
const tick = () => new Promise((resolve) => setTimeout(resolve));
/** One frame: the stream, then the system. */
const frame = (stream, system) => {
  stream.onPreUpdate();
  system.update();
};
const setup = async (options) => {
  const engine = await headless(),
    system = LODSystem.attach(engine),
    stream = LevelStream.attach(engine, options);
  return { engine, system, stream, anchor: engine.createMesh() };
};

test('a fine level loads when wanted, and the coarse level stays until it has', async () => {
  const { engine, system, stream, anchor } = await setup(),
    { calls, load } = held(engine),
    coarse = engine.createMesh(),
    fine = stream.level(load, { bytes: 10 }),
    lod = system.add(anchor, [{ object: fine }, { object: coarse, distance: 10 }], { radius: 1 });
  engine.camera.position = [0, 0, 50];
  frame(stream, system);
  assert.equal(lod.level, 1);
  assert.equal(calls.length, 0, 'far away nothing is fetched');
  engine.camera.position = [0, 0, 1];
  frame(stream, system);
  assert.equal(calls.length, 1);
  assert.equal(fine.state, 'loading');
  assert.equal(lod.level, 1, 'the coarse level holds');
  assert.equal(coarse.visible, true);
  calls[0].finish();
  await tick();
  assert.equal(fine.state, 'ready');
  frame(stream, system);
  assert.equal(lod.level, 0);
  assert.equal(coarse.visible, false);
  assert.equal(fine.object.visible, true);
  engine.dispose();
});

test('the first frame shows the nearest level that needs no fetch', async () => {
  const { engine, system, stream, anchor } = await setup(),
    { calls, load } = held(engine),
    coarse = engine.createMesh(),
    lod = system.add(anchor, [{ object: stream.level(load) }, { object: coarse, distance: 10 }], { radius: 1 });
  engine.camera.position = [0, 0, 1];
  frame(stream, system);
  assert.equal(lod.level, 1);
  assert.equal(calls.length, 1);
  engine.dispose();
});

test('with no level to show the object waits, then shows what arrives', async () => {
  const { engine, system, stream, anchor } = await setup(),
    { calls, load } = held(engine),
    fine = stream.level(load),
    lod = system.add(anchor, [{ object: fine }], { radius: 1 });
  frame(stream, system);
  assert.equal(lod.level, -1);
  calls[0].finish();
  await tick();
  frame(stream, system);
  assert.equal(lod.level, 0);
  engine.dispose();
});

test('at most `concurrency` fetch at once, the rest wait in order', async () => {
  const { engine, system, stream } = await setup({ concurrency: 2 }),
    { calls, load } = held(engine);
  for (let i = 0; i < 3; i++)
    system.add(engine.createMesh(), [{ object: stream.level(load) }, { object: engine.createMesh(), distance: 10 }], {
      radius: 1,
    });
  engine.camera.position = [0, 0, 1];
  frame(stream, system);
  assert.equal(calls.length, 2);
  assert.equal(stream.active, 2);
  calls[0].finish();
  await tick();
  assert.equal(calls.length, 3);
  engine.dispose();
});

test('a fetch nobody asks for any more is aborted and can start again', async () => {
  const { engine, system, stream, anchor } = await setup(),
    { calls, load } = held(engine),
    fine = stream.level(load);
  system.add(anchor, [{ object: fine }, { object: engine.createMesh(), distance: 10 }], { radius: 1 });
  engine.camera.position = [0, 0, 1];
  frame(stream, system);
  engine.camera.position = [0, 0, 50];
  for (let i = 0; i < 4; i++) frame(stream, system);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(fine.state, 'idle');
  await tick();
  assert.equal(stream.active, 0);
  engine.camera.position = [0, 0, 1];
  frame(stream, system);
  assert.equal(calls.length, 2);
  engine.dispose();
});

test('a failed level stays failed until retry, and the coarse level holds', async () => {
  const { engine, system, stream, anchor } = await setup(),
    { calls, load } = held(engine),
    coarse = engine.createMesh(),
    fine = stream.level(load),
    lod = system.add(anchor, [{ object: fine }, { object: coarse, distance: 10 }], { radius: 1 }),
    wrong = new Error('offline');
  engine.camera.position = [0, 0, 1];
  frame(stream, system);
  calls[0].fail(wrong);
  await tick();
  frame(stream, system);
  assert.equal(fine.state, 'failed');
  assert.equal(fine.error, wrong);
  assert.deepEqual(stream.failed, [fine]);
  assert.equal(calls.length, 1, 'no retry loop');
  assert.equal(lod.level, 1);
  fine.retry();
  assert.equal(fine.error, undefined);
  frame(stream, system);
  assert.equal(calls.length, 2);
  engine.dispose();
});

test('past maxBytes the longest unused levels go; a level on show stays', async () => {
  const { engine, system, stream } = await setup({ maxBytes: 25 }),
    { calls, load } = held(engine),
    levels = [0, 1, 2].map(() => stream.level(load, { bytes: 10 })),
    anchors = levels.map((level, i) => {
      const anchor = engine.createMesh().setPosition([i * 100, 0, 0]);
      system.add(anchor, [{ object: level }, { object: engine.createMesh(), distance: 10 }], { radius: 1 });
      return anchor;
    });
  assert.equal(anchors.length, 3);
  for (let i = 0; i < 3; i++) {
    engine.camera.position = [i * 100, 0, 1];
    engine.store.tick(false);
    frame(stream, system);
    calls[i].finish();
    await tick();
    frame(stream, system);
  }
  assert.equal(levels[2].visible, true);
  frame(stream, system);
  assert.equal(stream.resident, 20);
  assert.deepEqual(
    levels.map((level) => level.state),
    ['idle', 'ready', 'ready'],
  );
  stream.maxBytes = 0;
  frame(stream, system);
  assert.equal(levels[2].state, 'ready', 'on show, whatever it costs');
  assert.equal(levels[1].state, 'idle');
  engine.dispose();
});

test('a real object counts its vertices and indices', async () => {
  const { engine, stream, system, anchor } = await setup(),
    { box } = await import('../../core/dist/extension.js'),
    geometry = box(1, 1, 1),
    level = stream.level(async () => engine.createMesh().setGeometry(geometry));
  system.add(anchor, [{ object: level }], { radius: 1 });
  frame(stream, system);
  await tick();
  assert.equal(level.bytes, geometry.vertices.byteLength + geometry.indices.byteLength);
  engine.dispose();
});

test('options are checked, and dispose ends everything', async () => {
  assert.throws(() => new LevelStream({ concurrency: 0 }), RangeError);
  assert.throws(() => new LevelStream({ maxBytes: -1 }), RangeError);
  const { engine, stream, system, anchor } = await setup(),
    { calls, load } = held(engine);
  assert.throws(() => stream.level(3), TypeError);
  assert.throws(() => stream.level(load, { bytes: -1 }), RangeError);
  system.add(anchor, [{ object: stream.level(load) }], { radius: 1 });
  frame(stream, system);
  stream.dispose();
  assert.equal(calls[0].signal.aborted, true);
  engine.dispose();
});
