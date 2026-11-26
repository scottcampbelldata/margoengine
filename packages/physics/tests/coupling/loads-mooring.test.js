import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { TautMooringSolver } from '../../dist/loads.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();
const zero = [0, 0, 0];

function close(actual, expected, bound, label) {
  assert.ok(Math.abs(actual - expected) <= bound, `${label}: ${actual} vs ${expected} ± ${bound}`);
}

function make({
  rate = { num: 60, den: 1 },
  level = 0,
  span = 12,
  speed = 1.5,
  fixed = true,
  point = zero,
  rotation,
  axialRigidity = 24000,
} = {}) {
  const physics = new Physics(null, { gravity: zero, fixedTimestep: 1 / (60 * (1 << level)) });
  const anchor = physics.addBody(null, {
    type: fixed ? 'fixed' : 'dynamic',
    position: [0, -3, 0],
    rotation,
    colliders: fixed ? [] : { shape: 'box', halfExtents: [0.5, 0.5, 0.5], mass: 100 },
  });
  const float = physics.addBody(null, {
    position: [span, -3, 0],
    rotation,
    linearVelocity: [speed, 0, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], mass: 200 },
  });
  const mooring = new TautMooringSolver();
  const world = new PhysicsWorld({ rate, gravity: zero })
    .add(new RigidSolver(), { physics })
    .add(mooring, {
      rate: level,
      lines: [
        {
          length: 12,
          axialRigidity,
          anchor: { row: anchor.row, point },
          fairlead: { row: float.row, point },
        },
      ],
    })
    .couple(['tautMooring', 'rigid'], 'staggered');
  return { anchor, float, mooring, world };
}

test('a fixed pile holds the tension-only line with the axial oscillator peak and releases the load when slack', () => {
  const omega = Math.sqrt(24000 / 12 / 200);
  // E = m v² / 2 = k x² / 2 at first maximum; the ideal tension is v sqrt(k m).
  const truePeak = 1.5 * Math.sqrt((24000 / 12) * 200);
  function peakAt(level) {
    const hz = 60 * (1 << level);
    const model = make({ level, rate: { num: hz, den: 1 } });
    const { anchor, float, mooring, world } = model;
    let peak = 0;
    let energy = (200 * 1.5 * 1.5) / 2;
    let peakFrame = 0;
    for (let frame = 1; frame <= hz * 2; frame++) {
      world.advance(frame);
      const load = mooring.readLine(0);
      assert.ok(load.tension >= 0);
      assert.deepEqual(load.anchorForce, [load.tension, 0, 0]);
      assert.deepEqual(anchor.position, [0, -3, 0], 'pile stays attached to the bed');
      if (load.tension > peak) {
        peak = load.tension;
        peakFrame = frame;
      }
      const x = Math.max(0, float.position[0] - 12);
      const v = float.linearVelocity[0];
      const next = (200 * v * v + (24000 / 12) * x * x) / 2;
      // The exact axial scheme is passive. The kernel rounds pose and velocity to f32.
      assert.ok(next <= energy + 0.001, `axial energy increased at frame ${frame}: ${energy} to ${next}`);
      energy = next;
    }
    assert.ok(float.position[0] < 12);
    assert.equal(mooring.readLine(0).tension, 0);
    const alpha = omega / hz;
    const angle = Math.atan(alpha);
    const decay = 1 / Math.sqrt(1 + alpha * alpha);
    const quarter = Math.round(Math.PI / (2 * angle));
    // Backward Euler is a contraction by decay and a rotation by angle each step. The sample nearest the quarter
    // cycle gives the lower bound. At 240 Hz the first peak is at about 120 steps, each rounding the pose by at most
    // 0.48 µm near 12 m. Even a coherent pose error of 58 µm produces less than 0.12 N of tension error.
    const lower = truePeak * decay ** quarter * Math.cos(angle / 2);
    assert.ok(peak >= lower - 0.15 && peak <= truePeak + 0.15, `peak ${peak} outside [${lower}, ${truePeak}]`);
    assert.ok(peakFrame > quarter * 0.9 && peakFrame <= quarter + 1);
    return peak;
  }
  assert.ok(peakAt(2) > peakAt(0), 'refining from 60 to 240 Hz reduces the numerical energy loss');
});

test('a slack mooring has no force under approach and remains stable at high taut stiffness', () => {
  const slack = make({ span: 11, speed: -1.5 });
  slack.world.advance(6);
  assert.deepEqual(slack.mooring.readLine(0), { tension: 0, anchorForce: zero });
  assert.equal(slack.float.linearVelocity[0], -1.5);
  const stiff = make({ axialRigidity: 2e12 });
  stiff.world.advance(1);
  const { tension } = stiff.mooring.readLine(0);
  assert.ok(tension > 0 && tension < 200 * 1.5 * 60, `finite inextensible-limit load: ${tension}`);
  assert.ok(stiff.float.linearVelocity[0] >= 0 && stiff.float.linearVelocity[0] < 0.00001);
  assert.throws(() => make({ axialRigidity: Infinity }), {
    name: 'MargoError',
    code: 'unsupported',
    message: /Choose a positive finite mooring length.+#hydrodynamic-loads/,
  });
  assert.throws(() => stiff.mooring.readLine(1), {
    code: 'unsupported',
    message: /Choose a line index.+#hydrodynamic-loads/,
  });
});

test('locally specified offset attachments exchange linear and angular impulses with the two real rigid bodies', () => {
  const s = Math.SQRT1_2;
  const model = make({ span: 12.25, fixed: false, point: [0.25, 0, 0], rotation: [0, 0, s, s] });
  const { anchor, float, mooring, world } = model;
  world.advance(1);
  const dt = 1 / 60;
  // The unit cubes have Iz=m/6, and the rotated point lies 0.25 m above each centre.
  const arm = 0.25;
  const inverseMass = (1 / 100 + 1 / 200) * (1 + 6 * arm * arm);
  const expected = (0.25 + dt * 1.5) / (12 / 24000 + dt * dt * inverseMass);
  close(mooring.readLine(0).tension, expected, 0.00001, 'implicit line reaction with both rotational lever arms');
  close(100 * anchor.linearVelocity[0], dt * expected, 0.00001, 'anchor momentum');
  close(200 * (1.5 - float.linearVelocity[0]), dt * expected, 0.00003, 'fairlead momentum');
  close((100 / 6) * anchor.angularVelocity[2], -arm * dt * expected, 0.00001, 'anchor angular momentum');
  close((200 / 6) * float.angularVelocity[2], arm * dt * expected, 0.00001, 'fairlead angular momentum');
});

test('the mooring replay reproduces the entire body and line states', () => {
  frameRateIndependent((rate) => make({ rate, span: 11.6, fixed: false }).world);
  // At frame two the line is still slack. Restoring it before engagement must preserve the later line load.
  seekEqualsContinuous(() => make({ rate: { num: 24, den: 1 }, span: 11.6, fixed: false }).world, {
    at: 2,
    frames: 16,
  });
});
