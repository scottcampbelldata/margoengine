// shared/frame-resources: per-view uniform copies and deferred destroy, one state per GPU device on globalThis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { strictGPU } from './support/owned-command-recorder.js';
import { currentFrame, recording, retire, writeUniform } from '../packages/shared/frame-resources.js';

const left = { id: 'left' },
  right = { id: 'right' },
  third = { id: 'third' };
const frame = () => new Promise((resolve) => setTimeout(resolve, 0)); // a later task: the previous frame has closed
function lostDevice() {
  const gpu = strictGPU();
  let lose;
  gpu.device.lost = new Promise((resolve) => (lose = resolve));
  return { gpu, lose };
}

test('every copy of the module shares one state', async () => {
  const copy = await import('../packages/shared/frame-resources.js?copy');
  const { device } = strictGPU(),
    buffer = device.createBuffer({ size: 16 });
  copy.currentFrame(device, left);
  copy.currentFrame(device, right);
  retire(device, buffer);
  assert.equal(recording(device), true, 'a two-view frame recorded by another bundle is seen here');
  assert.equal(buffer.destroyed, false, 'and waits for that frame');
  await null;
  assert.equal(buffer.destroyed, true);
});

test('outside a multi-view frame or a draw, retire destroys at once, as a plain destroy', () => {
  const { device } = strictGPU(),
    idle = device.createBuffer({ size: 16 }),
    single = device.createBuffer({ size: 16 });
  retire(device, idle);
  assert.equal(idle.destroyed, true);
  currentFrame(device, left);
  retire(device, single);
  assert.equal(single.destroyed, true, 'a single-view frame keeps the plain behaviour');
});

test('two engines on two devices in one task keep separate frames and retirements', async () => {
  const a = strictGPU().device,
    b = strictGPU().device,
    uniformA = a.createBuffer({ size: 16 }),
    uniformB = b.createBuffer({ size: 16 });
  writeUniform(a, uniformA, new Float32Array([1, 0, 0, 0]), left);
  writeUniform(a, uniformA, new Float32Array([1, 0, 0, 0]), right);
  assert.equal(recording(a), true);
  assert.equal(recording(b), false, 'a frame on one device does not open the other');
  assert.equal(
    writeUniform(b, uniformB, new Float32Array([2, 0, 0, 0]), left),
    undefined,
    'first write of b this frame',
  );
  assert.ok(writeUniform(a, uniformA, new Float32Array([3, 0, 0, 0]), right), 'a second view on a takes a copy');
  retire(a, uniformA);
  assert.equal(uniformB.destroyed, false);
  await null;
  assert.equal(uniformA.destroyed, true);
  assert.equal(uniformB.destroyed, false, 'only its own resources are destroyed');
});

test('steady multi-view frames reuse their uniform copies', async () => {
  const gpu = strictGPU(),
    { device } = gpu,
    uniform = device.createBuffer({ size: 16 });
  const views = () =>
    [left, right, third].map((view, x) => writeUniform(device, uniform, new Float32Array([x, 0, 0, 0]), view)?.buffer);
  const first = views();
  await frame();
  const buffers = gpu.buffers.length,
    second = views();
  assert.deepEqual(second, first, 'the same copies serve the same views');
  assert.equal(gpu.buffers.length, buffers, 'no new buffers');
  retire(device, uniform);
  await null;
  assert.ok(
    [uniform, ...first.slice(1)].every((buffer) => buffer.destroyed),
    'copies are released with their buffer',
  );
});

test('a lost device drops its retirements and copies; the restored device is unaffected', async () => {
  const old = lostDevice(),
    restored = strictGPU().device,
    uniform = old.gpu.device.createBuffer({ size: 16 }),
    fresh = restored.createBuffer({ size: 16 });
  writeUniform(old.gpu.device, uniform, new Float32Array([1, 0, 0, 0]), left);
  writeUniform(old.gpu.device, uniform, new Float32Array([2, 0, 0, 0]), right);
  await frame();
  old.lose({ reason: 'unknown' });
  await old.gpu.device.lost;
  // Restoration releases the old resources and draws with new ones on the new device.
  retire(old.gpu.device, uniform);
  writeUniform(restored, fresh, new Float32Array(4), left);
  await frame();
  assert.equal(old.gpu.buffers.filter((buffer) => buffer.destroyed).length, 0, 'nothing of the lost device is touched');
  assert.equal(fresh.destroyed, false, "the new device's resources stay");
});

test('one view drawing several times in a frame writes its own buffer, as a plain writeBuffer would', () => {
  const gpu = strictGPU(),
    { device } = gpu,
    uniform = device.createBuffer({ size: 16 }),
    buffers = gpu.buffers.length;
  for (let x = 0; x < 3; x++)
    assert.equal(writeUniform(device, uniform, new Float32Array([x, 0, 0, 0]), left), undefined);
  assert.equal(gpu.buffers.length, buffers, 'no copies for a single view');
});
