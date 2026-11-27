// The planing solver's coupling checks (SEA-09): `PlaningSolver` holding a prismatic planing model through `bodyForces` as
// it runs on its thrust, held to the harness: the same run at 24, 30 and 60 frames a second, a seek equal to a continuous
// run, and the body answering the bottom's forces (its trim and rise) while the solver reads the body's attitude back.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { PlaningSolver } from '../../dist/ship.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();

const B = 0.2286,
  L = 5 * B,
  beta = (20 * Math.PI) / 180,
  mass = 0.608 * 999 * B ** 3,
  lcg = 0.35 * L,
  vcg = (B / 4) * Math.tan(beta);

const make = (rate = { num: 24, den: 1 }, thrust = 0.12 * mass * 9.81) => {
  const t0 = (4 * Math.PI) / 180,
    physics = new Physics(null, { fixedTimestep: 1 / 480, gravity: [0, -9.81, 0] }),
    body = physics.addBody(null, {
      position: [0, -0.03 + lcg * Math.sin(t0) + vcg * Math.cos(t0), 0],
      rotation: [0, 0, Math.sin(t0 / 2), Math.cos(t0 / 2)],
      linearVelocity: [4, 0, 0],
      colliders: { shape: 'box', halfExtents: [0.433 * L, 0.02, B / 2], mass },
    }),
    planing = new PlaningSolver(),
    world = new PhysicsWorld({ rate, gravity: [0, -9.81, 0] })
      .add(new RigidSolver(), { physics })
      .add(planing, {
        boats: [{ row: body.row, beam: B, deadrise: beta, length: L, transom: [-lcg, -vcg, 0], propeller: [0, 0, 0] }],
        density: 999,
        level: 3,
      })
      .couple(['planing', 'rigid'], 'staggered');
  planing.control(0).thrust = thrust;
  return Object.assign(world, { planing, body });
};

test('PlaningSolver: the same run at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('PlaningSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
test('PlaningSolver: the bottom lifts and trims the body, and the body’s attitude sets the bottom’s forces', () => {
  const world = make({ num: 60, den: 1 }),
    sunk = make({ num: 60, den: 1 });
  for (let f = 1; f <= 60 * 5; f++) world.advance(f);
  const s = world.planing.status(0);
  // Planing: the bottom carries the weight (the body neither sinks nor flies), at a positive trim.
  assert.ok(
    !s.airborne && s.trim > 0 && Math.abs((s.normal * Math.cos(s.trim)) / (mass * 9.81) - 1) < 0.1,
    `${s.normal}`,
  );
  assert.ok(Math.abs(world.body.linearVelocity[1]) < 0.05);
  // More thrust, more speed, less trim: the body's attitude changes the bottom's forces.
  sunk.planing.control(0).thrust = 0.2 * mass * 9.81;
  for (let f = 1; f <= 60 * 5; f++) sunk.advance(f);
  assert.ok(sunk.planing.status(0).speed > s.speed && sunk.planing.status(0).trim !== s.trim);
});
