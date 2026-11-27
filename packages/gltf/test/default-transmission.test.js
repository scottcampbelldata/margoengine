// KB4000 step 4: loadGLTF and parseGLTFAsync add the screen-space transmission pass on their own for a file that declares
// KHR_materials_transmission. `screenTransmission` keeps one pass per frame graph, made with depth writes, shared by its
// models and disposed with the last one; the loaders import the entry lazily, only for such a file.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const dist = new URL('../dist/', import.meta.url);

const fakeEngine = () => {
  const removed = [],
    graphs = [{}, {}],
    scenes = new Set([{ frameGraph: graphs[1], name: 'second' }]),
    used = [];
  const engine = {
    gpu: {},
    frameGraph: graphs[0],
    scenes,
    use(plugin, scene) {
      used.push({ plugin, scene });
      plugin.setup(engine);
      return engine;
    },
    sceneOf: () => ({ removePlugin: (name) => removed.push(name) }),
  };
  return { engine, graphs, used, removed, second: [...scenes][0] };
};
const fakeModel = () => {
  const model = {
    hook: undefined,
    root: { matrix: new Float32Array(16) },
    setTransmission(hook) {
      model.hook = hook;
      return () => {
        if (model.hook === hook) model.hook = undefined;
      };
    },
    onDispose: () => () => {},
  };
  return model;
};

test('screenTransmission shares one depth-writing pass per frame graph and disposes it with the last model', async () => {
  const { screenTransmission, Transmission } = await import('@margoengine/gltf/transmission');
  const { engine, graphs, used, removed, second } = fakeEngine();
  const a = fakeModel(),
    b = fakeModel(),
    c = fakeModel();
  const releaseA = screenTransmission.attach(a, engine, graphs[0]),
    releaseB = screenTransmission.attach(b, engine, graphs[0]),
    releaseC = screenTransmission.attach(c, engine, graphs[1]);
  assert.equal(used.length, 2, 'one pass per frame graph');
  assert.equal(used[0].scene, undefined, 'the default graph uses the default scene');
  assert.equal(used[1].scene, second, 'another graph uses its own scene');
  const [first] = used.map((u) => u.plugin);
  assert.ok(first instanceof Transmission);
  assert.equal(first.depthWrite, true);
  assert.equal(a.hook, first);
  assert.equal(b.hook, first);
  releaseA();
  assert.equal(a.hook, undefined);
  assert.deepEqual(removed, [], 'the pass stays while a model remains');
  releaseA();
  assert.deepEqual(removed, [], 'a second release is a no-op');
  releaseB();
  assert.deepEqual(removed, [first.name], 'the last model disposes the pass');
  // A later model on the same graph gets a new pass.
  const d = fakeModel();
  screenTransmission.attach(d, engine, graphs[0]);
  assert.equal(used.length, 3);
  assert.notEqual(d.hook, first);
  releaseC();
  assert.equal(removed.length, 2);
});

test('the loaders import gltf/transmission lazily, and the parsing workers never bundle it', () => {
  const chunks = readdirSync(dist).filter((name) => name.endsWith('.js'));
  const lazy = chunks.filter((name) => /import\(`\.\/transmission\.js`\)/.test(readFileSync(new URL(name, dist), 'utf8')));
  assert.equal(lazy.length, 1, `one chunk imports the pass lazily (${lazy})`);
  assert.match(readFileSync(new URL(lazy[0], dist), 'utf8'), /KHR_materials_transmission/);
  for (const entry of ['pbr.js', 'model-entry.js', 'asset-entry.js'])
    assert.doesNotMatch(readFileSync(new URL(entry, dist), 'utf8'), /^import[^;]*transmission/m, entry);
  // A worker draws nothing: inlining the pass there cost dist/workers/gltf.js 3.5 kB gzip (45,046 B).
  for (const worker of ['gltf.js', 'progressive.js'])
    assert.doesNotMatch(readFileSync(new URL(`workers/${worker}`, dist), 'utf8'), /transmission:copy|screenTransmission/, worker);
});

test('withTransmission adds the pass only for a physical file that declares the extension and leaves a choice alone', async () => {
  const { withTransmission } = await import('../src/default-transmission.ts');
  const glass = { materials: [{ extensions: { KHR_materials_transmission: { transmissionFactor: 0 } } }] },
    plain = { materials: [{ extensions: { KHR_materials_volume: {} } }] },
    shader = {},
    mine = { attach: () => () => {} };
  // false stays false, so calling it again (the buffers path of parseGLTFAsync does) never adds the pass.
  const off = { materials: shader, transmission: false };
  assert.equal(await withTransmission(glass, off), off);
  assert.equal(await withTransmission(glass, await withTransmission(glass, off)), off);
  const chosen = { materials: shader, transmission: mine };
  assert.equal(await withTransmission(glass, chosen), chosen, 'a given pass is kept');
  const base = {};
  assert.equal(await withTransmission(glass, base), base, 'no physical shader (materials: false): no pass');
  const other = { materials: shader };
  assert.equal(await withTransmission(plain, other), other, 'no KHR_materials_transmission: no pass');
  // A volume file takes the pass as well (KB-VOL-TINT-DISPLAY1): the slab-default case of
  // scripts/test-screen-transmission-browser.mjs proves it through parseGLTFAsync.
});
