import assert from 'node:assert/strict';
import test from 'node:test';
import { modalFractureImpulse, modalPreset, ModalSoundSolver } from '@margoengine/physics/modal-sound';
import { PhysicsWorld } from '../dist/world.js';

const FPS = { num: 60, den: 1 };
const mode = { frequency: 400, decay: 25, gain: 0.2 };
const oneMode = [{ material: { modes: [mode] } }];
const peak = (values) => values.reduce((a, v) => Math.max(a, Math.abs(v)), 0);

test('ModalSoundSolver verifies bounds, optional inputs, channel isolation and owning copies', async () => {
  const sound = await ModalSoundSolver.load({ inputs: 'none' });
  const world = new PhysicsWorld({ rate: FPS }).add(sound, { tracks: [{}, { material: 'bell' }] });
  world.advance(1);
  assert.equal(peak(sound.copyBlock().samples), 0);
  assert.equal(peak(sound.copyBlock(1).samples), 0);
  const copied = sound.copyBlock(1);
  copied.samples[0] = 1;
  assert.equal(sound.copyBlock(1).samples[0], 0);
  assert.throws(() => sound.copyBlock(2), /index/);
  assert.throws(() => modalPreset('stone'), /preset/);
  assert.throws(() => modalFractureImpulse(-1, 2), /released energy/);
  assert.equal(modalFractureImpulse(4, 3, 0.375), 3);
  const invalid = await ModalSoundSolver.load();
  assert.throws(() => new PhysicsWorld().add(invalid, { tracks: oneMode, sampleRate: 499 }), /sampleRate/);
  assert.throws(
    () =>
      new PhysicsWorld().add(invalid, {
        tracks: [{ material: { modes: [{ ...mode, frequency: 3800 }] } }],
        sampleRate: 8000,
      }),
    /mode frequency/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(ModalSoundSolver.load({ signal: controller.signal }), (err) => err.name === 'AbortError');
});

test('modal material presets are independently customizable', () => {
  const changed = modalPreset('bell');
  changed.modes[0].gain = 0.6;
  const original = modalPreset('bell');
  assert.notEqual(original.modes[0].gain, changed.modes[0].gain);
  assert.equal(original.modes[1].frequency, 440);
  assert.equal(modalFractureImpulse(4, 3, 0), 0);
  assert.throws(() => modalFractureImpulse(4, 3, 1.01), /energy fraction/);
});
