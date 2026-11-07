// The engine binding on a real engine and transform store with a stand-in renderer. Models here are stand-ins with
// the shape of PBRModel; tests/browser/engine.mjs runs real ones on a real GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, Geometry, PbrMaterial, TransformStore, box } from '@margoengine/core/extension';
import { Migrations, decodeSave, encodeSave } from '../dist/index.js';
import { captureScene, meshId, restoreScene } from '../dist/engine.js';

async function fixture(capacity = 256) {
  const store = await TransformStore.create(capacity),
    renderer = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} };
  return new Engine({ width: 8, height: 8, clientWidth: 8, clientHeight: 8 }, store, renderer, undefined, null);
}

let serial = 0;
/** A stand-in with PBRModel's shape: a root, nodes from a file, one baked-batch mesh under the root. */
function model(engine, url, nodes = [{ translation: [1, 2, 3] }, { name: 'hand' }], log = []) {
  const root = engine.createMesh(),
    made = nodes.map((definition) => {
      const node = engine.createMesh(root);
      node.name = definition.name ?? '';
      if (definition.translation) node.setPosition(definition.translation);
      return node;
    }),
    batch = engine.createMesh(root),
    plugin = {
      name: `gltf-pro:${serial++}`,
      root,
      nodes: made,
      ownedMeshes: [root, ...made, batch],
      asset: { baseURL: url, doc: { nodes } },
      selectedVariant: undefined,
      setup() {},
      selectVariant(variant) {
        this.selectedVariant = variant;
      },
      dispose() {
        log.push(`dispose ${url}`);
        engine.removePlugin(this.name);
        for (const mesh of this.ownedMeshes.toReversed()) mesh.dispose();
      },
    };
  engine.use(plugin);
  return plugin;
}

const loader = (engine, nodes, log = []) => ({
  load: async (url) => {
    log.push(`load ${url}`);
    return model(engine, url, nodes, log);
  },
  clone: async (source) => {
    log.push('clone');
    return model(engine, source.asset.baseURL, nodes, log);
  },
});

/** Every world matrix of the scene, by saved id. */
function worldMatrices(engine) {
  engine.store.tick(false);
  return new Map(
    [...engine.scene.meshes.values()].filter((mesh) => meshId(mesh)).map((mesh) => [meshId(mesh), Array.from(mesh.matrix)]),
  );
}

function assertSameMatrices(a, b) {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
  // Restoring normalises each float32 quaternion again, which moves a value by at most two float32 steps at 1 per
  // level of the tree; these scenes are under 4 levels and under 100 units across, so 100 * 3 * 2.4e-7 bounds it.
  for (const [id, matrix] of a) matrix.forEach((value, i) => assert.ok(Math.abs(value - b.get(id)[i]) <= 7.2e-5, `${id}[${i}]`));
}

const roundTrip = async (document) => decodeSave(await encodeSave(document, { compress: true }));

test('meshes come back with their tree, transforms, geometry, material and flags, with no mapping written', async () => {
  const engine = await fixture(),
    shape = box(1, 2, 3),
    triangle = new Geometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2]),
    red = new PbrMaterial({ color: [0.5, 0.25, 0.125], roughness: 0.25, metalness: 0.75, doubleSided: false }),
    a = engine.createMesh().setPosition([1, 2, 3]).setScale([2, 2, 2]).setGeometry(shape).setMaterial(red),
    b = engine.createMesh(a).setRotation([0.3, 0.2, 0.1]).setGeometry(shape).setMaterial(red),
    c = engine.createMesh(b).setPosition([0, 5, 0]).setGeometry(triangle);
  a.name = 'crate';
  c.receiveShadow = false;
  c.visible = false;
  const document = await roundTrip(captureScene(engine));
  assert.equal(document.meta.engine.geometries.length, 2, 'a shared geometry is stored once');
  const before = worldMatrices(engine);
  const { meshes } = await restoreScene(engine, document);
  assert.equal(engine.scene.meshes.size, 3, 'the old meshes left');
  assert.throws(() => a.check(), /disposed/);
  assertSameMatrices(before, worldMatrices(engine));
  const crate = meshes.get('crate'),
    second = meshes.get(document.entities[1].id),
    third = meshes.get(document.entities[2].id);
  assert.equal(crate.name, 'crate');
  assert.equal(crate.geometry, second.geometry, 'meshes that shared a geometry share one again');
  assert.equal(crate.material, second.material, 'meshes that shared a material share one again');
  assert.deepEqual(Array.from(crate.geometry.vertices), Array.from(shape.vertices));
  assert.deepEqual(Array.from(third.geometry.indices), [0, 1, 2]);
  assert.deepEqual(Array.from(crate.material.data), Array.from(red.data));
  assert.equal(third.receiveShadow, false);
  assert.equal(third.visible, false);
  assert.equal(crate.visible, true);
  assert.equal(engine.store.parents[third.id], second.id);
});

test('camera, lighting and background come back; camera: false leaves the view alone', async () => {
  const engine = await fixture();
  Object.assign(engine.camera, { fov: 40, near: 0.5, far: 80, position: [1, 2, 3], target: [4, 5, 6], up: [0, 0, 1] });
  engine.scene.lighting.direction.set([0.5, 0.25, 0.75, 2]);
  engine.scene.lighting.radiance.set([1, 0.5, 0.25, 0.125]);
  engine.scene.background = '#102030';
  const document = captureScene(engine);
  Object.assign(engine.camera, { fov: 60, position: [9, 9, 9] });
  engine.scene.lighting.direction.set([0, 1, 0, 1]);
  engine.scene.background = null;
  await restoreScene(engine, document, { camera: false });
  assert.equal(engine.camera.fov, 60);
  assert.equal(engine.scene.background, '#102030');
  assert.deepEqual(Array.from(engine.scene.lighting.direction), [0.5, 0.25, 0.75, 2]);
  await restoreScene(engine, document);
  const { fov, near, far, position, target, up } = engine.camera;
  assert.deepEqual({ fov, near, far, position, target, up }, {
    fov: 40,
    near: 0.5,
    far: 80,
    position: [1, 2, 3],
    target: [4, 5, 6],
    up: [0, 0, 1],
  });
});

test('a model saves as its URL, variant and only the nodes that moved; what hangs from a node stays there', async () => {
  const engine = await fixture(),
    knight = model(engine, 'https://example.test/models/knight.glb'),
    copy = model(engine, 'https://example.test/models/knight.glb');
  knight.root.setPosition([5, 0, 0]);
  knight.selectVariant(2);
  knight.nodes[1].setPosition([0, 7, 0]);
  copy.nodes[0].visible = false;
  const sword = engine.createMesh(knight.nodes[1]).setGeometry(box());
  sword.name = 'sword';
  const document = captureScene(engine),
    entity = (id) => document.entities.find((e) => e.id === id);
  assert.deepEqual(document.entities.map((e) => e.id), ['knight', 'knight-1', 'sword']);
  assert.equal(entity('knight').components.mesh, 'https://example.test/models/knight.glb');
  assert.equal(entity('knight').components.model.variant, 2);
  assert.deepEqual(Object.keys(entity('knight').components.model.nodes), ['1'], 'the node at its file pose is not saved');
  assert.deepEqual(entity('knight-1').components.model.nodes, { 0: { visible: false } });
  assert.equal(entity('sword').parent, 'knight');
  assert.equal(entity('sword').components.node, 1);
  const before = worldMatrices(engine),
    log = [],
    { models, meshes } = await restoreScene(engine, await roundTrip(document), loader(engine, undefined, log));
  assert.deepEqual(log.slice(0, 2), ['load https://example.test/models/knight.glb', 'clone'], 'one load per URL');
  assert.equal(models.size, 2);
  const again = models.get('knight');
  assert.equal(again.selectedVariant, 2);
  assert.equal(again.root.visible, true, 'hidden only until the swap');
  assert.deepEqual([again.nodes[1].position.x, again.nodes[1].position.y], [0, 7]);
  assert.equal(models.get('knight-1').nodes[0].visible, false);
  assert.equal(engine.store.parents[meshes.get('sword').id], again.nodes[1].id);
  assertSameMatrices(before, worldMatrices(engine));
  assert.equal([...engine.scene.plugins.values()].length, 2, 'the old models left');
});

test('a model with no URL is refused by name unless modelURL says where it lives', async () => {
  const engine = await fixture(),
    knight = model(engine, undefined);
  assert.throws(() => captureScene(engine), { name: 'TypeError', message: new RegExp(knight.name) });
  const document = captureScene(engine, { modelURL: () => '/k.glb' });
  assert.equal(document.entities[0].components.mesh, '/k.glb');
});

class Weather {
  name = 'weather';
  options = { quality: 'high', texture: new Map(), levels: new Float32Array([1, 2]) };
  rain = 0.5;
  #wind = 3;
  sun = new Float32Array([1, 0, 0]);
  setup() {}
  get wind() {
    return this.#wind;
  }
  set wind(value) {
    this.#wind = value;
  }
  get readOnly() {
    return 1;
  }
  static made = [];
  static attach(engine, options) {
    const plugin = new Weather();
    Weather.made.push(options);
    engine.use(plugin);
    return plugin;
  }
}

test('a plugin saves through saveState, or its options and accessors, with nothing written by hand', async () => {
  const engine = await fixture(),
    weather = new Weather(),
    own = { name: 'own', value: 4, setup() {}, saveState: () => ({ value: own.value }), loadState: (s) => (own.value = s.value) },
    nothing = { name: 'nothing', setup() {} },
    skipped = [];
  engine.use(weather).use(own).use(nothing);
  const document = await roundTrip(captureScene(engine, { onSkip: (plugin) => skipped.push(plugin.name) }));
  assert.deepEqual(skipped, ['nothing']);
  assert.deepEqual(document.meta.engine.plugins.own, { value: 4 });
  assert.deepEqual(document.meta.engine.plugins.weather, {
    properties: { wind: 3 },
    options: { quality: 'high', levels: [1, 2] },
  });
  weather.wind = 9;
  own.value = 5;
  await restoreScene(engine, document);
  assert.equal(weather.wind, 3);
  assert.equal(own.value, 4);
});

test('a binding names public fields, writes into typed arrays, replaces the default, or leaves a plugin out', async () => {
  const engine = await fixture(),
    weather = new Weather(),
    custom = { name: 'custom', level: 1, setup() {} },
    left = { name: 'left', get a() { return 1; }, set a(_) {}, setup() {} };
  engine.use(weather).use(custom).use(left);
  const plugins = {
      weather: { properties: ['rain', 'sun'] },
      custom: { save: (p) => [p.level], load: (p, [level]) => (p.level = level) },
      left: null,
    },
    document = captureScene(engine, { plugins }),
    sun = weather.sun;
  assert.deepEqual(document.meta.engine.plugins.custom, [1]);
  assert.equal('left' in document.meta.engine.plugins, false);
  weather.rain = 0;
  sun.fill(0);
  custom.level = 2;
  await restoreScene(engine, document, { plugins });
  assert.equal(weather.rain, 0.5);
  assert.equal(weather.sun, sun, 'the array stays the plugin\'s own');
  assert.deepEqual(Array.from(sun), [1, 0, 0]);
  assert.equal(custom.level, 1);
});

test('a plugin the scene lacks is attached with its saved options, or the save is refused before anything changes', async () => {
  const source = await fixture();
  source.use(new Weather());
  const document = captureScene(source),
    engine = await fixture(),
    kept = engine.createMesh();
  await assert.rejects(restoreScene(engine, document), { name: 'TypeError', message: /plugin 'weather'/ });
  kept.check();
  Weather.made.length = 0;
  await restoreScene(engine, document, { plugins: { weather: { type: Weather } } });
  assert.deepEqual(Weather.made, [{ quality: 'high', levels: [1, 2] }]);
  assert.equal(engine.hasPlugin('weather'), true);
  await restoreScene(await fixture(), document, { plugins: { weather: null } });
});

test('a failed restore leaves the running scene as it was: models, plugins, camera, meshes', async () => {
  const engine = await fixture(),
    log = [],
    first = { name: 'first', v: 1, setup() {}, saveState: () => first.v, loadState: (s) => (first.v = s) },
    bad = { name: 'bad', setup() {}, saveState: () => 1, loadState() {} };
  engine.use(first).use(bad);
  const old = engine.createMesh().setGeometry(box()),
    oldModel = model(engine, 'https://example.test/a.glb', undefined, log);
  old.name = 'old';
  const document = captureScene(engine);
  document.entities.push({ id: 'extra', components: { geometry: 0, score: 1 } });
  first.v = 2;
  engine.camera.fov = 33;
  const unchanged = () => {
    old.check();
    oldModel.root.check();
    assert.equal(first.v, 2);
    assert.equal(engine.camera.fov, 33);
    assert.equal(engine.scene.meshes.size, 5, 'nothing new stayed');
    assert.equal(engine.scene.plugins.size, 3);
  };
  // A model that does not load, while another did.
  document.entities.push({ id: 'broken', components: { mesh: 'https://example.test/broken.glb' } });
  const failing = {
    ...loader(engine, undefined, log),
    load(url) {
      return url.includes('broken') ? Promise.reject(new Error('404')) : loader(engine, undefined, log).load(url);
    },
  };
  await assert.rejects(restoreScene(engine, document, failing), (error) => error.code === 'failed' && error.cause.message === '404');
  unchanged();
  document.entities.pop();
  // onEntity throws.
  await assert.rejects(
    restoreScene(engine, document, {
      ...loader(engine, undefined, log),
      onEntity(_mesh, entity) {
        if (entity.id === 'extra') throw new Error('no');
      },
    }),
    (error) => error.code === 'failed' && error.cause.message === 'no',
  );
  unchanged();
  // A plugin throws after an earlier one changed.
  bad.loadState = () => {
    throw new Error('bad state');
  };
  await assert.rejects(restoreScene(engine, document, loader(engine, undefined, log)), (error) => error.cause.message === 'bad state');
  unchanged();
  bad.loadState = () => {};
  // Aborted while a model loads.
  const stop = new AbortController();
  await assert.rejects(
    restoreScene(engine, document, {
      ...loader(engine, undefined, log),
      signal: stop.signal,
      load: async (url) => {
        const loaded = await loader(engine, undefined, log).load(url);
        stop.abort(new Error('stopped'));
        return loaded;
      },
    }),
    /stopped/,
  );
  unchanged();
  await restoreScene(engine, document, loader(engine, undefined, log));
  assert.throws(() => old.check(), /disposed/);
  assert.equal(first.v, 1);
});

test('models stay out of sight until the swap', async () => {
  const engine = await fixture(),
    source = model(engine, 'https://example.test/a.glb'),
    other = model(engine, 'https://example.test/b.glb'),
    document = captureScene(engine);
  let release;
  const gate = new Promise((resolve) => (release = resolve)),
    seen = [];
  const restoring = restoreScene(engine, document, {
    load: async (url) => {
      const made = model(engine, url);
      seen.push(made);
      if (url.endsWith('b.glb')) await gate;
      return made;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen[0].root.visible, false, 'the first model waits hidden while the second loads');
  source.root.check();
  other.root.check();
  release();
  await restoring;
  assert.equal(seen[0].root.visible, true);
});

test('ids hold across saves, so a later save of a restored scene is the same document', async () => {
  const engine = await fixture(),
    a = engine.createMesh().setGeometry(box()),
    b = engine.createMesh().setGeometry(box());
  a.name = b.name = 'twin';
  model(engine, 'https://example.test/a.glb');
  const first = captureScene(engine, { camera: false });
  assert.deepEqual(first.entities.map((e) => e.id).sort(), ['a', 'twin', 'twin-1']);
  assert.deepEqual(captureScene(engine, { camera: false }), first, 'saving twice gives one document');
  await restoreScene(engine, first, loader(engine));
  const second = captureScene(engine, { camera: false }),
    sorted = (doc) => doc.entities.map((e) => e.id).sort();
  assert.deepEqual(sorted(second), sorted(first));
});

test('filter leaves a mesh and everything under it out, at capture and at clear', async () => {
  const engine = await fixture(),
    ui = engine.createMesh(),
    child = engine.createMesh(ui),
    world = engine.createMesh();
  ui.name = 'ui';
  child.name = 'label';
  world.name = 'world';
  const filter = (mesh) => mesh.name !== 'ui',
    document = captureScene(engine, { filter });
  assert.deepEqual(document.entities.map((e) => e.id), ['world']);
  await restoreScene(engine, document, { filter });
  ui.check();
  child.check();
  assert.throws(() => world.check(), /disposed/);
  assert.equal(engine.scene.meshes.size, 3);
});

test('clear: false adds to the scene; a second scene saves and restores by itself', async () => {
  const engine = await fixture(),
    kept = engine.createMesh(),
    other = engine.createScene('other');
  other.createMesh().name = 'there';
  other.lighting.direction.set([0, 0, 1, 3]);
  const document = captureScene(engine, { scene: other });
  assert.deepEqual(document.entities.map((e) => e.id), ['there']);
  await restoreScene(engine, document, { clear: false });
  kept.check();
  assert.equal(engine.scene.meshes.size, 2);
  assert.equal(other.meshes.size, 1);
  const { meshes } = await restoreScene(engine, document, { scene: other });
  assert.equal(meshes.get('there').scene, other);
  assert.equal(other.meshes.size, 1);
});

test('your components ride along and reach onEntity; the binding\'s names are refused; migrations run first', async () => {
  const engine = await fixture(),
    door = engine.createMesh(),
    key = engine.createMesh();
  door.name = 'door';
  key.name = 'key';
  const document = captureScene(engine, {
    version: 1,
    meta: { title: 'Chapter 1' },
    components: (mesh) => (mesh === door ? { opens: { $ref: 'key' }, hp: 3 } : undefined),
  });
  assert.throws(() => captureScene(engine, { components: () => ({ material: 1 }) }), /'material'/);
  const migrations = new Migrations(2).register(1, (old) => ({
      ...old,
      version: 2,
      entities: old.entities.map((e) => (e.id === 'door' ? { ...e, components: { ...e.components, hp: 4 } } : e)),
    })),
    heard = [],
    { meta } = await restoreScene(engine, document, {
      migrations,
      onEntity(mesh, entity, get) {
        if (entity.components.opens) heard.push([entity.components.hp, get(entity.components.opens.$ref).name]);
      },
    });
  assert.deepEqual(heard, [[4, 'key']]);
  assert.deepEqual(meta, { title: 'Chapter 1' });
});

test('damage is refused before anything changes', async () => {
  const engine = await fixture(),
    kept = engine.createMesh().setGeometry(box()),
    good = captureScene(engine),
    copy = () => structuredClone(good);
  const bad = [
    [(d) => (d.meta.engine.geometries[0].vertices = 'AAA'), /damaged|Invalid/],
    [(d) => (d.entities[0].components.geometry = 7), /no saved geometry 7/],
    [(d) => (d.meta.engine.camera.position = [1]), /camera/],
    [(d) => (d.meta.engine.lighting.direction = 'up'), /lighting/],
    [(d) => (d.meta.engine.plugins = 3), /plugins/],
    [(d) => (d.entities[0].components.mesh = { shape: 'box' }), /a model URL/],
    [(d) => (d.entities[0].parent = 'nobody'), /nobody/],
  ];
  for (const [damage, message] of bad) {
    const document = copy();
    damage(document);
    await assert.rejects(restoreScene(engine, document), message);
    kept.check();
  }
  const document = copy();
  document.entities[0].components.material = { color: 'not a colour' };
  await assert.rejects(restoreScene(engine, document), (error) => error.code === 'failed');
  kept.check();
  assert.equal(engine.scene.meshes.size, 1);
});

test('random trees survive capture, bytes and restore', async () => {
  let state = 12345;
  const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32,
    between = (a, b) => a + random() * (b - a);
  for (let round = 0; round < 40; round++) {
    const engine = await fixture(),
      made = [],
      shapes = [box(1, 1, 1), box(2, 1, 3)];
    for (let i = 0; i < 24; i++) {
      const parent = made.length && random() < 0.7 ? made[Math.floor(random() * made.length)] : null,
        mesh = engine.createMesh(parent).setPosition([between(-9, 9), between(-9, 9), between(-9, 9)]);
      mesh.setScale([between(0.5, 2), between(0.5, 2), between(0.5, 2)]);
      if (random() < 0.5) mesh.setRotation([between(-3, 3), between(-1.5, 1.5), between(-3, 3)]);
      else mesh.setQuaternion([between(-1, 1), between(-1, 1), between(-1, 1), between(0.1, 1)]);
      if (random() < 0.5) mesh.setGeometry(shapes[i % 2]);
      made.push(mesh);
    }
    const document = await roundTrip(captureScene(engine)),
      before = worldMatrices(engine);
    await restoreScene(engine, document);
    const after = worldMatrices(engine);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    // Scales up to 2 over up to 24 levels make world values large, so compare each to its own size.
    for (const [id, matrix] of before)
      matrix.forEach((value, i) => {
        const size = Math.max(1, ...matrix.map(Math.abs));
        assert.ok(Math.abs(value - after.get(id)[i]) <= 1e-5 * size, `round ${round} ${id}[${i}]`);
      });
  }
});
