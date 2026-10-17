// Proof for HANDOFF 5l.j (VAT crowd shadows + IBL, shadows fitted to small scenes) that apps not using the new paths see
// the same GPU calls as `ref`:
//  - vat: a VATCrowd with no lighting effect (instances added and edited, a format switch, device restoration, removal)
//    records every GPU call of @margoengine/animation/vat at `ref` and in the working tree: identical.
//  - shadows: core-mesh casters with `distance` set, and core meshes plus a custom `drawShadow` source with no `distance`,
//    record every GPU call of @margoengine/shadows: identical. Only core meshes and no `distance` is the intended change
//    (cascades fitted to the meshes' bounding sphere); the proof checks it differs and reports the fitted last split.
// Skinned and morphed gltf-pro casters needed no change (Shadows reads `primitive.deformed`); gltf-pro-lighting-hooks.proof.js
// still records gltf-pro + shadows identical, and gltf-pro now takes lightPBR from packages/shared.
// Run (after npm run build:packages): node examples/package-benchmarks/proofs/deformed-shadows.proof.js [ref] [pin] [--current]
// Pinned: 38d448e against 282e751, the commit that made this claim. --current: b3ed8ac against the working tree;
// 2091f12 intentionally reuses shadow draw scratch data and changes upload ordering (claims.md).
import assert from 'node:assert/strict';
import { refs, versions, current } from './compare.js';
import { mockGPU, context, passes } from './gpu-recorder.js';
import { Engine, TransformStore } from '../../../packages/core/dist/extension.js';
import { box } from '../../../packages/core/dist/index.js';

const { ref, pin } = refs('38d448e', '282e751', 'b3ed8ac'); // 38d448e: the commit before 5l.j
async function rig() {
  const gpu = mockGPU(),
    store = await TransformStore.create(32),
    buffers = new Map();
  const geometryBuffers = (geometry) => {
    if (!buffers.has(geometry))
      buffers.set(geometry, {
        vertex: gpu.device.createBuffer({ size: 576, usage: 32 }),
        index: gpu.device.createBuffer({ size: 144, usage: 16 }),
      });
    return buffers.get(geometry);
  };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {}, geometryBuffers },
    { position: [0, 2, 6], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(4 / 3, true);
  return { gpu, store, engine };
}

const vatData = {
  vertexCount: 3,
  rows: 3,
  width: 2048,
  texels: new Float32Array(2048 * 4).map((_, i) => (i % 7) * 0.1),
  indices: Uint32Array.from([0, 1, 2]),
  uvs: new Float32Array(6),
  clips: [{ name: 'a', start: 0, frames: 2, duration: 1, loop: true }],
};
async function vatStory({ VATCrowd }) {
  const { gpu, engine } = await rig();
  const log = gpu.record(() => {
    const view = context(gpu, { samples: 4, format: 'bgra8unorm', depthFormat: 'depth24plus' }),
      crowd = new VATCrowd(vatData, { color: [0.9, 0.8, 0.3, 1] });
    crowd.setup(engine);
    const run = passes(crowd);
    const steps = [
      () => crowd.add(),
      () => crowd.add({ matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1], offset: 0.3 }),
      () => {
        for (let i = 0; i < 20; i++) crowd.add({ speed: 1 + i });
      },
      () => crowd.set(1, { clip: 0, offset: 0.7 }),
      () => {
        view.state.format = 'rgba16float';
      },
      () => crowd.onDeviceRestored(),
      () => crowd.truncate(1),
      () => {},
    ];
    steps.forEach((step, frame) => {
      step();
      crowd.onPreUpdate(1 / 60);
      view.begin(frame);
      run(view.c);
      view.end();
    });
    crowd.dispose();
  });
  engine.dispose();
  return log;
}

async function shadowStory({ Shadows }, options, custom) {
  const { gpu, store, engine } = await rig();
  const log = gpu.record(() => {
    const view = context(gpu, { samples: 1, format: 'bgra8unorm', shader: 'let linear=direct*vec3f(1);' }),
      shadows = new Shadows({ resolution: 64, ...options });
    const floor = engine
        .createMesh()
        .setGeometry(box(6, 0.2, 6))
        .setPosition([0, -0.1, 0]),
      cube = engine.createMesh().setGeometry(box()).setPosition([0, 0.5, 0]);
    store.tick(false);
    shadows.setup(engine);
    const run = passes(shadows);
    shadows.add(floor, { static: true });
    shadows.add(cube);
    if (custom)
      shadows.add({
        drawShadow({ matrix, cascade }) {
          gpu.note('custom', cascade, matrix);
        },
      });
    const steps = [
      () => {},
      () => {
        cube.setPosition([1, 0.5, 0]);
      },
      () => {
        view.camera.position[1] = 3;
      },
      () => {
        cube.visible = false;
      },
      () => {
        floor.setScale([3, 1, 3]);
        shadows.invalidate();
      },
      () => {},
    ];
    steps.forEach((step, frame) => {
      step();
      store.tick(false);
      view.begin(frame);
      run(view.c);
      gpu.note('splits', shadows.splits);
      view.end();
    });
    shadows.dispose();
  });
  engine.dispose();
  return log;
}

const [animation, shadowsModule] = await Promise.all([
  versions('animation', ref, 'src/vat.ts', pin),
  versions('shadows', ref, undefined, pin),
]);
const result = { baseline: ref };
const vatBaseline = await vatStory(animation.baseline),
  vatCandidate = await vatStory(animation.candidate);
assert.ok(
  vatBaseline.some((entry) => entry[0] === 'pass.drawIndexed'),
  'the VAT story draws',
);
assert.deepEqual(vatCandidate, vatBaseline, 'VATCrowd without lighting changed its GPU calls');
result.vat = { identicalCalls: vatBaseline.length };
for (const [name, options, custom] of [
  ['distance500', { distance: 500 }, false],
  ['distance40', { distance: 40 }, false],
  ['customSource', {}, true],
]) {
  const expected = await shadowStory(shadowsModule.baseline, options, custom),
    actual = await shadowStory(shadowsModule.candidate, options, custom);
  assert.ok(
    expected.some((entry) => entry[0] === 'pass.drawIndexed'),
    'the shadow story draws',
  );
  assert.deepEqual(actual, expected, `Shadows GPU calls differ (${name})`);
  result[name] = { identicalCalls: expected.length };
}
const lastSplit = (log) =>
  log
    .filter((entry) => entry[0] === 'splits')
    .map(
      (entry) => +new Float32Array(Uint8Array.from(Buffer.from(entry[1].split(':')[1], 'hex')).buffer)[3].toFixed(2),
    );
const before = await shadowStory(shadowsModule.baseline, {}, false),
  after = await shadowStory(shadowsModule.candidate, {}, false);
if (!current) assert.notDeepEqual(after, before, 'core meshes without distance: cascades are fitted');
result.fitted = { lastSplitBefore: lastSplit(before), lastSplitAfter: lastSplit(after) };
assert.ok(
  result.fitted.lastSplitAfter.every((v) => v < 50),
  'fitted range stays near the 6 m scene',
);
console.log(JSON.stringify(result));
