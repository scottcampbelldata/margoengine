import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Stage } from '@margoengine/stage';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Migrations, encodeSave } from '@margoengine/save';

// The real save package and a real engine on a stand-in renderer; only glTF loading is a stand-in.
const world = { loads: [], gate: null, models: [] };
mock.module('@margoengine/gltf-pro', {
  namedExports: {
    async loadGLTF(engine, url, options) {
      world.loads.push({ url: String(url), options });
      if (world.gate) await world.gate;
      options.signal.throwIfAborted();
      if (String(url).includes('bad')) throw new Error('bad model');
      const root = engine.createMesh(),
        model = {
          root,
          nodes: [root],
          disposed: 0,
          dispose() {
            this.disposed++;
            root.dispose();
          },
        };
      world.models.push(model);
      return model;
    },
  },
});
const { addScene } = await import('@margoengine/stage/scene');

async function fixture() {
  world.loads = [];
  world.models = [];
  world.gate = null;
  const store = await TransformStore.create(64),
    renderer = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Engine({ width: 8, height: 8, clientWidth: 8, clientHeight: 8 }, store, renderer, undefined, null);
  return new Stage(engine);
}
const count = (stage) => stage.engine.scene.meshes.size;
const parentOf = (stage, mesh) => stage.engine.store.parents[mesh.id];
const saved = (entities, extra = {}) => ({ format: 'margo-save', version: 1, entities, ...extra });
const base = 'https://example.test/';
const level = saved(
  [
    {
      id: 'floor',
      name: 'Floor',
      transform: { position: [0, -1, 0], scale: [2, 1, 2] },
      components: { mesh: { shape: 'box', size: [10, 1, 10] }, material: { color: '#808080', roughness: 0.5 } },
    },
    {
      id: 'ball',
      parent: 'floor',
      transform: { position: [0, 2, 0], rotation: [0, 0, 0, 1] },
      components: { mesh: { shape: 'sphere', radius: 0.5 } },
    },
    { id: 'empty', components: { spawn: { team: 1 } } },
  ],
  { meta: { title: 'One' } },
);

test('a document becomes one mesh per entity, with transform, parent, shape, material and name', async () => {
  const stage = await fixture(),
    scene = await addScene(stage, level, { fit: false }),
    floor = scene.meshes.get('floor'),
    ball = scene.meshes.get('ball');
  assert.deepEqual([...scene.meshes.keys()].sort(), ['ball', 'empty', 'floor']);
  assert.equal(floor.name, 'Floor');
  assert.deepEqual([floor.position.y, floor.scale.x], [-1, 2]);
  assert.ok(floor.geometry && ball.geometry);
  assert.equal(scene.meshes.get('empty').geometry, null);
  assert.equal(floor.material.data[4], 0.5);
  assert.equal(parentOf(stage, ball), floor.id);
  assert.equal(scene.meta.title, 'One');
  scene.dispose();
  scene.dispose();
  assert.equal(count(stage), 0);
  stage.dispose();
});

test('JSON text, bytes and gzip all load; a URL is fetched and is the base of its models', async (t) => {
  const stage = await fixture(),
    text = JSON.stringify(level);
  (await addScene(stage, text, { fit: false })).dispose();
  (await addScene(stage, await encodeSave(level, { compress: true }), { fit: false })).dispose();
  (await addScene(stage, new TextEncoder().encode(text).buffer, { fit: false })).dispose();
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify(saved([{ id: 'car', components: { mesh: 'car.glb' } }])));
  };
  const scene = await addScene(stage, new URL('https://example.test/levels/one.json'), { fit: false });
  assert.deepEqual(asked, ['https://example.test/levels/one.json']);
  assert.equal(world.loads[0].url, 'https://example.test/levels/car.glb');
  assert.equal(parentOf(stage, world.models[0].root), scene.meshes.get('car').id);
  assert.equal(scene.models.get('car'), world.models[0]);
  scene.dispose();
  assert.equal(world.models[0].disposed, 1);
  assert.equal(count(stage), 0);
  globalThis.fetch = async () => new Response('', { status: 404 });
  await assert.rejects(addScene(stage, new URL('https://example.test/none.json')), { code: 'failed', message: /404/ });
  stage.dispose();
});

test('prefabs expand, and one prefab can load alone', async () => {
  const stage = await fixture(),
    prefabs = {
      tree: {
        root: 'trunk',
        entities: [
          { id: 'trunk', components: { mesh: { shape: 'box' } } },
          { id: 'top', parent: 'trunk', components: { mesh: { shape: 'sphere' } } },
        ],
      },
    },
    source = saved([{ id: 'a', prefab: 'tree', transform: { position: [3, 0, 0] } }], { prefabs }),
    all = await addScene(stage, source, { fit: false });
  assert.equal(all.meshes.size, 2);
  assert.equal(all.meshes.get('a').position.x, 3);
  all.dispose();
  const one = await addScene(stage, source, { prefab: 'tree', fit: false });
  assert.equal(one.meshes.size, 2);
  one.dispose();
  await assert.rejects(addScene(stage, source, { prefab: 'bush' }), TypeError);
  await assert.rejects(addScene(stage, source, { prefab: 'constructor' }), TypeError);
  assert.equal(count(stage), 0);
  stage.dispose();
});

test('migrations run before anything is built', async () => {
  const stage = await fixture(),
    migrations = new Migrations(2).register(1, (old) => ({
      ...old,
      version: 2,
      entities: old.entities.map((entity) => ({ ...entity, name: 'moved' })),
    })),
    scene = await addScene(stage, saved([{ id: 'a' }]), { migrations, fit: false });
  assert.equal(scene.meshes.get('a').name, 'moved');
  stage.dispose();
});

test('parent option, onEntity with references, and a material cannot reach placement', async () => {
  const stage = await fixture(),
    holder = stage.engine.createMesh(),
    seen = [],
    scene = await addScene(
      stage,
      saved([
        {
          id: 'a',
          components: { mesh: { shape: 'box' }, material: { parent: 'x', position: [9, 9, 9], color: '#ff0000' } },
        },
        { id: 'b', components: { follow: { $ref: 'a' } } },
      ]),
      {
        parent: holder,
        fit: false,
        onEntity(mesh, entity, get) {
          seen.push(entity.id);
          if (entity.components.follow) assert.ok(get(entity.components.follow.$ref).geometry);
        },
      },
    );
  assert.deepEqual(seen.sort(), ['a', 'b']);
  assert.equal(parentOf(stage, scene.meshes.get('a')), holder.id);
  assert.equal(scene.meshes.get('a').position.x, 0);
  stage.dispose();
});

test('fit frames what loaded, and a scene with nothing to frame leaves the camera alone', async () => {
  const stage = await fixture(),
    before = [...stage.engine.camera.position];
  (await addScene(stage, saved([{ id: 'a' }]))).dispose();
  assert.deepEqual([...stage.engine.camera.position], before);
  await addScene(stage, saved([{ id: 'a', components: { mesh: { shape: 'box', size: [20, 20, 20] } } }]));
  stage.engine.camera.advance(1);
  assert.notDeepEqual([...stage.engine.camera.position], before);
  stage.dispose();
});

test('all or nothing: a bad model, a bad component or a throwing onEntity leaves nothing', async () => {
  const stage = await fixture(),
    source = saved([
      { id: 'a', components: { mesh: 'good.glb' } },
      { id: 'b', components: { mesh: 'bad.glb' } },
    ]),
    says = (text) => (error) => text.test(`${error.message} ${error.cause?.message}`);
  await assert.rejects(addScene(stage, source, { base }), /bad model/);
  assert.equal(world.models[0].disposed, 1);
  assert.equal(count(stage), 0);
  await assert.rejects(addScene(stage, saved([{ id: 'a', components: { mesh: 7 } }]), { base }), says(/mesh/));
  await assert.rejects(
    addScene(stage, saved([{ id: 'a', components: { mesh: { shape: 'box' }, material: 7 } }])),
    says(/material/),
  );
  await assert.rejects(
    addScene(stage, saved([{ id: 'a', components: { mesh: 'good.glb' } }]), {
      base,
      onEntity() {
        throw new Error('nope');
      },
    }),
    says(/nope/),
  );
  assert.equal(world.models.at(-1).disposed, 1);
  assert.equal(count(stage), 0);
  await assert.rejects(addScene(stage, { format: 'other' }), TypeError);
  await assert.rejects(addScene(stage, level, { fit: 1 }), TypeError);
  stage.dispose();
});

test('abort and stage disposal reject with AbortError and leave nothing', async () => {
  const stage = await fixture(),
    caller = new AbortController(),
    source = saved([{ id: 'a', components: { mesh: 'one.glb' } }]);
  let open;
  world.gate = new Promise((resolve) => (open = resolve));
  const pending = addScene(stage, source, { signal: caller.signal, base });
  await new Promise((resolve) => setTimeout(resolve, 20));
  caller.abort();
  open();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(count(stage), 0);
  stage.dispose();
  await assert.rejects(addScene(stage, level), { name: 'AbortError' });
});

test('after the stage is disposed the engine owns the teardown, so dispose touches nothing', async () => {
  const stage = await fixture(),
    scene = await addScene(stage, saved([{ id: 'a', components: { mesh: 'one.glb' } }]), { base, fit: false });
  stage.dispose();
  scene.dispose();
  assert.equal(world.models[0].disposed, 0);
});
