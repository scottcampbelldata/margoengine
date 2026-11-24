import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { setRenderLayers } from '../../cameras/dist/layers.js';
import { PointCloud, SpriteBatch } from '../../points/dist/index.js';
import { PointRaycaster, UNATTACHED } from '../dist/points.js';
import { Raycaster } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { rng } from './reference.js';

async function world(camera = { position: [0, 0, 10], target: [0, 0, 0] }) {
  const h = optionalGPU();
  return new Engine(
    { width: 400, height: 200, clientWidth: 400, clientHeight: 200 },
    await TransformStore.create(256),
    { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    camera,
    null,
  );
}

const worldRay = (threshold = 0.1) => {
  const ray = new PointRaycaster();
  ray.threshold = threshold;
  ray.thresholdUnits = 'world';
  return ray;
};
const tiny = { size: 0, minPixelSize: 0 };

// Screen position of a world point on the engine's camera, in CSS pixels.
function screen(engine, p) {
  const canvas = engine.canvas;
  engine.camera.update(canvas.width / canvas.height, true);
  const m = engine.camera.matrix,
    w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
    x = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w,
    y = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w;
  return [(x * 0.5 + 0.5) * canvas.clientWidth, (0.5 - y * 0.5) * canvas.clientHeight];
}

test('points within the threshold of the ray hit, exactly as a scan over all of them finds', async () => {
  const engine = await world(),
    random = rng(3),
    positions = Float32Array.from({ length: 3000 * 3 }, () => random() * 8 - 4),
    cloud = new PointCloud({ positions, blockSize: 64, material: tiny }),
    ray = worldRay(0.2);
  let total = 0;
  for (let i = 0; i < 300; i++) {
    ray.set([random() * 8 - 4, random() * 8 - 4, 9], [random() - 0.5, random() - 0.5, -1]);
    const expected = [];
    for (let k = 0; k < 3000; k++) {
      const v = [0, 1, 2].map((a) => positions[k * 3 + a] - ray.origin[a]),
        along = v[0] * ray.direction[0] + v[1] * ray.direction[1] + v[2] * ray.direction[2],
        off = Math.sqrt(Math.max(v[0] ** 2 + v[1] ** 2 + v[2] ** 2 - along ** 2, 0));
      if (off <= 0.2 && along >= 0) expected.push(k);
    }
    const hits = ray.intersectObjects(engine, [cloud]);
    assert.deepEqual(
      hits.map((hit) => hit.index).toSorted((a, b) => a - b),
      expected,
    );
    total += hits.length;
    for (let k = 1; k < hits.length; k++) assert.ok(hits[k - 1].distance <= hits[k].distance);
  }
  assert.ok(total > 300);
});

test('one call answers meshes, points and sprites sorted by distance', async () => {
  const engine = await world(),
    mesh = engine.createMesh().setGeometry(box(1, 1, 1)),
    cloud = new PointCloud({ positions: [0, 0, 2], material: tiny }),
    batch = new SpriteBatch({ sprites: [{ position: [0, 0, -2], size: 1 }] }),
    ray = worldRay(0.1);
  ray.set([0.01, 0.02, 5], [0, 0, -1]);
  const hits = ray.intersectObjects(engine, [mesh, cloud, batch]);
  assert.deepEqual(
    hits.filter((hit) => hit.frontFace).map((hit) => hit.target ?? hit.mesh),
    [cloud, mesh, batch],
  );
  assert.equal(hits[0].mesh, UNATTACHED);
  assert.equal(hits[0].index, 0);
  assert.ok(Math.abs(hits[0].distance - 3) < 1e-9);
  ray.firstHitOnly = true;
  assert.equal(ray.intersectObjects(engine, [mesh, cloud, batch]).length, 1);
  assert.equal(ray.intersectObjects(engine, [mesh, cloud, batch])[0].target, cloud);
  ray.firstHitOnly = false;
  // Nothing of the plain Raycaster changes.
  assert.ok(ray instanceof Raycaster);
  assert.deepEqual(
    ray.intersectMeshes(engine, [mesh]).map((hit) => hit.mesh),
    new Raycaster(ray.origin, ray.direction).intersectMeshes(engine, [mesh]).map((hit) => hit.mesh),
  );
});

test('intersectEngine adds the clouds and batches of the points plugin', async () => {
  const engine = await world(),
    mesh = engine.createMesh().setGeometry(box(1, 1, 1)),
    cloud = new PointCloud({ positions: [0, 0, 2], material: tiny }),
    batch = new SpriteBatch({ sprites: [{ position: [0, 0, 3], size: 1 }] });
  engine.use({ name: 'points-stand-in', setup() {}, pointClouds: new Set([cloud]), spriteBatches: new Set([batch]) });
  const ray = worldRay();
  ray.set([0, 0, 5], [0, 0, -1]);
  assert.deepEqual(
    ray.intersectEngine(engine).slice(0, 3).map((hit) => hit.target ?? hit.mesh),
    [batch, cloud, mesh],
  );
});

test('a pixel threshold is that many CSS pixels on screen, near and far', async () => {
  const engine = await world();
  for (const z of [5, 0, -30]) {
    const cloud = new PointCloud({ positions: [1, 0.5, z], material: tiny }),
      ray = new PointRaycaster(),
      [x, y] = screen(engine, [1, 0.5, z]);
    ray.setFromEngine(engine, x + 2.9, y);
    assert.equal(ray.intersectObjects(engine, [cloud]).length, 1, `2.9 pixels at z ${z}`);
    ray.setFromEngine(engine, x + 3.2, y);
    assert.equal(ray.intersectObjects(engine, [cloud]).length, 0, `3.2 pixels at z ${z}`);
  }
});

test('a point drawn wider than the threshold hits across its drawn size', async () => {
  const engine = await world(),
    pixels = new PointCloud({ positions: [0, 0, 0], material: { size: 20 } }),
    scaled = new PointCloud({ positions: [0, 0, 0], sizes: [2], material: { size: 10 } }),
    metres = new PointCloud({ positions: [0, 0, 0], material: { size: 1, sizeUnits: 'world', maxPixelSize: 1e6 } }),
    clamped = new PointCloud({ positions: [0, 0, 0], material: { size: 1, sizeUnits: 'world', maxPixelSize: 4 } }),
    ray = new PointRaycaster(),
    [x, y] = screen(engine, [0, 0, 0]);
  ray.threshold = 0;
  ray.setFromEngine(engine, x + 9, y);
  assert.equal(ray.intersectObjects(engine, [pixels]).length, 1);
  assert.equal(ray.intersectObjects(engine, [scaled]).length, 1, 'a per-point size counts');
  ray.setFromEngine(engine, x + 11, y);
  assert.equal(ray.intersectObjects(engine, [pixels]).length, 0);
  assert.equal(ray.intersectObjects(engine, [scaled]).length, 0);
  ray.set([0.45, 0, 10], [0, 0, -1]);
  assert.equal(ray.intersectObjects(engine, [metres]).length, 1, 'world diameter 1 reaches 0.45');
  assert.equal(ray.intersectObjects(engine, [clamped]).length, 0, 'maxPixelSize caps it, as drawn');
  ray.set([0.55, 0, 10], [0, 0, -1]);
  assert.equal(ray.intersectObjects(engine, [metres]).length, 0);
});

test('a block whose largest point reaches the ray is not skipped', async () => {
  const engine = await world(),
    sizes = new Float32Array(100).fill(1);
  sizes[37] = 40;
  const positions = Float32Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? 50 + i : 0)),
    cloud = new PointCloud({ positions, sizes, blockSize: 10, material: { size: 1, sizeUnits: 'world', maxPixelSize: 1e6 } }),
    ray = worldRay(0),
    x = positions[37 * 3];
  ray.set([x + 19, 0, 9], [0, 0, -1]);
  assert.deepEqual(
    ray.intersectObjects(engine, [cloud]).map((hit) => hit.index),
    [37],
  );
});

test('near and far, hidden clouds, followed meshes, layers and filters all count', async () => {
  const engine = await world(),
    cloud = new PointCloud({ positions: [0, 0, 0], material: tiny }),
    mesh = engine.createMesh().setPosition([3, 0, 0]),
    ray = worldRay(0.1),
    count = () => ray.intersectObjects(engine, [cloud]).length;
  ray.set([0, 0, 5], [0, 0, -1]);
  assert.equal(count(), 1);
  ray.far = 4;
  assert.equal(count(), 0);
  ray.far = Infinity;
  ray.near = 6;
  assert.equal(count(), 0);
  ray.near = 0;
  cloud.visible = false;
  assert.equal(count(), 0);
  cloud.visible = true;
  cloud.attach(mesh);
  assert.equal(count(), 0, 'the cloud moved with the mesh');
  ray.set([3, 0, 5], [0, 0, -1]);
  const [hit] = ray.intersectObjects(engine, [cloud]);
  assert.equal(hit.mesh, mesh);
  assert.deepEqual(hit.point, [3, 0, 0]);
  assert.deepEqual(hit.localPoint, [0, 0, 0]);
  setRenderLayers(mesh, 2);
  ray.layers = 1;
  assert.equal(count(), 0);
  ray.layers = 2;
  assert.equal(count(), 1);
  ray.filter = () => false;
  assert.equal(count(), 0);
  ray.filter = null;
  mesh.visible = false;
  assert.equal(count(), 0);
  mesh.visible = true;
  mesh.dispose();
  assert.equal(count(), 0);
});

test('a cloud matrix moves, scales and turns its points', async () => {
  const engine = await world(),
    scale = 2,
    cloud = new PointCloud({
      positions: [1, 0, 0],
      material: tiny,
      matrix: new Float32Array([0, scale, 0, 0, -scale, 0, 0, 0, 0, 0, scale, 0, 5, 0, 0, 1]),
    }),
    ray = worldRay(0.05);
  ray.set([5, 2, 9], [0, 0, -1]);
  assert.deepEqual(ray.intersectObjects(engine, [cloud])[0].point, [5, 2, 0]);
  ray.set([1, 0, 9], [0, 0, -1]);
  assert.equal(ray.intersectObjects(engine, [cloud]).length, 0);
});

test('clipping planes cut points and sprites away as they cut the picture', async () => {
  const engine = await world(),
    planes = [[1, 0, 0, -1]],
    cloud = new PointCloud({ positions: [0, 0, 0, 2, 0, 0], material: { ...tiny, clippingPlanes: planes } }),
    batch = new SpriteBatch({ sprites: [{ position: [0, 0, 0] }], material: { clippingPlanes: planes } }),
    ray = worldRay(0.1);
  ray.set([0, 0, 5], [0, 0, -1]);
  assert.equal(ray.intersectObjects(engine, [cloud, batch]).length, 0);
  ray.set([2, 0, 5], [0, 0, -1]);
  assert.equal(ray.intersectObjects(engine, [cloud]).length, 1);
});

test('points that are not finite, and an empty cloud, answer nothing', async () => {
  const engine = await world(),
    cloud = new PointCloud({ positions: [Number.NaN, 0, 0, 0, 0, 0], material: tiny }),
    empty = new PointCloud({ positions: new Float32Array(0) }),
    ray = worldRay(0.1);
  ray.set([0, 0, 5], [0, 0, -1]);
  assert.deepEqual(
    ray.intersectObjects(engine, [cloud, empty]).map((hit) => hit.index),
    [1],
  );
});

test('a sprite hits inside its drawn quad: pivot, rotation, size and uv', async () => {
  const engine = await world(),
    batch = new SpriteBatch({
      sprites: [{ position: [1, 1, 0], size: [2, 1], center: [0, 0], uv: [0.5, 0, 1, 0.5] }],
    }),
    ray = worldRay(0);
  engine.camera.position[0] = 0;
  const through = (x, y) => {
    const [sx, sy] = screen(engine, [x, y, 0]);
    ray.setFromEngine(engine, sx, sy);
    return ray.intersectObjects(engine, [batch]);
  };
  assert.equal(through(1.1, 1.1).length, 1);
  assert.equal(through(2.9, 1.9).length, 1);
  assert.equal(through(0.9, 1.5).length, 0, 'left of the pivot corner');
  assert.equal(through(3.1, 1.5).length, 0);
  assert.equal(through(2, 2.1).length, 0);
  const [hit] = through(2, 1.5),
    uv = hit.uv;
  assert.ok(Math.abs(uv[0] - 0.75) < 1e-6 && Math.abs(uv[1] - 0.25) < 1e-6, `uv ${uv}`);
  assert.equal(hit.index, 0);
  assert.equal(hit.offset, 0);

  batch.set(0, { rotation: Math.PI / 2 });
  // A quarter turn: 2 wide along +x becomes 2 tall along +y, 1 tall becomes 1 wide along -x.
  assert.equal(through(0.5, 2.5).length, 1);
  assert.equal(through(1.5, 1.5).length, 0);
  batch.set(0, { rotation: 0 });
  batch.material.rotation = Math.PI / 2;
  assert.equal(through(0.5, 2.5).length, 1, 'material rotation adds to it');
});

test('a sprite faces the camera, wherever the camera stands', async () => {
  const engine = await world({ position: [10, 0, 0], target: [0, 0, 0] }),
    batch = new SpriteBatch({ sprites: [{ position: [0, 0, 0], size: 2 }] }),
    ray = worldRay(0);
  ray.set([10, 0.9, 0.9], [-1, 0, 0]);
  assert.equal(ray.intersectObjects(engine, [batch]).length, 1);
  ray.set([10, 1.1, 0], [-1, 0, 0]);
  assert.equal(ray.intersectObjects(engine, [batch]).length, 0);
});

test('a sprite sized in pixels keeps its size on screen, and the threshold widens it', async () => {
  const engine = await world(),
    batch = new SpriteBatch({ sprites: [{ position: [0, 0, -20], size: 40 }], material: { sizeUnits: 'pixels' } }),
    ray = new PointRaycaster(),
    [x, y] = screen(engine, [0, 0, -20]);
  ray.threshold = 0;
  ray.setFromEngine(engine, x + 19, y);
  assert.equal(ray.intersectObjects(engine, [batch]).length, 1);
  ray.setFromEngine(engine, x + 21, y);
  assert.equal(ray.intersectObjects(engine, [batch]).length, 0);
  ray.threshold = 3;
  assert.equal(ray.intersectObjects(engine, [batch]).length, 1);
});

test('a bad threshold says what to pass, and a list of meshes alone needs no check', async () => {
  const engine = await world(),
    cloud = new PointCloud({ positions: [0, 0, 0] }),
    ray = new PointRaycaster([0, 0, 5], [0, 0, -1]);
  ray.threshold = -1;
  assert.throws(() => ray.intersectObjects(engine, [cloud]), RangeError);
  assert.deepEqual(ray.intersectObjects(engine, []), []);
  ray.threshold = 1;
  ray.thresholdUnits = 'metres';
  assert.throws(() => ray.intersectObjects(engine, [cloud]), TypeError);
});
