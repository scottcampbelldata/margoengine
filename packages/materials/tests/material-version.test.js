// p-uv-transform of the speed matrix (4,096 boxes, one material each) drew 4,096 draws and read every material's rows
// and bindings every frame (36-42 ms of CPU; perf-history entry 24). Now a material reports a change stamp (gltf-pro
// `PBRMaterialShading.version`) so a steady one is reused whole, meshes of materials that share a pipeline and group 2
// draw as one instanced draw whose instances read their own uniform block, and every material record and live colour
// keeps one hidden class. CPU recording only: the fake pass records the draws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import {
  Material,
  PbrMaterial,
  PhongMaterial,
  Texture,
  UnlitMaterial,
  WgslMaterial,
  createMesh,
} from '../dist/index.js';
import { optionalGPU, uniformBytes } from '../../../tests/support/optional-gpu.js';

async function world(capacity = 64) {
  const harness = optionalGPU(),
    store = await TransformStore.create(capacity),
    device = harness.engine.gpu;
  device.limits.maxTextureDimension2D = 8192;
  device.limits.maxUniformBufferBindingSize = 65536;
  device.queue.writeTexture = () => {};
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 40], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(128 / 96, true);
  const draws = [];
  let pipeline, uniform, view, effect;
  const context = {
    ...harness.context,
    camera: engine.camera,
    draw() {},
    encoder: {
      beginRenderPass: () => ({
        setPipeline(p) {
          pipeline = p;
        },
        setBindGroup(i, group) {
          if (i === 2) effect = group.entries;
          if (i !== 0) return;
          uniform = group.entries.find((entry) => entry.binding === 0).resource;
          view = group.entries.find((entry) => entry.binding === 3)?.resource;
        },
        setVertexBuffer() {},
        setIndexBuffer() {},
        setStencilReference() {},
        setViewport() {},
        setScissorRect() {},
        drawIndexed(count, n = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0) {
          draws.push({ pipeline, count, n, uniform, view, effect, firstInstance });
        },
        end() {},
      }),
    },
  };
  // One frame; with `views`, one pass per view ({ view, camera }) as a multi-view frame draws them.
  const frame = async (views) => {
    await null;
    draws.length = 0;
    store.tick(false);
    if (!views) return engine.frameGraph.execute(context);
    for (const v of views) engine.frameGraph.execute({ ...context, view: v.view, camera: v.camera });
  };
  return { harness, engine, device, frame, draws, destroy: () => engine.dispose() };
}
const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };
const pixel = () => new Texture({ data: new Uint8Array(16).fill(255), width: 2, height: 2 }, { mipmaps: false });
/** Floats `from` to `from + count` of block `i` of a rows draw (220 floats a block). */
const block = (draw, i, from, count) => [
  ...new Float32Array(uniformBytes(draw.uniform).slice().buffer, (i * 220 + from) * 4, count),
];
/** Runs `body` with `bound()`, which returns (and resets) the materials whose bindings ran since the last call. */
async function countBindings(body) {
  const bindings = Material.prototype.bindings,
    seen = new Set();
  Material.prototype.bindings = function (...args) {
    seen.add(this);
    return bindings.apply(this, args);
  };
  try {
    await body(() => {
      const out = [...seen];
      seen.clear();
      return out;
    });
  } finally {
    Material.prototype.bindings = bindings;
  }
}
test('a material record reports a version that changes with every edit and stays while nothing changes', async () => {
  const w = await world();
  try {
    const map = pixel(),
      other = pixel(),
      material = new PbrMaterial({ map }),
      mesh = createMesh(w.engine, triangle, material),
      shading = mesh.primitives[0].material.shading;
    assert.ok(Number.isNaN(shading.version), 'unknown before the map is on the GPU');
    await w.frame();
    let last = shading.version;
    assert.equal(typeof last, 'number');
    assert.ok(!Number.isNaN(last));
    assert.equal(shading.version, last, 'steady');
    const changed = (label) => {
      const next = shading.version;
      assert.ok(next !== last && !Number.isNaN(next), label);
      last = next;
    };
    const unknown = async (label) => {
      assert.ok(Number.isNaN(shading.version), label + ': not steady until it uploads');
      await w.frame();
      changed(label);
    };
    material.roughness = 0.25;
    changed('a setter');
    material.color[1] = 0.5;
    changed('a colour written in place');
    material.emissive[0] = 0.25;
    changed('an emissive colour written in place');
    material.factors[1] = 0.5;
    changed('a factor row written in place');
    material.setUVTransform({ offset: [0.5, 0] });
    changed('setUVTransform');
    material.copy(new PbrMaterial({ color: [0, 0, 1] }));
    changed('copy');
    material.map = other;
    await unknown('a new map');
    other.update();
    await unknown('Texture.update');
    other.wrapS = 'repeat';
    await unknown('a sampler option');
    assert.throws(() => (material.map = {}), TypeError, 'a map must be a Texture');
    assert.equal(shading.version, last, 'a refused edit changes nothing');
  } finally {
    w.destroy();
  }
});

test('materials with their own shader or bindings report no version', async () => {
  const w = await world();
  try {
    const material = new WgslMaterial({ wgsl: 'fn shade(i: Out, s: Surface) -> Surface { return s; }' }),
      mesh = createMesh(w.engine, triangle, material);
    await w.frame();
    assert.ok(Number.isNaN(mesh.primitives[0].material.shading.version));
  } finally {
    w.destroy();
  }
});

test('a steady material binds nothing; texture uploads, map swaps and in-place colours still show next frame', async () => {
  const w = await world();
  let uploads = 0;
  w.device.queue.writeTexture = () => uploads++;
  try {
    await countBindings(async (bound) => {
      const map = pixel(),
        // Offsets that are not the identity: an identity UV row takes no tangent frame, another shader.
        materials = [1, 2, 3].map((k) => new PbrMaterial({ map, uvTransform: { offset: [k / 4, 0] } }));
      materials.forEach((m, k) => createMesh(w.engine, triangle, m).root.setPosition([k, 0, 0]));
      await w.frame();
      await w.frame();
      bound();
      await w.frame();
      assert.deepEqual(bound(), [], 'steady');
      // An in-place colour write reaches the mesh's block; only that material binds again.
      materials[0].color[0] = 0.25;
      await w.frame();
      assert.deepEqual(bound(), [materials[0]]);
      assert.deepEqual(block(w.draws[0], 0, 76, 4), [0.25, 1, 1, 1]);
      await w.frame();
      assert.deepEqual(bound(), [], 'steady again');
      // A texture update uploads once, through the bindings of the materials that read it.
      uploads = 0;
      map.update();
      await w.frame();
      assert.equal(uploads, 1);
      assert.deepEqual(new Set(bound()), new Set(materials));
      await w.frame();
      assert.deepEqual(bound(), [], 'steady once uploaded');
      assert.equal(uploads, 1);
      // A new map is bound by its material only, and it draws apart (another group 2).
      materials[2].map = pixel();
      await w.frame();
      assert.deepEqual(bound(), [materials[2]]);
      assert.deepEqual(
        w.draws.map((draw) => draw.n),
        [2, 1],
      );
    });
  } finally {
    w.destroy();
  }
});
test('meshes of materials that share a pipeline draw as one instanced draw per 74 instances, each with its own block', async () => {
  const w = await world(256);
  try {
    const map = pixel(),
      meshes = [];
    for (let i = 0; i < 200; i++) {
      const mesh = createMesh(
        w.engine,
        triangle,
        new PbrMaterial({ map, color: [1, 1, 1], uvTransform: { offset: [(i + 1) / 256, 0], rotation: i * 0.01 } }),
      );
      mesh.root.setPosition([(i % 20) - 10, Math.floor(i / 20) - 5, 0]);
      meshes.push(mesh);
    }
    await w.frame();
    await w.frame();
    assert.deepEqual(
      w.draws.map((draw) => [draw.n, draw.firstInstance]),
      [
        [74, 0],
        [74, 74],
        [52, 148],
      ],
      'one draw per binding of 74 blocks, each starting at its first block',
    );
    const [first, second] = w.draws;
    assert.notEqual(first.uniform.offset, second.uniform.offset);
    assert.equal(first.uniform.offset % 256, 0);
    assert.equal(second.uniform.offset % 256, 0);
    assert.match(first.pipeline.vertex.module.code, /var<uniform> margoRows:array<Frame,74>/);
    assert.match(first.pipeline.vertex.module.code, /margoK=i\.margoK;/);
    assert.doesNotMatch(first.pipeline.vertex.module.code, /(?<![\w.])f\./, 'every read goes to the uniform array');
    // Block i holds mesh i's UV row (offset x), identity model rows and determinant 1.
    assert.ok(Math.abs(block(first, 5, 104, 4)[2] - 6 / 256) < 1e-6);
    assert.ok(Math.abs(block(second, 0, 104, 4)[2] - 75 / 256) < 1e-6);
    assert.deepEqual(block(first, 5, 16, 16), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    assert.deepEqual(block(first, 5, 97, 1), [1]);
    // An edit of one material uploads its block only.
    const writes = [],
      write = w.device.queue.writeBuffer;
    w.device.queue.writeBuffer = function (buffer, offset, data, dataOffset, size) {
      if (buffer === first.uniform.buffer) writes.push([offset, size]);
      return write.apply(this, arguments);
    };
    try {
      meshes[80].material.setUVTransform({ offset: [0.75, 0] });
      await w.frame();
      assert.deepEqual(writes, [[(16320 + 6 * 220) * 4, 220]], "only mesh 80's block (binding 1, slot 6) uploads");
      assert.ok(Math.abs(block(w.draws[1], 6, 104, 4)[2] - 0.75) < 1e-6);
    } finally {
      w.device.queue.writeBuffer = write;
    }
  } finally {
    w.destroy();
  }
});

test('materials with different textures keep their own draws', async () => {
  const w = await world();
  try {
    const a = pixel(),
      b = pixel();
    for (let i = 0; i < 6; i++)
      createMesh(w.engine, triangle, new UnlitMaterial({ map: i % 2 ? a : b, color: [i / 6, 0, 0] })).root.setPosition([
        i,
        0,
        0,
      ]);
    await w.frame();
    await w.frame();
    assert.deepEqual(
      w.draws.map((draw) => draw.n),
      [3, 3],
      'one draw per texture',
    );
  } finally {
    w.destroy();
  }
});

test('every material record and every live colour of a kind keep one shape (shared accessors and setters)', async () => {
  const w = await world();
  try {
    const records = [new PbrMaterial({}), new PbrMaterial({ color: [1, 0, 0] })].map(
      (m) => createMesh(w.engine, triangle, m).primitives[0].material,
    );
    const [a, b] = records.map((r) => Object.getOwnPropertyDescriptors(r));
    assert.deepEqual(Reflect.ownKeys(a), Reflect.ownKeys(b));
    for (const key of Reflect.ownKeys(a))
      if (a[key].get || a[key].set) {
        assert.equal(a[key].get, b[key].get, String(key) + ' getter is shared');
        assert.equal(a[key].set, b[key].set, String(key) + ' setter is shared');
      }
    const [x, y] = [new PbrMaterial({}), new PbrMaterial({ color: '#ff0000' })];
    assert.equal(x.color.set, y.color.set);
    assert.equal(x.emissive.set, y.emissive.set);
    // The record's side follows the material, and setting it is a material edit.
    records[0].side = 'double';
    assert.equal(records[0].side, 'double');
    assert.throws(() => (records[0].side = 'sideways'), TypeError);
  } finally {
    w.destroy();
  }
});

test('a batch drawn in a view made anew each frame binds that view block, not one an earlier view left', async () => {
  const { setRenderLayers } = await import('../../cameras/dist/layers.js');
  const w = await world();
  try {
    const material = new PbrMaterial({ color: [1, 0, 0] });
    for (let i = 0; i < 2; i++) createMesh(w.engine, triangle, material).root.setPosition([i, 0, 0]);
    setRenderLayers(createMesh(w.engine, triangle, new PbrMaterial({ color: [0, 1, 0] })).nodes[0], 2);
    const camera = (x) => ({
        matrix: Float32Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0) + (i === 12 ? x : 0)),
        position: [x, 0, 4],
        target: [x, 0, 0],
      }),
      view = (id, layers) => ({ id, viewport: [0, 0, 128, 96], index: 0, layers }),
      x = (draw) => new Float32Array(uniformBytes(draw.view).slice().buffer)[12],
      both = () => [
        { view: view('a', 1), camera: camera(1) },
        { view: view('b', 1), camera: camera(2) },
      ];
    await w.frame(both());
    await w.frame(both());
    assert.deepEqual(
      w.draws.map((draw) => [draw.n, x(draw)]),
      [
        [2, 1],
        [2, 2],
      ],
    );
    // A view that draws only the layer-2 mesh takes the first view block; the batch then draws in view b alone.
    await w.frame([
      { view: view('c', 2), camera: camera(5) },
      { view: view('b', 1), camera: camera(2) },
    ]);
    assert.deepEqual(
      w.draws.map((draw) => [draw.n, x(draw)]),
      [
        [1, 5],
        [2, 2],
      ],
      "the batch binds view b's block",
    );
  } finally {
    w.destroy();
  }
});

test('a material whose meshes all went binds new buffers when a new mesh draws it', async () => {
  const w = await world();
  try {
    const material = new PhongMaterial({ color: [1, 0, 0] });
    createMesh(w.engine, triangle, material).destroy(); // made and gone before a frame: nothing derived
    const first = createMesh(w.engine, triangle, material);
    await w.frame();
    await w.frame();
    const old = w.draws[0].effect.find((entry) => entry.resource.buffer)?.resource.buffer;
    assert.ok(old, 'phong binds its uniform buffer in group 2');
    // The last mesh goes, and with it the material's buffers; a new mesh must not bind them.
    first.destroy();
    await w.frame();
    assert.equal(old.destroyed, true);
    createMesh(w.engine, triangle, material);
    await w.frame();
    await w.frame();
    const buffers = w.draws[0].effect.filter((entry) => entry.resource.buffer).map((entry) => entry.resource.buffer);
    assert.ok(buffers.length);
    assert.ok(
      buffers.every((buffer) => !buffer.destroyed),
      'group 2 binds no destroyed buffer',
    );
  } finally {
    w.destroy();
  }
});
