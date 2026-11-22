import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { PackageEditor } from '../dist/packages.js';
import { ShaderEditor } from '../dist/shaders.js';
import { RemoteTarget, channelTransport } from '../dist/remote.js';

// KB-INSPECTOR-REMOTE-OWNER1 and its siblings: disposing a panel or target takes it off the scene that holds it (not
// the active one) and leaves a same-name plugin of another scene alone. Found by the inspector owner/lifetime fixture.
const cases = {
  PackageEditor: (engine, parent) => PackageEditor.attach(engine, { parent, objects: { Settings: { gain: 1 } } }),
  ShaderEditor: (engine, parent) => ShaderEditor.attach(engine, { parent, meshes: [] }),
  RemoteTarget: (engine) => {
    const port = Object.assign(new EventTarget(), { postMessage() {} });
    return RemoteTarget.attach(engine, { transport: channelTransport(port), statsIntervalMs: 0 });
  },
};
for (const [name, attach] of Object.entries(cases))
  test(`${name}: dispose takes it off the scene that holds it, twice harmlessly, and spares a same-name plugin`, async (t) => {
    const dom = new JSDOM('<body></body>'),
      store = await TransformStore.create(16),
      engine = new Engine(
        dom.window.document.createElement('canvas'),
        store,
        { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
        undefined,
        null,
      );
    t.after(() => {
      engine.dispose();
      dom.window.close();
    });
    const second = engine.createScene('owned'),
      other = engine.createScene('neighbor');
    // Attached while `second` is set up, so it lives there while the default scene is the active one.
    let plugin;
    second.use({
      name: 'owner:attach',
      setup() {
        plugin = attach(engine, dom.window.document.body);
      },
    });
    second.removePlugin('owner:attach');
    assert.equal(engine.sceneOf(plugin), second);
    const neighbour = { name: plugin.name, setup() {}, dispose() {} };
    other.use(neighbour);
    plugin.dispose();
    plugin.dispose();
    assert.equal(engine.sceneOf(plugin), undefined);
    assert.equal(second.plugins.get(plugin.name), undefined);
    assert.equal(other.plugins.get(plugin.name), neighbour);
  });
