// KB-RESTORE-BORROWED1, the vfx rows of scripts/borrowed-registry.json (docs/conventions.md, "Borrowed GPU objects",
// rule 6): no VFX member holds a caller's GPU object across a device restore. VFXState's buffers and `shadows.buffer`
// are the effect's own, made again on the new device; the soft and sort features are factories the effect calls with
// each device; a skinned primitive's `deformed` is the deformer's record (its owner clears it at a restore), read every
// frame. This pins that: after a restore every buffer the effect binds or copies from is one of the new device's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// One triangle in the bind pose, 20 floats a vertex, position first.
const primitive = () => {
  const vertices = new Float32Array(3 * 20);
  vertices.set([1, 0, 0], 20);
  vertices.set([0, 1, 0], 40);
  return { vertices, indices: new Uint32Array([0, 1, 2]) };
};
const depthTexture = () => ({
  format: 'depth32float',
  dimension: '2d',
  width: 64,
  height: 64,
  usage: 4,
  sampleCount: 1,
  createView: (d) => ({ view: d }),
});
// Every GPUBuffer the bind group descriptors name.
const buffersOf = (groups) => groups.flatMap((g) => g.entries.map((e) => e.resource?.buffer).filter(Boolean));

test("after a device restore every buffer a VFX binds or copies is the new device's, and a skinned primitive is read each frame", () => {
  const first = optionalGPU(),
    second = optionalGPU(),
    { engine, context } = first;
  engine.stats = { drawCalls: 0 };
  context.width = context.height = 64;
  // The frame's buffer copies, so the deformer's buffer can be followed into the effect.
  const copies = [],
    copy = context.encoder.copyBufferToBuffer;
  context.encoder.copyBufferToBuffer = (source, ...rest) => {
    copies.push(source);
    copy(source, ...rest);
  };
  const p = primitive(),
    depth = depthTexture(),
    lights = [],
    effect = new VFX({
      capacity: 64,
      rate: 100,
      softness: 0.5,
      depth: () => depth,
      sort: true,
      shadows: { count: 4, into: { setLights: (l) => lights.push(l) } },
      skinned: { primitive: p },
    });
  engine.use(effect);
  const pose = engine.gpu.createBuffer({ size: 3 * 80, usage: 128 });
  p.deformed = pose;
  first.frame();
  first.frame();
  const old = new Set(first.resources),
    shadowsBefore = effect.options.shadows.buffer,
    gpuBefore = effect.gpuState;
  assert.ok(old.has(shadowsBefore), 'shadows.buffer is the light list the feature made');
  assert.ok(buffersOf(first.groups).some((b) => b === gpuBefore.particles));
  assert.ok(copies.includes(pose), "the deformer's buffer is read every frame");
  // The soft feature made its uniform with the device; the sort feature its own buffers.
  const groupsBefore = first.groups.length;

  // The restore: the deformer clears its record (animation's Skin and GeometryCachePlayer, and gltf, do in
  // onDeviceRestored), the engine and the frame move to the new device and the effect is told.
  p.deformed = undefined;
  engine.gpu = context.device = second.engine.gpu;
  copies.length = 0;
  effect.onDeviceRestored(engine);
  first.frame();
  first.frame();
  assert.equal(first.groups.length, groupsBefore, 'no bind group is made on the old device after the restore');
  const bound = buffersOf(second.groups);
  assert.ok(bound.length > 0, 'the effect binds buffers on the new device');
  assert.deepEqual(
    bound.filter((b) => old.has(b)),
    [],
    'nothing of the old device is bound',
  );
  assert.ok(
    bound.every((b) => second.resources.includes(b)),
    "every bound buffer is the new device's",
  );
  assert.deepEqual(
    copies.filter((b) => old.has(b)),
    [],
    'nothing of the old device is copied from',
  );
  const state = effect.gpuState;
  for (const key of ['particles', 'alive', 'visible', 'indirect']) {
    assert.ok(second.resources.includes(state[key]), `VFXState.${key} is made again on the new device`);
    assert.ok(old.has(gpuBefore[key]) && gpuBefore[key].destroyed, `the old ${key} is the effect's own and destroyed`);
  }
  const shadows = effect.options.shadows.buffer;
  assert.notEqual(shadows, shadowsBefore);
  assert.ok(second.resources.includes(shadows), 'shadows.buffer is made again on the new device');
  assert.ok(shadowsBefore.destroyed, 'the old light list is the feature output and destroyed with the effect');
  assert.ok(!pose.destroyed, "the deformer's buffer is never destroyed by the effect");

  // The deformer's new record is read on the next frame.
  const posed = second.engine.gpu.createBuffer({ size: 3 * 80, usage: 128 });
  new Float32Array(posed.data).fill(7);
  p.deformed = posed;
  first.frame();
  assert.ok(copies.includes(posed), "the new device's record is copied");
  const storage = second.resources.find(
    (r) => r.size === 16 + 3 * 80 && r.data && new Uint32Array(r.data, 0, 3).join() === '0,1,2',
  );
  assert.ok(storage, 'the triangles and vertices on the new device');
  assert.deepEqual([...new Float32Array(storage.data, 16, 3)], [7, 7, 7], 'the posed vertices of the new record');
  effect.dispose();
});
