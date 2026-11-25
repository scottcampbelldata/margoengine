import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore, box, PbrMaterial } from '@margoengine/core/extension';
import { children, parent } from '../dist/index.js';
import { AssetContainer, loadContainer } from '../dist/container.js';

const make = async () =>
  new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, await TransformStore.create(16), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });

/** A plugin that records its life in `log`. */
const plugin = (name, log = []) => ({
  name,
  setup: () => log.push(`+${name}`),
  dispose: () => log.push(`-${name}`),
});
const factory = (name, log) => (engine) => {
  const made = plugin(name, log);
  engine.use(made);
  return made;
};

/** A model as the container reads one: a plugin that owns a root and nodes in the active scene. */
const model = (engine, geometry, name = 'model') => {
  const root = engine.createMesh(),
    node = engine.createMesh(root).setGeometry(geometry);
  root.name = `${name}-root`;
  node.name = `${name}-node`;
  const made = {
    name,
    root,
    nodes: [node],
    disposed: false,
    setup() {},
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      engine.sceneOf(made)?.removePlugin(name);
      node.dispose();
      root.dispose();
    },
  };
  engine.use(made);
  return made;
};
let copies = 0;
const cloneModel = async (source) => {
  const engine = source.root.engine,
    scene = engine.sceneOf(source),
    name = `${source.name}-copy${copies++}`;
  let made;
  const scope = { name: `${name}-scope`, setup: () => void (made = model(engine, source.nodes[0].geometry, name)) };
  scene.use(scope);
  scene.removePlugin(scope.name);
  made.root.visible = source.root.visible;
  return made;
};
const drawn = (engine) => {
  engine.render({ delta: 0 });
  return engine.stats.visible;
};

test('remove from the scene hides without destroying, and add brings every member back as it was', async () => {
  using engine = await make();
  const geometry = box(),
    log = [],
    tree = engine.createMesh().setGeometry(geometry),
    leaf = engine.createMesh(tree).setGeometry(geometry).setPosition([1, 0, 0]),
    off = engine.createMesh().setGeometry(geometry),
    car = model(engine, geometry, 'car');
  off.visible = false;
  const set = new AssetContainer(engine, { cloneModel });
  set.add(tree, off, car, factory('wind', log));
  assert.equal(set.inScene, true);
  assert.deepEqual(set.meshes, [tree, off]);
  assert.deepEqual(set.models, [car]);
  assert.deepEqual(set.plugins.map((each) => each.name), ['wind']);
  assert.equal(drawn(engine), 3);

  assert.equal(set.removeAllFromScene(), set);
  set.removeAllFromScene();
  assert.equal(drawn(engine), 0, 'a hidden root hides its subtree');
  assert.equal(set.inScene, false);
  assert.deepEqual(set.plugins, []);
  assert.equal(engine.scene.plugins.has('wind'), false);
  assert.equal(engine.scene.meshes.size, 5);
  assert.equal(parent(leaf), tree);
  assert.equal(car.disposed, false);

  set.addAllToScene().addAllToScene();
  assert.equal(drawn(engine), 3);
  assert.equal(off.visible, false);
  assert.equal(tree.visible, true);
  assert.deepEqual(log, ['+wind', '-wind', '+wind']);
});

test('items added to a removed container are hidden and their factories wait', async () => {
  using engine = await make();
  const log = [],
    mesh = engine.createMesh().setGeometry(box()),
    set = new AssetContainer(engine).removeAllFromScene();
  // A factory may return an unattached plugin: the container attaches it.
  set.add(mesh, () => plugin('rain', log));
  assert.equal(mesh.visible, false);
  assert.deepEqual(log, []);
  set.addAllToScene();
  assert.equal(mesh.visible, true);
  assert.equal(set.plugins[0], engine.scene.plugins.get('rain'));
});

test('add refuses bad items and changes nothing, factories included', async () => {
  using engine = await make();
  const root = engine.createMesh(),
    child = engine.createMesh(root),
    elsewhere = engine.createScene('other').createMesh(),
    gone = engine.createMesh(),
    car = model(engine, box(), 'car'),
    log = [],
    set = new AssetContainer(engine),
    second = new AssetContainer(engine);
  gone.dispose();
  const good = factory('good', log);
  for (const [bad, expected] of [
    [child, /root mesh/],
    [elsewhere, /container scene/],
    [gone, { code: 'disposed' }],
    [car.root, /add the model/],
    [42, TypeError],
    [null, TypeError],
    [root, /already in a container/],
  ])
    assert.throws(() => set.add(good, root, bad), expected);
  assert.deepEqual(set.meshes, []);
  assert.deepEqual(log, []);
  const boom = new Error('boom');
  assert.throws(
    () =>
      set.add(root, good, () => {
        throw boom;
      }),
    boom,
  );
  assert.deepEqual(log, ['+good', '-good']);
  assert.deepEqual(set.meshes, []);
  assert.throws(() => set.add(async () => plugin('late')), /synchronously/);
  const mine = plugin('mine');
  engine.use(mine);
  assert.throws(() => set.add(() => mine), /new plugin/);
  assert.equal(engine.scene.plugins.get('mine'), mine, 'a plugin the factory did not make stays');
  set.add(root);
  assert.throws(() => second.add(root), /already in a container/);
});

test('a factory that fails on the way back leaves the container out of the scene', async () => {
  using engine = await make();
  const mesh = engine.createMesh(),
    log = [];
  let fail = false;
  const set = new AssetContainer(engine).add(mesh, factory('first', log), (target) => {
    if (fail) throw new Error('no');
    return factory('second', log)(target);
  });
  set.removeAllFromScene();
  fail = true;
  assert.throws(() => set.addAllToScene(), /no/);
  assert.equal(set.inScene, false);
  assert.equal(mesh.visible, false);
  assert.deepEqual([...engine.scene.plugins.keys()], []);
  fail = false;
  set.addAllToScene();
  assert.deepEqual([...engine.scene.plugins.keys()], ['first', 'second']);
});

test('helpers a factory attaches leave with it, and a throwing plugin dispose does not strand the rest', async () => {
  using engine = await make();
  const mesh = engine.createMesh(),
    set = new AssetContainer(engine).add(
      mesh,
      (target) => {
        target.use(plugin('helper'));
        return plugin('main');
      },
      () => ({
        name: 'bad',
        setup() {},
        dispose() {
          throw new Error('bad dispose');
        },
      }),
    );
  assert.throws(() => set.removeAllFromScene(), /bad dispose/);
  assert.equal(set.inScene, false);
  assert.equal(mesh.visible, false);
  assert.deepEqual([...engine.scene.plugins.keys()], []);
});

test('the members live in the container scene, and factories attach there', async () => {
  using engine = await make();
  const scene = engine.createScene('other'),
    set = new AssetContainer(engine, { scene }).add(scene.createMesh(), factory('fog', []));
  assert.equal(scene.plugins.has('fog'), true);
  assert.equal(engine.scene.plugins.size, 0);
  set.removeAllFromScene();
  assert.equal(scene.plugins.size, 0);
});

test('release hands an item back as it was; dead members are forgotten', async () => {
  using engine = await make();
  const a = engine.createMesh(),
    b = engine.createMesh(),
    log = [],
    wind = factory('wind', log),
    set = new AssetContainer(engine).add(a, b, wind);
  assert.equal(set.release(wind), true);
  set.removeAllFromScene();
  assert.equal(engine.scene.plugins.has('wind'), true);
  assert.equal(set.release(a), true);
  assert.equal(set.release(a), false);
  assert.equal(a.visible, true);
  assert.equal(set.contains(a), false);
  b.dispose();
  assert.deepEqual(set.meshes, []);
  set.dispose();
  a.check();
});

test('instantiate copies trees and models, shares resources, names copies and leaves the source alone', async () => {
  using engine = await make();
  const geometry = box(),
    material = new PbrMaterial({ color: '#ff0000' }),
    tree = engine.createMesh().setGeometry(geometry).setMaterial(material),
    leaf = engine.createMesh(tree).setGeometry(geometry).setMaterial(material),
    car = model(engine, geometry, 'car'),
    log = [],
    set = new AssetContainer(engine, { cloneModel }).add(tree, car, factory('wind', log));
  tree.name = 'tree';
  leaf.name = 'leaf';
  set.removeAllFromScene();
  const copy = await set.instantiate({ name: (name) => `${name} 2` });
  const [treeCopy] = copy.meshes,
    [leafCopy] = children(treeCopy),
    [carCopy] = copy.models;
  assert.equal(copy.inScene, true);
  assert.equal(set.inScene, false);
  assert.equal(tree.visible, false);
  assert.deepEqual([treeCopy.name, leafCopy.name, carCopy.root.name, carCopy.nodes[0].name], [
    'tree 2',
    'leaf 2',
    'car-root 2',
    'car-node 2',
  ]);
  assert.equal(leafCopy.geometry, geometry);
  assert.equal(leafCopy.material, material);
  assert.equal(treeCopy.visible, true);
  assert.equal(carCopy.root.visible, true);
  assert.deepEqual(copy.plugins, [], 'plugin factories are not copied');
  assert.equal(drawn(engine), 3);

  const own = await set.instantiate({ cloneMaterials: true, filter: (item) => item === tree });
  const [mine] = own.meshes,
    [mineLeaf] = children(mine);
  assert.deepEqual(own.models, []);
  assert.equal(mine.name, 'tree');
  assert.notEqual(mine.material, material);
  assert.equal(mine.material, mineLeaf.material);
  assert.deepEqual(mine.material.data, material.data);
  assert.equal(leaf.material, material);

  copy.dispose();
  own.dispose();
  assert.equal(engine.scene.meshes.size, 4);
  tree.check();
});

test('a failed or aborted instantiate leaves no copy', async () => {
  using engine = await make();
  const mesh = engine.createMesh().setGeometry(box()),
    car = model(engine, box(), 'car');
  const count = () => [engine.scene.meshes.size, engine.scene.plugins.size];
  const before = count();
  const boom = new Error('clone failed');
  const failing = new AssetContainer(engine, {
    cloneModel: async () => {
      throw boom;
    },
  }).add(mesh, car);
  await assert.rejects(failing.instantiate(), boom);
  assert.deepEqual(count(), before);
  failing.release(mesh);
  failing.release(car);

  const controller = new AbortController();
  const set = new AssetContainer(engine, {
    cloneModel: async (source) => {
      const made = await cloneModel(source);
      controller.abort(new Error('stop'));
      return made;
    },
  }).add(mesh, car);
  await assert.rejects(set.instantiate({ signal: controller.signal }), /stop/);
  assert.deepEqual(count(), before);
  await assert.rejects(set.instantiate({ signal: AbortSignal.abort(new Error('early')) }), /early/);
  await assert.rejects(set.instantiate({ name: () => 5 }), /return a string/);
  await assert.rejects(set.instantiate({ cloneMaterials: 1 }), TypeError);
  await assert.rejects(set.instantiate({ filter: true }), TypeError);
  await assert.rejects(set.instantiate({ signal: {} }), TypeError);
  await assert.rejects(set.instantiate(null), TypeError);
  assert.deepEqual(count(), before);

  // Disposed while a model copy was on its way.
  const pending = set.instantiate();
  set.dispose();
  await assert.rejects(pending, { code: 'disposed' });
  assert.deepEqual(count(), [0, 0]);
});

test('moveAllFromScene takes root meshes and models, keeps what keep says and other containers', async () => {
  using engine = await make();
  const geometry = box(),
    a = engine.createMesh().setGeometry(geometry),
    child = engine.createMesh(a).setGeometry(geometry),
    kept = engine.createMesh().setGeometry(geometry),
    taken = engine.createMesh().setGeometry(geometry),
    car = model(engine, geometry, 'car'),
    sky = plugin('sky');
  engine.use(sky);
  const other = new AssetContainer(engine).add(taken),
    set = new AssetContainer(engine).moveAllFromScene((item) => item === kept);
  assert.deepEqual(set.meshes, [a]);
  assert.deepEqual(set.models, [car]);
  assert.equal(set.inScene, false);
  assert.equal(set.contains(child), true);
  assert.equal(set.contains(taken), false);
  assert.equal(drawn(engine), 2);
  assert.equal(engine.scene.plugins.get('sky'), sky);
  set.moveAllFromScene((item) => item === kept);
  assert.equal(set.meshes.length, 1);
  assert.throws(() => set.moveAllFromScene(true), TypeError);
  other.dispose();
});

test('dispose releases what the container owns and nothing else', async () => {
  using engine = await make();
  const geometry = box(),
    log = [],
    a = engine.createMesh().setGeometry(geometry),
    child = engine.createMesh(a).setGeometry(geometry),
    car = model(engine, geometry, 'car'),
    hung = engine.createMesh(car.nodes[0]),
    theirs = engine.createMesh(),
    stranger = model(engine, geometry, 'stranger'),
    outside = engine.createMesh();
  const other = new AssetContainer(engine).add(theirs);
  theirs.setParent(child);
  stranger.root.setParent(a);
  let kept;
  {
    using set = new AssetContainer(engine).add(a, car, factory('wind', log));
    set.removeAllFromScene();
    kept = set;
  }
  assert.equal(kept.disposed, true);
  kept.dispose();
  assert.equal(car.disposed, true);
  assert.equal(stranger.disposed, false);
  for (const mesh of [theirs, stranger.root, stranger.nodes[0], outside]) mesh.check();
  for (const mesh of [a, child, car.root, car.nodes[0], hung]) assert.throws(() => mesh.check(), { code: 'disposed' });
  assert.deepEqual([...engine.scene.plugins.keys()], ['stranger']);
  for (const use of [
    () => kept.add(outside),
    () => kept.addAllToScene(),
    () => kept.removeAllFromScene(),
    () => kept.moveAllFromScene(),
    () => kept.release(a),
  ])
    assert.throws(use, { code: 'disposed' });
  await assert.rejects(kept.instantiate(), { code: 'disposed' });
  // A disposed member may join again nowhere, and a freed owner may.
  new AssetContainer(engine).add(outside);
  other.dispose();
});

test('construction options are validated, and disposal after the engine is quiet', async () => {
  const engine = await make(),
    foreign = await make();
  assert.throws(() => new AssetContainer(engine, null), TypeError);
  assert.throws(() => new AssetContainer(engine, { scene: foreign.scene }), /scene/);
  assert.throws(() => new AssetContainer(engine, { cloneModel: 1 }), TypeError);
  const set = new AssetContainer(engine).add(engine.createMesh(), factory('wind', []));
  engine.dispose();
  assert.throws(() => set.addAllToScene(), { code: 'disposed' });
  assert.throws(() => new AssetContainer(engine), { code: 'disposed' });
  set.dispose();
  foreign.dispose();
});

test('loadContainer loads into its scene, out of the picture until added', async () => {
  using engine = await make();
  const scene = engine.createScene('level'),
    geometry = box(),
    signals = [];
  const load = async (url, { signal }) => {
    assert.equal(engine.plugins, scene.plugins, 'the loader runs with the container scene active');
    signals.push(signal);
    return model(engine, geometry, url);
  };
  const signal = new AbortController().signal,
    set = await loadContainer(engine, 'crate', { scene, load, signal, cloneModel });
  assert.deepEqual(signals, [signal]);
  assert.equal(set.inScene, false);
  assert.equal(set.models[0].root.visible, false);
  set.addAllToScene();
  assert.equal(set.models[0].root.visible, true);
  assert.equal((await set.instantiate()).models.length, 1);
});

test('a failed or aborted load builds nothing', async () => {
  using engine = await make();
  const geometry = box(),
    empty = () => assert.deepEqual([engine.scene.meshes.size, engine.scene.plugins.size], [0, 0]),
    boom = new Error('404');
  await assert.rejects(loadContainer(engine, 'a', { load: () => Promise.reject(boom) }), boom);
  const controller = new AbortController(),
    reason = new Error('left the level');
  await assert.rejects(
    loadContainer(engine, 'a', {
      signal: controller.signal,
      load: async () => {
        controller.abort(reason);
        return model(engine, geometry);
      },
    }),
    reason,
  );
  let called = false;
  const load = async () => void (called = true);
  await assert.rejects(loadContainer(engine, 'a', { signal: AbortSignal.abort(reason), load }), reason);
  assert.equal(called, false);
  await assert.rejects(loadContainer(engine, 'a', { load: async () => ({}) }), TypeError);
  await assert.rejects(loadContainer(engine, '', { load }), TypeError);
  await assert.rejects(loadContainer(engine, 'a', { load: 1 }), TypeError);
  await assert.rejects(loadContainer(engine, 'a', { signal: 1 }), TypeError);
  await assert.rejects(loadContainer(engine, 'a', null), TypeError);
  // A model made in another scene than the container's is refused and disposed.
  const other = engine.createScene('other');
  let stray;
  await assert.rejects(
    loadContainer(engine, 'a', {
      scene: other,
      load: async () => {
        await null;
        return (stray = model(engine, geometry));
      },
    }),
    /container scene/,
  );
  assert.equal(stray.disposed, true);
  empty();
});
