import assert from 'node:assert/strict';
import { cpuTimer } from '../../../scripts/support/cpu-budget.mjs';
import test from 'node:test';
import {
  BatchTable,
  FetchQueue,
  Tileset,
  TilesRenderer,
  availabilityIndex,
  boxBounds,
  cartographicToEcef,
  contentMagic,
  decompose,
  eastNorthUpToEcef,
  ecefToCartographic,
  expandTemplate,
  implicitBounds,
  invert,
  mortonIndex,
  multiply,
  parseB3dm,
  parseCmpt,
  parseContent,
  parsePnts,
  parseSubtree,
  regionBounds,
  sphereBounds,
  transformPoint,
} from '../dist/index.js';
import {
  b3dm,
  boxGLB,
  cityTileset,
  cmpt,
  enu,
  implicitTileset,
  memoryFetch,
  pnts,
  settle,
  subtree,
} from './generator.js';

const close = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

/** ECEF position of a point given in the city's ENU metres. */
const cityPoint = (local, lon = -75.6, lat = 40.04) => transformPoint(enu(lon, lat), local);
const view = (local, extra = {}) => ({ position: cityPoint(local), screenHeight: 800, fov: 60, ...extra });

async function loadCity(options = {}, data = cityTileset(options.city)) {
  const memory = memoryFetch(data.files, options.memory);
  const tileset = await Tileset.load(memory.url, { fetch: memory.fetch, ...options.tileset });
  return { tileset, memory, data };
}
/** Updates until nothing is pending (each round lets fetches finish). */
async function converge(tileset, v, rounds = 40) {
  let frame;
  for (let i = 0; i < rounds; i++) {
    frame = tileset.update(v);
    if (frame.pending === 0 && tileset.progress.loading === 0 && tileset.progress.queued === 0) return frame;
    await settle(4);
  }
  return frame;
}

test('WGS84: geodetic and ECEF round trip to under a millimetre, poles and heights included', () => {
  for (const [lon, lat, h] of [
    [0, 0, 0],
    [-75.6, 40.04, 120],
    [139.7, 35.7, -50],
    [10, 89.9999, 8848],
    [-170, -90, 0],
    [45, 60, 35_786_000],
  ]) {
    const p = cartographicToEcef((lon * Math.PI) / 180, (lat * Math.PI) / 180, h),
      c = ecefToCartographic(...p),
      back = cartographicToEcef(c.longitude, c.latitude, c.height);
    close(Math.hypot(back[0] - p[0], back[1] - p[1], back[2] - p[2]), 0, 1e-3, `round trip at ${lon},${lat},${h}`);
    close(c.height, h, 1e-3, 'height');
  }
  const m = eastNorthUpToEcef(...cartographicToEcef(0.3, 0.7, 0));
  const dot = (i, j) => m[i * 4] * m[j * 4] + m[i * 4 + 1] * m[j * 4 + 1] + m[i * 4 + 2] * m[j * 4 + 2];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) close(dot(i, j), i === j ? 1 : 0, 1e-12, 'ENU orthonormal');
});

test('matrices: inverse, decompose and the frame keep float64 precision at ECEF scale', () => {
  const m = enu(-75.6, 40.04),
    i = invert(m),
    p = cityPoint([1234.5, 678.9, 10.25]);
  const local = transformPoint(i, p);
  close(local[0], 1234.5, 1e-7, 'x');
  close(local[1], 678.9, 1e-7, 'y');
  close(local[2], 10.25, 1e-7, 'z');
  const d = decompose(multiply(m, Float64Array.of(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1)));
  for (const s of d.scale) close(s, 2, 1e-12, 'scale');
  close(Math.hypot(...d.rotation), 1, 1e-12, 'unit quaternion');
  assert.throws(() => invert(new Float64Array(16)), RangeError);
});

test('bounds: box, sphere and region distance, containment and frustum tests', () => {
  const box = boxBounds([0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0.5]);
  assert.equal(box.distanceTo([1, 0.5, 0]), 0);
  close(box.distanceTo([5, 0, 0]), 3, 1e-12, 'box distance along x');
  close(box.distanceTo([2, 1, 1.5]), 1, 1e-12, 'box distance along z');
  const sphere = sphereBounds([10, 0, 0, 2], Float64Array.of(3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1));
  close(sphere.radius, 6, 1e-12, 'scaled radius');
  close(sphere.distanceTo([60, 0, 0]), 24, 1e-9, 'sphere distance');
  // Planes: x >= -1 and x <= 1 (and four that keep everything).
  const planes = [1, 0, 0, 1, -1, 0, 0, 1, 0, 1, 0, 1e9, 0, -1, 0, 1e9, 0, 0, 1, 1e9, 0, 0, -1, 1e9];
  assert.equal(boxBounds([0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5]).intersectsFrustum(planes), true);
  assert.equal(boxBounds([5, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5]).intersectsFrustum(planes), false);
  assert.equal(boxBounds([1.4, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5]).intersectsFrustum(planes), true, 'straddles');
  const rad = Math.PI / 180,
    region = [-75.7 * rad, 40 * rad, -75.5 * rad, 40.1 * rad, -10, 300],
    r = regionBounds(region);
  for (const lon of [-75.7, -75.6, -75.5])
    for (const lat of [40, 40.05, 40.1])
      for (const h of [-10, 300])
        assert.equal(r.distanceTo(cartographicToEcef(lon * rad, lat * rad, h)), 0, `region holds ${lon},${lat},${h}`);
  assert.ok(r.distanceTo(cartographicToEcef(-75.6 * rad, 40.05 * rad, 1000)) > 600, 'far above the region');
  // A whole hemisphere still holds its points.
  const hemi = regionBounds([-Math.PI / 2, -Math.PI / 2, Math.PI / 2, Math.PI / 2, 0, 0]);
  assert.equal(hemi.distanceTo(cartographicToEcef(1.2, 0.3, 0)), 0);
  assert.throws(() => regionBounds([0, 1, 0.1, 0, 0, 0]), RangeError);
});

test('formats: b3dm, pnts and cmpt round trip through our writers; batch tables read JSON and binary', () => {
  const glb = boxGLB();
  assert.equal(contentMagic(glb), 'glTF');
  const tile = parseB3dm(
    b3dm(glb, {
      rtcCenter: [1, 2, 3],
      batch: [
        { name: 'a', height: 4 },
        { name: 'b', height: 7.5 },
      ],
    }),
  );
  assert.equal(tile.type, 'b3dm');
  assert.deepEqual(tile.rtcCenter, [1, 2, 3]);
  assert.deepEqual([...tile.gltf], [...glb]);
  assert.ok(tile.batchTable instanceof BatchTable);
  assert.deepEqual(tile.batchTable.feature(1), { name: 'b', height: 7.5 });
  assert.equal(tile.batchTable.get(5, 'name'), undefined, 'out-of-range batch id');
  const points = parsePnts(pnts([0, 0, 0, 1, 2, 3], [255, 0, 0, 0, 128, 255], { rtcCenter: [10, 20, 30] }));
  assert.deepEqual([...points.positions], [0, 0, 0, 1, 2, 3]);
  assert.deepEqual([...points.colors], [255, 0, 0, 255, 0, 128, 255, 255]);
  assert.deepEqual(points.rtcCenter, [10, 20, 30]);
  const composite = parseCmpt(cmpt([b3dm(glb), cmpt([glb])]));
  assert.equal(composite.tiles.length, 2);
  assert.equal(composite.tiles[1].type, 'cmpt');
  assert.equal(composite.tiles[1].tiles[0].type, 'glb');
});

test('fuzz: truncated or corrupt content never crashes or hangs; errors are TypeError or RangeError', () => {
  const samples = [
    b3dm(boxGLB(), { batch: [{ name: 'x', height: 1 }] }),
    pnts([0, 0, 0, 1, 1, 1], [1, 2, 3, 4, 5, 6]),
    cmpt([b3dm(boxGLB()), pnts([0, 0, 0], [0, 0, 0])]),
    subtree({ tiles: [1, 1, 0, 1, 0], contents: 1, children: 0 }),
  ];
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const cpu = cpuTimer();
  let thrown = 0;
  for (const sample of samples)
    for (let i = 0; i < 400; i++) {
      const bytes = i < 200 ? sample.slice(0, Math.floor(random() * sample.length)) : sample.slice();
      if (i >= 200)
        for (let k = 0; k < 1 + (i % 6); k++) bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
      try {
        if (contentMagic(bytes) === 'subt')
          void parseSubtree(bytes, 'QUADTREE', 2).catch((e) =>
            assert.ok(e instanceof TypeError || e instanceof RangeError, e.message),
          );
        else parseContent(bytes);
      } catch (error) {
        thrown++;
        assert.ok(error instanceof TypeError || error instanceof RangeError, `${error?.name}: ${error?.message}`);
      }
    }
  assert.ok(thrown > 500, `most corrupt inputs are rejected (${thrown})`);
  assert.ok(cpu() < 150, 'fuzzing finishes quickly');
});

test('implicit tiling: Morton order, availability indices, templates, subtree bitstreams and subdivision', async () => {
  assert.equal(mortonIndex(0, 0), 0);
  assert.equal(mortonIndex(1, 0), 1);
  assert.equal(mortonIndex(0, 1), 2);
  assert.equal(mortonIndex(3, 3), 15);
  assert.equal(mortonIndex(1, 1, 1), 7);
  assert.equal(mortonIndex(2, 0, 0), 8);
  assert.equal(availabilityIndex(0, 0, 0), 0);
  assert.equal(availabilityIndex(1, 1, 1), 4);
  assert.equal(availabilityIndex(2, 0, 0), 5);
  assert.equal(availabilityIndex(1, 1, 0, 1), 1 + 5);
  assert.equal(expandTemplate('t/{level}/{x}/{y}/{z}.glb', 3, 4, 5, 6), 't/3/4/5/6.glb');
  const s = await parseSubtree(
    subtree({ tiles: [1, 1, 0, 0, 1], contents: [1, 0, 0, 0, 1], children: 0 }),
    'QUADTREE',
    2,
  );
  assert.equal(s.tiles.get(0), true);
  assert.equal(s.tiles.get(2), false);
  assert.equal(s.tiles.count, 3);
  assert.equal(s.contents[0].get(1), false);
  assert.equal(s.childSubtrees.count, 0);
  // Children of a box partition it.
  const root = boxBounds([0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0, 2]);
  const child = implicitBounds(root, 'QUADTREE', 1, 1, 0);
  assert.deepEqual([...child.center], [4, -4, 0]);
  assert.deepEqual([...child.halfAxes], [4, 0, 0, 0, 4, 0, 0, 0, 2]);
  const octant = implicitBounds(root, 'OCTREE', 2, 3, 0, 3);
  assert.deepEqual([...octant.center], [6, -6, 1.5]);
});

test('selection: a far camera draws only the root; a close camera refines toward it and nowhere else', async () => {
  const { tileset } = await loadCity({ city: { levels: 4 } });
  let frame = await converge(tileset, view([0, 0, 200_000]));
  assert.deepEqual(
    frame.selected.map((t) => t.depth),
    [0],
  );
  // Close to the south-west corner, low.
  frame = await converge(tileset, view([-900, -900, 30]));
  const depths = frame.selected.map((t) => t.depth);
  assert.ok(depths.includes(3), `deepest level near the camera: ${depths}`);
  for (const tile of frame.selected) {
    // Every drawn tile either meets the error target or is a leaf.
    assert.ok(
      tile.screenSpaceError <= tileset.maximumScreenSpaceError || tile.children.length === 0,
      `tile ${tile.id} sse ${tile.screenSpaceError}`,
    );
    // And its parent did not (otherwise the parent would have been drawn instead).
    if (tile.parent) assert.ok(tile.parent.screenSpaceError > tileset.maximumScreenSpaceError);
  }
  const far = frame.selected.filter((t) => t.bounds.distanceTo(view([-900, -900, 30]).position) > 1500);
  assert.ok(
    far.every((t) => t.depth <= 2),
    'far tiles stay coarse',
  );
  // The drawn set covers the city exactly once (REPLACE: no ancestor drawn with its descendant).
  const drawn = new Set(frame.selected);
  for (const tile of frame.selected) for (let p = tile.parent; p; p = p.parent) assert.ok(!drawn.has(p), 'no overlap');
  const area = frame.selected.reduce((sum, t) => sum + 4 ** -t.depth, 0);
  close(area, 1, 1e-12, 'drawn tiles cover the whole city');
});

test('selection follows a moving camera: new tiles load where it goes, and the error target holds every frame', async () => {
  const { tileset, memory } = await loadCity({ city: { levels: 5 } });
  const path = [-900, -450, 0, 450, 900];
  const loadedAt = [];
  for (const x of path) {
    const frame = await converge(tileset, view([x, 0, 25]));
    const near = frame.selected.filter((t) => t.distance < 100);
    assert.ok(near.length && near.every((t) => t.depth === 4), `leaves under the camera at x=${x}`);
    loadedAt.push(memory.requests.length);
  }
  for (let i = 1; i < loadedAt.length; i++) assert.ok(loadedAt[i] > loadedAt[i - 1], 'each move requests new tiles');
  assert.equal(new Set(memory.requests).size, memory.requests.length, 'no tile is fetched twice under a large budget');
});

test('REPLACE keeps the parent drawn until all visible children are ready (no holes); ADD draws both', async () => {
  let open;
  const opened = new Promise((resolve) => (open = resolve));
  const gate = (path) => (path.startsWith('tiles/1/') ? opened : Promise.resolve());
  const { tileset } = await loadCity({ city: { levels: 2 }, memory: { gate } });
  const near = view([0, 0, 20]);
  let frame = await converge(tileset, near, 5);
  assert.deepEqual(
    frame.selected.map((t) => t.depth),
    [0],
    'children pending: the root covers',
  );
  assert.equal(tileset.progress.loading, 4);
  open();
  frame = await converge(tileset, near);
  assert.deepEqual(
    frame.selected.map((t) => t.depth),
    [1, 1, 1, 1],
    'children ready: they replace the root',
  );
  const { tileset: add } = await loadCity({ city: { levels: 2, refine: 'ADD' } });
  frame = await converge(add, near);
  assert.equal(frame.selected[0].depth, 0, 'ADD draws the parent');
  assert.equal(frame.selected.length, 5, 'and its four children');
  tileset.dispose();
});

test('skipLevelOfDetail does not request far-too-coarse ancestors', async () => {
  const normal = await loadCity({ city: { levels: 5 } });
  const skip = await loadCity({
    city: { levels: 5 },
    tileset: { skipLevelOfDetail: true, skipScreenSpaceErrorFactor: 2 },
  });
  const v = view([0, 0, 20]);
  await converge(normal.tileset, v);
  await converge(skip.tileset, v);
  const depths = (m) => m.requests.filter((p) => p.startsWith('tiles/')).map((p) => Number(p.split('/')[1]));
  assert.ok(depths(normal.memory).includes(0), 'the classic order loads the root first');
  assert.ok(!depths(skip.memory).includes(1), `skipping leaves out level 1: ${depths(skip.memory)}`);
  assert.ok(skip.memory.requests.length < normal.memory.requests.length, 'fewer requests');
});

test('fetch queue: priority order, concurrency limit, and aborting what is no longer wanted', async () => {
  const queue = new FetchQueue({ maxConcurrent: 2 }),
    started = [],
    finish = new Map(),
    aborted = [];
  const run = (key) => (signal) =>
    new Promise((resolve) => {
      started.push(key);
      signal.addEventListener('abort', () => {
        aborted.push(key);
        resolve();
      });
      finish.set(key, resolve);
    });
  queue.begin();
  for (const [key, priority] of [
    ['far', [1, 900]],
    ['near', [1, 10]],
    ['parent', [0, 1]],
    ['mid', [1, 50]],
  ])
    queue.want(key, priority, run(key));
  queue.flush();
  assert.deepEqual(started, ['parent', 'near']);
  assert.equal(queue.inFlight, 2);
  queue.begin();
  queue.want('near', [1, 10], run('near'));
  queue.want('mid', [1, 50], run('mid'));
  queue.flush();
  assert.deepEqual(aborted, ['parent'], 'unwanted in-flight request aborted');
  await settle();
  queue.begin();
  queue.want('near', [1, 10], run('near'));
  queue.want('mid', [1, 50], run('mid'));
  queue.flush();
  assert.deepEqual(started, ['parent', 'near', 'mid'], 'far was dropped, mid started when a slot freed');
  assert.throws(() => new FetchQueue({ maxConcurrent: 0 }), RangeError);
});

test('memory budget: eviction keeps ready content under the budget as the camera moves, least recently used first', async () => {
  const data = cityTileset({ levels: 5 });
  const tileSize = data.files.get('tiles/4/0/0.glb').byteLength;
  const budget = tileSize * 120; // one view needs about 90 tiles; the five together need far more
  const { tileset } = await loadCity({ tileset: { memoryBudget: budget } }, data);
  const unloaded = [];
  tileset.on('tileunload', ({ tile }) => unloaded.push(tile));
  let overs = 0;
  for (const [x, y] of [
    [-900, -900],
    [900, -900],
    [900, 900],
    [-900, 900],
    [0, 0],
  ]) {
    await converge(tileset, view([x, y, 25]));
    const ready = [...tileset.tiles()].filter((t) => t.state === 'ready' && !t.external),
      frame = Math.max(...ready.map((t) => t.lastUsed));
    // Either under the budget, or everything still held is in use by this view (nothing evictable is kept).
    assert.ok(
      tileset.bytes <= budget || ready.every((t) => t.lastUsed === frame),
      `bytes ${tileset.bytes} over budget ${budget} at ${x},${y} with unused tiles kept`,
    );
    if (tileset.bytes > budget) overs++;
  }
  assert.ok(overs <= 1, `the corner views fit the budget (${overs} over)`);
  assert.ok(unloaded.length > 0, 'something was evicted');
  for (const tile of unloaded) assert.ok(tile.state === 'unloaded' || tile.state === 'ready');
  // Coming back reloads what was evicted.
  const before = tileset.progress.ready;
  await converge(tileset, view([-900, -900, 25]));
  assert.ok(tileset.progress.ready > 0 && before > 0);
});

test('external tilesets load as children; implicit tilesets load subtrees then content', async () => {
  const city = cityTileset({ levels: 2 });
  const files = new Map([...city.files].map(([k, v]) => [`city/${k}`, v]));
  files.set(
    'tileset.json',
    new TextEncoder().encode(
      JSON.stringify({
        asset: { version: '1.1' },
        geometricError: 1000,
        root: {
          boundingVolume: city.tileset.root.boundingVolume,
          transform: city.tileset.root.transform,
          geometricError: 500,
          refine: 'REPLACE',
          content: { uri: 'city/tileset.json' },
        },
      }),
    ),
  );
  // The outer root's transform and the inner root's transform both apply: drop the inner one to keep positions.
  const inner = JSON.parse(new TextDecoder().decode(files.get('city/tileset.json')));
  delete inner.root.transform;
  files.set('city/tileset.json', new TextEncoder().encode(JSON.stringify(inner)));
  const memory = memoryFetch(files);
  const outer = await Tileset.load(memory.url, { fetch: memory.fetch });
  const frame = await converge(outer, view([0, 0, 20]));
  assert.ok(outer.root.external);
  assert.ok(
    frame.selected.length >= 4 && frame.selected.every((t) => t.depth === 2),
    'drew the external tileset leaves',
  );
  assert.ok(memory.requests.includes('city/tiles/1/0/0.glb'), 'content resolves against the external tileset URL');

  const implicit = implicitTileset({ levels: 4, subtreeLevels: 2 });
  const im = memoryFetch(implicit.files);
  const tiles = await Tileset.load(im.url, { fetch: im.fetch });
  const centre = cartographicToEcef((0.01 * Math.PI) / 180, (0.01 * Math.PI) / 180, 5);
  const result = await converge(tiles, { position: centre, screenHeight: 800, fov: 60 });
  assert.ok(
    im.requests.some((p) => p.startsWith('subtrees/0/')),
    'root subtree',
  );
  assert.ok(
    im.requests.some((p) => p.startsWith('subtrees/2/')),
    'child subtrees',
  );
  assert.ok(
    result.selected.some((t) => t.implicit.level === 3),
    `deepest implicit level drawn: ${result.selected.map((t) => t.implicit.level)}`,
  );
  close(
    result.selected.reduce((s, t) => s + 4 ** -t.implicit.level, 0),
    1,
    1e-12,
    'implicit cover',
  );
});

test('errors: a missing tile reports a coded error, its parent stays drawn, and retry() recovers', async () => {
  let broken = true;
  const { tileset } = await loadCity({
    city: { levels: 2 },
    memory: { fail: (p) => (broken && p === 'tiles/1/1/1.glb' ? 503 : 0) },
  });
  const errors = [];
  tileset.on('error', (e) => errors.push(e));
  let frame = await converge(tileset, view([0, 0, 20]));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.name, 'MargoError');
  assert.equal(errors[0].error.code, 'failed');
  assert.match(errors[0].error.message, /tileset\.retry\(\)/);
  assert.deepEqual(
    frame.selected.map((t) => t.depth),
    [0],
    'no hole: the root covers the failed child',
  );
  broken = false;
  tileset.retry();
  frame = await converge(tileset, view([0, 0, 20]));
  assert.deepEqual(
    frame.selected.map((t) => t.depth),
    [1, 1, 1, 1],
  );

  // Corrupt content fails the tile, not the tileset.
  const data = cityTileset({ levels: 2 });
  data.files.set('tiles/1/0/0.glb', new Uint8Array([1, 2, 3, 4, 5]));
  const corrupt = await loadCity({}, data);
  const seen = [];
  corrupt.tileset.on('error', (e) => seen.push(e.error));
  await converge(corrupt.tileset, view([0, 0, 20]));
  assert.equal(seen.length, 1);
  assert.match(seen[0].message, /Unknown tile content/);

  await assert.rejects(
    Tileset.load('https://tiles.test/nope.json', { fetch: memoryFetch(new Map()).fetch }),
    (e) => e.code === 'failed' && /404/.test(e.message),
  );
  assert.throws(
    () => Tileset.from({ asset: { version: '1.1' }, geometricError: 1, root: { geometricError: 1 } }, 'https://x/'),
    (e) => e instanceof TypeError && /boundingVolume/.test(e.message),
  );
  assert.throws(
    () =>
      Tileset.from(
        {
          asset: { version: '1.1' },
          geometricError: 1,
          root: { boundingVolume: { sphere: [0, 0, 0, 1] }, geometricError: 1 },
          extensionsRequired: ['VENDOR_magic'],
        },
        'https://x/',
      ),
    (e) => e.code === 'unsupported',
  );
});

test('AbortSignal: aborting the load rejects; dispose aborts requests in flight and frees content', async () => {
  const data = cityTileset({ levels: 2 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    Tileset.load('https://tiles.test/tileset.json', {
      fetch: memoryFetch(data.files).fetch,
      signal: controller.signal,
    }),
    (e) => e.name === 'AbortError',
  );
  const memory = memoryFetch(data.files, { delay: 50 });
  const disposed = [];
  const tileset = await Tileset.load(memory.url, {
    fetch: memory.fetch,
    content: (content) => ({ bytes: content.byteLength, visible: false, dispose: () => disposed.push(content) }),
  });
  await converge(tileset, view([0, 0, 200_000]), 30);
  tileset.update(view([0, 0, 20]));
  assert.ok(tileset.progress.loading > 0);
  tileset.dispose();
  await settle();
  assert.ok(memory.aborted.length > 0, 'in-flight requests aborted');
  assert.equal(disposed.length, 1, 'the ready root was freed');
  assert.throws(
    () => tileset.update(view([0, 0, 20])),
    (e) => e.code === 'disposed',
  );
});

test('progress and idle events, and metadata with schema defaults', async () => {
  const data = cityTileset({ levels: 2 });
  const json = {
    ...data.tileset,
    schema: {
      classes: { building: { properties: { floors: { type: 'SCALAR', default: 3 }, name: { type: 'STRING' } } } },
    },
  };
  json.root = { ...json.root, metadata: { class: 'building', properties: { name: 'hall' } } };
  data.files.set('tileset.json', new TextEncoder().encode(JSON.stringify(json)));
  const { tileset } = await loadCity({}, data);
  assert.deepEqual(tileset.properties(tileset.root.metadata), { floors: 3, name: 'hall' });
  const progress = [],
    idle = [],
    loads = [];
  tileset.on('progress', (p) => progress.push(p));
  tileset.on('idle', (p) => idle.push(p));
  tileset.on('tileload', ({ tile }) => loads.push(tile.id));
  await converge(tileset, view([0, 0, 20]));
  assert.ok(progress.length > 1);
  assert.equal(idle.length, 1);
  assert.equal(loads.length, 5);
  assert.equal(progress.at(-1).selected, 4);
});

test('TilesRenderer: ENU frame puts the tileset at the world origin, y up; content keeps float64 placement', async () => {
  const data = cityTileset({ levels: 2 });
  const memory = memoryFetch(data.files);
  const placed = [];
  const mesh = () => {
    const m = { visible: true, position: null, quaternion: null, scale: null };
    m.setPosition = (v) => ((m.position = v), m);
    m.setQuaternion = (v) => ((m.quaternion = v), m);
    m.setScale = (v) => ((m.scale = v), m);
    m.dispose = () => {};
    return m;
  };
  const engine = {
    camera: { position: [0, 200_000, 0], fov: 60, planes: new Float32Array(24) },
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
  const renderer = await TilesRenderer.load(engine, memory.url, {
    fetch: memory.fetch,
    loadModel: async (_engine, gltf) => {
      const root = mesh();
      placed.push({ root, gltf });
      return { root, dispose() {} };
    },
  });
  const origin = renderer.toWorld(renderer.tileset.root.bounds.center);
  for (const v of origin) close(v, 0, 1e-6, 'root centre at the world origin');
  const up = renderer.cartographicToWorld(-75.6, 40.04, 100);
  close(up[1] - renderer.cartographicToWorld(-75.6, 40.04, 0)[1], 100, 1e-6, 'height is +y');
  for (let i = 0; i < 20 && renderer.tileset.progress.ready < 1; i++) {
    renderer.update();
    await settle(4);
  }
  assert.ok(placed.length >= 1);
  // The root box sits on the ENU origin plane, so its root mesh lands at about (0, -up offset, 0) in the world.
  const root = placed[0].root;
  assert.ok(Math.hypot(...root.position) < 50, `placed near the origin: ${root.position}`);
  close(Math.hypot(...root.quaternion), 1, 1e-9, 'unit rotation');
  // Move the camera close: the renderer refines (its camera is read in world space).
  engine.camera.position = [0, 20, 0];
  for (let i = 0; i < 30; i++) {
    renderer.update();
    await settle(4);
  }
  assert.ok(
    renderer.last.selected.every((t) => t.depth === 1),
    'refined under a close camera',
  );
  renderer.dispose();
  assert.equal(engine.plugins.size, 0);
});

test('memory budget: when the view alone passes the budget, refinement waits instead of growing past it', async () => {
  const data = cityTileset({ levels: 3 });
  const one = data.files.get('tiles/0/0/0.glb').byteLength;
  const { tileset } = await loadCity({ tileset: { memoryBudget: one * 2 } }, data);
  const frame = await converge(tileset, view([0, 0, 20]));
  assert.ok(tileset.overBudget, 'over budget flagged');
  // The root and level 1 (hole-filling fallbacks) may load; the leaves (refinement) never start.
  assert.ok(
    frame.selected.every((t) => t.depth <= 1),
    `no refinement past the budget: ${frame.selected.map((t) => t.depth)}`,
  );
  const leaves = [...tileset.tiles()].filter((t) => t.depth === 2 && t.state === 'ready').length;
  assert.ok(leaves < 16, `refinement stopped part way: ${leaves} of 16 leaves`);
});

// Regression: in a page, Tileset.load('data/tileset.json') fetched the JSON (fetch resolves against the page) but
// then every tile failed with "Cannot resolve tile URI": the relative tileset URL was kept as the base.
test('tileset: a relative tileset URL resolves against the page, and so do its tiles', async () => {
  const data = cityTileset({ levels: 2 }),
    files = new Map([...data.files].map(([path, bytes]) => [`app/data/${path}`, bytes])),
    memory = memoryFetch(files, { base: 'https://site.test/' }),
    had = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { href: 'https://site.test/app/index.html' }, configurable: true });
  try {
    const tileset = await Tileset.load('data/tileset.json', {
      fetch: memory.fetch,
      content: (content) => ({ bytes: content.byteLength, visible: false, dispose() {} }),
    });
    assert.equal(tileset.url, 'https://site.test/app/data/tileset.json');
    assert.ok(tileset.root.contentUrls.length > 0);
    assert.ok(tileset.root.contentUrls.every((url) => url.startsWith('https://site.test/app/data/')));
    tileset.dispose();
  } finally {
    if (had) Object.defineProperty(globalThis, 'location', had);
    else delete globalThis.location;
  }
});
