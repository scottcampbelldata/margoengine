import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Stage } from '@margoengine/stage';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Migrations, encodeSave } from '@margoengine/save';

// The real save package and a real engine on a stand-in renderer; only glTF loading is a stand-in.
const world = { loads: [], gate: null, models: [], clones: 0, cloneFails: false, lists: [], receivers: [], suns: [] };
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
mock.module('@margoengine/animation/skeleton-utils', {
  namedExports: {
    async cloneModel(source) {
      if (world.cloneFails) throw new Error('no copy');
      world.clones++;
      const root = source.root.engine.createMesh(),
        model = {
          source,
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
mock.module('@margoengine/clustered', {
  namedExports: {
    Clustered: {
      attach(engine) {
        const plugin = {
          name: 'clustered',
          setup() {},
          dispose() {},
          setLights(lights) {
            world.lists.push(lights);
          },
          add(model) {
            world.receivers.push(model);
            return () => world.receivers.splice(world.receivers.indexOf(model), 1);
          },
        };
        engine.use(plugin);
        return plugin;
      },
    },
  },
});
mock.module('@margoengine/clustered/directional', {
  namedExports: {
    DirectionalLights: {
      attach(engine, { lights }) {
        const plugin = { name: 'clustered:directional', lights, setup() {}, dispose() {}, setLights: (list) => world.suns.push(list) };
        engine.use(plugin);
        return plugin;
      },
    },
  },
});
const { addScene } = await import('@margoengine/stage/scene');

async function fixture() {
  world.loads = [];
  world.models = [];
  world.gate = null;
  world.clones = 0;
  world.cloneFails = false;
  world.lists = [];
  world.receivers = [];
  world.suns = [];
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
  await assert.rejects(addScene(stage, level, { fit: 1 }), {
    name: 'TypeError',
    message: /Invalid fit: expected a boolean; use true to fit the camera or false to keep its view; see https:\/\/margoengine\.com\/errors#arguments/,
  });
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

const near = (actual, expected) =>
  [...actual].forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-6, `${[...actual]} against ${expected}`));
// A quarter turn about y, so the entity's -Z looks down world -X.
const quarter = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

test('one load per URL: the other entities on it are copies, each under its own mesh', async () => {
  const stage = await fixture(),
    tree = (id) => ({ id, components: { mesh: 'tree.glb' } }),
    scene = await addScene(stage, saved([tree('a'), tree('b'), tree('c'), { id: 'd', components: { mesh: 'rock.glb' } }]), { base, fit: false });
  assert.deepEqual(world.loads.map((load) => load.url).sort(), [`${base}rock.glb`, `${base}tree.glb`]);
  assert.equal(world.clones, 2);
  assert.equal(new Set(scene.models.values()).size, 4);
  assert.equal(scene.models.get('b').source, scene.models.get('a'));
  assert.equal(scene.models.get('c').source, scene.models.get('a'));
  for (const id of ['a', 'b', 'c', 'd'])
    assert.equal(parentOf(stage, scene.models.get(id).root), scene.meshes.get(id).id);
  scene.dispose();
  assert.ok(world.models.every((model) => model.disposed === 1));
  assert.equal(count(stage), 0);
});

test('one entity per URL needs no copy, and a copy that fails leaves nothing', async () => {
  const stage = await fixture();
  await addScene(stage, saved([{ id: 'a', components: { mesh: 'tree.glb' } }]), { base, fit: false });
  assert.equal(world.clones, 0);
  const before = count(stage);
  world.cloneFails = true;
  const tree = (id) => ({ id, components: { mesh: 'tree.glb' } });
  await assert.rejects(addScene(stage, saved([tree('a'), tree('b')]), { base, fit: false }), /no copy/);
  assert.equal(count(stage), before);
  assert.equal(world.models.at(-1).disposed, 1);
});

test('a directional light is the sun, from the world pose under its parent, and dispose puts the sun back', async () => {
  const stage = await fixture(),
    { direction, radiance } = stage.engine.lighting,
    was = [[...direction], [...radiance]],
    scene = await addScene(
      stage,
      saved([
        { id: 'rig', transform: { rotation: quarter } },
        { id: 'sun', parent: 'rig', components: { light: { color: [1, 0.5, 0.25], intensity: 2, ambient: 0.3 } } },
      ]),
      { fit: false },
    );
  near(direction, [1, 0, 0, 2]);
  near(radiance, [1, 0.5, 0.25, 0.3]);
  assert.equal(scene.lights, undefined, 'one sun needs no clustered lights');
  scene.dispose();
  near(direction, was[0]);
  near(radiance, was[1]);
});

test('a camera takes the world pose, sets the view instead of fit, and every camera is in the map', async () => {
  const stage = await fixture(),
    box = { id: 'box', components: { mesh: { shape: 'box' } } },
    scene = await addScene(
      stage,
      saved([
        box,
        { id: 'rig', transform: { position: [1, 2, 3], rotation: quarter } },
        { id: 'free', parent: 'rig', transform: { position: [0, 0, 2] }, components: { camera: { fov: 40, near: 0.5, far: 50 } } },
        { id: 'fixed', transform: { position: [0, 1, 5] }, components: { camera: { target: [0, 1, 0], active: true } } },
      ]),
    ),
    camera = stage.engine.camera;
  near(camera.position, [0, 1, 5]);
  near(camera.target, [0, 1, 0]);
  const free = scene.cameras.get('free');
  near(free.position, [3, 2, 3]);
  near(free.target, [-7, 2, 3]);
  assert.deepEqual([free.fov, free.near, free.far], [40, 0.5, 50]);
  Object.assign(camera, free);
  near(camera.position, [3, 2, 3]);
  assert.equal(camera.fov, 40);
});

test('a camera with active false waits, and fit still frames the scene', async () => {
  const stage = await fixture(),
    from = [...stage.engine.camera.position];
  await addScene(
    stage,
    saved([
      { id: 'box', components: { mesh: { shape: 'box' } } },
      { id: 'spare', transform: { position: [9, 9, 9] }, components: { camera: { active: false } } },
    ]),
    { fit: false },
  );
  near(stage.engine.camera.position, from);
});

test('point and spot lights go to one Clustered, models receive them, and two scenes add up', async () => {
  const stage = await fixture(),
    first = await addScene(
      stage,
      saved([
        { id: 'tree', components: { mesh: 'tree.glb' } },
        { id: 'lamp', transform: { position: [1, 2, 3] }, components: { light: { type: 'point', color: [1, 0, 0], intensity: 4, range: 9 } } },
        { id: 'spot', transform: { rotation: quarter }, components: { light: { type: 'spot', innerConeAngle: 0.2, outerConeAngle: 0.5 } } },
      ]),
      { base, fit: false },
    );
  const list = world.lists.at(-1);
  assert.deepEqual(list[0], { position: [1, 2, 3], color: [1, 0, 0], intensity: 4, range: 9 });
  assert.equal(list[1].range, 16, 'no range: the one gltf-pro gives');
  near(list[1].direction, [-1, 0, 0]);
  assert.deepEqual([list[1].innerAngle, list[1].outerAngle], [0.2, 0.5]);
  assert.deepEqual(world.receivers, [first.models.get('tree')]);
  const second = await addScene(stage, saved([{ id: 'lamp', components: { light: { type: 'point' } } }]), { fit: false });
  assert.equal(second.lights, first.lights);
  assert.equal(world.lists.at(-1).length, 3);
  first.dispose();
  assert.equal(world.lists.at(-1).length, 1);
  assert.deepEqual(world.receivers, []);
  second.dispose();
  assert.equal(world.lists.at(-1).length, 0);
});

test('a second directional light goes beside the sun', async () => {
  const stage = await fixture(),
    sun = (id, rotation) => ({ id, transform: { rotation }, components: { light: { intensity: 2 } } }),
    scene = await addScene(stage, saved([sun('one', [0, 0, 0, 1]), sun('two', quarter)]), { fit: false });
  near(stage.engine.lighting.direction, [0, 0, 1, 2]);
  const [extra] = world.suns.at(-1);
  near(extra.direction, [-1, 0, 0]);
  assert.equal(extra.intensity, 2);
  assert.equal(stage.engine.plugins.get('clustered:directional').lights, scene.lights);
});

test('a bad light or camera names the entity, before anything loads', async () => {
  const stage = await fixture(),
    bad = (components) => addScene(stage, saved([{ id: 'x', components: { mesh: 'tree.glb', ...components } }]), { base, fit: false });
  await assert.rejects(bad({ light: 1 }), /Entity 'x' light/);
  await assert.rejects(bad({ light: { type: 'area' } }), /type: 'directional', 'point' or 'spot'/);
  await assert.rejects(bad({ light: { color: '#fff' } }), /color: \[r, g, b\]/);
  await assert.rejects(bad({ light: { type: 'point', ambient: 1 } }), /on a directional light/);
  await assert.rejects(bad({ light: { type: 'spot', innerConeAngle: 1, outerConeAngle: 0.5 } }), /innerConeAngle/);
  await assert.rejects(bad({ light: { type: 'point', range: 0 } }), /range/);
  await assert.rejects(bad({ camera: 'main' }), /Entity 'x' camera/);
  await assert.rejects(bad({ camera: { fov: 200 } }), /fov/);
  await assert.rejects(bad({ camera: { near: 5, far: 1 } }), /far/);
  await assert.rejects(bad({ camera: { target: [0, 0] } }), /target/);
  await assert.rejects(bad({ camera: { active: 'yes' } }), /active/);
  assert.equal(world.loads.length, 0);
  assert.equal(count(stage), 0);
});
