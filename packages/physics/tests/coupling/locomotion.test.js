import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerrainBed } from '@margoengine/physics/earth';
import {
  GROUND_CONTACT_FIELD,
  GROUND_LOCOMOTION_LAYOUT,
  GROUND_POSE_FIELD,
  GroundLocomotion,
} from '@margoengine/physics/locomotion';
import { PhysicsWorld } from '@margoengine/physics/world';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const bedShape = { width: 4, depth: 4, columns: 8, rows: 8, centre: [0, 0] };
const fps60 = { num: 60, den: 1 };
const close = (actual, expected, error = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= error, actual + ' vs ' + expected);

test('the real TerrainBed field changes the load and published pose at the same physical origin', async () => {
  const cellSize = 32;
  const cell = [2, 3, -1];
  const shape = { ...bedShape, centre: [cell[0] * cellSize, cell[2] * cellSize] };
  const options = { bedShape: shape, cellSize };
  const bodies = [
    {
      kind: 'snake',
      position: [0, 0.2, 0],
      mass: 1,
      radius: 0.1,
      length: 1,
      links: 1,
      stiffness: 25,
      damping: 0,
      frequency: 0,
      bend: 0,
      friction: 0,
      reverseFriction: 0,
      lateralFriction: 0,
    },
  ];
  const [raised, missing] = await Promise.all([GroundLocomotion.load(options), GroundLocomotion.load(options)]);
  const world = new PhysicsWorld({ rate: fps60, gravity: [0, 0, 0], cellSize })
    .add(new TerrainBed(), { ...shape, elevations: () => 0.125 }, [0, cell[1], 0])
    .add(raised, { bodies, originCell: cell }, cell);
  const flat = new PhysicsWorld({ rate: fps60, gravity: [0, 0, 0], cellSize })
    .add(new TerrainBed(), { ...shape, elevations: () => 0 }, [0, cell[1], 0])
    .add(missing, { bodies, originCell: cell }, cell);
  world.advance(1);
  flat.advance(1);
  const expected = 25 * (0.1 - (0.2 - 0.125));
  close(raised.readContact(0, 0).force[1], expected);
  close(raised.read(0).velocity[1], expected / 60);
  assert.deepEqual(missing.read(0).velocity, [0, 0, 0]);
  const pose = world.fields.port(GROUND_POSE_FIELD.name);
  const contact = world.fields.port(GROUND_CONTACT_FIELD.name);
  assert.deepEqual(pose.cell, cell);
  assert.equal(pose.region.layout, GROUND_LOCOMOTION_LAYOUT);
  assert.equal(contact.region.layout, GROUND_LOCOMOTION_LAYOUT);
  assert.equal(pose.region.byteLength, 14 * 8);
  assert.equal(contact.region.byteLength, 13 * 8);
  close(new Float64Array(world.memory.buffer, contact.region.byteOffset, 13)[7], expected);
});

test('published samples follow the same sloped triangle as the real TerrainBed', async () => {
  const locomotion = await GroundLocomotion.load({ bedShape });
  const world = new PhysicsWorld({ rate: fps60, gravity: [0, 0, 0] })
    .add(new TerrainBed(), { ...bedShape, elevations: (x) => 0.25 * x })
    .add(locomotion, {
      bodies: [
        {
          kind: 'snake',
          position: [0, 0.075, 0],
          mass: 1,
          length: 1,
          links: 1,
          radius: 0.1,
          stiffness: 25,
          damping: 0,
          frequency: 0,
          bend: 0,
        },
      ],
    });
  world.advance(1);
  const f = locomotion.readContact(0, 0).force;
  const hyp = Math.hypot(1, 0.25);
  const reaction = 25 * (0.1 - 0.075 / hyp);
  close(f[0], (-0.25 * reaction) / hyp);
  close(f[1], reaction / hyp);
  close(f[2], 0);
});

test('coupled feet, body phase and contacts agree after restore and across display frame rates', async () => {
  const groups = await Promise.all(Array.from({ length: 5 }, () => GroundLocomotion.load({ bedShape })));
  let next = 0;
  const make = (rate = { num: 24, den: 1 }) =>
    new PhysicsWorld({ rate })
      .add(new TerrainBed(), { ...bedShape, elevations: (x, z) => 0.01 * x + 0.005 * z })
      .add(groups[next++], { bodies: [{ kind: 'snake' }, { kind: 'crab' }] });
  frameRateIndependent(make);
  seekEqualsContinuous(make);
});
