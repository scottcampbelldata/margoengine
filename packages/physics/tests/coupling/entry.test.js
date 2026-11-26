// Water entry's coupling checks (SEA-14): `EntrySolver` beside `RigidSolver`, held to the harness. A ball dropped in leaves
// the same state at 24, 30 and 60 frames a second, a seek equals a continuous run, and the effect runs both ways: a
// faster ball makes a different entry, and the water slows the ball.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { EntrySolver } from '../../dist/entry.js';
import { FORCE_WORDS, PhysicsWorld, regionWords, RigidSolver } from '../../dist/world.js';
import { effectBothWays, frameRateIndependent, seekEqualsContinuous } from './harness.js';
import { makeEntryLaunch } from './entry-launch.js';

await Physics.load();

/** A sphere of radius R as a UV mesh wound outward. */
function sphereMesh(R, nu = 24, nv = 12) {
  const vertices = [],
    indices = [];
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const th = (Math.PI * j) / nv,
        ph = (2 * Math.PI * i) / nu;
      vertices.push(R * Math.sin(th) * Math.cos(ph), R * Math.cos(th), R * Math.sin(th) * Math.sin(ph));
    }
  const at = (i, j) => j * (nu + 1) + i;
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      if (j > 0) indices.push(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      if (j < nv - 1) indices.push(at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  return { vertices, indices };
}

const make = (rate = { num: 24, den: 1 }, { speed = 9, density = 1025 } = {}) => {
  const physics = new Physics(null, { fixedTimestep: 1 / 240, gravity: [0, -9.81, 0] }),
    R = 0.05,
    ball = physics.addBody(null, {
      position: [0, 0.3, 0],
      linearVelocity: [1, -speed, 0],
      colliders: { shape: 'sphere', radius: R, mass: 3 * 1025 * (4 / 3) * Math.PI * R ** 3 },
    }),
    entry = new EntrySolver(),
    world = new PhysicsWorld({ rate, gravity: [0, -9.81, 0] })
      .add(new RigidSolver(), { physics })
      .add(entry, { bodies: [{ row: ball.row, mesh: sphereMesh(R) }], sea: { elevation: () => 0, density }, level: 2 })
      .couple(['entry', 'rigid'], 'staggered');
  world.probe = { entry, ball };
  return world;
};

test('EntrySolver: the same entry at 24, 30 and 60 frames a second', () => frameRateIndependent(make, { seconds: 1 }));
test('EntrySolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
test('EntrySolver: a faster ball makes a different entry, and denser water slows the ball more', () =>
  effectBothWays(
    // Side 0 pushes the ball (faster), side 1 the water (denser); -1 is neither.
    (side) => make({ num: 24, den: 1 }, side === 0 ? { speed: 12 } : side === 1 ? { density: 1400 } : {}),
    (world, side) =>
      side === 0
        ? JSON.stringify(world.probe.entry.splashes().map((e) => e.speed.toFixed(6)))
        : world.probe.ball.linearVelocity[1],
  ));

test('EntrySolver observes a launching HullSolver hull without duplicating loads or wake displacement', async (context) => {
  await Physics.load({ threads: true });
  const frameCount = 32;

  function launch(observed, shared) {
    const { world, physics, vessel, probe, wake, entry } = makeEntryLaunch({
      observed,
      probeMesh: sphereMesh(0.05),
      shared,
    });
    using _cleanup = physics;
    world.advance(3);
    const snapshot = world.takeSnapshot();
    const trace = [];
    let loadsOnProbe = false;
    let cavity = false;
    for (let frame = 4; frame <= frameCount; frame++) {
      world.advance(frame);
      const values = regionWords(world.arena.memory, entry.exportPorts(frame)[0].region);
      const at = vessel.row * FORCE_WORDS;
      assert.ok(
        values.subarray(at, at + FORCE_WORDS).every((load) => load === 0),
        'the hull row has no second force',
      );
      loadsOnProbe ||= values[probe.row * FORCE_WORDS + 1] !== 0;
      if (observed) cavity ||= entry.bodyState(vessel.row).cavity;
      trace.push({
        motion: [
          ...vessel.position,
          ...vessel.rotation,
          ...vessel.linearVelocity,
          ...vessel.angularVelocity,
          ...probe.position,
          ...probe.rotation,
          ...probe.linearVelocity,
          ...probe.angularVelocity,
        ],
        wave: wake.sample(0.2, 0.5).height,
        entrySources: entry.seaSources(),
      });
    }
    assert.ok(loadsOnProbe, 'the same solver still loads a non-observer body');
    const wakeState = wake.stateRegions().map((region) => regionWords(world.arena.memory, region).slice());
    const events = entry.splashes();
    const hash = world.hash();
    world.restoreSnapshot(snapshot.bytes);
    world.advance(frameCount);
    assert.equal(world.hash(), hash);
    assert.deepEqual(entry.splashes(), events);
    return { trace, observedEvents: events.filter((event) => event.row === vessel.row), cavity, hash, wakeState };
  }

  const bare = launch(false, false);
  const observed = launch(true, false);
  assert.deepEqual(launch(true, true), observed);
  assert.deepEqual(observed.wakeState, bare.wakeState);
  for (let frame = 0; frame < bare.trace.length; frame++) assert.deepEqual(observed.trace[frame], bare.trace[frame]);
  const entry = observed.observedEvents.find((event) => event.kind === 'entry');
  assert.ok(entry?.cavity && entry.crownHeight > 0 && observed.cavity);
  const peak = Math.max(...observed.trace.map(({ wave }) => Math.abs(wave)));
  assert.ok(peak > 0.001, 'the HullSolver still sends a resolved wave');
  context.diagnostic(JSON.stringify({ entryTime: entry.time, crownHeight: entry.crownHeight, peak }));
});

test('an open launch cavity changes the live hull force once and returns to water pressure after seal', async (context) => {
  await Physics.load({ threads: true });
  function launch(pressure, shared) {
    const { world, physics, vessel, hull, entry } = makeEntryLaunch({ pressure, shared, mass: 60 });
    using _cleanup = physics;
    world.advance(3);
    const snapshot = world.takeSnapshot();
    const trace = [];
    for (let frame = 4; frame <= 32; frame++) {
      world.advance(frame);
      const [entryForce, air] = entry.exportPorts(frame - 1);
      const state = (port) => regionWords(world.arena.memory, port.region);
      const at = vessel.row * FORCE_WORDS;
      const load = state(hull.exportPorts(frame - 1)[0]).slice(at, at + FORCE_WORDS);
      const cavity = entry.bodyState(vessel.row).cavity;
      assert.ok(state(entryForce).every((value) => value === 0));
      assert.deepEqual(entry.seaSources(), []);
      if (air) {
        assert.equal(state(air)[4 * vessel.row], Number(cavity));
        const direction = state(air).subarray(4 * vessel.row + 1, 4 * vessel.row + 4);
        assert.ok(Math.abs(Math.hypot(...direction) - Number(cavity)) < 1e-12);
      }
      trace.push({ cavity, load, speed: vessel.linearVelocity[1] });
    }
    const hash = world.hash();
    const seal = entry.splashes().find((event) => event.kind === 'seal');
    world.restoreSnapshot(snapshot.bytes);
    world.advance(32);
    assert.equal(world.hash(), hash);
    return { trace, seal, hash };
  }

  const reference = launch(false, false);
  const coupled = launch(true, false);
  assert.deepEqual(launch(true, true), coupled);
  const opening = coupled.trace.findIndex(({ cavity, load }, frame) =>
    cavity && Math.abs(load[1] - reference.trace[frame].load[1]) > 0.01);
  assert.ok(opening >= 0, 'the published cavity changes the hull water load');
  assert.deepEqual(coupled.trace.slice(0, opening), reference.trace.slice(0, opening));
  const forceChange = coupled.trace[opening].load[1] - reference.trace[opening].load[1];
  assert.ok(Math.abs(coupled.trace[opening].speed - reference.trace[opening].speed) > 1e-4);
  assert.ok(coupled.seal);
  const sealFrame = Math.round(coupled.seal.time * 60 + 0.5);
  assert.equal(coupled.trace[sealFrame - 5].cavity, true);
  assert.equal(coupled.trace[sealFrame - 4].cavity, false);
  assert.ok(!coupled.trace.at(-1).cavity);
  context.diagnostic(JSON.stringify({ forceChange, opening: opening + 4, sealTime: coupled.seal.time }));
});
