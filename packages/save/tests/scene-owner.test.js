import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { restoreScene } from '../dist/engine.js';

async function fixture(t) {
  const engine = new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(32),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
  t.after(() => engine.dispose());
  return engine;
}

function document(plugins) {
  return { format: 'margo-save', version: 1, entities: [], meta: { engine: { plugins } } };
}

for (const name of ['save:restore', 'save:restore:'])
  test(`restore scope cannot collide with running or saved ${name}`, async (t) => {
    const engine = await fixture(t),
      scene = engine.createScene('target');
    const sentinel = { name: 'save:restore', setup() {} };
    if (name.endsWith(':')) scene.use(sentinel);
    let made;
    await restoreScene(engine, document({ [name]: {} }), {
      scene,
      plugins: {
        [name]: {
          type: {
            attach(host) {
              made = {
                name,
                setup(runtime) {
                  assert.equal(runtime.lighting, scene.lighting);
                },
              };
              host.use(made);
              return made;
            },
          },
        },
      },
    });
    assert.equal(scene.plugins.get(name), made);
    assert.equal(scene.plugins.size, name.endsWith(':') ? 2 : 1);
    if (name.endsWith(':')) assert.equal(scene.plugins.get(sentinel.name), sentinel);
  });

test('a throwing factory rolls back every new helper, its passes and meshes', async (t) => {
  const engine = await fixture(t),
    scene = engine.createScene('target'),
    disposed = [],
    made = [],
    names = [];
  const kept = { name: 'helper-kept', setup() {} };
  scene.use(kept);
  await assert.rejects(
    restoreScene(engine, document({ factory: {} }), {
      scene,
      plugins: {
        factory: {
          type: {
            attach(host) {
              for (const name of ['helper-a', 'factory', 'helper-b']) {
                const plugin = {
                  name,
                  setup(runtime) {
                    this.mesh = runtime.createMesh();
                  },
                  registerPasses(graph) {
                    graph.add({
                      name,
                      order: 1,
                      execute() {
                        names.push(name);
                      },
                    });
                  },
                  dispose() {
                    disposed.push(name);
                    this.mesh.dispose();
                  },
                };
                host.use(plugin);
                made.push(plugin);
              }
              throw new Error('partial attach');
            },
          },
        },
      },
    }),
    (error) => error.code === 'failed' && error.cause.message === 'partial attach',
  );
  assert.deepEqual(disposed, ['helper-b', 'factory', 'helper-a']);
  assert.deepEqual([...scene.plugins.values()], [kept]);
  assert.equal(scene.meshes.size, 0);
  for (const plugin of made) assert.equal(engine.sceneOf(plugin), undefined);
  scene.frameGraph.execute({
    draw() {
      names.push('main');
    },
  });
  assert.deepEqual(names, ['main']);
  assert.equal(engine.scene.plugins.size, 0);
  assert.equal(engine.lighting, engine.scene.lighting);
});

test('rollback never removes a later instance with the factory plugin name', async (t) => {
  const engine = await fixture(t),
    scene = engine.createScene('target');
  const replacement = { name: 'factory', setup() {} };
  let made;
  await assert.rejects(
    restoreScene(engine, document({ factory: {} }), {
      scene,
      plugins: {
        factory: {
          type: {
            attach(host) {
              made = { name: 'factory', setup() {} };
              host.use(made);
              return made;
            },
          },
          load() {
            scene.removePlugin('factory');
            scene.use(replacement);
            throw new Error('state replaced instance');
          },
        },
      },
    }),
    (error) => error.code === 'failed' && error.cause.message === 'state replaced instance',
  );
  assert.equal(engine.sceneOf(made), undefined);
  assert.deepEqual([...scene.plugins.values()], [replacement]);
  assert.equal(engine.sceneOf(replacement), scene);
});

for (const target of ['default', 'secondary', 'secondary-with-default-name'])
  for (const failure of [null, 'attach', 'load', 'later'])
    test(`restore factory in ${target}: ${failure ?? 'success'}`, async (t) => {
      const engine = new Engine(
        { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
        await TransformStore.create(32),
        { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
        undefined,
        null,
      );
      t.after(() => engine.dispose());
      const scene = target === 'default' ? engine.scene : engine.createScene('saved'),
        kept = scene.createMesh(),
        defaultKept = engine.scene.createMesh(),
        name = 'restored-factory',
        made = [],
        restored = [];
      let defaultDisposals = 0;
      const sentinel = {
        name,
        setup() {},
        dispose() {
          defaultDisposals++;
        },
      };
      if (target === 'secondary-with-default-name') engine.use(sentinel);
      const old = { name: 'later', value: 1, setup() {} };
      scene.use(old);
      const type = {
        attach(host, options) {
          assert.equal(host, engine, 'factory receives the real engine');
          assert.deepEqual(options, { saved: true });
          const plugin = {
            name,
            disposed: false,
            setup(runtime) {
              this.mesh = runtime.createMesh();
              this.lighting = runtime.lighting;
            },
            registerPasses(graph) {
              graph.add({ name, order: 0, execute() {} });
            },
            onDeviceRestored(runtime) {
              restored.push(runtime);
            },
            dispose() {
              if (this.disposed) return;
              this.disposed = true;
              engine.sceneOf(this)?.removePlugin(this.name);
              this.mesh.dispose();
            },
          };
          host.use(plugin);
          made.push(plugin);
          if (failure === 'attach') throw new Error('factory attach failed');
          return plugin;
        },
      };
      const document = {
        format: 'margo-save',
        version: 1,
        entities: [],
        meta: {
          engine: {
            plugins: {
              [name]: { options: { saved: true }, properties: { value: 7 } },
              later: { properties: { value: 8 } },
            },
          },
        },
      };
      const plugins = {
        [name]: {
          type,
          load(plugin, state) {
            assert.equal(engine.sceneOf(plugin), scene, 'state applies to target registration');
            plugin.value = state.properties.value;
            if (failure === 'load') throw new Error('factory state failed');
          },
        },
        later: {
          properties: ['value'],
          load(plugin, state) {
            plugin.value = state.properties.value;
            if (failure === 'later' && plugin.value === 8) throw new Error('later state failed');
          },
        },
      };
      const result = restoreScene(engine, document, { scene, clear: false, plugins });
      if (failure)
        await assert.rejects(result, (error) => {
          assert.equal(error.code, 'failed');
          assert.match(
            error.cause.message,
            failure === 'attach'
              ? /factory attach failed/
              : failure === 'load'
                ? /factory state failed/
                : /later state failed/,
          );
          return true;
        });
      else await result;
      assert.equal(made.length, 1);
      const plugin = made[0];
      assert.equal(plugin.lighting, scene.lighting, 'setup is in target scope');
      assert.equal(plugin.mesh.scene, scene);
      kept.check();
      defaultKept.check();
      if (target === 'secondary-with-default-name') {
        assert.equal(engine.scene.plugins.get(name), sentinel);
        assert.equal(defaultDisposals, 0);
      } else if (target !== 'default') assert.equal(engine.scene.plugins.size, 0);
      assert.equal(engine.lighting, engine.scene.lighting, 'active scene restored');
      if (failure) {
        assert.equal(old.value, 1);
        assert.equal(plugin.disposed, true);
        assert.equal(engine.sceneOf(plugin), undefined);
        assert.equal(scene.plugins.size, 1, 'no factory or scope remains');
        assert.throws(() => plugin.mesh.check(), /disposed/);
      } else {
        assert.equal(plugin.value, 7);
        assert.equal(old.value, 8);
        assert.equal(engine.sceneOf(plugin), scene);
        assert.equal(scene.plugins.size, 2, 'no temporary scope remains');
        plugin.onDeviceRestored(engine);
        assert.deepEqual(restored, [engine]);
        scene.removePlugin(name);
        const replacement = { name, setup() {}, dispose() {} };
        scene.use(replacement);
        plugin.dispose();
        assert.equal(scene.plugins.get(name), replacement);
      }
    });
