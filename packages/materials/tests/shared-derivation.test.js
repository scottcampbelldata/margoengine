// Meshes that share a material derive its shader, pipeline and lighting group once per frame, not once per mesh; a
// run's meshes of one material and geometry draw as one instanced draw; a run sets state only when it changes. Before,
// 10,000 unlit meshes ran the whole shader derivation, a pipeline search and every shading callback 10,000 times a
// frame, each mesh owned its own pipeline and made its own draw (perf-history). CPU recording only: the fake pass
// counts what the draws set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Material, UnlitMaterial, createMesh } from '../dist/index.js';
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
  const calls = { setPipeline: 0, setBindGroup: [0, 0, 0, 0], setVertexBuffer: 0, setIndexBuffer: 0, draws: [] };
  let uniform, instances;
  const context = {
    ...harness.context,
    camera: engine.camera,
    draw() {},
    encoder: {
      beginRenderPass: () => ({
        setPipeline() {
          calls.setPipeline++;
        },
        setBindGroup(index, group) {
          calls.setBindGroup[index]++;
          if (index === 0) uniform = group.entries.find((entry) => entry.binding === 0).resource;
        },
        setVertexBuffer(slot, buffer) {
          calls.setVertexBuffer++;
          if (slot === 1) instances = buffer;
        },
        setIndexBuffer() {
          calls.setIndexBuffer++;
        },
        drawIndexed(count, n = 1) {
          calls.draws.push({ uniform, n, instances: n > 1 ? instances : undefined });
        },
        end() {},
      }),
    },
  };
  const frame = () => {
    calls.setPipeline = calls.setVertexBuffer = calls.setIndexBuffer = 0;
    calls.setBindGroup.fill(0);
    calls.draws.length = 0;
    store.tick(false);
    engine.frameGraph.execute(context);
  };
  // Base colour of a recorded draw: uniform floats 76-79 (read after the run uploaded them).
  const base = (draw) => [...new Float32Array(uniformBytes(draw.uniform).slice().buffer, 76 * 4, 4)];
  // An instanced draw's rows: 24 floats each, the world matrix first.
  const rows = (draw) => {
    const data = new Float32Array(draw.instances.data);
    return Array.from({ length: draw.n }, (_, i) => data.slice(i * 24, i * 24 + 24));
  };
  return { harness, engine, frame, calls, base, rows, destroy: () => engine.dispose() };
}
const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };

test('twenty meshes of one material and geometry derive once a frame and draw as one instanced draw', async () => {
  const w = await world();
  try {
    const material = new Material({ color: [1, 0, 0] });
    let derived = 0;
    const shader = material.shader.bind(material);
    material.shader = (...args) => {
      derived++;
      return shader(...args);
    };
    for (let i = 0; i < 20; i++) createMesh(w.engine, triangle, material).root.setPosition([i, 0, 0]);
    w.frame();
    const pipelines = w.harness.pipelines.length;
    assert.deepEqual(
      w.calls.draws.map((draw) => draw.n),
      [20],
    );
    // Each instance row is its mesh's world matrix, in draw order (translation x = i), tint 1 and an identity UV row.
    w.rows(w.calls.draws[0]).forEach((row, i) => {
      assert.equal(row[12], i);
      assert.deepEqual([...row.slice(16)], [1, 1, 1, 1, 1, 1, 0, 0]);
    });
    derived = 0;
    w.frame();
    await null; // the next frame
    w.frame();
    assert.equal(derived, 2, 'one derivation per frame for the shared material, not one per mesh');
    assert.equal(w.harness.pipelines.length, pipelines, 'steady frames build no pipeline');
    assert.equal(
      pipelines,
      1,
      'one pipeline: the instanced variant (meshes in a batch build no pipeline of their own)',
    );
    assert.equal(w.calls.setPipeline, 1);
    assert.equal(w.calls.setBindGroup[0], 1);
    assert.deepEqual(
      w.calls.draws.map((draw) => draw.n),
      [20],
    );
  } finally {
    w.destroy();
  }
});

test('a live edit reaches every mesh of the material next frame; a swapped mesh draws its new material', async () => {
  const w = await world();
  try {
    const red = new UnlitMaterial({ color: [1, 0, 0] }),
      blue = new UnlitMaterial({ color: [0, 0, 1] }),
      meshes = Array.from({ length: 4 }, (_, i) => createMesh(w.engine, triangle, red));
    meshes.forEach((mesh, i) => mesh.root.setPosition([i, 0, 0]));
    w.frame();
    for (const draw of w.calls.draws) assert.deepEqual(w.base(draw), [1, 0, 0, 1]);
    red.color = [0, 1, 0];
    await null; // the next frame
    w.frame();
    for (const draw of w.calls.draws) assert.deepEqual(w.base(draw), [0, 1, 0, 1], 'the edit reaches every mesh');
    meshes[2].material = blue;
    await null; // the next frame
    w.frame();
    // The three red meshes draw as one instanced draw (in mesh order), the swapped mesh as its own draw.
    assert.deepEqual(
      w.calls.draws.map((draw) => [w.base(draw)[2], draw.n]),
      [
        [0, 3],
        [1, 1],
      ],
      'only the swapped mesh draws blue',
    );
    assert.deepEqual(
      w.rows(w.calls.draws[0]).map((row) => row[12]),
      [0, 1, 3],
    );
    assert.equal(meshes[2].primitives[0].material.base, blue.color);
  } finally {
    w.destroy();
  }
});

test('a moving camera uploads only the shared view block, not every mesh uniform', async () => {
  const w = await world();
  try {
    const material = new UnlitMaterial({ color: [1, 0, 0] });
    for (let i = 0; i < 20; i++) createMesh(w.engine, triangle, material).root.setPosition([i, 0, 0]);
    w.frame();
    await null; // the next frame
    w.engine.camera.position = [1, 2, 6];
    w.engine.camera.update(128 / 96, true);
    const writes = w.harness.bufferWrites,
      start = writes.length;
    w.frame();
    const bytes = writes.slice(start).reduce((sum, write) => sum + write.bytes, 0);
    // Each mesh's own uniform (880 bytes) used to hold the camera: 20 meshes uploaded 20 x 880 bytes per moved frame.
    assert.ok(bytes > 0 && bytes <= 192, `only the 192-byte view block uploads (got ${bytes} bytes)`);
    assert.deepEqual(
      w.calls.draws.map((draw) => draw.n),
      [20],
    );
  } finally {
    w.destroy();
  }
});

test('a moved mesh uploads only its own instance row', async () => {
  const w = await world();
  try {
    const material = new UnlitMaterial({ color: [1, 0, 0] }),
      meshes = Array.from({ length: 20 }, (_, i) => createMesh(w.engine, triangle, material));
    meshes.forEach((mesh, i) => mesh.root.setPosition([i, 0, 0]));
    w.frame();
    await null; // the next frame
    meshes[7].root.setPosition([7, 5, 0]);
    const writes = w.harness.bufferWrites,
      start = writes.length;
    w.frame();
    assert.deepEqual(
      writes.slice(start).map((write) => [write.offset, write.bytes]),
      [[7 * 96, 96]],
      'one 96-byte instance row',
    );
    assert.equal(w.rows(w.calls.draws[0])[7][13], 5);
  } finally {
    w.destroy();
  }
});
