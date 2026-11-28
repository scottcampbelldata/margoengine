import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SwimSolver, swimPropulsion } from '@margoengine/physics/life';
import { PhysicsWorld } from '@margoengine/physics/world';

test('LIFE-03 default feedback limits reach the published fast-envelope root at three body lengths', async () => {
  const swimmer = await SwimSolver.load();
  const lengths = [0.12, 0.4, 12];
  const bodies = [...lengths, lengths[0]].map((length, row) => ({
    position: [row * 10, -30, 0],
    length,
    width: 0.18 * length,
    height: 0.15 * length,
    mass: 12 * length ** 3,
    tail: { amplitude: 0.1 * length, span: 0.2 * length, wavelength: length },
    target: { velocity: [0, 0, 120], relativeToWater: true },
    ...(row === lengths.length ? { maximumFrequency: 2 } : {}),
  }));
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, 0, 0] }).add(swimmer, { bodies });
  world.advance(1);
  const actual = lengths.map((length, row) => {
    const { frequency } = swimmer.read(row);
    const ratio = frequency / 22;
    const inferred = (1 - ratio) / (1 + 4 * ratio) / ratio ** 2;
    const independentlyExpected = (length / 0.4) ** 2;
    assert.ok(Math.abs(inferred - independentlyExpected) <= 128 * Number.EPSILON * independentlyExpected);
    return frequency;
  });
  assert(actual[0] > actual[1] && actual[1] > actual[2]);
  assert(actual[0] > 3 && actual[2] < 3);
  assert.equal(swimmer.read(3).frequency, 2);
});

test('LIFE-03 unrepresentable propulsion leaves a reused result intact and zero water is force free', () => {
  const usual = { amplitude: 0.1, span: 0.2, wavelength: 0.9 };
  const out = swimPropulsion(usual, 2, 1);
  const previous = { ...out };
  const huge = { ...usual, amplitude: 1e120, span: 1e120 };
  assert.throws(() => swimPropulsion(huge, 2, 1, 1000, out), {
    name: 'MargoError',
    code: 'state',
    message: /exceeds finite SI units.*reduce amplitude/i,
  });
  assert.deepEqual(out, previous);
  assert.deepEqual(swimPropulsion(huge, 2, 0, 0, out), {
    thrust: 0,
    power: 0,
    efficiency: 0,
    strouhal: Infinity,
  });
});

test('LIFE-03 malformed control is coded and does not change the accepted command', async () => {
  const swimmer = await SwimSolver.load();
  const world = new PhysicsWorld().add(swimmer, {
    bodies: [
      {
        position: [0, -2, 0],
        mass: 1,
        length: 0.5,
        width: 0.1,
        height: 0.08,
        tail: { amplitude: 0.03, span: 0.1, wavelength: 0.35 },
        frequency: 2,
      },
    ],
  });
  world.advance(1);
  const prior = world.takeSnapshot();
  assert.throws(() => swimmer.setControl(0, { effort: 0.2, buoyancy: 0.9, target: 2 }), {
    name: 'MargoError',
    code: 'state',
    message: /pass a target position or velocity vector/i,
  });
  assert.deepEqual(world.takeSnapshot().bytes, prior.bytes);
});
