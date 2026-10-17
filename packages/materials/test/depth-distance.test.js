import test from 'node:test';
import assert from 'node:assert/strict';
import { Material, Texture, createMesh } from '../dist/index.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };
const texture = () =>
  new Texture({ data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 }, { mipmaps: false });

async function scene() {
  const h = optionalGPU(),
    device = h.engine.gpu,
    store = await TransformStore.create(32),
    renderer = { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      renderer,
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  device.limits.maxTextureDimension2D = 8192;
  engine.camera.update(4 / 3, true);
  return {
    h,
    device,
    engine,
    renderer,
    frame() {
      store.tick(false);
      engine.frameGraph.execute({ ...h.context, camera: engine.camera });
    },
    close() {
      engine.dispose();
      h.cleanup();
    },
  };
}

const depthBuffer = (h) => h.groups.at(-1)?.entries.find((entry) => entry.binding === 196)?.resource.buffer;
const floats = (buffer) => [...new Float32Array(buffer.data)];

test('depth and distance modes choose their packing defaults and retain an owned reference position', () => {
  const position = [2, -3, 4],
    depth = new Material({ shading: 'depth' }),
    distance = new Material({ shading: 'distance', referencePosition: position });
  assert.equal(depth.depthPacking, 'basic');
  assert.equal(distance.depthPacking, 'rgba');
  assert.deepEqual(depth.referencePosition, [0, 0, 0]);
  assert.equal(distance.nearDistance, 1);
  assert.equal(distance.farDistance, 1000);
  position[0] = 9;
  assert.deepEqual(distance.referencePosition, [2, -3, 4]);
  const exposed = distance.referencePosition;
  exposed[1] = 9;
  assert.deepEqual(distance.referencePosition, [2, -3, 4]);
  const next = [-1, 2, -3];
  distance.referencePosition = next;
  next[2] = 9;
  distance.depthPacking = 'basic';
  distance.nearDistance = 0;
  distance.farDistance = 10;
  assert.deepEqual(distance.referencePosition, [-1, 2, -3]);
  assert.equal(distance.depthPacking, 'basic');
  assert.equal(distance.nearDistance, 0);
  assert.equal(distance.farDistance, 10);
  assert.equal(distance.physical, undefined);
  assert.equal(distance.transmissive, false);
  for (const shading of ['depth', 'distance'])
    assert.throws(() => new Material({ shading, clearcoat: 0 }), /standard shading/);
});

test('depth controls reject invalid values even when another shading mode leaves them unused', () => {
  const material = new Material();
  for (const value of ['RGB', '', 0, null]) {
    assert.throws(() => new Material({ depthPacking: value }), TypeError);
    assert.throws(() => {
      material.depthPacking = value;
    }, TypeError);
  }
  for (const value of [null, {}, [1, 2], [1, 2, 3, 4], [1, NaN, 3], [0, Infinity, 0], [1e300, 0, 0], ['1', 2, 3]]) {
    assert.throws(() => new Material({ referencePosition: value }), RangeError);
    assert.throws(() => {
      material.referencePosition = value;
    }, RangeError);
  }
  assert.deepEqual(material.referencePosition, [0, 0, 0]);
  for (const key of ['nearDistance', 'farDistance']) {
    for (const value of [-1, NaN, Infinity, -Infinity, 1e300, '2', null]) {
      assert.throws(() => new Material({ [key]: value }), RangeError, key + ': ' + String(value));
      assert.throws(
        () => {
          material[key] = value;
        },
        RangeError,
        key + ': ' + String(value),
      );
    }
  }
  assert.equal(material.nearDistance, 1);
  assert.equal(material.farDistance, 1000);
});

test('distance ranges validate both constructor bounds together and preserve valid state after a rejected edit', () => {
  const material = new Material({ shading: 'distance', nearDistance: 2000, farDistance: 3000 });
  assert.equal(material.nearDistance, 2000);
  assert.equal(material.farDistance, 3000);
  for (const [nearDistance, farDistance] of [
    [1, 1],
    [2, 1],
    [0, 0],
    [1, 1 + Number.EPSILON],
  ])
    assert.throws(() => new Material({ nearDistance, farDistance }), RangeError);
  assert.throws(() => {
    material.nearDistance = 3000;
  }, RangeError);
  assert.throws(() => {
    material.farDistance = 2000;
  }, RangeError);
  assert.equal(material.nearDistance, 2000);
  assert.equal(material.farDistance, 3000);
});

test('real mesh frames upload live depth controls to one shared 32-byte uniform', async () => {
  const s = await scene();
  try {
    const map = texture(),
      material = new Material({
        shading: 'distance',
        map,
        referencePosition: [2, -3, 4],
        nearDistance: 0,
        farDistance: 12,
      }),
      a = createMesh(s.engine, triangle, material),
      b = createMesh(s.engine, triangle, material);
    s.frame();
    const buffer = depthBuffer(s.h);
    assert.equal(buffer?.size, 32);
    assert.deepEqual(floats(buffer), [2, -3, 4, 0, 0, 12, 1, 0]);
    const groups = s.h.groups.filter((g) => g.entries.some((e) => e.binding === 196));
    assert.equal(groups.length, 2);
    assert.ok(groups.every((g) => g.entries.find((e) => e.binding === 196).resource.buffer === buffer));
    const allocations = { buffers: s.h.counts.buffers, textures: s.h.counts.textures };
    material.referencePosition = [-4, 5, 6];
    material.nearDistance = 2;
    material.farDistance = 20;
    material.depthPacking = 'basic';
    s.frame();
    assert.deepEqual(floats(buffer), [-4, 5, 6, 0, 2, 20, 0, 0]);
    assert.deepEqual({ buffers: s.h.counts.buffers, textures: s.h.counts.textures }, allocations);
    const view = map.bind(s.device, true)[0];
    a.dispose();
    assert.equal(buffer.destroyed, false);
    b.dispose();
    assert.equal(buffer.destroyed, true);
    assert.equal(view.texture.destroyed, false, 'the caller retains texture ownership');
    map.dispose();
  } finally {
    s.close();
  }
});

test('depth uniforms follow the owning engine and recreate for a replacement GPU device', async () => {
  const a = await scene(),
    b = await scene();
  try {
    const material = new Material({ shading: 'depth', referencePosition: [1, 2, 3] }),
      meshA = createMesh(a.engine, triangle, material),
      meshB = createMesh(b.engine, triangle, material);
    a.frame();
    b.frame();
    const bufferA = depthBuffer(a.h),
      bufferB = depthBuffer(b.h);
    assert.notEqual(bufferA, bufferB);
    assert.deepEqual(floats(bufferA), [1, 2, 3, 0, 1, 1000, 0, 0]);
    const replacement = optionalGPU();
    try {
      const restored = material.bindings(replacement.engine.gpu, a.engine).find((e) => e.binding === 196)
        .resource.buffer;
      assert.notEqual(restored, bufferA);
      assert.equal(bufferA.destroyed, true);
      assert.equal(bufferB.destroyed, false);
      assert.deepEqual(floats(restored), [1, 2, 3, 0, 1, 1000, 0, 0]);
      meshA.dispose();
      assert.equal(restored.destroyed, true);
      assert.equal(bufferB.destroyed, false);
      meshB.dispose();
      assert.equal(bufferB.destroyed, true);
    } finally {
      replacement.cleanup();
    }
  } finally {
    a.close();
    b.close();
  }
});

test('existing modes retain their texture bindings without allocating the depth uniform', async () => {
  const s = await scene();
  try {
    for (const shading of ['standard', 'basic', 'normal', 'matcap']) {
      const material = new Material({ shading });
      const entries = material.bindings(s.device, s.engine);
      assert.deepEqual(
        entries.map((e) => e.binding),
        shading === 'matcap'
          ? [32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43]
          : [32, 33, 34, 35, 36, 37, 38, 39, 40, 41],
      );
    }
    assert.equal(s.h.counts.buffers, 0);
    const material = new Material({ clearcoatMap: texture() }),
      mesh = createMesh(s.engine, triangle, material),
      entries = material.bindings(s.device, s.engine),
      buffer = entries.find((e) => e.binding === 200).resource.buffer;
    assert.equal(buffer.size, 560);
    assert.equal(
      entries.some((e) => e.binding === 196),
      false,
    );
    mesh.dispose();
    assert.equal(buffer.destroyed, true);
    material.clearcoatMap.dispose();
  } finally {
    s.close();
  }
});
