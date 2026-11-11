import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildOctree } from '@margoengine/points/octree';
import { SelectionStore } from '@margoengine/sciviz/link';
import { dataToScene } from '@margoengine/sciviz';

class PointsHost {
  clouds = new Set();
  static attach(engine, options) {
    const p = new PointsHost();
    Object.assign(p, options);
    engine.use(p);
    return p;
  }
  add(cloud) {
    this.clouds.add(cloud);
    return cloud;
  }
  remove(cloud) {
    this.clouds.delete(cloud);
  }
  dispose() {
    this.clouds.clear();
  }
}
const pointsModule = await import('@margoengine/points');
mock.module('@margoengine/points', { namedExports: { ...pointsModule, PointsPlugin: PointsHost } });
const { pointcloud, openPointCloud } = await import('@margoengine/sciviz/pointcloud');
const identity = () => Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
function figure() {
  const plugins = new Map(),
    layers = [],
    fig = new EventTarget();
  const canvas = Object.assign(new EventTarget(), { width: 100, height: 100 });
  const engine = {
    canvas,
    camera: { matrix: identity(), position: [0, 0, 5], fov: 60 },
    use(p) {
      plugins.set(p.name, p);
      p.setup?.(engine);
    },
    hasPlugin: (name) => plugins.has(name),
    // As core: the scene holding the plugin, none once removed. Plugin dispose asks it (988f6a3ad).
    sceneOf: (p) => (plugins.get(p?.name) === p ? engine : undefined),
    removePlugin(name) {
      const p = plugins.get(name);
      plugins.delete(name);
      p?.dispose();
    },
  };
  return Object.assign(fig, {
    engine,
    layers,
    plugins,
    bounds: [-1, 1, -1, 1, -1, 1],
    addLayer(layer) {
      layers.push(layer);
      this.bounds = layer.bounds;
      layer.setModel(dataToScene(this.bounds, [1, 1, 1]));
      return layer;
    },
  });
}
const source = () =>
  buildOctree({
    positions: Float32Array.of(-0.5, 0, 0, 0.5, 0, 0),
    attributes: { intensity: Uint16Array.of(10, 90), vector: Float32Array.of(1, 2, 3, 4) },
    rowIds: ['a', 'b'],
  });

test('attributes and stable identities survive sampling and shared selection without network reads', async () => {
  const f = figure(),
    store = new SelectionStore([], { universe: 'open' });
  using layer = await pointcloud(f, source(), {
    name: 'scan',
    selection: store,
    attribute: 'intensity',
    range: [0, 100],
  });
  await layer.ready({ signal: AbortSignal.timeout(1000) });
  assert.equal(layer.stats.loaded, 2);
  assert.equal(layer.stats.drawn, 2);
  assert.equal(layer.stats.attributeBytes, 20);
  layer.octree.matrix.set(identity());
  const hit = layer.pick(25, 50);
  assert.equal(hit.rowId, 'scan/a');
  assert.deepEqual(hit.attributes, { intensity: 10, vector: [1, 2] });
  const cloud = [...layer.points.clouds][0],
    before = cloud.colors.slice();
  store.select(['scan/b'], { source: 'table' });
  assert.notEqual(cloud.colors[0], before[0]);
  assert.equal(cloud.colors[1], before[1]);
  assert.deepEqual(layer.select({ rect: [0, 0, 50, 100] }), ['scan/a']);
  assert.deepEqual(store.rowIds, ['scan/a']);
  store.clear();
  assert.deepEqual(cloud.colors, before);
  layer.setColour({ attribute: 'vector', component: 1, range: [0, 4], colormap: 'gray' });
  assert.notDeepEqual(cloud.colors, before);
});

test('large survey origins are subtracted before float32 and pick returns world data units', async () => {
  const f = figure(),
    origin = [9_000_000.123, 8_000_000.456, 300.789];
  using layer = await pointcloud(f, source(), { origin });
  assert.equal(layer.octree.matrix[12], -0);
  assert.equal(layer.octree.matrix[13], -1);
  assert.equal(layer.octree.matrix[14], 1);
  await layer.ready({ signal: AbortSignal.timeout(1000) });
  layer.octree.matrix.set(identity());
  assert.deepEqual(layer.pick(25, 50).position, [origin[0] - 0.5, origin[1], origin[2]]);
  layer.setPointBudget(5);
  assert.equal(layer.points.pointBudget, 5);
  assert.equal(layer.octree.pointBudget, 5);
  assert.throws(() => layer.setPointBudget(1), /root count/);
});

test('billion-point metadata performs only visible node work and retains only resident attributes', async () => {
  const s = source(),
    root = { ...s.root, children: new Array(8).fill(null) };
  let reads = 0;
  // 1,000,000,000 records are described by the hierarchy, not allocated in the viewer.
  root.children[0] = { ...root, id: 'r0', parent: root, count: 999_999_998, level: 1, children: [] };
  const f = figure();
  using layer = await pointcloud(
    f,
    {
      root,
      load(node, signal) {
        signal.throwIfAborted();
        reads++;
        return s.load(s.root);
      },
    },
    { pointBudget: 2, maxLoadedPoints: 2 },
  );
  await layer.ready({ signal: AbortSignal.timeout(1000) });
  assert.equal(reads, 1);
  assert.equal(layer.stats.drawn, 2);
  assert.equal(layer.stats.attributeBytes, 20);
  assert.equal(layer.points.clouds.size, 1);
  layer.dispose();
  assert.equal(layer.stats.attributeBytes, 0);
  assert.equal(f.plugins.size, 0);
});

test('errors and cancellation propagate, malformed columns fail, and disposal releases plugins', async () => {
  const f = figure(),
    s = source(),
    failure = new Error('broken node');
  using layer = await pointcloud(f, {
    root: s.root,
    load() {
      throw failure;
    },
  });
  await assert.rejects(layer.ready({ signal: AbortSignal.timeout(1000) }), (e) => e === failure);
  const controller = new AbortController();
  controller.abort(failure);
  await assert.rejects(
    openPointCloud(f, 'https://unused', { format: 'copc', signal: controller.signal }),
    (e) => e === failure,
  );
  using bad = await pointcloud(figure(), {
    root: s.root,
    load() {
      return { positions: new Float32Array(3) };
    },
  });
  await assert.rejects(bad.ready({ signal: AbortSignal.timeout(1000) }), /count differs/);
  const later = await pointcloud(figure(), s);
  later.dispose();
  assert.throws(() => later.pick(0, 0), /disposed/);
  const invalid = figure();
  await assert.rejects(pointcloud(invalid, s, { maxLoadedPoints: 0 }), /maxLoadedPoints/);
  assert.equal(invalid.plugins.size, 0, 'invalid octree options allocate no engine plugins');
});

test("disposal while another scene is active removes the layer's own points plugin, not that scene's", async () => {
  const f = figure(),
    engine = f.engine,
    scenes = [f.plugins, new Map()];
  let active = scenes[0];
  // As core: use and removePlugin(name) act on the active scene; sceneOf finds the scene a plugin joined.
  const owner = (scene) => ({
    removePlugin(name) {
      const p = scene.get(name);
      scene.delete(name);
      p?.dispose?.();
    },
  });
  Object.assign(engine, {
    use(p) {
      active.set(p.name, p);
      p.setup?.(engine);
    },
    hasPlugin: (name) => active.has(name),
    sceneOf: (p) => {
      const scene = scenes.find((m) => m.get(p?.name) === p);
      return scene && owner(scene);
    },
    removePlugin(name) {
      owner(active).removePlugin(name);
    },
  });
  const layer = await pointcloud(f, source()),
    points = layer.points,
    decoy = { name: points.name, disposed: 0, dispose() {
      this.disposed++;
    } };
  scenes[1].set(decoy.name, decoy);
  active = scenes[1];
  layer.dispose();
  assert.equal(scenes[1].get(decoy.name), decoy, 'the active scene keeps its same-named plugin');
  assert.equal(decoy.disposed, 0);
  assert.equal(scenes[0].has(points.name), false, 'the points plugin left the scene it joined');
});

test('an inactive empty:false shared predicate dims all points until a row is selected', async () => {
  const store = new SelectionStore([], { universe: 'open', empty: false });
  using layer = await pointcloud(figure(), source(), {
    name: 'scan',
    selection: store,
    attribute: 'intensity',
    range: [0, 100],
  });
  await layer.ready({ signal: AbortSignal.timeout(1000) });
  const cloud = [...layer.points.clouds][0],
    before = cloud.colors.slice();
  store.select(['scan/a']);
  assert.notEqual(cloud.colors[0], before[0]);
  assert.equal(cloud.colors[1], before[1]);
  store.clear();
  assert.deepEqual(cloud.colors, before);
});

test('URL adapters reuse the real LAZ, COPC and Potree readers with attributes and source origins', async () => {
  const fixture = (name) =>
    new Uint8Array(readFileSync(new URL(`../../points/tests/fixtures/${name}`, import.meta.url)));
  for (const [format, name] of [
    ['laz', 'USGS_LPC_MT_Statewide_Phase3_2021_B21_568232.laz'],
    ['copc', 'laz/simple.copc.laz'],
  ]) {
    const bytes = fixture(name),
      requests = [];
    const fetcher = async (_url, init) => {
      init.signal?.throwIfAborted();
      const range = new Headers(init.headers).get('Range');
      requests.push(range);
      if (!range) return new Response(bytes);
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range);
      return new Response(bytes.subarray(+a, +b + 1), { status: 206 });
    };
    using layer = await openPointCloud(figure(), 'https://archive/tile', {
      format,
      fetch: fetcher,
      attribute: 'intensity',
      range: [0, 65535],
      minNodePixels: 1e12,
    });
    await layer.ready({ signal: AbortSignal.timeout(5000) });
    assert(layer.stats.loaded > 0);
    assert(layer.stats.attributeBytes > 0);
    assert(layer.origin.some((v) => v !== 0));
    assert.equal(requests.some(Boolean), format === 'copc');
  }
  const fetcher = async (url) => {
    const path = new URL(url).pathname.slice(1).replace(/cloud\.js$/, 'cloud.js.json');
    return new Response(fixture(`potree/lion-1.4-laz/${path}`));
  };
  using layer = await openPointCloud(figure(), 'https://archive/cloud.js', {
    format: 'potree',
    fetch: fetcher,
    attribute: 'intensity',
    range: [0, 65535],
    minNodePixels: 1e12,
  });
  await layer.ready({ signal: AbortSignal.timeout(5000) });
  assert(layer.stats.loaded > 0);
  assert(layer.stats.attributeBytes > 0);
});
