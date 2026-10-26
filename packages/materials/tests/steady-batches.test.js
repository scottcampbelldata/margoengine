// Materials scenes of the speed matrix that drew one draw per mesh (perf-history entry 23): wireframe meshes never
// batched, blended meshes were one draw each (sorted back to front), and every material composed its shader again every
// frame. Now wireframe meshes batch as line-list instanced draws, consecutive blended meshes batch in their sort order
// (materials that differ only in colour fold into one draw, the colours as instance tints), and a material whose shader
// inputs did not change keeps last frame's shader and pipeline. CPU recording only: the fake pass records the draws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Material, PbrMaterial, Texture, UnlitMaterial, createMesh } from '../dist/index.js';
import { optionalGPU, uniformBytes } from '../../../tests/support/optional-gpu.js';

async function world() {
  const harness = optionalGPU(),
    store = await TransformStore.create(64),
    device = harness.engine.gpu;
  device.limits.maxTextureDimension2D = 8192;
  device.limits.maxUniformBufferBindingSize = 65536;
  device.queue.writeTexture = () => {};
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(128 / 96, true);
  const draws = [];
  let pipeline, uniform, instances, index;
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
          if (i === 0) uniform = group.entries.find((entry) => entry.binding === 0).resource;
        },
        setVertexBuffer(slot, buffer) {
          if (slot === 1) instances = buffer;
        },
        setIndexBuffer(buffer) {
          index = buffer;
        },
        setStencilReference() {},
        drawIndexed(count, n = 1) {
          draws.push({ pipeline, count, n, uniform, index, instances: n > 1 ? instances : undefined });
        },
        end() {},
      }),
    },
  };
  const frame = () => {
    draws.length = 0;
    store.tick(false);
    engine.frameGraph.execute(context);
  };
  // An instanced draw's rows: 24 floats each (world matrix, tint, UV row).
  const rows = (draw) => {
    const data = new Float32Array(draw.instances.data);
    return Array.from({ length: draw.n }, (_, i) => [...data.slice(i * 24, i * 24 + 24)]);
  };
  const base = (draw) => [...new Float32Array(uniformBytes(draw.uniform).slice().buffer, 76 * 4, 4)];
  return { harness, engine, frame, draws, rows, base, destroy: () => engine.dispose() };
}
const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };
const f32 = (values) => [...Float32Array.from(values)];

test('wireframe meshes of one material draw as one instanced line-list draw of their edges', async () => {
  const w = await world();
  try {
    const material = new PbrMaterial({ color: [1, 0.5, 0], wireframe: true });
    for (let i = 0; i < 12; i++) createMesh(w.engine, triangle, material).root.setPosition([i, 0, 0]);
    w.frame();
    await null; // the next frame
    w.frame();
    assert.equal(w.draws.length, 1, 'one draw, not one per mesh');
    const [draw] = w.draws;
    assert.equal(draw.n, 12);
    assert.equal(draw.count, 6, 'three edges, two indices each');
    assert.equal(draw.pipeline.primitive.topology, 'line-list');
    assert.deepEqual(
      w.rows(draw).map((row) => row[12]),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    );
  } finally {
    w.destroy();
  }
});

test('consecutive blended meshes of one material draw as one instanced draw, back to front', async () => {
  const w = await world();
  try {
    const material = new UnlitMaterial({ color: [1, 0, 0], transparent: true, opacity: 0.5 });
    // Nearest first in creation order: the sort draws the farthest (z = -7) first.
    for (let i = 0; i < 8; i++) createMesh(w.engine, triangle, material).root.setPosition([0, 0, -i]);
    w.frame();
    assert.equal(w.draws.length, 1);
    assert.equal(w.draws[0].n, 8);
    assert.deepEqual(
      w.rows(w.draws[0]).map((row) => row[14] + 0),
      [-7, -6, -5, -4, -3, -2, -1, 0],
    );
  } finally {
    w.destroy();
  }
});

test('blended meshes that differ only in colour fold into one draw, each colour its instance tint, in sort order', async () => {
  const w = await world();
  try {
    const colours = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      paints = colours.map((color) => new UnlitMaterial({ color, transparent: true, opacity: 0.5 }));
    for (let i = 0; i < 9; i++) createMesh(w.engine, triangle, paints[i % 3]).root.setPosition([0, 0, -i]);
    w.frame();
    await null; // the next frame
    w.frame();
    assert.equal(w.draws.length, 1, 'one draw for three materials');
    const [draw] = w.draws;
    assert.equal(draw.n, 9);
    assert.deepEqual(w.base(draw), [1, 1, 1, 1], 'the batch uniform holds base colour 1');
    const rows = w.rows(draw);
    // Farthest first: mesh 8 (paint 2), 7 (paint 1), ...
    assert.deepEqual(
      rows.map((row) => row[14] + 0),
      [-8, -7, -6, -5, -4, -3, -2, -1, 0],
    );
    rows.forEach((row, k) => {
      const i = 8 - k;
      assert.deepEqual(row.slice(16, 20), f32([...colours[i % 3], 0.5]), `mesh ${i} tint is its colour`);
    });
    // A live colour edit reaches the tints next frame.
    paints[1].color = [0.25, 0.25, 0.25];
    await null;
    w.frame();
    assert.deepEqual(w.rows(w.draws[0])[1].slice(16, 20), f32([0.25, 0.25, 0.25, 0.5]));
  } finally {
    w.destroy();
  }
});

test('a blended mesh of another blending between them ends the batch, and the order stays', async () => {
  const w = await world();
  try {
    const normal = new UnlitMaterial({ color: [1, 0, 0], transparent: true, opacity: 0.5 }),
      additive = new UnlitMaterial({ color: [0, 1, 0], transparent: true, blending: 'additive', depthWrite: false });
    for (let i = 0; i < 7; i++)
      createMesh(w.engine, triangle, i === 3 ? additive : normal).root.setPosition([0, 0, -i]);
    w.frame();
    assert.deepEqual(
      w.draws.map((draw) => draw.n),
      [3, 1, 3],
      'farthest three, the additive mesh, the nearest three',
    );
    assert.deepEqual(
      w.rows(w.draws[0]).map((row) => row[14] + 0),
      [-6, -5, -4],
    );
    assert.deepEqual(
      w.rows(w.draws[2]).map((row) => row[14] + 0),
      [-2, -1, 0],
    );
    assert.notEqual(w.draws[1].pipeline, w.draws[0].pipeline);
  } finally {
    w.destroy();
  }
});

test('a material keeps its shader across frames until a shader input changes; its bindings run every frame', async () => {
  const w = await world();
  const shader = Material.prototype.shader,
    bindings = Material.prototype.bindings,
    calls = { shader: 0, bindings: 0 };
  Material.prototype.shader = function (...args) {
    calls.shader++;
    return shader.apply(this, args);
  };
  Material.prototype.bindings = function (...args) {
    calls.bindings++;
    return bindings.apply(this, args);
  };
  try {
    const map = new Texture({ data: new Uint8Array(16).fill(255), width: 2, height: 2 }, { mipmaps: false }),
      materials = [0, 1, 2].map((k) => new PbrMaterial({ map, uvTransform: { offset: [k / 4, 0] } }));
    materials.forEach((material, k) => createMesh(w.engine, triangle, material).root.setPosition([k, 0, 0]));
    w.frame();
    await null;
    w.frame();
    const pipelines = w.harness.pipelines.length;
    for (const key in calls) calls[key] = 0;
    await null;
    w.frame();
    assert.equal(calls.shader, 0, 'no shader composed on a steady frame');
    assert.equal(calls.bindings, 3, "each material's bindings (texture uploads, live values) still run");
    assert.equal(w.harness.pipelines.length, pipelines);
    assert.equal(w.draws.length, 3);
    // A shader input (flat shading) composes that material's shader again, and only that one.
    materials[1].flatShading = true;
    await null;
    w.frame();
    assert.equal(calls.shader, 1);
    assert.notEqual(w.draws[1].pipeline, w.draws[0].pipeline, 'the flat-shaded material draws its new pipeline');
    assert.match(w.draws[1].pipeline.vertex.module.code, /dpdx|dpdy/, 'flat shading takes the face normal');
    // A row edit (the UV transform) shows without composing anything.
    calls.shader = 0;
    materials[2].setUVTransform({ offset: [0.5, 0.5] });
    await null;
    w.frame();
    assert.equal(calls.shader, 0);
    const rows = new Float32Array(uniformBytes(w.draws[2].uniform).slice().buffer, 104 * 4, 8);
    assert.deepEqual([rows[2], rows[6]], [0.5, 0.5], 'the new offset reaches the draw');
  } finally {
    Material.prototype.shader = shader;
    Material.prototype.bindings = bindings;
    w.destroy();
  }
});

test('material records copy with their live values and nothing hidden', async () => {
  const w = await world();
  try {
    const material = new UnlitMaterial({ color: [0.25, 0.5, 0.75] }),
      mesh = createMesh(w.engine, triangle, material),
      record = mesh.primitives[0].material,
      copy = { ...record };
    assert.equal(copy.base, material.color);
    assert.equal(copy.settings, material.settings);
    assert.equal(Object.getOwnPropertySymbols(copy).length, 0);
    assert.equal(copy.shading, record.shading);
  } finally {
    w.destroy();
  }
});
