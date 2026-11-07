import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { GLTFAsset } from '../../gltf-pro/dist/index.js';
import { gaussianSplats, readGaussianSplats } from '../../gltf-pro/dist/splats.js';
import { transformSplats } from '../../splats/dist/index.js';
import { glbChunks } from '../../shared/glb.js';
import { TilesRenderer, holdsSplats, multiply, transformPoint } from '../dist/index.js';
import { SPLATS_PER_CLOUD, TileSplats, mergePlaced, placeSplats } from '../dist/splats.js';
import { boxGLB, memoryFetch, settle } from './generator.js';

const folder = new URL('../../../examples/assets/3d-tiles/GaussianSplats/sh_unit_cube/', import.meta.url),
  sampleGlb = () => new Uint8Array(readFileSync(new URL('0/0.glb', folder)));

/** The real sample's one primitive, read by gltf-pro as the drawer reads it. */
async function sampleSplats() {
  const [json, binary] = glbChunks(sampleGlb()),
    doc = JSON.parse(new TextDecoder().decode(json.data)),
    asset = new GLTFAsset(doc, [], binary.data, { splats: gaussianSplats }, 2 ** 30);
  return readGaussianSplats(asset, doc.meshes[0].primitives[0]);
}

/** A seeded rotation and scale with a far translation (an ECEF-sized offset), column-major float64. */
function farMatrix() {
  const c = Math.cos(0.7),
    s = Math.sin(0.7);
  return Float64Array.from([c * 2, s * 2, 0, 0, -s * 2, c * 2, 0, 0, 0, 0, 2, 0, 1_215_013.25, -4_736_021.5, 4_081_007.75, 1]);
}

function fakeEngine() {
  const mesh = () => {
    const m = { visible: true, matrix: new Float32Array(16), check() {}, dispose() {} };
    m.setPosition = () => m;
    m.setQuaternion = () => m;
    m.setScale = () => m;
    return m;
  };
  return {
    camera: { position: [0, 50, 300], fov: 60, planes: new Float32Array(24) },
    canvas: { height: 600 },
    plugins: new Map(),
    createMesh: mesh,
    use(plugin) {
      this.plugins.set(plugin.name, plugin);
      plugin.setup?.(this);
      return this;
    },
    hasPlugin(name) {
      return this.plugins.has(name);
    },
    removePlugin(name) {
      this.plugins.delete(name);
    },
  };
}

/** The real sh_unit_cube tileset (CesiumJS spec data, Apache-2.0) from memory, run until its one tile settles. */
async function cube(options) {
  const files = new Map(['tileset.json', '0/0.glb'].map((n) => [n, new Uint8Array(readFileSync(new URL(n, folder)))])),
    memory = memoryFetch(files),
    engine = fakeEngine(),
    models = [],
    loadModel = async (_engine, gltf) => {
      const model = { root: engine.createMesh(), gltf, dispose() {} };
      models.push(model);
      return model;
    },
    renderer = await TilesRenderer.load(engine, memory.url, { fetch: memory.fetch, loadModel, ...options }),
    errors = [];
  renderer.tileset.on('error', ({ error }) => errors.push(error));
  for (let i = 0; i < 40 && renderer.tileset.progress.ready + renderer.tileset.progress.failed < 1; i++) {
    renderer.update();
    await settle(4);
  }
  return { renderer, models, errors };
}

test('splat tiles: holdsSplats tells a KHR_gaussian_splatting glTF from a plain one', () => {
  assert.equal(holdsSplats({ type: 'glb', gltf: sampleGlb(), byteLength: 0 }), true);
  assert.equal(holdsSplats({ type: 'glb', gltf: boxGLB(), byteLength: 0 }), false);
  const text = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, extensionsUsed: ['KHR_gaussian_splatting'] }));
  assert.equal(holdsSplats({ type: 'gltf', gltf: text, byteLength: 0 }), true);
});

test('splat tiles: without the splats option a splat tile fails with a coded error naming the entry, not misplaced', async () => {
  // Before the fix the renderer handed the glTF to loadModel, and gltf-pro attached its splats at the model's own
  // origin, outside the tile transform and the frame, and never hid them with the tile.
  const { renderer, models, errors } = await cube();
  assert.equal(models.length, 0, 'loadModel is not given a splat tile');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'unsupported');
  assert.match(errors[0].message, /tiles\/splats/);
  renderer.dispose();
});

test('splat tiles: with the splats option the real sample goes to the drawer with its content and tile', async () => {
  const calls = [];
  const drawer = async (host, content, tile) => {
    calls.push({ host, content, tile });
    return { bytes: content.byteLength, visible: false, dispose() {} };
  };
  const { renderer, models, errors } = await cube({ splats: drawer });
  assert.deepEqual(errors, []);
  assert.equal(models.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content.type, 'glb');
  assert.equal(calls[0].tile, renderer.tileset.root);
  // The host gives the frame x tile x y-up to z-up matrix and calls listeners after each update.
  let updates = 0;
  const stop = calls[0].host.onUpdate(() => updates++);
  renderer.update();
  renderer.update();
  stop();
  renderer.update();
  assert.equal(updates, 2);
  assert.deepEqual(calls[0].host.offset(), [0, 0, 0]);
  renderer.dispose();
});

test('splat tiles: the real sample placed far from the origin keeps float64 positions and the transformed shapes', async () => {
  const data = await sampleSplats(),
    matrix = farMatrix(),
    placed = await placeSplats(data, matrix),
    count = data.positions.length / 3;
  assert.equal(count, 27);
  assert.deepEqual(placed.anchor, [matrix[12], matrix[13], matrix[14]]);
  // Shapes and harmonics match @margoengine/splats' own transform with the same matrix.
  const whole = transformSplats(data, matrix);
  for (let i = 0; i < whole.covariances.length; i++)
    assert.ok(Math.abs(placed.data.covariances[i] - whole.covariances[i]) <= 1e-5 * (1 + Math.abs(whole.covariances[i])), `covariance ${i}`);
  assert.deepEqual(placed.data.sphericalHarmonics, whole.sphericalHarmonics);
  // Built around an offset near the tile (a floating origin 3 m away), every centre is exact to float32 at that size.
  const offset = [matrix[12] + 1, matrix[13] - 2, matrix[14] + 2],
    merged = mergePlaced([placed], offset);
  let worst = 0,
    naive = 0;
  for (let i = 0; i < count; i++) {
    const want = transformPoint(matrix, [data.positions[i * 3], data.positions[i * 3 + 1], data.positions[i * 3 + 2]]);
    for (let k = 0; k < 3; k++) {
      worst = Math.max(worst, Math.abs(merged.positions[i * 3 + k] - (want[k] - offset[k])));
      naive = Math.max(naive, Math.abs(whole.positions[i * 3 + k] - want[k]));
    }
  }
  // The sample spans about 100 m after the scale of 2: float32 there resolves 8 micrometres; 1e-4 m bounds it.
  assert.ok(worst < 1e-4, `float64 placement error ${worst} m`);
  // A float32 transform at 4,700 km rounds to 0.5 m steps: what keeping the translation apart avoids.
  assert.ok(naive > 1e-2, `float32 at ECEF loses ${naive} m`);
});

test('splat tiles: mergePlaced pads harmonics to the largest degree, band 0 from the colour', () => {
  const plain = {
      data: {
        positions: new Float32Array([0, 0, 0]),
        covariances: new Float32Array([1, 0, 0, 1, 0, 1]),
        colors: new Float32Array([0.75, 0.5, 0.25, 1]),
      },
      anchor: [10, 0, 0],
    },
    sh = new Float32Array(9 * 3).map((_, i) => i / 100),
    banded = {
      data: {
        positions: new Float32Array([1, 2, 3]),
        covariances: new Float32Array([1, 0, 0, 1, 0, 1]),
        colors: new Float32Array([0, 0, 0, 0.5]),
        sphericalHarmonics: sh,
      },
      anchor: [0, 0, 0],
    };
  const merged = mergePlaced([plain, banded]);
  assert.equal(merged.sphericalHarmonics.length, 2 * 9 * 3);
  const C0 = 0.2820947917738781;
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(0.5 + C0 * merged.sphericalHarmonics[c] - plain.data.colors[c]) < 1e-6);
  for (let i = 3; i < 27; i++) assert.equal(merged.sphericalHarmonics[i], 0, `higher band ${i} of the plain splat`);
  assert.deepEqual(merged.sphericalHarmonics.subarray(27), sh);
  assert.deepEqual([...merged.positions], [10, 0, 0, 1, 2, 3]);
  assert.equal(mergePlaced([plain]).sphericalHarmonics, undefined);
});

/** A scene on a fake host: `updates()` stands for the renderer's selection updates. */
function scene(limit) {
  const listeners = new Set(),
    built = [];
  let offset = [0, 0, 0];
  const host = {
    engine: {},
    onUpdate(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    offset: () => offset,
  };
  const splats = new TileSplats(
    host,
    (_engine, data) => {
      const cloud = { count: data.positions.length / 3, data, disposed: false, dispose() { cloud.disposed = true; } };
      built.push(cloud);
      return cloud;
    },
    limit,
  );
  return {
    splats,
    built,
    listeners,
    update: () => {
      for (const l of listeners) l();
    },
    move: (o) => (offset = o),
  };
}
const part = (n, x) => ({
  data: {
    positions: new Float32Array(n * 3).fill(x),
    covariances: new Float32Array(n * 6).map((_, i) => (i % 6 === 0 || i % 6 === 3 || i % 6 === 5 ? 1 : 0)),
    colors: new Float32Array(n * 4).fill(1),
  },
  anchor: [0, 0, 0],
});

test('splat tiles: the visible tiles form one cloud, rebuilt once per update that changed them', () => {
  const s = scene();
  const a = s.splats.add(part(2, 1)),
    b = s.splats.add(part(3, 2)),
    c = s.splats.add(part(4, 3));
  s.update();
  assert.equal(s.built.length, 0, 'nothing visible, nothing built');
  s.splats.show(a, true);
  s.splats.show(b, true);
  s.update();
  assert.equal(s.splats.clouds.length, 1);
  assert.equal(s.splats.count, 5);
  s.update();
  assert.equal(s.splats.builds, 1, 'no change, no rebuild');
  // A REPLACE swap in one update (b hides, c shows) is one rebuild, never a frame with both or neither.
  s.splats.show(b, false);
  s.splats.show(c, true);
  s.update();
  assert.equal(s.splats.builds, 2);
  assert.equal(s.splats.count, 6);
  assert.equal(s.built[0].disposed, true, 'the old cloud is freed');
  assert.deepEqual([...new Set(s.splats.clouds[0].data.positions)].sort(), [1, 3]);
  // A floating-origin move rebuilds around the new offset.
  s.move([1, 0, 0]);
  s.update();
  assert.equal(s.splats.builds, 3);
  assert.equal(s.splats.clouds[0].data.positions[0], 0);
  // The last tile going frees the cloud at once and stops listening.
  for (const e of [a, b, c]) s.splats.remove(e);
  assert.equal(s.splats.clouds.length, 0);
  assert.equal(s.built.at(-1).disposed, true);
  assert.equal(s.listeners.size, 0);
});

test('splat tiles: past the per-cloud limit the visible splats start another cloud', () => {
  assert.equal(SPLATS_PER_CLOUD, 3_000_000);
  const s = scene(5);
  for (const n of [3, 2, 4]) s.splats.show(s.splats.add(part(n, n)), true);
  s.update();
  assert.deepEqual(s.splats.clouds.map((c) => c.count), [5, 4]);
});
