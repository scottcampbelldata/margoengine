import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../dist/index.js';
import { GrowableWorld } from '../dist/growable.js';
import { ObjectComponent, objectField } from '../dist/objects.js';
import { WorldSerializer, createDelta, applyDelta } from '../dist/serialize.js';
import { encodeGraph, decodeGraph } from '../src/serialize-codec.ts';

function setup(WorldType = World, capacity = 8) {
  const world = new WorldType(capacity);
  const position = world.component({ x: Float64Array, y: Int32Array, flag: Uint8Array });
  const object = new ObjectComponent(world, { value: objectField() });
  const tag = world.tag(),
    extra = world.component({ untouched: Float32Array });
  return { world, position, object, tag, extra, codec: new WorldSerializer(world, { position, object, tag }) };
}
test('binary snapshots preserve chosen fields, tags, empty entities, observers and safe generational mappings', async () => {
  const s = setup(),
    t = setup();
  const stale = s.world.create();
  s.world.destroy(stale);
  const one = s.world.create(),
    empty = s.world.create();
  s.position.add(one, { x: -0, y: -2147483648, flag: 255 });
  s.tag.add(one);
  const shared = { message: 'こんにちは', nested: [undefined, null, 2n] };
  shared.self = shared;
  s.object.add(one, { value: shared });
  s.object.add(empty, { value: shared });
  const packet = await s.codec.snapshot();
  assert.equal(packet[0], 69);
  const additions = [];
  t.position.observers.push({
    onAdd: (e) => additions.push(t.position.fields.flag[t.position.index(e)]),
    onRemove() {},
    onChange() {},
  });
  let map = await t.codec.restore(packet);
  assert.notEqual(map.get(one), one);
  assert.equal(t.world.alive(stale), true);
  assert.deepEqual(additions, [255]);
  assert.equal(Object.is(t.position.fields.x[t.position.index(map.get(one))], -0), true);
  const v = t.object.fields.value[t.object.index(map.get(one))];
  assert.equal(v.self, v);
  assert.equal(v, t.object.fields.value[t.object.index(map.get(empty))]);
  assert.equal(v.message, shared.message);
  assert.equal(t.tag.has(map.get(one)), true);
  t.extra.add(map.get(empty), { untouched: 9 });
  s.world.destroy(one);
  s.object.remove(empty);
  map = await t.codec.restore(await s.codec.snapshot(), { entities: map });
  assert.equal(map.size, 1);
  assert.equal(t.world.alive(map.get(empty)), true);
  assert.equal(t.extra.fields.untouched[t.extra.index(map.get(empty))], 9);
  assert.equal(t.object.size, 0);
  assert.equal(t.position.size, 0);
});

test('portable graph covers shared buffers, holes, maps, sets, specials, dates and explicit app codecs', () => {
  const buffer = new ArrayBuffer(16),
    view = new Float32Array(buffer, 4, 2),
    bytes = new Uint8Array(buffer);
  view[0] = 3.5;
  const root = {
    view,
    bytes,
    data: new DataView(buffer),
    nullObject: Object.create(null),
    array: [1, , undefined],
    special: [NaN, Infinity, -Infinity, -0, 19n],
    date: new Date(12345),
    regex: /hello/giu,
  };
  root.regex.lastIndex = 2;
  root.map = new Map([[root, root.array]]);
  root.set = new Set([root]);
  Object.defineProperty(root.nullObject, '__proto__', { value: root, enumerable: true });
  const restored = decodeGraph(encodeGraph(root));
  assert.equal(restored.view.buffer, restored.bytes.buffer);
  assert.equal(restored.data.buffer, restored.bytes.buffer);
  assert.equal(restored.view[0], 3.5);
  assert.equal(1 in restored.array, false);
  assert.equal(restored.map.get(restored), restored.array);
  assert.equal(restored.set.has(restored), true);
  assert.equal(Object.getPrototypeOf(restored.nullObject), null);
  assert.equal(restored.nullObject.__proto__, restored);
  assert.equal(restored.date.getTime(), 12345);
  assert.equal(restored.regex.lastIndex, 2);
  assert.deepEqual(restored.special, root.special);
  const action = () => 7;
  const codecs = [
    { name: 'action', test: (v) => typeof v === 'function', encode: () => 'action', decode: () => action },
  ];
  assert.equal(decodeGraph(encodeGraph([action, action], codecs), codecs)[0], action);
  assert.throws(() => encodeGraph(action), /portable/);
  assert.throws(
    () =>
      encodeGraph({
        get execute() {
          throw new TypeError('must not run');
        },
      }),
    /portable/,
  );
  assert.throws(() => encodeGraph({ value: Symbol() }), /portable/);
  assert.throws(() => decodeGraph(encodeGraph(action, codecs)), /portable/);
  assert.throws(() => encodeGraph({}, [...codecs, ...codecs]), /portable/);
});

test('delta transport is baseline checked, reversible, sparse and reconstructs exact snapshot bytes', async () => {
  const s = setup(World, 700);
  let random = 123456;
  const entities = Array.from({ length: 512 }, () => {
    const e = s.world.create();
    random = (Math.imul(random, 1664525) + 1013904223) | 0;
    s.position.add(e, { x: random / 300, y: random, flag: random >>> 24 });
    return e;
  });
  const before = await s.codec.snapshot();
  s.position.fields.x[s.position.index(entities[200])] += 0.25;
  const after = await s.codec.snapshot(),
    delta = await createDelta(before, after);
  assert.ok(
    delta.length < after.length,
    'one changed block transfers fewer bytes than this incompressible full snapshot',
  );
  const restored = await applyDelta(before, delta);
  assert.deepEqual(restored, after);
  const undo = await createDelta(after, before);
  assert.deepEqual(await applyDelta(after, undo), before);
  await assert.rejects(applyDelta(after, delta), /snapshot|schema/);
  const emptyDelta = await createDelta(before, before);
  assert.deepEqual(await applyDelta(before, emptyDelta), before);
  for (const end of [0, 1, 3, 4, 5, delta.length - 1]) await assert.rejects(applyDelta(before, delta.subarray(0, end)));
  const corrupt = delta.slice();
  corrupt[corrupt.length - 3] ^= 255;
  await assert.rejects(applyDelta(before, corrupt));
});

test('invalid schema, finite numeric contracts and capacity failures leave entity state unchanged', async () => {
  const s = setup(World, 4),
    target = setup(World, 1);
  const a = s.world.create(),
    b = s.world.create();
  s.position.add(a, { x: 3 });
  s.tag.add(b);
  const e = target.world.create();
  target.position.add(e, { x: 17 });
  const packet = await s.codec.snapshot();
  await assert.rejects(target.codec.restore(packet), /capacity|exhausted/);
  assert.equal(target.world.alive(e), true);
  assert.equal(target.position.fields.x[0], 17);
  const other = new WorldSerializer(s.world, { renamed: s.position });
  await assert.rejects(other.restore(packet), /schema/);
  assert.equal(s.position.fields.x[0], 3);
  s.position.fields.x[0] = NaN;
  await assert.rejects(s.codec.snapshot(), /finite/);
  s.position.fields.x[0] = 3;
  await assert.rejects(s.codec.snapshot({ maxBytes: 16 }), /limit/);
  for (const end of [0, 1, 3, 4, 5, packet.length - 1]) await assert.rejects(s.codec.restore(packet.subarray(0, end)));
  assert.equal(s.position.fields.x[0], 3);
});

test('growable restore reserves capacity before mutation and restores fully supplied object rows without factories', async () => {
  const s = setup(World, 8);
  for (let i = 0; i < 6; i++) {
    const e = s.world.create();
    s.position.add(e, { x: i });
  }
  const w = new GrowableWorld({ capacity: 1, limit: 8 });
  const position = w.component({ x: Float64Array, y: Int32Array, flag: Uint8Array });
  const object = new ObjectComponent(w, {
    value: objectField(() => {
      throw new TypeError('factory must not run for supplied field');
    }),
  });
  const tag = w.tag(),
    codec = new WorldSerializer(w, { position, object, tag });
  assert.equal((await codec.restore(await s.codec.snapshot())).size, 6);
  assert.equal(w.capacity, 8);
  const source = s.world.create();
  s.object.add(source, { value: 'provided' });
  const map = await codec.restore(await s.codec.snapshot());
  assert.equal(object.fields.value[object.index(map.get(source))], 'provided');
  const e = w.create(),
    out = new Uint32Array(w.capacity);
  assert.equal(w.entities(out), 8);
  assert.throws(() => w.entities(new Uint32Array(0)), /small/);
  assert.equal(w.available, 0);
  assert.throws(() => w.reserve(-1), /reservation/);
  w.destroy(e);
  assert.equal(w.available, 1);
});

test('abort and expanded-size limits reject without touching target state', async () => {
  const s = setup(World, 2),
    e = s.world.create();
  s.object.add(e, { value: 'x'.repeat(200000) });
  const packet = await s.codec.snapshot(),
    controller = new AbortController();
  const pending = s.codec.restore(packet, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  await assert.rejects(s.codec.restore(packet, { maxBytes: 2000 }), /limit/);
  assert.equal(s.object.fields.value[0].length, 200000);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(createDelta(packet, packet, { signal: pre.signal }), (err) => err.name === 'AbortError');
});
