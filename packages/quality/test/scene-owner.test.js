import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { redrawAfterRestore } from '../dist/index.js';
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
for (const target of ['default', 'secondary'])
  for (const mode of ['stop', 'remove', 'scene-dispose', 'engine-dispose']) {
    if (target === 'default' && mode === 'scene-dispose') continue;
    test(`${target} redraw ${mode} cancels queued frames and releases its identity`, async (t) => {
      const engine = await fixture(t),
        scene = target === 'default' ? engine.scene : engine.createScene('redraw'),
        frames = [];
      let stop,
        renders = 0,
        plugin;
      const scope = {
        name: 'scope',
        setup() {
          stop = redrawAfterRestore(
            engine,
            () => renders++,
            (callback) => frames.push(callback),
          );
          plugin = [...scene.plugins.values()].find((p) => p !== scope);
        },
      };
      scene.use(scope);
      scene.removePlugin(scope.name);
      let removed = 0;
      const sentinel = {
        name: plugin.name,
        setup() {},
        dispose() {
          removed++;
        },
      };
      if (target === 'secondary') engine.use(sentinel);
      plugin.onDeviceRestored(engine);
      if (mode === 'stop') stop();
      else if (mode === 'remove') scene.removePlugin(plugin.name);
      else if (mode === 'scene-dispose') scene.dispose();
      else engine.dispose();
      assert.equal(engine.sceneOf(plugin), undefined, 'wrapper detaches from its actual scene');
      while (frames.length) frames.shift()();
      assert.equal(renders, 0, 'queued callbacks cannot render after their plugin lifetime');
      plugin.onDeviceRestored(engine);
      assert.equal(frames.length, 0, 'a retained callback cannot enqueue after disposal');
      if (target === 'secondary' && mode !== 'engine-dispose') {
        assert.equal(engine.scene.plugins.get(plugin.name), sentinel);
        assert.equal(removed, 0);
      }
      if (mode === 'stop' || mode === 'remove') {
        const replacement = { name: plugin.name, setup() {} };
        scene.use(replacement);
        stop();
        assert.equal(scene.plugins.get(plugin.name), replacement);
      }
    });
  }
for (const target of ['default', 'secondary'])
  test(`${target} redraw stop cancels an already queued second frame`, async (t) => {
    const engine = await fixture(t),
      scene = target === 'default' ? engine.scene : engine.createScene('redraw'),
      frames = [];
    let stop,
      plugin,
      renders = 0;
    const scope = {
      name: 'scope',
      setup() {
        stop = redrawAfterRestore(
          engine,
          () => renders++,
          (callback) => frames.push(callback),
        );
        plugin = [...scene.plugins.values()].find((value) => value !== scope);
      },
    };
    scene.use(scope);
    scene.removePlugin(scope.name);
    plugin.onDeviceRestored(engine);
    frames.shift()();
    assert.equal(renders, 1);
    assert.equal(frames.length, 1);
    stop();
    frames.shift()();
    assert.equal(renders, 1);
    assert.equal(engine.sceneOf(plugin), undefined);
  });
test('stopping from the first redraw prevents the second redraw', async (t) => {
  const engine = await fixture(t),
    frames = [];
  let renders = 0,
    stop;
  stop = redrawAfterRestore(
    engine,
    () => {
      renders++;
      stop();
    },
    (callback) => frames.push(callback),
  );
  const plugin = [...engine.scene.plugins.values()][0];
  plugin.onDeviceRestored(engine);
  frames.shift()();
  while (frames.length) frames.shift()();
  assert.equal(renders, 1);
  assert.equal(engine.sceneOf(plugin), undefined);
});
