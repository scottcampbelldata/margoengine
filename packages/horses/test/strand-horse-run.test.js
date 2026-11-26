// addStrandHorse run whole on the CPU: the native strand solver steps with the gait, poses the tail, mane and forelock
// joints, replays a film time exactly and takes its wind. strand-horse.browser.mjs is the GPU picture.
import assert from 'node:assert/strict';
import test from 'node:test';
import { rotateByQuaternion, multiplyQuaternions, normalizeQuaternion } from '../../math/dist/quat.js';
import { horseJointTranslation } from '../dist/model.js';
import { addStrandHorse } from '../dist/strands.js';

async function cpuEngine() {
  const { Engine, TransformStore } = await import('../../core/dist/extension.js');
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(4096),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
  );
  // The model and skinning draws need WebGPU; here they are only recorded, so the solver, gait and pose run on the CPU.
  engine.use = () => engine;
  return engine;
}

const distance = (a, b) => Math.hypot(...a.map((x, k) => x - b[k]));

/** Where the horse's current pose puts `joint` in the world. */
function posed(horse, joint) {
  const { skeleton, pose } = horse,
    { position, heading } = horse.frame(),
    solved = [];
  for (const [i, { parent }] of skeleton.joints.entries()) {
    const root = { position, rotation: [0, Math.sin(heading / 2), 0, Math.cos(heading / 2)] },
      from = solved[parent] ?? root,
      offset = rotateByQuaternion(horseJointTranslation(skeleton, pose, i), from.rotation);
    solved.push({
      position: from.position.map((x, k) => x + offset[k]),
      rotation: normalizeQuaternion(multiplyQuaternions(from.rotation, pose.rotations[i])),
    });
  }
  return solved[joint].position;
}

async function ride(engine, strands) {
  const horse = await addStrandHorse(engine, { detail: 0, coatHair: false, maneHair: false, strands });
  const chains = horse.skeleton.strandChains,
    tip = () => [...horse.strandSolver.sample(0, chains[0].length - 1).position],
    start = tip(),
    startHash = horse.strandWorld.hash();
  horse.speed = 4;
  horse.gait = 'trot';
  for (let i = 0; i < 30; i++) horse.advanceTime(1 / 30);
  return { horse, chains, tip, start, startHash };
}

test('addStrandHorse steps its strands with the gait, poses the strand joints and replays a film time', async () => {
  const engine = await cpuEngine(),
    { horse, chains, tip, start, startHash } = await ride(engine);
  try {
    assert.equal(chains.length, 11);
    const end = tip(),
      hash = horse.strandWorld.hash();
    assert.notEqual(hash, startHash);
    assert.ok(distance(start, end) > 1, `the tail travels with the horse: ${distance(start, end)} m`);
    // The pose puts the tail, a mane lock and the forelock where the solver has them.
    for (const guide of [0, 4, 9]) {
      const index = chains[guide].length - 1,
        joint = posed(horse, chains[guide][index]),
        sample = horse.strandSolver.sample(guide, index).position;
      assert.ok(distance(joint, [...sample]) < 1e-5, `guide ${guide}: ${joint} against ${[...sample]}`);
    }
    horse.seek(0.25);
    assert.notEqual(horse.strandWorld.hash(), hash);
    horse.seek(1);
    assert.equal(horse.strandWorld.hash(), hash, 'the same film time is the same physics');
    assert.deepEqual(tip(), end);
  } finally {
    horse.dispose();
    engine.dispose();
  }
});

test('addStrandHorse passes the shared wind to the guides', async () => {
  const engine = await cpuEngine(),
    still = await ride(engine),
    calm = still.tip();
  still.horse.dispose();
  const wind = {
    medium: 'air',
    cell: [0, 0, 0],
    sample: (x, y, z, t, out = { velocity: [0, 0, 0] }) => {
      out.velocity[0] = 20;
      out.velocity[1] = out.velocity[2] = 0;
      out.density = 1.225;
      out.temperature = 288.15;
      return out;
    },
  };
  const windy = await ride(engine, { wind });
  try {
    assert.ok(windy.tip()[0] - calm[0] > 0.02, `a 20 m/s side wind moves the tail: ${windy.tip()} against ${calm}`);
  } finally {
    windy.horse.dispose();
    engine.dispose();
  }
});

test('addStrandHorse stops at an aborted signal before it loads or builds anything', async () => {
  const engine = new Proxy({}, { get: () => assert.fail('the engine must not be touched after an abort') }),
    reason = new Error('stop');
  await assert.rejects(addStrandHorse(engine, { signal: AbortSignal.abort(reason) }), reason);
});
