import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { TilesRenderer, Y_UP_TO_Z_UP, invert, multiply, parseI3dm, transformDirection, transformPoint, translation } from '../dist/index.js';
import { i3dm, instanceCenter, instanceMatrices } from '../dist/i3dm.js';
import { boxGLB, groveTileset, i3dm as writeI3dm, memoryFetch, settle } from './generator.js';

const close = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

/** Column-major T x R x S from a translation, a unit quaternion and a scale (what the renderer hands a mesh). */
function compose(t, q, s) {
  const [x, y, z, w] = q;
  return Float64Array.from([
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ]);
}
/** A seeded rotation, scale and translation, column-major. */
function randomMatrix(seed, reach) {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const q = [r(), r(), r(), r()],
    l = Math.hypot(...q);
  return compose([r() * reach, r() * reach, r() * reach], q.map((v) => v / l), [1 + r() * 0.5, 1 + r() * 0.5, 1 + r() * 0.5]);
}

test('i3dm maths: root x node x instance row equals translate(center) x instance x y-up to z-up x node', () => {
  const instances = new Float64Array(16 * 6);
  for (let i = 0; i < 6; i++) instances.set(randomMatrix(i + 3, 500), i * 16);
  const node = randomMatrix(99, 20),
    center = instanceCenter(instances),
    rows = instanceMatrices(instances, node, center);
  let mean = [0, 0, 0];
  for (let i = 0; i < 6; i++) for (let k = 0; k < 3; k++) mean[k] += instances[i * 16 + 12 + k] / 6;
  for (let k = 0; k < 3; k++) close(center[k], mean[k], 1e-9, 'centre is the mean position');
  for (let i = 0; i < 6; i++) {
    const got = multiply(multiply(translation(...center), node), rows.subarray(i * 16, i * 16 + 16));
    const want = multiply(multiply(instances.subarray(i * 16, i * 16 + 16), Y_UP_TO_Z_UP), node);
    for (let k = 0; k < 16; k++) close(got[k], want[k], 1e-9 * (1 + Math.abs(want[k])), `instance ${i} element ${k}`);
  }
});

/** A fake engine and gltf-pro-shaped model: one primitive on a node translated (1, 2, 3) inside the model. */
function fakeEngine() {
  const mesh = (matrix = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])) => {
    const m = { visible: true, matrix, position: null, quaternion: null, scale: null, disposed: false };
    m.check = () => {};
    m.setPosition = (v) => ((m.position = v), m);
    m.setQuaternion = (v) => ((m.quaternion = v), m);
    m.setScale = (v) => ((m.scale = v), m);
    m.dispose = () => {};
    return m;
  };
  const models = [];
  const engine = {
    camera: { position: [0, 300, 300], fov: 60, planes: new Float32Array(24) },
    canvas: { height: 600 },
    plugins: new Map(),
    use(plugin) {
      this.plugins.set(plugin.name, plugin);
      plugin.setup(this);
      return this;
    },
    hasPlugin(name) {
      return this.plugins.has(name);
    },
    removePlugin(name) {
      const p = this.plugins.get(name);
      this.plugins.delete(name);
      p?.dispose();
    },
  };
  const loadModel = async (_engine, gltf) => {
    const root = mesh(),
      node = mesh(Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1])),
      model = { root, gltf, primitives: [{ node }, { node }], disposed: 0, dispose() { model.disposed++; } };
    models.push(model);
    return model;
  };
  return { engine, loadModel, models };
}

async function grove(options = {}) {
  const data = groveTileset(options.grove);
  const memory = memoryFetch(data.files);
  const { engine, loadModel, models } = fakeEngine();
  const renderer = await TilesRenderer.load(engine, memory.url, { fetch: memory.fetch, loadModel, i3dm, ...options.renderer });
  const errors = [];
  renderer.tileset.on('error', ({ error }) => errors.push(error));
  for (let i = 0; i < 30 && renderer.tileset.progress.ready + renderer.tileset.progress.failed < 1; i++) {
    renderer.update();
    await settle(4);
  }
  return { data, memory, renderer, models, errors };
}

test('i3dm: every tree lands where the float64 maths puts its foot, standing up, in one instanced draw per node', async () => {
  const { data, renderer, models, errors } = await grove();
  assert.deepEqual(errors, []);
  assert.equal(models.length, 1, 'one model for the whole grove');
  const [model] = models,
    [a, b] = model.primitives;
  assert.equal(a.instances, b.instances, 'primitives on one node share their instance rows');
  assert.equal(a.instances.count, 25);
  const root = compose(model.root.position, model.root.quaternion, model.root.scale),
    node = model.primitives[0].node.matrix;
  const content = parseI3dm(data.files.get('tiles/grove.i3dm'), undefined);
  for (let i = 0; i < 25; i++) {
    const row = a.instances.data.subarray(i * 24, i * 24 + 16),
      world = multiply(multiply(root, node), row);
    // The model's own origin under the node offset is (-1, -2, -3) in node space; at the instance it is the foot.
    const foot = transformPoint(world, transformPoint(invert(node), [0, 0, 0])),
      want = renderer.toWorld([0, 1, 2].map((k) => content.matrices[i * 16 + 12 + k] + data.rtc[k]));
    for (let k = 0; k < 3; k++) close(foot[k], want[k], 5e-3, `tree ${i} axis ${k}`);
    // glTF +y (the trunk) points along the world's up at the grove (ENU frame: +y).
    const up = transformDirection(world, [0, 1, 0]),
      l = Math.hypot(...up);
    close(up[1] / l, 1, 1e-4, `tree ${i} stands up`);
  }
  // Float32 rows stay small: the root sits at the grove's centre.
  for (let i = 0; i < 25; i++) assert.ok(Math.abs(a.instances.data[i * 24 + 12]) < 200, 'row translation stays local');
  renderer.dispose();
  assert.equal(model.disposed, 1, 'dispose frees the model');
});

test('i3dm: an external glTF (gltfFormat 0) is fetched relative to the tile with the tileset fetch', async () => {
  const { memory, models, errors, renderer } = await grove({ grove: { uri: true } });
  assert.deepEqual(errors, []);
  assert.equal(models.length, 1);
  assert.ok(memory.requests.some((r) => r.endsWith('models/tree.glb')), memory.requests.join());
  assert.equal(models[0].primitives[0].instances.count, 25);
  renderer.dispose();
});

test('i3dm: without the i3dm option the tile fails with a coded error naming the entry, and the rest stays up', async () => {
  const { errors, models, renderer } = await grove({ renderer: { i3dm: undefined } });
  assert.equal(models.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'unsupported');
  assert.match(errors[0].message, /tiles\/i3dm/);
  renderer.dispose();
});

test('i3dm: zero instances load no model and draw nothing', async () => {
  const empty = writeI3dm(boxGLB(), { positions: [] });
  const content = parseI3dm(empty);
  assert.equal(content.length, 0);
  const { engine, loadModel, models } = fakeEngine();
  const host = {
    engine,
    url: 'https://tiles.test/tileset.json',
    loadModel: (gltf, signal) => loadModel(engine, gltf, signal),
    place() {},
    forget() {},
    contentMatrix: () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    fetch: async () => new Uint8Array(0),
  };
  const drawn = await i3dm(host, content, { contentUrls: ['https://tiles.test/a.i3dm'] }, new AbortController().signal);
  assert.equal(drawn.bytes, content.byteLength);
  drawn.visible = true;
  assert.equal(drawn.visible, false);
  drawn.dispose();
  assert.equal(models.length, 0);
});

test('i3dm: the real TilesetWithTreeBillboards sample (Cesium, CC0) places all 25 trees at their feet, standing up', async () => {
  const folder = new URL('../../../examples/assets/3d-tiles/TilesetWithTreeBillboards/', import.meta.url),
    files = new Map(['tileset.json', 'tree.i3dm', 'tree_billboard.i3dm'].map((name) => [name, new Uint8Array(readFileSync(new URL(name, folder)))])),
    memory = memoryFetch(files),
    { engine, loadModel, models } = fakeEngine(),
    renderer = await TilesRenderer.load(engine, memory.url, { fetch: memory.fetch, loadModel, i3dm }),
    errors = [];
  renderer.tileset.on('error', ({ error }) => errors.push(error));
  for (let i = 0; i < 40 && models.length < 1; i++) {
    renderer.update();
    await settle(4);
  }
  assert.deepEqual(errors, []);
  assert.ok(models.length >= 1);
  for (const model of models) {
    const name = ['tree.i3dm', 'tree_billboard.i3dm'].find((n) => parseI3dm(files.get(n)).gltf.byteLength === model.gltf.byteLength),
      content = parseI3dm(files.get(name)),
      rows = model.primitives[0].instances;
    assert.equal(content.length, 25, name);
    assert.equal(rows.count, 25, name);
    const root = compose(model.root.position, model.root.quaternion, model.root.scale),
      node = model.primitives[0].node.matrix;
    for (let i = 0; i < 25; i++) {
      const world = multiply(multiply(root, node), rows.data.subarray(i * 24, i * 24 + 16)),
        foot = transformPoint(world, transformPoint(invert(node), [0, 0, 0])),
        want = renderer.toWorld([0, 1, 2].map((k) => content.matrices[i * 16 + 12 + k]));
      // 5 mm: float32 rows within the grove's 100 m reach hold about 8 micrometres; the rest is the fake's float32 node.
      for (let k = 0; k < 3; k++) close(foot[k], want[k], 5e-3, `${name} tree ${i} axis ${k}`);
      const up = transformDirection(world, [0, 1, 0]);
      // EAST_NORTH_UP at each tree: within 100 m of the frame's centre the local up turns by under 2e-5 rad.
      close(up[1] / Math.hypot(...up), 1, 1e-4, `${name} tree ${i} stands up`);
    }
  }
  renderer.dispose();
});
