// Dual quaternion skinning: the encoded slot reproduces a bone matrix, and a blend keeps a twisted joint's volume.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Animation } from '../dist/index.js';
import { dualQuaternionSkinning, encodeDualQuaternions, skinDualQuaternion } from '../dist/dqs.js';
import { skinnedStrip } from '../test/fixture.js';
import { engine, model, near } from './support/models.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

/** Column-major translate * rotate(axis, degrees) * `stretch` (a row-major 3x3). */
function bone(translation, axis, degrees, stretch = [1, 0, 0, 0, 1, 0, 0, 0, 1]) {
  const h = (degrees * Math.PI) / 180,
    c = Math.cos(h),
    s = Math.sin(h),
    t = 1 - c,
    [x, y, z] = axis,
    r = [
      t * x * x + c, t * x * y - s * z, t * x * z + s * y,
      t * x * y + s * z, t * y * y + c, t * y * z - s * x,
      t * x * z - s * y, t * y * z + s * x, t * z * z + c,
    ],
    out = new Float32Array(16);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += r[i * 3 + k] * stretch[k * 3 + j];
      out[j * 4 + i] = sum;
    }
  out.set(translation, 12);
  out[15] = 1;
  return out;
}
const apply = (m, [x, y, z]) => [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
const unitAxis = (...a) => a.map((v) => v / Math.hypot(...a));

test('one bone: the encoded slot moves points exactly as its matrix, whatever the matrix', () => {
  const axis = unitAxis(1, 2, -3),
    bones = [
      bone([0, 0, 0], [0, 0, 1], 0),
      bone([1, -2, 3], axis, 37),
      bone([1, -2, 3], axis, 180),
      bone([0.5, 0, 0], [1, 0, 0], 179.9),
      bone([1, 2, 3], axis, 95, [2, 0, 0, 0, 2, 0, 0, 0, 2]), // uniform scale
      bone([1, 2, 3], axis, 95, [0.5, 0, 0, 0, 3, 0, 0, 0, 1.5]), // axis scale
      bone([1, 2, 3], axis, 95, [1, 0.4, 0.2, 0.4, 2, -0.3, 0.2, -0.3, 1.2]), // stretch off the axes
      bone([1, 2, 3], axis, 95, [1, 0.5, 0, 0, 1, 0, 0, 0, 1]), // shear
      bone([1, 2, 3], axis, 95, [-1, 0, 0, 0, 1, 0, 0, 0, 1]), // mirrored
      bone([1, 2, 3], axis, 95, [-2, 0, 0, 0, -2, 0, 0, 0, -2]), // mirrored through a point
      bone([1, 2, 3], axis, 95, [1, 0, 0, 0, 1, 0, 0, 0, 0]), // flattened
      bone([1, 2, 3], axis, 95, [1, 0, 0, 0, 0, 0, 0, 0, 0]), // a line
      bone([1, 2, 3], axis, 95, [0, 0, 0, 0, 0, 0, 0, 0, 0]), // scaled to nothing: a common way to hide a part
    ];
  bones.forEach((m, b) => {
    const slot = encodeDualQuaternions(m.slice());
    assert.ok(Math.abs(Math.hypot(...slot.subarray(0, 4)) - 1) < 1e-6, `bone ${b} has a unit rotation`);
    for (const point of [[0, 0, 0], [1, 0, 0], [0.3, -2, 5], [-4, 1, 1]])
      near(skinDualQuaternion(slot, [0], [1], point).position, apply(m, point), 2e-5, `bone ${b} at ${point}`);
  });
});

test('the normal of a stretched or mirrored bone matches the inverse transpose', () => {
  const m = bone([0, 0, 0], unitAxis(1, 1, 0), 40, [2, 0, 0, 0, 0.5, 0, 0, 0, 1]),
    n = [0.6, 0.8, 0],
    // Inverse transpose of a rotation times a stretch: the rotation of the stretch's inverse.
    expected = apply(bone([0, 0, 0], unitAxis(1, 1, 0), 40, [0.5, 0, 0, 0, 2, 0, 0, 0, 1]), n),
    size = Math.hypot(...expected);
  near(
    skinDualQuaternion(encodeDualQuaternions(m.slice()), [0], [1], [0, 0, 0], n).normal,
    expected.map((v) => v / size),
    1e-5,
  );
  const mirrored = encodeDualQuaternions(bone([0, 0, 0], [0, 0, 1], 0, [-1, 0, 0, 0, 1, 0, 0, 0, 1]));
  near(skinDualQuaternion(mirrored, [0], [1], [0, 0, 0], [1, 0, 0]).normal, [-1, 0, 0], 1e-6, 'a mirror turns it over');
});

test('a twist keeps its volume where blended matrices collapse', () => {
  // Candy wrapper: a point on a unit tube, halfway between two bones turned 170 degrees apart about the tube.
  const twisted = bone([0, 0, 0], [1, 0, 0], 170),
    palette = new Float32Array(32);
  palette.set(bone([0, 0, 0], [1, 0, 0], 0), 0);
  palette.set(twisted, 16);
  const linear = [0, 1, 0].map((v, i) => 0.5 * v + 0.5 * apply(twisted, [0, 1, 0])[i]),
    slots = encodeDualQuaternions(palette.slice()),
    { position } = skinDualQuaternion(slots, [0, 1], [0.5, 0.5], [0, 1, 0]);
  assert.ok(Math.hypot(linear[1], linear[2]) < 0.1, 'the linear blend pinches to the axis');
  assert.ok(Math.abs(Math.hypot(position[1], position[2]) - 1) < 1e-5, 'the radius holds');
  // It turned half way, 85 degrees, the short way round.
  near(position, apply(bone([0, 0, 0], [1, 0, 0], 85), [0, 1, 0]), 1e-5);
});

test('a bone and its antipode blend the same; the sign follows the heaviest influence, not the first', () => {
  const a = bone([0, 0, 0], [0, 0, 1], 10),
    b = bone([1, 0, 0], [0, 0, 1], 50),
    slots = new Float32Array(48);
  slots.set(encodeDualQuaternions(a.slice()), 0);
  slots.set(encodeDualQuaternions(b.slice()), 16);
  const flipped = slots.slice();
  for (let i = 16; i < 24; i++) flipped[i] = -flipped[i];
  const point = [0.4, 0.2, 0.1],
    even = skinDualQuaternion(slots, [0, 1], [0.3, 0.7], point).position;
  near(skinDualQuaternion(flipped, [0, 1], [0.3, 0.7], point).position, even, 1e-6, 'q and -q are one rotation');
  // An idle first influence square to the rest must not choose their signs: glTF fills spare slots with joint 0.
  slots.set(encodeDualQuaternions(bone([0, 0, 0], [1, 0, 0], 180)), 32);
  const idle = [2, 0, 1],
    weights = [0, 0.3, 0.7];
  near(skinDualQuaternion(slots, idle, weights, point).position, even, 1e-6);
  const twin = slots.slice();
  for (let i = 16; i < 24; i++) twin[i] = -twin[i];
  near(skinDualQuaternion(twin, idle, weights, point).position, even, 1e-6);
});

test('blended stretch: two equally scaled bones keep the scale', () => {
  const scale = [2, 0, 0, 0, 2, 0, 0, 0, 2],
    a = bone([0, 0, 0], [0, 0, 1], 0, scale),
    b = bone([0, 0, 0], [0, 0, 1], 60, scale),
    slots = new Float32Array(32);
  slots.set(a, 0);
  slots.set(b, 16);
  encodeDualQuaternions(slots);
  near(
    skinDualQuaternion(slots, [0, 1], [0.5, 0.5], [1, 0, 0]).position,
    apply(bone([0, 0, 0], [0, 0, 1], 30, scale), [1, 0, 0]),
    1e-5,
  );
});

test('encodeDualQuaternions and skinDualQuaternion refuse bad input, naming the fix', () => {
  assert.throws(() => encodeDualQuaternions(new Float32Array(15)), /16 floats per bone/);
  assert.throws(() => encodeDualQuaternions(new Float32Array(16), new Float32Array(8)), /16 floats per bone/);
  assert.throws(() => skinDualQuaternion(new Float32Array(16), [0, 1], [1], [0, 0, 0]), /as many joints as weights/);
  const palette = bone([1, 0, 0], [0, 0, 1], 30),
    out = new Float32Array(16);
  assert.equal(encodeDualQuaternions(palette, out), out);
  assert.equal(palette[12], 1, 'a separate output leaves the palette as it was');
});

test('dualQuaternionSkinning is a shader of its own, four and eight influences, with linear left as it was', () => {
  for (const extra of [false, true]) {
    const code = dualQuaternionSkinning.shader(extra);
    assert.match(code, /fn rotated/);
    assert.equal(code.includes('jointsExtra'), extra);
    assert.doesNotMatch(code, /let skin=/, 'no blended matrix');
  }
});

/** A WebGPU-shaped engine, enough for Animation.setup to place a model and build its dispatches. */
async function gpuEngine(t) {
  const gpu = optionalGPU(),
    store = await TransformStore.create(64),
    e = new Engine(
      { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
      store,
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  t.after(() => {
    e.dispose();
    gpu.cleanup();
  });
  store.tick(false);
  return { e, gpu, store };
}

test('the skinning option reaches the shader and the bones, and models of both modes deform together', async (t) => {
  const { e, gpu, store } = await gpuEngine(t),
    device = gpu.engine.gpu,
    shaders = [],
    module = device.createShaderModule;
  device.createShaderModule = (d) => {
    shaders.push(d.code);
    return module.call(device, d);
  };
  const linear = model(e, skinnedStrip()),
    twisted = model(e, skinnedStrip());
  e.use(linear);
  e.use(twisted);
  const plain = Animation.attach(linear),
    dq = Animation.attach(twisted, { skinning: dualQuaternionSkinning });
  assert.equal(shaders.filter((code) => code.includes('fn rotated')).length, 1, 'one pipeline for the mode');
  assert.equal(dq['slots'][0].mode, dualQuaternionSkinning);
  assert.equal(plain['slots'][0].mode, undefined);
  plain.playing = dq.playing = false;
  plain.seek(0.5);
  dq.seek(0.5);
  store.tick(false);
  const writes = [],
    writeBuffer = device.queue.writeBuffer;
  device.queue.writeBuffer = function (buffer, offset, data, ...rest) {
    writes.push({ offset, data: data.slice?.() });
    return writeBuffer.call(this, buffer, offset, data, ...rest);
  };
  t.after(() => {
    device.queue.writeBuffer = writeBuffer;
  });
  const context = { backend: 'webgpu', device, encoder: device.createCommandEncoder() };
  context.encoder.beginComputePass ??= () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} });
  dq['upload'](context);
  const palette = dq['resources'][0].palette;
  // Joint 1 turned 45 degrees about +Z: the slot's rotation, not a matrix.
  const q = palette.subarray(16, 20),
    h = (45 * Math.PI) / 360;
  near([...q].map(Math.abs), [0, 0, Math.sin(h), Math.cos(h)], 1e-5, 'slot rotation');
  assert.equal(palette[15], 0, 'not the 1 a matrix ends in');
  const arena = dq['arena'],
    dispatches = arena.dispatches([plain, dq], (owner) => owner['slots'], {
      owners: [],
      version: -1,
      dispatches: [],
    });
  assert.equal(dispatches.length, 2, 'one dispatch per mode');
  assert.notEqual(dispatches[0].pipeline, dispatches[1].pipeline);
});

test('an invalid skinning option names the entry to import', async () => {
  const strip = model(await engine(), skinnedStrip());
  for (const skinning of ['dual', {}, null])
    assert.throws(() => new Animation(strip, { skinning }), /dualQuaternionSkinning from @margoengine\/animation\/dqs/);
});
