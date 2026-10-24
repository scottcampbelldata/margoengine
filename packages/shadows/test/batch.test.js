import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '../dist/index.js';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { box } from '../../core/dist/index.js';

/** An engine over the recording GPU whose meshes all share one geometry's buffers, and `n` caster boxes. */
async function scene(n) {
  const gpu = mockGPU(),
    store = await TransformStore.create(n + 8),
    buffers = { vertex: gpu.device.createBuffer({ size: 576 }), index: gpu.device.createBuffer({ size: 144 }) };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    {
      backend: 'webgpu',
      gpu: gpu.device,
      add() {},
      remove() {},
      render() {},
      dispose() {},
      geometryBuffers: () => buffers,
    },
    { position: [0, 20, 40], target: [0, 0, 0] },
    null,
  );
  const geometry = box(0.5, 0.5, 0.5),
    side = Math.ceil(Math.sqrt(n)),
    meshes = Array.from({ length: n }, (_, i) =>
      engine
        .createMesh()
        .setGeometry(geometry)
        .setPosition([(i % side) - side / 2, 0.25, Math.floor(i / side) - side / 2]),
    );
  const view = context(gpu, { samples: 1, shader: 'let linear=direct*vec3f(1);' }),
    shadows = new Shadows({ resolution: 64, distance: 100 });
  shadows.setup(engine);
  for (const mesh of meshes) shadows.add(mesh);
  const run = passes(shadows),
    frame = (position) =>
      gpu.record(() => {
        store.tick(false);
        view.begin(0);
        view.camera.position = position;
        run(view.c);
      });
  return { gpu, meshes, shadows, frame };
}

test('1,000 casters sharing a geometry draw as one instanced draw per cascade, matrices uploaded once a frame', async () => {
  const { meshes, shadows, frame } = await scene(1000);
  try {
    const log = frame([0, 20, 40]),
      draws = log.filter((e) => e[0] === 'pass.drawIndexed');
    assert.deepEqual(
      draws.map((e) => [e[1], e[2]]),
      Array(4).fill([36, 1000]),
      'one draw of 1,000 instances in each of the 4 cascades',
    );
    assert.equal(shadows.stats.staticDraws, 4000, 'stats still count every caster in every cascade');
    // The world matrices go up once for all four cascades: one 64,000-byte write, instance k = mesh k's matrix.
    const matrices = log.filter((e) => e[0] === 'writeBuffer' && e[3].length === 1000 * 64 * 2);
    assert.equal(matrices.length, 1);
    const bytes = Buffer.from(matrices[0][3], 'hex'),
      floats = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    for (const k of [0, 499, 999])
      assert.deepEqual([...floats.subarray(k * 16, k * 16 + 16)], [...Float32Array.from(meshes[k].matrix)]);
    // The camera orbits: the cascades move, so the cached map redraws, still one draw per cascade.
    const next = frame([10, 20, 38]).filter((e) => e[0] === 'pass.drawIndexed');
    assert.equal(next.length, 4);
  } finally {
    shadows.dispose();
  }
});

test('fewer than 8 casters sharing a geometry keep one draw each', async () => {
  const { shadows, frame } = await scene(7);
  try {
    const draws = frame([0, 20, 40]).filter((e) => e[0] === 'pass.drawIndexed');
    assert.equal(draws.length, 28);
    assert.ok(draws.every((e) => e[2] === undefined));
  } finally {
    shadows.dispose();
  }
});

test('a hidden caster leaves the batch; dispose destroys the batch buffers', async () => {
  const { gpu, meshes, shadows, frame } = await scene(16);
  frame([0, 20, 40]);
  meshes[3].visible = false;
  const draws = frame([1, 20, 40]).filter((e) => e[0] === 'pass.drawIndexed');
  assert.deepEqual(
    draws.map((e) => e[2]),
    [15, 15, 15, 15],
  );
  const log = gpu.record(() => shadows.dispose()),
    destroyed = new Set(log.filter((e) => e[0] === 'destroy').map((e) => e[1])),
    made = gpu.record(() => {});
  assert.deepEqual(made, []);
  // The batch storage buffer (written with 15 or 16 matrices) and the four cascade cameras are among the destroyed.
  assert.ok(destroyed.size >= 5, `destroyed ${destroyed.size}`);
});
