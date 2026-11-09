// A refused decal list throws before anything changes: the previous decals and their upload stay as they were.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Decals } from '../dist/decals.js';
import { Camera } from '../../core/dist/extension.js';
import { SceneTarget } from '../../shared/msaa.js';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const base = { position: [0, 0, 0], direction: [0, -1, 0], width: 2, height: 1, up: [0, 0, -1] };
const overflow = (2 - 2 ** -24) * 2 ** 127; // rounds to Infinity as Float32
function rig() {
  const gpu = mockGPU(),
    view = context(gpu, { samples: 1, format: 'rgba16float', shader: 'lit shader' }),
    usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    texture = (format) => gpu.device.createTexture({ size: [128, 96], format, usage }),
    target = new SceneTarget(gpu.device, texture('rgba16float'), texture('depth24plus-stencil8'), 1),
    effect = new Decals(),
    run = passes(effect);
  effect.setup({ gpu: gpu.device, sceneOf: () => undefined, removePlugin() {} });
  let n = 0;
  const frame = () =>
    gpu.record(() => {
      view.begin(n++);
      target.begin(view.c);
      view.c.camera = new Camera({ position: [0, 3, 4], target: [0, 0, 0] });
      view.c.camera.update(4 / 3, true);
      run(view.c);
    });
  return { gpu, effect, frame };
}
const hole = (array, lane) => {
  const copy = array.slice();
  delete copy[lane];
  return copy;
};
// The upload of two decals' storage: 96 B each, logged as hex.
const storage = (e) => e[0] === 'writeBuffer' && e[3].length === 2 * 96 * 2;
const sparse = (length, ...entries) => Object.assign(new Array(length), entries);

test('an invalid entry or a hole refuses the whole list and keeps the current decals', () => {
  const lists = [
    [base, null],
    [base, 'decal'],
    sparse(2, base),
    [base, , base],
    [base, { ...base, position: hole(base.position, 1) }],
    [base, { ...base, rect: hole([0, 0, 1, 1], 3) }],
    [base, { ...base, color: [0, -1, 0] }],
    [base, { ...base, direction: [0, -Infinity, 0] }],
  ];
  const errors = [
    [base, { ...base, position: [overflow, 0, 0] }],
    [base, { ...base, width: 1e100 }],
    [base, { ...base, color: [0, 1e100, 0] }],
  ];
  const r = rig();
  r.effect.setDecals([base, { ...base, mode: 'over' }]);
  assert.ok(r.frame().some(storage));
  for (const [list, error] of [...lists.map((l) => [l, RangeError]), ...errors.map((l) => [l, TypeError])]) {
    const log = r.gpu.record(() => assert.throws(() => r.effect.setDecals(list), error));
    assert.deepEqual(log, [], 'nothing created or uploaded');
    assert.equal(r.effect.count, 2);
    const next = r.frame();
    assert.equal(next.some(storage), false, 'no new decal upload');
    assert.equal(next.filter((e) => e[0] === 'pass.draw').length, 2, 'previous decals still draw');
  }
  r.effect.dispose();
});

test('large direction and up vectors normalise, HDR colour is kept, and [] clears', () => {
  const r = rig();
  r.effect.setDecals([{ ...base, direction: [0, -1e100, 0], up: [0, 0, -1e100], color: [2, 1, 0.5] }]);
  const upload = r.frame().find((e) => e[0] === 'writeBuffer' && e[3].length === 96 * 2);
  const bytes = Buffer.from(upload[3], 'hex'),
    values = new Float32Array(bytes.buffer, bytes.byteOffset, 24);
  assert.ok(values.every(Number.isFinite));
  assert.equal(values[20], 2);
  assert.equal(r.effect.setDecals([]).count, 0);
  assert.deepEqual(r.frame(), []);
  r.effect.dispose();
});
