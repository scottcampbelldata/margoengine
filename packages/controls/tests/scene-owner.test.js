import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import {
  OrbitControls,
  MapControls,
  TrackballControls,
  ArcballControls,
  FlyControls,
  FirstPersonControls,
  PointerLockControls,
  TransformControls,
  ArcballGizmo,
} from '../dist/index.js';
import { WalkControls } from '../dist/walk.js';
import { ThirdPersonControls } from '../dist/third-person.js';
import { FakeElement } from './control-fakes.js';

const factories = [
  ...Object.entries({
    OrbitControls,
    MapControls,
    TrackballControls,
    ArcballControls,
    FlyControls,
    FirstPersonControls,
    PointerLockControls,
    TransformControls,
    WalkControls,
  }).map(([name, Control]) => [name, (engine) => new Control(engine)]),
  ['ThirdPersonControls', (engine) => new ThirdPersonControls(engine, () => [0, 0, 0])],
  [
    'ArcballGizmo',
    (engine) =>
      new ArcballGizmo({
        engine,
        camera: engine.camera,
        element: engine.canvas,
        state: 'none',
        rotate() {},
      }),
  ],
];

async function fixture(t) {
  const canvas = new FakeElement(64, 64);
  canvas.width = canvas.height = 64;
  const engine = new Engine(
    canvas,
    await TransformStore.create(32),
    {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    },
    undefined,
    null,
  );
  t.after(() => engine.dispose());
  return engine;
}

for (const [name, make] of factories)
  for (const target of ['default', 'secondary'])
    for (const mode of ['direct', 'owner', 'scene', 'engine']) {
      if (target === 'default' && mode === 'scene') continue;
      test(`${name} ${target} ${mode} disposal detaches the actual wrapper`, async (t) => {
        const engine = await fixture(t);
        const scene = target === 'default' ? engine.scene : engine.createScene('control-owner');
        let control, plugin;
        const scope = {
          name: 'scope',
          setup() {
            control = make(engine);
            plugin = [...scene.plugins.values()].find((value) => value !== scope);
          },
        };
        scene.use(scope);
        scene.removePlugin(scope.name);
        assert.equal(engine.sceneOf(plugin), scene);
        let removed = 0;
        const sentinel = {
          name: plugin.name,
          setup() {},
          dispose() {
            removed++;
          },
        };
        if (target === 'secondary') engine.use(sentinel);
        plugin.onDeviceRestored?.(engine);
        if (mode === 'direct') control.dispose();
        else if (mode === 'owner') scene.removePlugin(plugin.name);
        else if (mode === 'scene') scene.dispose();
        else engine.dispose();
        assert.equal(engine.sceneOf(plugin), undefined, 'wrapper registration detached');
        assert.equal(engine.canvas.listenerCount, 0, 'all input listeners released');
        assert.equal(engine.canvas.style.touchAction, 'auto');
        if (target === 'secondary' && mode !== 'engine') {
          assert.equal(engine.scene.plugins.get(plugin.name), sentinel);
          assert.equal(removed, 0, 'same-name default instance preserved');
        }
        if (mode === 'direct' || mode === 'owner') {
          const replacement = { name: plugin.name, setup() {} };
          scene.use(replacement);
          control.dispose();
          assert.equal(scene.plugins.get(plugin.name), replacement, 'replacement preserved');
        }
      });
    }

for (const [name, Control] of Object.entries({ OrbitControls, TransformControls }))
  for (const target of ['default', 'secondary'])
    test(`${name} ${target} throwing listener initialization leaves no wrapper`, async (t) => {
      const engine = await fixture(t);
      const scene = target === 'default' ? engine.scene : engine.createScene('failed-control');
      const add = engine.canvas.addEventListener;
      const failure = new Error('listener initialization');
      let added = 0;
      engine.canvas.addEventListener = function (...args) {
        if (++added === 2) throw failure;
        return add.apply(this, args);
      };
      assert.throws(
        () =>
          scene.use({
            name: 'scope',
            setup() {
              new Control(engine);
            },
          }),
        (error) => error === failure,
      );
      assert.equal(scene.plugins.size, 0, 'failed setup releases its scope and child');
      assert.equal(engine.canvas.listenerCount, 0);
      assert.equal(engine.canvas.style.touchAction, 'auto');
    });
