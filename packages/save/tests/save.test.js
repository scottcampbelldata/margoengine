// Save documents: validation, prefabs and overrides, migrations, all-or-nothing loading, the ECS adapter, encoding,
// the storage adapters, round-trip property tests and fuzzed input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '@margoengine/ecs';
import {
  Migrations,
  decodeSave,
  ecsAdapter,
  encodeSave,
  expandSave,
  indexedDBStorage,
  loadGame,
  loadWorld,
  memoryStorage,
  mergePatch,
  parseSave,
  saveEcs,
  saveGame,
  validateSave,
  webStorage,
} from '../dist/index.js';
import { fileStorage } from '../dist/node.js';
import { fakeIndexedDB, fakeWebStorage } from './fakes.js';

const save = (entities, extra = {}) => ({ format: 'margo-save', version: 1, entities, ...extra });

const castle = () =>
  save(
    [
      { id: 'world', name: 'World' },
      {
        id: 'gate',
        parent: 'world',
        prefab: 'door',
        transform: { position: [0, 0, 5] },
        overrides: { handle: { components: { colour: { r: 1 } } } },
      },
      { id: 'vault', parent: 'world', prefab: 'door', overrides: { handle: null } },
      { id: 'guard', parent: 'world', prefab: 'guard', components: { health: 50 } },
      { id: 'camera', components: { follow: { $ref: 'guard' }, look: { $ref: 'gate/handle' } } },
    ],
    {
      prefabs: {
        door: {
          entities: [
            { id: 'frame', components: { mesh: 'door.glb', open: false } },
            { id: 'handle', parent: 'frame', components: { colour: { r: 0, g: 0, b: 0 }, opens: { $ref: 'frame' } } },
            { id: 'knob', parent: 'handle', components: { mesh: 'knob.glb' } },
          ],
        },
        guard: {
          entities: [
            { id: 'body', components: { health: 100, team: 'red' } },
            { id: 'post', parent: 'body', prefab: 'door' },
          ],
        },
      },
    },
  );

test('prefab instances expand with stable ids, the instance as root, local references re-pointed and overrides merged', () => {
  const entities = expandSave(parseSave(castle()));
  const byId = Object.fromEntries(entities.map((e) => [e.id, e]));
  assert.deepEqual(Object.keys(byId).sort(), [
    'camera',
    'gate',
    'gate/handle',
    'gate/knob',
    'guard',
    'guard/post',
    'guard/post/handle',
    'guard/post/knob',
    'vault',
    'world',
  ]);
  assert.deepEqual(byId.gate.components, { mesh: 'door.glb', open: false });
  assert.equal(byId.gate.parent, 'world');
  assert.deepEqual(byId.gate.transform, { position: [0, 0, 5] });
  assert.deepEqual(
    byId['gate/handle'].components,
    { colour: { r: 1, g: 0, b: 0 }, opens: { $ref: 'gate' } },
    'merge patch + re-pointed ref',
  );
  assert.equal(byId['gate/handle'].parent, 'gate');
  assert.equal(byId['vault/handle'], undefined, 'null override removes the entity...');
  assert.equal(byId['vault/knob'], undefined, '...and its children');
  assert.deepEqual(byId.guard.components, { health: 50, team: 'red' }, "the instance's components win");
  assert.equal(byId['guard/post/handle'].components.opens.$ref, 'guard/post', 'nested prefab refs are re-pointed too');
  assert.deepEqual(byId['gate/handle'].source, { prefab: 'door', local: 'handle' });
  // Parents come before children.
  const index = new Map(entities.map((e, i) => [e.id, i]));
  for (const e of entities) if (e.parent) assert.ok(index.get(e.parent) < index.get(e.id));
  assert.throws(
    () =>
      expandSave(
        parseSave(
          save(
            [
              { id: 'a', prefab: 'p' },
              { id: 'b', components: { x: { $ref: 'a/gone' } } },
            ],
            { prefabs: { p: { entities: [{ id: 'r' }] } } },
          ),
        ),
      ),
    /references 'a\/gone'/,
  );
});

test('mergePatch follows RFC 7386', () => {
  assert.deepEqual(mergePatch({ a: 'b', c: { d: 'e', f: 'g' } }, { a: 'z', c: { f: null } }), {
    a: 'z',
    c: { d: 'e' },
  });
  assert.deepEqual(mergePatch({ a: [1, 2] }, { a: [3] }), { a: [3] });
  assert.deepEqual(mergePatch('x', { a: 1 }), { a: 1 });
  assert.equal(mergePatch({ a: 1 }, null), undefined);
});

test('validateSave reports every problem with its path and fix', () => {
  const issues = validateSave(
    {
      format: 'margo-save',
      version: 0,
      entities: [
        { id: 'a', parent: 'b', components: { hp: 'lots' } },
        { id: 'b', parent: 'a', transform: { position: [0, NaN, 0] } },
        { id: 'a' },
        { id: 'c', components: { target: { $ref: 'nobody' } }, colour: 'red' },
        { id: 'd', prefab: 'missing' },
      ],
    },
    { components: { hp: (v) => (typeof v === 'number' ? null : 'must be a number of hit points') } },
  );
  assert.deepEqual(
    issues.map((i) => i.path),
    [
      'version',
      'entities[0].components.hp',
      'entities[1].transform.position',
      'entities[2].id',
      'entities[3].colour',
      'entities[4].prefab',
      'entities[0].parent',
      'entities[1].parent',
      'entities[3].components.target',
    ],
  );
  assert.match(issues.find((i) => i.path === 'entities[0].parent').message, /parent cycle/);
  const cyclic = save([{ id: 'x', prefab: 'p' }], {
    prefabs: { p: { entities: [{ id: 'r', prefab: 'q' }] }, q: { entities: [{ id: 's', prefab: 'p' }] } },
  });
  assert.match(
    validateSave(cyclic)
      .map((i) => i.message)
      .join(),
    /contains itself/,
  );
  assert.throws(() => parseSave('{"format": "margo-save", '), /not valid JSON/);
  assert.throws(
    () => parseSave({ format: 'margo-save', version: 1, entities: [{ id: 'a', components: { f: () => 1 } }] }),
    TypeError,
  );
  assert.throws(
    () => parseSave(save([{ id: 'a', components: { hp: 'x' } }]), { strictComponents: true }),
    /unknown component 'hp'/,
  );
});

test('migrations run in order on a copy and fail with a code that names the fix', () => {
  const migrations = new Migrations()
    .register(1, (doc) => ({
      ...doc,
      version: 2,
      entities: doc.entities.map((e) => ({ ...e, components: { ...e.components, hp: e.components.health } })),
    }))
    .register(2, (doc) => {
      for (const e of doc.entities) delete e.components.health;
      doc.version = 3;
      return doc;
    });
  assert.equal(migrations.latest, 3);
  const old = save([{ id: 'a', components: { health: 7 } }]);
  const frozen = structuredClone(old);
  const current = migrations.migrate(old);
  assert.deepEqual(current.entities[0].components, { hp: 7 });
  assert.equal(current.version, 3);
  assert.deepEqual(old, frozen, 'the input is untouched');
  assert.throws(() => migrations.migrate({ ...old, version: 4 }), RangeError);
  assert.throws(
    () => new Migrations(5).register(1, (d) => ({ ...d, version: 2 })).migrate(old),
    (e) => e.code === 'failed' && /from save version 2 to 3/.test(e.message),
  );
  const boom = new Error('bad data');
  assert.throws(
    () =>
      new Migrations()
        .register(1, () => {
          throw boom;
        })
        .migrate(old),
    (e) => e.code === 'failed' && e.cause === boom,
  );
  assert.throws(
    () => new Migrations().register(1, (d) => d).migrate(old),
    (e) => e.code === 'failed' && /must return the document with version 2/.test(e.message),
  );
  assert.throws(
    () => migrations.register(1, (d) => d),
    (e) => e.code === 'state',
  );
  assert.equal(migrations.covers(1), true);
  assert.equal(new Migrations(3).covers(1), false);
});

/** A world in Maps, with a hook that throws on a chosen step. */
function mapWorld(failOn = () => false) {
  const live = new Map(),
    committed = [];
  return {
    live,
    committed,
    adapter: {
      create(entity) {
        if (failOn('create', entity)) throw new Error(`cannot build ${entity.id}`);
        const handle = { id: entity.id, entity, links: {} };
        live.set(entity.id, handle);
        return handle;
      },
      link(handle, entity, resolve) {
        if (failOn('link', entity)) throw new Error(`cannot link ${entity.id}`);
        for (const [name, value] of Object.entries(entity.components))
          if (value && value.$ref) handle.links[name] = resolve(value.$ref);
      },
      commit(handles) {
        if (failOn('commit')) throw new Error('commit failed');
        committed.push(handles.size);
      },
      destroy(handle) {
        live.delete(handle.id);
      },
    },
  };
}

test('loadWorld is all or nothing: a failure at any step destroys everything it built', () => {
  const ok = mapWorld();
  const handles = loadWorld(castle(), ok.adapter);
  assert.equal(handles.size, 10);
  assert.equal(ok.live.get('camera').links.follow, ok.live.get('guard'));
  assert.deepEqual(ok.committed, [10]);
  for (const [step, which] of [
    ['create', 'guard/post/knob'],
    ['link', 'camera'],
    ['commit', null],
  ]) {
    const world = mapWorld((s, e) => s === step && (which === null || e?.id === which));
    assert.throws(
      () => loadWorld(castle(), world.adapter),
      (error) =>
        error.code === 'failed' &&
        error.message.includes(`in ${step}`) &&
        /nothing was kept/.test(error.message) &&
        error.cause instanceof Error,
    );
    assert.equal(world.live.size, 0, `nothing is left after a failed ${step}`);
  }
  const invalid = mapWorld();
  assert.throws(() => loadWorld(save([{ id: 'a', parent: 'nobody' }]), invalid.adapter), TypeError);
  assert.equal(invalid.live.size, 0);
  const controller = new AbortController();
  const aborted = mapWorld((s) => s === 'link' && (controller.abort(new Error('menu')), false));
  assert.throws(() => loadWorld(castle(), aborted.adapter, { signal: controller.signal }), /menu/);
  assert.equal(aborted.live.size, 0);
});

test('ECS worlds save and load through the adapter, and a bad value undoes the whole load', async () => {
  const make = () => {
    const world = new World(64);
    return {
      world,
      position: world.component({ x: Float32Array, y: Float32Array }),
      health: world.component({ hp: Int32Array }),
    };
  };
  const a = make();
  for (let i = 0; i < 10; i++) {
    const e = a.world.create();
    a.position.add(e, { x: i, y: i * 2 });
    if (i % 3 === 0) a.health.add(e, { hp: 100 - i });
  }
  const doc = saveEcs(a.world, { position: a.position, health: a.health });
  const storage = memoryStorage();
  await saveGame(storage, 'slot-1', doc);
  const b = make();
  const loaded = loadWorld(
    await loadGame(storage, 'slot-1'),
    ecsAdapter(b.world, { position: b.position, health: b.health }),
  );
  assert.equal(loaded.size, 10);
  const again = saveEcs(b.world, { position: b.position, health: b.health });
  assert.deepEqual(
    again.entities.map((e) => e.components),
    doc.entities.map((e) => e.components),
    'same components after the round trip',
  );
  const c = make();
  const bad = structuredClone(doc);
  bad.entities[7].components.health = { hp: 1.5 };
  assert.throws(
    () => loadWorld(bad, ecsAdapter(c.world, { position: c.position, health: c.health })),
    (e) => e.code === 'failed',
  );
  const ids = new Uint32Array(64);
  assert.equal(c.world.query([c.position], ids), 0, 'no entity of the failed load is left in the world');
  assert.throws(
    () => loadWorld(save([{ id: 'x', components: { mana: { v: 1 } } }]), ecsAdapter(c.world, { position: c.position })),
    (e) => e.cause instanceof TypeError,
  );
});

test('encodeSave and decodeSave: plain and gzip, damaged bytes are a TypeError, abort stops', async () => {
  const doc = castle();
  const plain = await encodeSave(doc),
    packed = await encodeSave(doc, { compress: true });
  assert.equal(packed[0], 0x1f);
  assert.ok(packed.length < plain.length);
  assert.deepEqual(await decodeSave(plain), doc);
  assert.deepEqual(await decodeSave(packed), doc);
  const damaged = packed.slice();
  damaged[damaged.length - 5] ^= 0xff;
  damaged[20] ^= 0xff;
  await assert.rejects(decodeSave(damaged), TypeError);
  await assert.rejects(decodeSave(new Uint8Array([0xff, 0xfe, 0x00])), TypeError);
  await assert.rejects(decodeSave(new TextEncoder().encode('{"a":')), /not valid JSON/);
  await assert.rejects(encodeSave(doc, { signal: AbortSignal.abort(new Error('stop')) }), /stop/);
});

test('storage adapters: memory, Web Storage, IndexedDB and files keep bytes, list keys and fail cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'margo-save-'));
  try {
    const idb = fakeIndexedDB();
    const web = fakeWebStorage(4000);
    const adapters = {
      memory: memoryStorage(),
      web: webStorage(web),
      idb: indexedDBStorage({ factory: idb }),
      file: fileStorage(dir),
    };
    const bytes = await encodeSave(castle(), { compress: true });
    for (const [name, storage] of Object.entries(adapters)) {
      assert.equal(await storage.read('slot 1/a'), null, name);
      await storage.write('slot 1/a', bytes);
      await storage.write('b', new Uint8Array([1, 2, 3]));
      assert.deepEqual(await storage.read('slot 1/a'), bytes, name);
      assert.deepEqual(await storage.keys(), ['b', 'slot 1/a'], name);
      assert.equal(await storage.delete('b'), true, name);
      assert.equal(await storage.delete('b'), false, name);
      await assert.rejects(storage.read('', {}), TypeError, name);
      await assert.rejects(storage.read('x', { signal: AbortSignal.abort(new Error('stop')) }), /stop/, name);
      const doc = await loadGame(storage, 'slot 1/a');
      assert.deepEqual(doc, castle(), `${name} round trip`);
    }
    assert.deepEqual((await readdir(dir)).sort(), ['slot%201%2Fa.save'], 'no temporary files are left');
    // A full Web Storage refuses with a code and keeps the old save.
    await assert.rejects(adapters.web.write('slot 1/a', new Uint8Array(5000)), (e) => e.code === 'failed');
    assert.deepEqual(await adapters.web.read('slot 1/a'), bytes);
    // A failed IndexedDB transaction keeps the old save.
    idb.failWrites = true;
    await assert.rejects(adapters.idb.write('slot 1/a', new Uint8Array([9])), (e) => e.code === 'failed');
    idb.failWrites = false;
    assert.deepEqual(await adapters.idb.read('slot 1/a'), bytes);
    // An aborted file write keeps the old save and leaves no temporary file.
    await assert.rejects(
      adapters.file.write('slot 1/a', new Uint8Array([9]), { signal: AbortSignal.abort(new Error('stop')) }),
      /stop/,
    );
    assert.deepEqual(await adapters.file.read('slot 1/a'), bytes);
    assert.deepEqual(await readdir(dir), ['slot%201%2Fa.save']);
    assert.throws(
      () => webStorage(undefined),
      (e) => e.code === 'unsupported',
    );
    await assert.rejects(indexedDBStorage().read('a'), (e) => e.code === 'unsupported');
    // saveGame refuses an invalid document and writes nothing.
    await assert.rejects(saveGame(adapters.memory, 'bad', save([{ id: 'a', parent: 'x' }])), TypeError);
    assert.equal(await adapters.memory.read('bad'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Seeded generator for the property and fuzz tests.
function lcg(seed) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
function randomSave(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const value = (depth = 0) => {
    const k = random();
    if (depth > 2 || k < 0.4) return pick([0, 1.5, -3, 'text', '', true, false, null, 1e20]);
    if (k < 0.7) return Array.from({ length: Math.floor(random() * 3) }, () => value(depth + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(random() * 3) }, (_, i) => [`f${i}`, value(depth + 1)]));
  };
  const prefabs = {
    crate: {
      entities: [
        { id: 'box', components: { mass: 2, loot: value() } },
        { id: 'lid', parent: 'box', components: { hinge: { $ref: 'box' } } },
      ],
    },
    cart: {
      entities: [
        { id: 'base', components: { wheels: 4 } },
        { id: 'load', parent: 'base', prefab: 'crate' },
      ],
    },
  };
  const entities = [];
  const count = 1 + Math.floor(random() * 25);
  for (let i = 0; i < count; i++) {
    const entity = { id: `n${i}` };
    if (i && random() < 0.6) entity.parent = `n${Math.floor(random() * i)}`;
    if (random() < 0.5)
      entity.transform = { position: [random(), random(), random()], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    if (random() < 0.8)
      entity.components = {
        data: value(),
        ...(i && random() < 0.4 ? { link: { $ref: `n${Math.floor(random() * i)}` } } : {}),
      };
    if (random() < 0.3) {
      entity.prefab = pick(['crate', 'cart']);
      if (entity.prefab === 'crate' && random() < 0.5)
        entity.overrides = { lid: random() < 0.5 ? null : { components: { colour: 'blue' } } };
      if (entity.prefab === 'cart' && random() < 0.5)
        entity.overrides = { 'load/lid': { components: { locked: true } } };
    }
    if (random() < 0.3) entity.name = `Entity ${i}`;
    entities.push(entity);
  }
  return {
    format: 'margo-save',
    version: 1 + Math.floor(random() * 3),
    entities,
    prefabs,
    meta: { title: 'Run', time: random() * 1000 },
  };
}

test('property: save -> bytes -> load gives the same document and the same expanded world, plain or gzipped', async () => {
  const random = lcg(31);
  for (let n = 0; n < 120; n++) {
    const doc = randomSave(random);
    assert.deepEqual(validateSave(doc), [], `document ${n} is valid`);
    const expanded = expandSave(parseSave(doc));
    for (const compress of [false, true]) {
      const back = parseSave(await decodeSave(await encodeSave(doc, { compress })));
      assert.deepEqual(back, doc);
      assert.deepEqual(expandSave(back), expanded);
    }
    const world = mapWorld();
    const handles = loadWorld(doc, world.adapter);
    assert.deepEqual(
      [...handles.keys()],
      expanded.map((e) => e.id),
    );
    // Saving the loaded world again (its resolved entities as a flat save) expands to the same world.
    const flat = { format: 'margo-save', version: doc.version, entities: expanded.map(({ source: _, ...e }) => e) };
    assert.deepEqual(
      expandSave(parseSave(flat)).map(({ source: _, ...e }) => e),
      expanded.map(({ source: _, ...e }) => e),
    );
  }
});

test('fuzz: mutated and random input never crashes validateSave; parseSave and loadWorld throw only TypeError', async () => {
  const random = lcg(4242);
  const junk = [
    null,
    undefined,
    0,
    -1,
    NaN,
    Infinity,
    '',
    '/',
    'x',
    true,
    [],
    {},
    [1, 2],
    { $ref: 'nope' },
    { id: 'n0' },
  ];
  const mutate = (value, depth = 0) => {
    if (value === null || typeof value !== 'object' || depth > 6)
      return random() < 0.5 ? junk[Math.floor(random() * junk.length)] : value;
    const copy = Array.isArray(value) ? [...value] : { ...value };
    const keys = Object.keys(copy);
    for (let k = 0; k < 2 && keys.length; k++) {
      const key = keys[Math.floor(random() * keys.length)];
      copy[key] = random() < 0.3 ? junk[Math.floor(random() * junk.length)] : mutate(copy[key], depth + 1);
    }
    return copy;
  };
  let loaded = 0;
  for (let i = 0; i < 1500; i++) {
    const input = mutate(randomSave(random));
    assert.ok(Array.isArray(validateSave(input)));
    const world = mapWorld();
    try {
      loadWorld(input, world.adapter);
      loaded++;
    } catch (error) {
      assert.ok(error instanceof TypeError, `only TypeError escapes, got ${error}`);
      assert.equal(world.live.size, 0, 'a refused load builds nothing');
    }
  }
  assert.ok(loaded > 50, `some mutated saves still load (${loaded})`);
  for (let i = 0; i < 300; i++) {
    const bytes = Uint8Array.from({ length: Math.floor(random() * 80) }, () => Math.floor(random() * 256));
    if (random() < 0.3) {
      bytes[0] = 0x1f;
      bytes[1] = 0x8b;
    }
    try {
      parseSave(await decodeSave(bytes));
    } catch (error) {
      assert.ok(error instanceof TypeError, `only TypeError escapes, got ${error}`);
    }
  }
});
