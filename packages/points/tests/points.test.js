import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Camera} from '@margoengine/core';
import {
  PointCloud, PointsMaterial, PointsPlugin, SpriteBatch, SpriteMaterial, SPRITE_STRIDE,
  buildBlocks, expandBlockBounds, worldBox, boxInFrustum, cullBlocks, screenArea, allocateBudget, multiply, projectPoint, pickPoint,
  boxScreenRect, packColors, mergeRanges, atlasRect, random, NO_BLOCK,
} from '../dist/index.js';

const bunny = (await readFile(new URL('./fixtures/bunny.pcd', import.meta.url), 'utf8')).split('\n').slice(10).filter(Boolean).flatMap(line => line.trim().split(/\s+/).map(Number));
const randomCloud = (n, seed = 7, scale = 10) => {const next = random(seed), p = new Float32Array(n * 3); for (let i = 0; i < p.length; i++) p[i] = (next() - 0.5) * scale; return p;};
const camera = (position = [0, 0, 10], target = [0, 0, 0], aspect = 1, options = {}) => {const c = new Camera({position, target, fov: 60, near: 0.1, far: 100, ...options}); c.update(aspect, true); return c;};
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

function checkBlocks(blocks, positions, count, blockSize) {
  const seen = new Uint8Array(count);
  let total = 0;
  for (let b = 0; b < blocks.length; b++) {
    assert.ok(blocks.counts[b] <= blockSize && blocks.counts[b] > 0, `block ${b} has ${blocks.counts[b]} points`);
    if (b) assert.equal(blocks.starts[b], blocks.starts[b - 1] + blocks.counts[b - 1], 'blocks are contiguous in slot order');
    for (let s = blocks.starts[b]; s < blocks.starts[b] + blocks.counts[b]; s++) {
      const p = blocks.order[s];
      assert.equal(seen[p], 0, `point ${p} appears twice`); seen[p] = 1; total++;
      assert.equal(blocks.blockOf[p], b);
      for (let a = 0; a < 3; a++) {
        const v = Math.fround(positions[p * 3 + a]);
        assert.ok(v >= blocks.bounds[b * 6 + a] && v <= blocks.bounds[b * 6 + 3 + a], `point ${p} outside block ${b} bounds`);
      }
    }
  }
  assert.equal(total, blocks.finite);
}

test('chunking covers every point once, respects the block size and bounds, and is deterministic', () => {
  const n = 100_000, positions = randomCloud(n), blocks = buildBlocks(positions, n, 4096, 3);
  checkBlocks(blocks, positions, n, 4096);
  assert.equal(blocks.finite, n);
  // Median splits keep leaves between half and the full block size.
  assert.ok(blocks.length >= Math.ceil(n / 4096) && blocks.length <= Math.ceil(n / 2048), `${blocks.length} blocks`);
  for (let b = 0; b < blocks.length; b++) assert.ok(blocks.counts[b] >= 2048);
  // Spatially compact: the blocks' volumes sum to about the cloud volume, not blocks * cloud volume.
  let volume = 0;
  for (let b = 0; b < blocks.length; b++) volume += (blocks.bounds[b * 6 + 3] - blocks.bounds[b * 6]) * (blocks.bounds[b * 6 + 4] - blocks.bounds[b * 6 + 1]) * (blocks.bounds[b * 6 + 5] - blocks.bounds[b * 6 + 2]);
  assert.ok(volume < 1000 * 1.2, `blocks overlap: total volume ${volume}`);
  const again = buildBlocks(positions, n, 4096, 3), other = buildBlocks(positions, n, 4096, 4);
  assert.deepEqual(again.order, blocks.order);
  assert.notDeepEqual(other.order, blocks.order);
});

test('chunking the real Stanford bunny scan (PCL bunny.pcd)', () => {
  const n = bunny.length / 3;
  assert.equal(n, 397);
  const blocks = buildBlocks(bunny, n, 64);
  checkBlocks(blocks, bunny, n, 64);
  assert.ok(blocks.length >= 7 && blocks.length <= 13);
  const whole = buildBlocks(bunny, n, 1000);
  assert.equal(whole.length, 1);
  assert.ok(Math.abs(whole.bounds[0] - Math.min(...bunny.filter((_, i) => i % 3 === 0))) < 1e-6);
});

test('non-finite points are left out of blocks; empty clouds give no blocks', () => {
  const positions = new Float32Array([0, 0, 0, NaN, 1, 1, 1, 1, 1, 2, Infinity, 2]);
  const blocks = buildBlocks(positions, 4, 2);
  assert.equal(blocks.finite, 2);
  assert.equal(blocks.blockOf[1], NO_BLOCK); assert.equal(blocks.blockOf[3], NO_BLOCK);
  assert.equal(buildBlocks(new Float32Array(0), 0).length, 0);
  assert.throws(() => buildBlocks(positions, 5), RangeError);
  assert.throws(() => buildBlocks(positions, 4, 0), RangeError);
});

test('a prefix of a shuffled block is an even subsample of the block', () => {
  const side = 128, n = side * side, positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {positions[i * 3] = i % side; positions[i * 3 + 1] = Math.floor(i / side);}
  const blocks = buildBlocks(positions, n, n, 9);
  assert.equal(blocks.length, 1);
  for (const k of [256, 1024, 4096]) {
    const quadrants = [0, 0, 0, 0];
    let mx = 0, my = 0;
    for (let s = 0; s < k; s++) {const p = blocks.order[s], x = positions[p * 3], y = positions[p * 3 + 1]; mx += x; my += y; quadrants[(x < side / 2 ? 0 : 1) + (y < side / 2 ? 0 : 2)]++;}
    mx /= k; my /= k;
    assert.ok(Math.abs(mx - 63.5) < 6 && Math.abs(my - 63.5) < 6, `prefix ${k} centroid ${mx}, ${my}`);
    for (const q of quadrants) assert.ok(Math.abs(q - k / 4) < 0.25 * k / 4 + 20, `prefix ${k} quadrants ${quadrants}`);
  }
});

test('expandBlockBounds grows only the blocks of updated points', () => {
  const positions = randomCloud(1000), blocks = buildBlocks(positions, 1000, 100);
  const before = blocks.bounds.slice(), target = 5, b = blocks.blockOf[target];
  positions.set([50, 50, 50], target * 3);
  assert.equal(expandBlockBounds(blocks, positions, target, 1), 1);
  assert.equal(blocks.bounds[b * 6 + 3], 50);
  for (let other = 0; other < blocks.length; other++) if (other !== b) assert.deepEqual(blocks.bounds.slice(other * 6, other * 6 + 6), before.slice(other * 6, other * 6 + 6));
});

test('frustum culling against Camera.planes: known cases and no false negatives', () => {
  const cam = camera();
  const box = (x, y, z, e = 0.5) => [x, y, z, e, e, e];
  assert.ok(boxInFrustum(box(0, 0, 0), cam.planes));
  assert.ok(!boxInFrustum(box(0, 0, 12), cam.planes), 'behind the camera');
  assert.ok(!boxInFrustum(box(30, 0, 0), cam.planes), 'far right');
  assert.ok(!boxInFrustum(box(0, 0, -200), cam.planes), 'beyond the far plane');
  assert.ok(boxInFrustum(box(0, 0, 10, 3), cam.planes), 'contains the camera');
  assert.ok(boxInFrustum(box(7, 0, 0), cam.planes, 3), 'margin widens the test');
  // Blocks transformed by a model matrix.
  const blocks = {bounds: new Float32Array([-1, -1, -1, 1, 1, 1]), counts: new Uint32Array([10]), length: 1};
  const out = new Uint32Array(1);
  assert.equal(cullBlocks(blocks, identity, cam.planes, out), 1);
  assert.equal(cullBlocks(blocks, translate(40, 0, 0), cam.planes, out), 0);
  const rotated = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, -5, 1], world = new Float64Array(6);
  worldBox(blocks.bounds, 0, rotated, world);
  assert.deepEqual([...world].map(v => Math.round(v * 1e6) / 1e6), [0, 0, -5, 1, 1, 1]);
  // Randomized: any point whose projection is inside the clip volume belongs to a visible block.
  for (const [eye, aspect] of [[[3, 4, 8], 1.5], [[-6, 2, -5], 0.75], [[0.5, 9, 0.2], 1]]) {
    const view = camera(eye, [0, 0, 0], aspect), positions = randomCloud(50_000, 11, 30), cloud = buildBlocks(positions, 50_000, 512);
    const visible = new Uint32Array(cloud.length), count = cullBlocks(cloud, identity, view.planes, visible), set = new Set(visible.subarray(0, count));
    assert.ok(count > 0 && count < cloud.length, `${count} of ${cloud.length} blocks visible`);
    const p = new Float64Array(3);
    let inside = 0;
    for (let i = 0; i < 50_000; i++) {
      if (!projectPoint(view.matrix, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], 100, 100, p)) continue;
      if (p[0] < 0 || p[0] > 100 || p[1] < 0 || p[1] > 100) continue;
      inside++;
      assert.ok(set.has(cloud.blockOf[i]), `point ${i} is on screen but its block was culled`);
    }
    assert.ok(inside > 100);
  }
});

test('screen area grows as blocks come closer and is capped by the viewport', () => {
  const far = screenArea([0, 0, 0, 1, 1, 1], [0, 0, 50], 200, 400, 400), near = screenArea([0, 0, 0, 1, 1, 1], [0, 0, 10], 200, 400, 400);
  assert.ok(near > far * 20);
  assert.equal(screenArea([0, 0, 0, 1, 1, 1], [0, 0, 0.5], 200, 400, 300), 400 * 300);
});

test('budget allocation: exact sum, capped blocks, area-proportional shares', () => {
  const out = new Uint32Array(4);
  assert.equal(allocateBudget([10, 20, 30, 40], [1, 1, 1, 1], 4, 1000, out), 100);
  assert.deepEqual([...out], [10, 20, 30, 40]);
  // 4 blocks of 1000, equal weight, budget 1000: 250 each.
  assert.equal(allocateBudget([1000, 1000, 1000, 1000], [1, 1, 1, 1], 4, 1000, out), 1000);
  assert.deepEqual([...out], [250, 250, 250, 250]);
  // A small block keeps all of its points; its unused share flows to the others in weight proportion.
  assert.equal(allocateBudget([50, 1000, 1000, 1000], [1, 1, 1, 2], 4, 1000, out), 1000);
  assert.equal(out[0], 50);
  assert.ok(Math.abs(out[3] - 2 * out[1]) <= 2 && Math.abs(out[1] - out[2]) <= 1, `${out}`);
  // Randomized invariants.
  const next = random(5);
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(next() * 60), counts = [], weights = [];
    for (let i = 0; i < n; i++) {counts.push(Math.floor(next() * 20000)); weights.push(next() < 0.1 ? 0 : next() * 1e5);}
    const budget = Math.floor(next() * 300000), result = new Uint32Array(n), sum = allocateBudget(counts, weights, n, budget, result);
    const total = counts.reduce((a, b) => a + b, 0);
    assert.equal(sum, Math.min(budget, total));
    assert.equal(result.reduce((a, b) => a + b, 0), sum);
    for (let i = 0; i < n; i++) assert.ok(result[i] <= counts[i]);
  }
  assert.throws(() => allocateBudget([1], [1], 1, -1, out), RangeError);
});

test('projection and nearest-point picking match a brute-force search', () => {
  const view = camera([4, 3, 9]), n = 20_000, positions = randomCloud(n, 3, 8), blocks = buildBlocks(positions, n, 1000);
  const ranges = Array.from(blocks.starts, (start, b) => ({start, count: blocks.counts[b]}));
  const p = new Float64Array(3), next = random(2);
  for (let trial = 0; trial < 20; trial++) {
    const x = next() * 256, y = next() * 256;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (!projectPoint(view.matrix, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], 256, 256, p)) continue;
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d < bestD) {bestD = d; best = i;}
    }
    const hit = pickPoint(positions, blocks.order, ranges, view.matrix, 256, 256, x, y, 50);
    if (bestD > 50) {assert.equal(hit, null); continue;}
    assert.ok(hit, 'expected a hit');
    assert.ok(Math.abs(hit.distance - bestD) <= 0.5, `distance ${hit.distance} vs ${bestD}`);
  }
  // A point projected to the canvas center; ties go to the nearer point.
  const pair = new Float32Array([0, 0, 0, 0, 0, 5]);
  const hit = pickPoint(pair, null, [{start: 0, count: 2}], camera().matrix, 256, 256, 128, 128, 2);
  assert.equal(hit.index, 1);
  assert.ok(Math.abs(hit.screen[0] - 128) < 1e-3 && Math.abs(hit.screen[1] - 128) < 1e-3);
  // Points behind the camera never project.
  assert.equal(projectPoint(camera().matrix, 0, 0, 20, 256, 256, p), false);
  // The model matrix goes through `multiply(viewProj, model)`.
  const mvp = multiply(camera().matrix, translate(1, 0, 0));
  projectPoint(mvp, 0, 0, 0, 256, 256, p);
  assert.ok(Math.abs(p[0] - (128 + 128 / Math.tan(Math.PI / 6) / 10)) < 1e-3);
  const rect = boxScreenRect([0, 0, 0, 1, 1, 0], camera().matrix, 256, 256);
  assert.ok(rect[0] < 128 && rect[2] > 128 && rect[1] < 128 && rect[3] > 128);
});

test('color packing for float RGB, byte RGBA and clamping', () => {
  const out = new Uint32Array(3);
  packColors(new Float32Array([1, 0, 0, 0, 0.5, 1, -1, 2, 0.25]), 3, 3, out);
  assert.equal(out[0], 0xff0000ff); assert.equal(out[1], 0xffff8000); assert.equal(out[2], 0xff40ff00);
  packColors(new Uint8Array([1, 2, 3, 4]), 4, 1, out, 2);
  assert.equal(out[2], 0x04030201);
  assert.throws(() => packColors([1, 2], 2, 1, out), RangeError);
  assert.throws(() => packColors([1, 2, 3], 3, 1, out, 3), RangeError);
});

test('ranges merge and atlas cells are laid out row by row from the top left', () => {
  assert.deepEqual(mergeRanges([[10, 12], [0, 2], [2, 4], [11, 20], [30, 31]]), [[0, 4], [10, 20], [30, 31]]);
  assert.deepEqual(atlasRect(0, 2, 2), [0, 0, 0.5, 0.5]);
  assert.deepEqual(atlasRect(3, 2, 2), [0.5, 0.5, 1, 1]);
  assert.deepEqual(atlasRect(1, 4, 1, 0.01), [0.26, 0.01, 0.49, 0.99]);
  assert.throws(() => atlasRect(4, 2, 2), RangeError);
});

test('PointCloud accepts the loaders point-cloud shape and tracks subrange updates', () => {
  const loaded = {kind: 'points', positions: new Float32Array(bunny), colors: new Float32Array(bunny.length).fill(0.5), normals: new Float32Array(bunny.length)};
  const cloud = new PointCloud({...loaded, blockSize: 100});
  assert.equal(cloud.count, 397);
  assert.equal(cloud.positions, loaded.positions, 'Float32Array positions are used in place');
  assert.equal(cloud.colorComponents, 3);
  assert.equal(cloud.colors[0], 0xff808080);
  assert.equal(cloud.normals, loaded.normals);
  cloud.updatePositions(10, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...cloud.positions.subarray(30, 36)], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(cloud.dirty.positions, [[10, 12]]);
  const b = cloud.blocks.blockOf[11];
  assert.ok(cloud.blocks.bounds[b * 6 + 5] >= 6, 'bounds grew to the new point');
  cloud.updateColors(0, new Uint8Array([255, 0, 0, 128]), 4);
  assert.equal(cloud.colors[0], 0x800000ff);
  assert.throws(() => cloud.updatePositions(396, [0, 0, 0, 0, 0, 0]), RangeError);
  assert.throws(() => cloud.updateSizes(0, [1]), /no per-point sizes/);
  const structure = cloud.structure;
  cloud.setSizes(new Float32Array(397).fill(2));
  assert.equal(cloud.structure, structure + 1);
  cloud.updateSizes(5, [3, 3]);
  assert.deepEqual(cloud.dirty.sizes, [[5, 7]]);
  assert.throws(() => new PointCloud({positions: [0, 0]}), RangeError);
  assert.throws(() => new PointCloud({positions: [0, 0, 0], colors: [1, 1]}), RangeError);
  const rgba = new PointCloud({positions: [0, 0, 0, 1, 1, 1], colors: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])});
  assert.equal(rgba.colorComponents, 4);
});

test('reorder permutes the arrays into slot order and keeps a source index', () => {
  const n = 5000, positions = randomCloud(n), colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors[i * 3] = (i % 255) / 255;
  const cloud = new PointCloud({positions, colors, reorder: true, blockSize: 512});
  assert.equal(cloud.direct, true);
  for (let i = 0; i < n; i += 97) {
    const source = cloud.sourceIndex[i];
    assert.deepEqual([...cloud.positions.subarray(i * 3, i * 3 + 3)], [...positions.subarray(source * 3, source * 3 + 3)]);
    assert.equal(cloud.colors[i] & 255, Math.round(colors[source * 3] * 255));
    assert.equal(cloud.blocks.order[i], i);
  }
  checkBlocks(cloud.blocks, cloud.positions, n, 512);
  assert.throws(() => cloud.rebuild(), /reordered/);
});

test('SpriteBatch stores instances, grows, and removes by swapping', () => {
  const batch = new SpriteBatch({capacity: 2});
  const a = batch.add({position: [1, 2, 3], size: [2, 3], rotation: 0.5, center: [0, 1], uv: atlasRect(1, 2, 2), color: [0.5, 0.25, 1], opacity: 0.5});
  assert.equal(a, 0);
  assert.deepEqual([...batch.data.subarray(0, SPRITE_STRIDE)], [1, 2, 3, 0.5, 2, 3, 0, 1, 0.5, 0, 1, 0.5, 0.5, 0.25, 1, 0.5]);
  batch.add({}); const structure = batch.structure; batch.add({position: [9, 9, 9]});
  assert.equal(batch.count, 3); assert.equal(batch.capacity, 4); assert.equal(batch.structure, structure + 1);
  assert.equal(batch.remove(0), 2);
  assert.deepEqual([...batch.data.subarray(0, 3)], [9, 9, 9]);
  batch.set(1, {size: 5});
  assert.deepEqual([...batch.data.subarray(SPRITE_STRIDE + 4, SPRITE_STRIDE + 6)], [5, 5]);
  assert.throws(() => batch.set(5, {}), RangeError);
  assert.throws(() => batch.add({size: -1}), RangeError);
});

test('materials validate and expose Three.js aliases', () => {
  const m = new PointsMaterial({size: 3, sizeAttenuation: true, color: '#ff0000'});
  assert.equal(m.sizeUnits, 'world');
  assert.ok(Math.abs(m.color[0] - 1) < 1e-6 && m.color[1] === 0);
  assert.equal(m.writesDepth, true);
  m.transparent = true; assert.equal(m.writesDepth, false);
  assert.throws(() => new PointsMaterial({shape: 'star'}), RangeError);
  assert.throws(() => new PointsMaterial({opacity: 2}), RangeError);
  const s = new SpriteMaterial({sizeAttenuation: false});
  assert.equal(s.sizeUnits, 'pixels'); assert.equal(s.transparent, true);
  const version = s.mapVersion; s.map = {width: 1, height: 1, data: new Uint8ClampedArray(4)}; assert.equal(s.mapVersion, version + 1);
});

test('SSR-safe construction and a one-time WebGL2 warning', () => {
  const plugin = new PointsPlugin({pointBudget: 10});
  const cloud = plugin.add(new PointCloud({positions: [0, 0, 0]}));
  assert.equal(plugin.pick(0, 0), null);
  const warnings = [], warn = console.warn;
  console.warn = message => warnings.push(message);
  try {
    plugin.setup({backend: 'webgl2', gpu: null});
    new PointsPlugin({name: 'other'}).setup({backend: 'webgl2', gpu: null});
  } finally {console.warn = warn;}
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WebGL2/);
  cloud.dispose();
  assert.equal(plugin.pointClouds.size, 0);
  assert.throws(() => new PointsPlugin({pointBudget: -1}), RangeError);
});
