import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainImagery, xyzImagery, wmtsImagery, imageryTiles } from '../dist/imagery.js';
import { PlanetTerrain } from '../dist/planet.js';

function fixture(options = {}) {
  const writes = [],
    textures = [],
    effects = new Set();
  const gpu = {
    limits: { maxSampledTexturesPerShaderStage: 16, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 },
    createBuffer: (d) => ({
      ...d,
      destroy() {
        this.dead = true;
      },
    }),
    createSampler: () => ({}),
    createTexture(d) {
      const t = {
        ...d,
        dimension: '2d',
        sampleCount: 1,
        depthOrArrayLayers: d.size[2] ?? 1,
        width: d.size[0],
        height: d.size[1],
        createView(d) {
          return { t, d };
        },
        destroy() {
          this.dead = true;
        },
      };
      textures.push(t);
      return t;
    },
    queue: {
      writeBuffer(_b, _o, data) {
        writes.push(Array.from(data));
      },
      writeTexture(...args) {
        writes.push(args);
      },
    },
  };
  const terrain = {
    options: { origin: [0, 0], size: [10, 20] },
    addLighting(e) {
      effects.add(e);
      return () => effects.delete(e);
    },
  };
  const engine = { gpu, sceneOf: () => undefined };
  const imagery = new TerrainImagery(terrain, { automatic: false, maxTiles: 8, ...options });
  imagery.setup(engine);
  return { imagery, engine, gpu, textures, writes, effects };
}
const source = () =>
  xyzImagery('https://example.test/{z}/{x}/{y}', { tileSize: 1, load: async () => new Uint8Array([255, 0, 0, 255]) });

test('XYZ and WMTS address north-origin rows, named matrices, style and dimensions', () => {
  assert.equal(xyzImagery('/{z}/{x}/{y}').url, '/{z}/{x}/{y}');
  const tile = { level: 1, x: 3, y: 2 };
  const wmts = wmtsImagery({
    url: 'https://example.test/wmts?token=one',
    layer: 'air photo',
    matrixSet: 'grid',
    matrices: ['base', 'fine'],
    dimensions: { TIME: '2026-11-10' },
  });
  const url = new URL(wmts.url(tile));
  assert.equal(wmts.maxLevel, 1);
  assert.equal(url.searchParams.get('TILEMATRIX'), 'fine');
  assert.equal(url.searchParams.get('TILEROW'), '2');
  assert.equal(url.searchParams.get('TILECOL'), '3');
  assert.equal(url.searchParams.get('LAYER'), 'air photo');
  assert.equal(url.searchParams.get('TIME'), '2026-11-10');
  assert.equal(url.searchParams.get('token'), 'one');
  const rest = wmtsImagery({
    url: 'https://example.test/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}/{TIME}',
    layer: 'l',
    matrixSet: 'A:B',
    dimensions: { TIME: 'now' },
  });
  assert.equal(rest.url(tile), 'https://example.test/A%3AB/1/2/3/now');
});

test('nested residency is bounded, deduplicated, coarse first and covers the dateline/poles', () => {
  for (const center of [
    [0.99999, 0],
    [0.00001, 1],
    [-2.5, 0.5],
  ])
    for (const columns of [1, 2]) {
      const tiles = imageryTiles(center, 18, 64, columns);
      assert.ok(tiles.length <= 64);
      assert.equal(new Set(tiles.map((t) => `${t.level}/${t.x}/${t.y}`)).size, tiles.length);
      assert.equal(tiles.filter((t) => t.level === 0).length, columns);
      assert.ok(tiles.some((t) => t.level === 18));
      for (const t of tiles) {
        assert.ok(t.x >= 0 && t.x < columns * 2 ** t.level);
        assert.ok(t.y >= 0 && t.y < 2 ** t.level);
      }
      assert.deepEqual(
        tiles.map((t) => t.level),
        tiles.map((t) => t.level).sort((a, b) => a - b),
      );
    }
});

test('ordered layers update styles and bounds atomically, retaining borrowed ownership', async () => {
  const f = fixture(),
    borrowed = f.gpu.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: 4 });
  const a = f.imagery.add({ source: { texture: () => borrowed, attribution: 'Public domain' } });
  const b = f.imagery.add({ source: source(), alpha: 0.25, brightness: 2, bounds: [1, 2, 3, 4] });
  await f.imagery.ready;
  assert.deepEqual(f.imagery.order, [a, b]);
  assert.deepEqual(f.imagery.credits, ['Public domain']);
  f.imagery.move(a, 1);
  assert.deepEqual(f.imagery.order, [b, a]);
  f.imagery.set(b, { show: false, alpha: 0.5 });
  const data = f.writes.at(-1);
  assert.deepEqual(data.slice(0, 8), [1, 2, 3, 4, 0, 2, 1, 1]);
  assert.throws(() => f.imagery.set(b, { alpha: -1, bounds: [2, 2, 8, 8] }), RangeError);
  f.imagery.set(b, { show: true });
  assert.deepEqual(f.writes.at(-1).slice(0, 8), [1, 2, 3, 4, 0.5, 2, 1, 1]);
  assert.equal(f.imagery.bindings().length, 4);
  assert.equal(f.imagery.remove(b), true);
  assert.equal(f.imagery.remove(b), false);
  assert.equal(f.textures.at(-1).dead, true);
  f.imagery.dispose();
  f.imagery.dispose();
  assert.equal(borrowed.dead, undefined);
  assert.equal(f.effects.size, 0);
  assert.throws(() => f.imagery.add({ source: source() }), { code: 'disposed' });
});

test('residency reuses loaded tiles, stale requests cannot upload, restoration reacquires borrowed textures', async () => {
  const f = fixture();
  let calls = 0;
  f.imagery.add({
    source: {
      ...source(),
      load: async (_t, signal) => {
        calls++;
        signal.throwIfAborted();
        return new Uint8Array([1, 2, 3, 255]);
      },
    },
  });
  await f.imagery.ready;
  await f.imagery.update([0.5, 0.5], 2);
  const before = calls;
  await f.imagery.update([0.5, 0.5], 2);
  assert.equal(calls, before);
  const firstTexture = f.textures.at(-1);
  f.imagery.onDeviceRestored(f.engine);
  await f.imagery.ready;
  assert.equal(firstTexture.dead, true);
  assert.equal(f.effects.size, 1);
  assert.notEqual(f.textures.at(-1), firstTexture);
  f.imagery.dispose();
  let complete;
  const g = fixture();
  g.imagery.add({
    source: {
      ...source(),
      load: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    },
  });
  g.imagery.dispose();
  const writeCount = g.writes.length;
  complete(new Uint8Array([0, 0, 0, 255]));
  await g.imagery.ready;
  assert.equal(g.writes.length, writeCount, 'disposed request uploaded');
});

test('request errors and caller cancellation are observable without automatic retries', async () => {
  const f = fixture();
  let calls = 0;
  f.imagery.add({
    source: {
      ...source(),
      load: async () => {
        calls++;
        throw new TypeError('provider failed');
      },
    },
  });
  await assert.rejects(f.imagery.ready, /provider failed/);
  assert.equal(calls, 1);
  assert.match(f.imagery.error.message, /provider failed/);
  f.imagery.dispose();
  const g = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(g.imagery.update([0, 0], 0, controller.signal), { name: 'AbortError' });
  g.imagery.dispose();
});

test('imagery patches lit clipmap, RVT and planet surfaces before lighting, and validates capacity', async () => {
  const f = fixture();
  f.imagery.add({ source: source() });
  await f.imagery.ready;
  for (const call of ['terrainColor', 'terrainVirtualGround']) {
    const code = f.imagery.shader(`let base=${call}(i.position,n);let lit=base;`, 1);
    assert.match(code, new RegExp(`let base=terrainImagery\\(${call}\\(i.position,n\\),i.position\\);`));
    assert.match(code, /textureSampleGrad/);
  }
  assert.throws(() => f.imagery.shader('wrong shader', 1), { code: 'unsupported' });
  assert.throws(() => new TerrainImagery({}, {}), TypeError);
  assert.throws(() => fixture({ maxTiles: 2 }), RangeError);
  assert.throws(() => f.imagery.add({ source: source(), brightness: Infinity }), RangeError);
  f.imagery.dispose();
  const planet = new PlanetTerrain({ radius: 100, relief: 0, maxPatches: 6, resolution: 4 });
  const imagery = new TerrainImagery(planet, { automatic: false });
  imagery.setup(f.engine);
  imagery.add({ source: source() });
  await imagery.ready;
  const code = imagery.shader('let nl=clamp(dot(n,planet.light.xyz),0.0,1.0);', 1);
  assert.match(code, /base=terrainImagery\(base,i.position\);let nl/);
  assert.match(code, /normalize\(position-planet.center.xyz\)/);
  assert.throws(() => imagery.set(imagery.order[0], { bounds: [170, -90, 190, 90] }), RangeError);
  imagery.dispose();
  planet.dispose();
});

test('R5: the minLevel fallback is the center tile when level zero has two columns', () => {
  // Capacity 4 with two columns leaves two fine tiles; the level-1 parent of center 0.9 is column 3 of 4.
  const tiles = imageryTiles([0.9, 0.5], 3, 4, 2, 1);
  assert.ok(
    tiles.some((t) => t.level === 1 && t.x === 3 && t.y === 1),
    `center parent 1/3/1 missing: ${JSON.stringify(tiles)}`,
  );
});

test('R5: a clipmap camera past the east edge loads the east edge tiles, not the west side', async () => {
  const f = fixture({ maxTiles: 64 }),
    loaded = [];
  f.imagery.add({
    source: {
      ...source(),
      load: async (tile) => {
        loaded.push(tile);
        return new Uint8Array([1, 2, 3, 255]);
      },
    },
  });
  await f.imagery.ready;
  loaded.length = 0;
  await f.imagery.update([1.1, 0.5], 5);
  const fine = loaded.filter((t) => t.level === 5).map((t) => t.x);
  assert.ok(fine.includes(31), `level-5 columns ${fine} miss the east edge column 31`);
  assert.ok(!fine.includes(0), `level-5 columns ${fine} wrapped to the west edge`);
  f.imagery.dispose();
});

test('the small WebGL2 preview is refused during setup with a coded WebGPU error, before any lighting is added', () => {
  const effects = new Set(),
    terrain = {
      options: { origin: [0, 0], size: [10, 20] },
      addLighting(e) {
        effects.add(e);
        return () => effects.delete(e);
      },
    };
  for (const engine of [
    { backend: 'webgl2', gpu: null, sceneOf: () => undefined },
    { backend: 'webgl2', gpu: {}, sceneOf: () => undefined },
  ])
    assert.throws(
      () => new TerrainImagery(terrain, { automatic: false }).setup(engine),
      (error) =>
        error.code === 'unsupported' &&
        error.message.startsWith('TerrainImagery needs WebGPU') &&
        error.message.includes('https://margoengine.com/errors#webgpu'),
    );
  assert.equal(effects.size, 0);
});
