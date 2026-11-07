// A step that can fail must leave the engine as it was: the real Engine and GPURenderer run here on a fake device, and
// allocation fails through the renderer's own limit check or through createBuffer throwing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { GPURenderer } from '../packages/core/dist/renderer.js';
import { Geometry, PbrMaterial, box } from '../packages/core/dist/geometry.js';

const ROOMY = 1 << 30;

globalThis.GPUBufferUsage ??= { COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 };
globalThis.GPUTextureUsage ??= { RENDER_ATTACHMENT: 16 };

function makeGpu() {
  const gpu = { live: new Set(), draws: [], throwOn: 0, limits: { maxBufferSize: ROOMY } };
  const bound = (buffer) => assert.ok(gpu.live.has(buffer), 'a draw binds a destroyed buffer');
  const pass = {
    setPipeline() {},
    setBindGroup() {},
    setViewport() {},
    setScissorRect() {},
    setVertexBuffer: (_slot, buffer) => bound(buffer),
    setIndexBuffer: bound,
    drawIndexed: (_indices, count) => gpu.draws.push(count),
    end() {},
  };
  const device = {
    lost: new Promise(() => {}),
    features: new Set(),
    limits: gpu.limits,
    addEventListener() {},
    destroy() {},
    createBindGroup: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createCommandEncoder: () => ({ finish: () => ({}), beginRenderPass: () => pass }),
    createBuffer(descriptor) {
      if (gpu.throwOn && --gpu.throwOn === 0) throw new Error('out of memory');
      const buffer = {
        size: descriptor.size,
        destroy() {
          gpu.live.delete(buffer);
        },
      };
      gpu.live.add(buffer);
      return buffer;
    },
    queue: {
      submit() {},
      writeBuffer(buffer, offset, data, _start, size) {
        assert.ok(offset + (size === undefined ? data.byteLength : size * 4) <= buffer.size, 'write past the buffer');
      },
    },
  };
  const pipeline = { getBindGroupLayout: () => ({}) };
  gpu.renderer = new GPURenderer(
    { width: 4, height: 4 },
    device,
    { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) },
    'bgra8unorm',
    pipeline,
    { multisample: { count: 1 }, depthStencil: { format: 'depth32float' } },
    pipeline,
  );
  // The engine's own batch list, handed to every render: the only view of it that survives the build's name mangling.
  const render = gpu.renderer.render;
  gpu.renderer.render = function (camera, lighting, batches, ...rest) {
    gpu.batches = batches;
    return render.call(this, camera, lighting, batches, ...rest);
  };
  gpu.device = device;
  gpu.heal = () => {
    gpu.throwOn = 0;
    gpu.limits.maxBufferSize = ROOMY;
  };
  return gpu;
}

const canvas = () => ({ width: 4, height: 4, clientWidth: 4, clientHeight: 4 });

async function makeEngine(capacity = 16) {
  const gpu = makeGpu(),
    engine = new Engine(canvas(), await TransformStore.create(capacity), gpu.renderer, undefined, null);
  engine.render({ culling: false });
  return { engine, gpu };
}

/** A one-triangle geometry, 72 bytes of vertices: small enough that only the instance buffer meets the limit below. */
const triangle = () =>
  new Geometry(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]));

/** Fails the next `renderer.add` the way each failure mode does; `instance` reaches the third buffer of the add. */
const failures = {
  'the GPU buffer limit': (gpu, limit) => {
    gpu.limits.maxBufferSize = limit;
  },
  'createBuffer throwing on the instance buffer': (gpu) => {
    gpu.throwOn = 3;
  },
};

/** Every value a failed allocation could disturb, compared by identity. */
function state(gpu, batches = gpu.batches) {
  const values = [batches.length, gpu.live.size];
  for (const batch of batches) {
    const { vertex, index, instance } = gpu.renderer.geometryBuffers(batch.geometry);
    values.push(batch, batch.geometry, batch.references, batch.instances, batch.count, vertex, index, instance);
  }
  for (const buffer of gpu.live) values.push(buffer);
  return values;
}
const batchOf = (gpu, geometry) => gpu.batches.find((batch) => batch.geometry === geometry);
function assertSame(after, before) {
  assert.equal(after.length, before.length, 'state size changed');
  for (let i = 0; i < before.length; i++) assert.equal(after[i], before[i], `state value ${i} changed`);
}
/** Draws one frame and returns each batch's instance count. */
function draw(engine, gpu) {
  gpu.draws.length = 0;
  engine.render({ culling: false });
  return [...gpu.draws];
}
/** Nothing is owned once the meshes go: no batch, and of the buffers only the renderer's own uniform. */
function assertNothingHeld(gpu, batches = gpu.batches) {
  assert.equal(batches.length, 0, 'a batch leaked');
  assert.equal(gpu.live.size, 1, 'a GPU buffer leaked');
}

for (const [name, fail] of Object.entries(failures)) {
  test(`first registration failing through ${name} changes nothing, and a retry works`, async () => {
    const { engine, gpu } = await makeEngine(),
      working = engine.createMesh().setGeometry(triangle()),
      mesh = engine.createMesh(),
      fresh = box();
    try {
      draw(engine, gpu);
      const before = state(gpu);
      fail(gpu, 8);
      assert.throws(() => mesh.setGeometry(fresh), name.includes('limit') ? /GPU buffer limit/ : /out of memory/);
      gpu.heal();
      assertSame(state(gpu), before);
      assert.equal(mesh.geometry, null);
      assert.equal(batchOf(gpu, fresh), undefined);
      assert.deepEqual(draw(engine, gpu), [1], 'the working mesh still draws');

      mesh.setGeometry(fresh);
      assert.equal(batchOf(gpu, fresh).references, 1);
      assert.deepEqual(draw(engine, gpu), [1, 1], 'the retry draws');

      mesh.dispose();
      working.dispose();
      assertNothingHeld(gpu);
    } finally {
      engine.dispose();
    }
    assert.equal(gpu.live.size, 0);
  });

  test(`instance growth failing through ${name} keeps the batch and its buffers, and a retry works`, async () => {
    const { engine, gpu } = await makeEngine(),
      geometry = triangle(),
      meshes = [engine.createMesh().setGeometry(geometry), engine.createMesh().setGeometry(geometry)],
      third = engine.createMesh();
    try {
      assert.deepEqual(draw(engine, gpu), [2]);
      const before = state(gpu),
        { vertex, index, instance } = gpu.renderer.geometryBuffers(geometry);
      // 200 bytes: the two-instance buffer (192) fits and the six-instance one (576) does not.
      fail(gpu, 200);
      assert.throws(() => third.setGeometry(geometry), name.includes('limit') ? /GPU buffer limit/ : /out of memory/);
      gpu.heal();
      assertSame(state(gpu), before);
      assert.equal(third.geometry, null);
      assert.equal(batchOf(gpu, geometry).references, 2);
      for (const buffer of [vertex, index, instance]) assert.ok(gpu.live.has(buffer), 'the old buffers stay alive');
      assert.deepEqual(draw(engine, gpu), [2], 'the batch keeps drawing');

      third.setGeometry(geometry);
      assert.equal(batchOf(gpu, geometry).references, 3);
      assert.equal(batchOf(gpu, geometry).instances.length, 6 * 24);
      for (const buffer of [vertex, index, instance]) assert.ok(!gpu.live.has(buffer), 'a replaced buffer is freed');
      assert.deepEqual(draw(engine, gpu), [3], 'the retry draws');

      for (const mesh of [...meshes, third]) mesh.dispose();
      assertNothingHeld(gpu);
    } finally {
      engine.dispose();
    }
    assert.equal(gpu.live.size, 0);
  });

  test(`Mesh.setGeometry keeps the old geometry when the new one fails through ${name}`, async () => {
    const { engine, gpu } = await makeEngine(),
      old = box(),
      full = triangle(),
      mesh = engine.createMesh().setGeometry(old),
      others = [engine.createMesh().setGeometry(full), engine.createMesh().setGeometry(full)];
    try {
      assert.deepEqual(draw(engine, gpu), [1, 2]);
      const bounds = [...engine.store.bounds.subarray(mesh.id * 4, mesh.id * 4 + 4)];
      // Swapped to a geometry never seen, then to one whose batch must grow.
      for (const [target, limit] of [
        [triangle(), 8],
        [full, 200],
      ]) {
        const before = state(gpu);
        fail(gpu, limit);
        assert.throws(() => mesh.setGeometry(target));
        gpu.heal();
        assertSame(state(gpu), before);
        assert.equal(mesh.geometry, old, 'the mesh keeps its geometry');
        assert.deepEqual([...engine.store.bounds.subarray(mesh.id * 4, mesh.id * 4 + 4)], bounds);
        assert.equal(batchOf(gpu, old).references, 1);
        assert.deepEqual(draw(engine, gpu), [1, 2], 'the mesh keeps drawing its old geometry');
      }
      mesh.setGeometry(full);
      assert.equal(batchOf(gpu, old), undefined, 'the swap releases the old geometry');
      assert.deepEqual(draw(engine, gpu), [3]);
      mesh.dispose();
      for (const other of others) other.dispose();
      assertNothingHeld(gpu);
    } finally {
      engine.dispose();
    }
  });
}

test('instance storage failing to allocate on the CPU changes nothing', async () => {
  const { engine, gpu } = await makeEngine(),
    geometry = triangle(),
    meshes = [engine.createMesh().setGeometry(geometry), engine.createMesh().setGeometry(geometry)],
    third = engine.createMesh(),
    Real = globalThis.Float32Array;
  try {
    draw(engine, gpu);
    const before = state(gpu);
    globalThis.Float32Array = class extends Real {
      constructor(...args) {
        if (args[0] === 6 * 24) throw new RangeError('Array buffer allocation failed');
        super(...args);
      }
    };
    try {
      assert.throws(() => third.setGeometry(geometry), /allocation failed/);
    } finally {
      globalThis.Float32Array = Real;
    }
    assertSame(state(gpu), before);
    assert.deepEqual(draw(engine, gpu), [2]);
    for (const mesh of meshes) mesh.dispose();
    third.dispose();
    assertNothingHeld(gpu);
  } finally {
    globalThis.Float32Array = Real;
    engine.dispose();
  }
});

test('engine.retain growing a drawn batch keeps its instances on screen', async () => {
  const { engine, gpu } = await makeEngine(),
    geometry = triangle(),
    meshes = [engine.createMesh().setGeometry(geometry), engine.createMesh().setGeometry(geometry)];
  try {
    draw(engine, gpu);
    engine.retain(geometry);
    assert.deepEqual(draw(engine, gpu), [2]);
    const { instances } = batchOf(gpu, geometry);
    assert.equal(instances[15], 1, 'the first instance has its matrix');
    assert.equal(instances[24 + 15], 1, 'the second instance has its matrix');
    engine.release(geometry);
    for (const mesh of meshes) mesh.dispose();
    assertNothingHeld(gpu);
  } finally {
    engine.dispose();
  }
});

async function rebooting(create, run) {
  const real = GPURenderer.create;
  GPURenderer.create = create;
  try {
    return await run();
  } finally {
    GPURenderer.create = real;
  }
}

test('geometry set inside onDeviceRestored reaches the restored device', async () => {
  const { engine, gpu } = await makeEngine(),
    next = makeGpu(),
    shared = triangle(),
    held = [engine.createMesh().setGeometry(shared), engine.createMesh().setGeometry(shared)],
    grown = engine.createMesh(),
    added = engine.createMesh();
  try {
    draw(engine, gpu);
    engine.use({
      name: 'restore',
      setup() {},
      onDeviceRestored() {
        grown.setGeometry(shared); // a batch that must grow
        added.setGeometry(box()); // a batch the restore has not seen
      },
    });
    await rebooting(
      async () => next.renderer,
      () => engine.rebootDevice(),
    );
    assert.deepEqual(draw(engine, next), [3, 1]);
    for (const mesh of [...held, grown, added]) mesh.dispose();
    assertNothingHeld(next);
  } finally {
    engine.dispose();
  }
});

test('geometry set while a restore runs is drawn whether the restore works or fails', async () => {
  for (const restored of [true, false]) {
    const { engine, gpu } = await makeEngine(),
      next = makeGpu(),
      shared = triangle(),
      held = [engine.createMesh().setGeometry(shared), engine.createMesh().setGeometry(shared)],
      grown = engine.createMesh(),
      added = engine.createMesh();
    try {
      draw(engine, gpu);
      const reboot = rebooting(
        async () => {
          await null; // `create` starts inside rebootDevice's first step; the restore is marked running after that
          grown.setGeometry(shared);
          added.setGeometry(box());
          if (!restored) throw new Error('no adapter');
          return next.renderer;
        },
        () => engine.rebootDevice(),
      );
      if (restored) await reboot;
      else await assert.rejects(reboot, /no adapter/);
      const current = restored ? next : gpu;
      assert.deepEqual(draw(engine, current), [3, 1]);
      for (const mesh of [...held, grown, added]) mesh.dispose();
      assertNothingHeld(current);
    } finally {
      engine.dispose();
    }
  }
});

test('a restore that cannot rebuild a batch keeps the engine on its renderer, and a retry works', async () => {
  const { engine, gpu } = await makeEngine(),
    next = makeGpu(),
    retry = makeGpu(),
    mesh = engine.createMesh().setGeometry(triangle());
  try {
    draw(engine, gpu);
    const before = state(gpu);
    next.limits.maxBufferSize = 8;
    await rebooting(
      async () => next.renderer,
      () => assert.rejects(engine.rebootDevice(), /GPU buffer limit/),
    );
    assertSame(state(gpu), before);
    assert.equal(engine.gpu, gpu.device, 'the engine stays on its renderer');
    assert.equal(next.live.size, 0, 'the failed renderer frees what it made');
    await rebooting(
      async () => retry.renderer,
      () => engine.rebootDevice(),
    );
    assert.deepEqual(draw(engine, retry), [1]);
    mesh.dispose();
    assertNothingHeld(retry);
  } finally {
    engine.dispose();
  }
});

test('one failing onDeviceRestored leaves no other plugin on the lost device', async () => {
  const { engine, gpu } = await makeEngine(),
    next = makeGpu(),
    hud = engine.createScene('hud'),
    restored = [];
  try {
    engine.use({
      name: 'bad',
      setup() {},
      onDeviceRestored() {
        throw new Error('hook failed');
      },
    });
    engine.use({ name: 'after', setup() {}, onDeviceRestored: () => restored.push('after') });
    hud.use({ name: 'other scene', setup() {}, onDeviceRestored: () => restored.push('other scene') });
    await rebooting(
      async () => next.renderer,
      () => assert.rejects(engine.rebootDevice(), /hook failed/),
    );
    assert.deepEqual(restored, ['after', 'other scene']);
    assert.equal(engine.gpu, next.device);
    assert.equal(engine.frameGraph, engine.scene.frameGraph, 'the default scene is active again');
    assert.equal(gpu.live.size, 0, 'the old renderer is released');
  } finally {
    engine.dispose();
  }
});

test('a failed store growth leaves createMesh state as it was, and a retry works', async () => {
  const { engine, gpu } = await makeEngine(1),
    { store } = engine,
    node = engine.createMesh(),
    { grow } = store;
  try {
    // A node off screen: nothing is visible, so the frame has no reason to collect and reads the slots it kept.
    node.setPosition([1e6, 0, 0]);
    engine.render();
    assert.equal(store.visible[node.id], 0);
    store.grow = () => {
      throw new Error('out of memory');
    };
    assert.throws(() => engine.createMesh(), /out of memory/);
    store.grow = grow;
    assert.equal(store.capacity, 1);

    node.position.x = 2e6;
    engine.render();
    assert.equal(node.matrix[12], 2e6, 'the mesh view still reads the store');

    const mesh = engine.createMesh().setGeometry(box());
    assert.equal(mesh.id, 1, 'the slot the failed call took is free again');
    assert.equal(store.capacity, 2);
    assert.deepEqual(draw(engine, gpu), [1]);
    mesh.dispose();
    node.dispose();
    assertNothingHeld(gpu);
  } finally {
    engine.dispose();
  }
});

test('a material that fails collection keeps failing until fixed, and then every mesh draws', async () => {
  const { engine, gpu } = await makeEngine(),
    geometry = triangle(),
    good = new PbrMaterial(),
    bad = new PbrMaterial(),
    meshes = [engine.createMesh().setGeometry(geometry), engine.createMesh().setGeometry(geometry)];
  meshes[0].setMaterial(good);
  meshes[1].setMaterial(bad);
  try {
    assert.deepEqual(draw(engine, gpu), [2]);
    const value = bad.data[0];
    bad.data[0] = 2;
    assert.throws(() => draw(engine, gpu), /Invalid material/);
    assert.throws(() => draw(engine, gpu), /Invalid material/, 'the second frame must not draw a part of the batch');
    bad.data[0] = value;
    assert.deepEqual(draw(engine, gpu), [2]);
  } finally {
    engine.dispose();
  }
});

test('Scene.dispose finishes when a plugin throws, and the error reaches the caller', async () => {
  const { engine, gpu } = await makeEngine(),
    scene = engine.createScene('level'),
    disposed = [];
  try {
    scene.use({
      name: 'bad',
      setup() {},
      dispose() {
        throw new Error('plugin dispose failed');
      },
    });
    scene.use({ name: 'after', setup() {}, dispose: () => disposed.push('after') });
    scene.createMesh().setGeometry(box());
    assert.throws(() => scene.dispose(), /plugin dispose failed/);
    assert.deepEqual(disposed, ['after'], 'the next plugin is disposed');
    assert.equal(scene.plugins.size, 0);
    assert.equal(scene.meshes.size, 0);
    assert.equal(engine.meshes.size, 0);
    assertNothingHeld(gpu);
  } finally {
    engine.dispose();
  }
});
