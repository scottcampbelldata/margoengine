// Every model scale gets the same shadow with default settings (docs/known-bugs.md, fixed 2026-11-11: a model a few
// centimetres across, the Khronos BoomBox among them, cast no visible shadow). The GPU side is scale-browser.mjs; these
// are the CPU halves: cascades and their depth ranges scale with the scene, models fit the cascades as core meshes do,
// and a model framed from kilometres away stays inside the shadowed distance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows, cascadeSplits, fitCascades } from '../dist/index.js';
import { setMeshSource, clearMeshSource } from '../../shared/mesh-source.js';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { box } from '../../core/dist/index.js';

const LIGHT = [-4, 4, 2];

test('fitCascades with a scene sphere scales exactly with the scene, millimetres included', () => {
  // A scene 2 ** -6 the size of a metre one and the same scene 1024 times smaller: every length scales by 2 ** -10,
  // so every cascade's light-space box must too. Below one unit the radius rounds to 1/16 of its octave, which scales.
  const fit = (s) => {
    const camera = { position: [0, 2 * s, 5 * s], target: [0, 0, 0], fov: 60, near: 0.1 * s, far: 20 * s };
    return fitCascades(
      camera,
      16 / 9,
      LIGHT,
      2048,
      cascadeSplits(0.1 * s, 20 * s, 0.5),
      undefined,
      undefined,
      100,
      undefined,
      4,
      undefined,
      [0, 0, 0, 14.2 * s],
    );
  };
  const small = fit(2 ** -6),
    tiny = fit(2 ** -16),
    metre = fit(1);
  for (let i = 0; i < 4; i++) {
    assert.equal(tiny.ranges[i], small.ranges[i] * 2 ** -10, `cascade ${i} depth range`);
    // The x row is 1 / radius: the radius, and so the texel, scales too (it was rounded up to 1/16 of a unit).
    assert.equal(tiny.matrices[i * 16], small.matrices[i * 16] * 2 ** 10, `cascade ${i} radius`);
  }
  // The depth range reaches the scene, not 100 units towards the light.
  assert.ok(metre.ranges[0] < 2 * (5 + 2 * 14.2), `metre depth ${metre.ranges[0]}`);
  // Without a scene the margin stays a fixed world length, as before.
  const old = fitCascades(
    { position: [0, 2, 5], target: [0, 0, 0], fov: 60, near: 0.1, far: 20 },
    16 / 9,
    LIGHT,
    2048,
    cascadeSplits(0.1, 20, 0.5),
  );
  assert.ok(old.ranges[0] > 200, `margin depth ${old.ranges[0]}`);
});

async function rig(scale) {
  const gpu = mockGPU(),
    store = await TransformStore.create(16),
    buffers = { vertex: gpu.device.createBuffer({ size: 576 }), index: gpu.device.createBuffer({ size: 144 }) };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {}, geometryBuffers: () => buffers },
    { position: [0, 2 * scale, 6 * scale], target: [0, 0, 0] },
    null,
  );
  const view = context(gpu, { samples: 1, shader: 'let linear=direct*vec3f(1);' });
  const frame = (shadows) => {
    store.tick(false);
    view.begin(0);
    Object.assign(view.camera, { position: [0, 2 * scale, 6 * scale], target: [0, 0, 0], near: 0.1 * scale, far: 1000 * scale });
    passes(shadows)(view.c);
    return [...shadows.splits];
  };
  return { gpu, engine, buffers, frame };
}

// A gltf-pro style model (what loadGLTF and materials' createMesh make): a source with shadowPrimitives whose node has
// no core geometry and a mesh-source record with a local box. `reads` counts how often that box is computed.
function model(engine, buffers, size) {
  const node = engine.createMesh(),
    h = size / 2,
    vertices = new Float32Array(40);
  vertices.set([-h, 0, -h], 0);
  vertices.set([h, size, h], 20);
  const record = {
    model: { disposed: false },
    node,
    primitives: [{ vertices, indices: [0, 1, 0], deformed: false, material: { shading: {} } }],
    stride: 80,
    skinned: false,
    morphed: false,
    reads: 0,
    get bounds() {
      this.reads++;
      return new Float32Array([-h, 0, -h, h, size, h]);
    },
  };
  setMeshSource(node, record);
  return {
    record,
    source: { shadowPrimitives: [{ node, vertex: buffers.vertex, index: buffers.index, count: 3, stride: 80 }] },
    dispose() {
      clearMeshSource(node);
      node.dispose();
    },
  };
}

test('a model fits the cascades as core meshes do, and its box is read once, not every frame', async () => {
  const { engine, buffers, frame } = await rig(1);
  const floor = engine.createMesh().setGeometry(box(6, 0.1, 6)).setPosition([0, -0.05, 0]),
    toy = model(engine, buffers, 0.02),
    shadows = new Shadows({ resolution: 64 });
  try {
    shadows.setup(engine);
    shadows.add(toy.source);
    shadows.add(floor, { castShadow: false });
    const splits = frame(shadows);
    // The floor's sphere (radius about 4.2) seen from 6.3 m: far is that sum rounded up a quarter octave, as for core
    // meshes; before, a model kept the cascades on 0.1 to 500 m, so the first cascade's texels were 6 cm wide.
    assert.ok(splits[3] >= 9 && splits[3] < 12, `fitted far ${splits[3]}`);
    for (let i = 0; i < 5; i++) frame(shadows);
    assert.equal(toy.record.reads, 1, 'the local box is computed once while the vertex arrays stay');
    toy.record.primitives[0].vertices = toy.record.primitives[0].vertices.slice();
    frame(shadows);
    assert.equal(toy.record.reads, 2, 'a new vertex array is read again');
    // A displaced or deformed primitive has no fixed box: the default distance comes back.
    toy.record.primitives[0].deformed = true;
    assert.equal(frame(shadows)[3], 500);
  } finally {
    shadows.dispose();
    toy.dispose();
    engine.dispose();
  }
});

test('the default distance follows the camera: a scene framed from kilometres keeps its shadows', async () => {
  // The same scene at 1 m and at 1024 m (a power of two, so the quarter-octave rounding scales exactly): the fitted
  // cascades scale with it. Before, the 500 m default cut a model framed from 6 km out of the shadowed range.
  const splitsAt = async (scale, custom) => {
    const { engine, frame } = await rig(scale);
    const floor = engine
        .createMesh()
        .setGeometry(box(6 * scale, 0.1 * scale, 6 * scale))
        .setPosition([0, -0.05 * scale, 0]),
      shadows = new Shadows({ resolution: 64 });
    try {
      shadows.setup(engine);
      shadows.add(floor);
      if (custom) shadows.add({ drawShadow() {} });
      return frame(shadows);
    } finally {
      shadows.dispose();
      engine.dispose();
    }
  };
  const metre = await splitsAt(1),
    km = await splitsAt(1024);
  for (let i = 0; i < 4; i++) assert.equal(km[i], Math.fround(metre[i] * 1024), `split ${i}`);
  // A caster with no bounds keeps 500 m near the camera, and 20 times the camera's target distance when that is farther.
  assert.equal((await splitsAt(1, true))[3], 500);
  assert.equal((await splitsAt(1024, true))[3], Math.fround(20 * Math.hypot(2, 6) * 1024));
});
