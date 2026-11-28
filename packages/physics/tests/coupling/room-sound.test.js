import assert from 'node:assert/strict';
import test from 'node:test';
import { RoomSoundSolver } from '../../dist/room-sound.js';
import { PhysicsWorld, regionWords } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const layout = {
  grid: { dimensions: [9, 1, 5], spacing: 2, reflection: 1 },
  source: [2, 0, 3],
  receiver: [6, 0, 3],
  speedOfSound: 60,
};

test('an air slot admits diffraction into the geometric shadow at exactly the shortest stencil route', async () => {
  for (const aperture of [false, true]) {
    const air = new Uint8Array(45).fill(1);
    for (let z = aperture ? 1 : 0; z < 5; z++) air[z * 9 + 4] = 0;
    const room = await RoomSoundSolver.load();
    const world = new PhysicsWorld({ rate }).add(room, {
      ...layout,
      grid: { ...layout.grid, air },
    });
    const path = [];
    for (let frame = 1; frame <= 20; frame++) {
      world.advance(frame);
      path.push(room.readTrace().values[0]);
      assert.equal(room.pressureAt([4, 0, 3]), 0, 'solid voxels never store wave pressure');
    }
    if (aperture) {
      assert.ok(
        path.slice(0, 10).every((p) => p === 0),
        'there is no pressure before the 10-link signal can arrive',
      );
      // Four shortest paths on each side of the aperture, ten links at lambda^2=1/4.
      assert.equal(path[10], 16 * 0.25 ** 10);
    } else assert.ok(path.every((p) => p === 0));
  }
});

test('higher wall absorption loses pressure energy in the same enclosed scene', async () => {
  const pressure = [1, -1, 1, -1, 1, -1];
  const make = async (reflection) => {
    const room = await RoomSoundSolver.load();
    const world = new PhysicsWorld({ rate }).add(room, {
      grid: { dimensions: [6, 1, 1], spacing: 2, reflection },
      source: [0, 0, 0],
      receiver: [1, 0, 0],
      speedOfSound: 60,
      initialPressure: pressure,
      impulse: 0,
    });
    return { room, world };
  };
  const [hard, absorb] = await Promise.all([make(1), make(0.25)]);
  const observed = [0, 0];
  for (let frame = 1; frame <= 60; frame++) {
    for (const [i, { room, world }] of [hard, absorb].entries()) {
      world.advance(frame);
      if (frame > 30) {
        const p = room.readTrace().values[0];
        observed[i] += p * p;
      }
    }
  }
  assert.ok(0 < observed[1] && observed[1] < observed[0], `absorbing ${observed[1]}, reflecting ${observed[0]}`);
});

test('a registry impulse drives the audibly delayed receiver and restores the exact wave state', async () => {
  const room = await RoomSoundSolver.load({ excitation: true });
  const field = room.excitationField;
  let host;
  let region;
  const emitter = {
    describe: () => ({ id: 'roomTestPulse', rate: 0, stableRate: () => 0, fields: [{ field, access: 'write' }] }),
    init(h) {
      host = h;
      region = h.allocate('wave-pulse', 8, 'f64', 1);
    },
    step({ tick }) {
      regionWords(host.memory, region)[0] = tick === 2 ? 1 : 0;
    },
    importPorts() {},
    exportPorts(tick) {
      return [{ field: field.name, region, tick, cell: host.cell }];
    },
    stateRegions: () => [region],
    extraState: () => [],
  };
  const world = new PhysicsWorld({ rate }).add(emitter, {}).add(room, layout);
  const cell = [-11, 4, -2];
  world.shiftOrigin([11, -4, 2]);
  world.advance(2);
  assert.equal(room.readTrace().values[0], 0);
  const saved = world.takeSnapshot();
  world.advance(12);
  assert.notEqual(room.readTrace().values[0], 0);
  const hash = world.hash();
  world.restoreSnapshot(saved.bytes);
  world.advance(12);
  assert.equal(world.hash(), hash);
  const port = world.fields.port(room.traceField.name);
  assert.deepEqual(port.cell, cell);
  assert.deepEqual(world.fields.port(room.pressureField.name).cell, cell);
  assert.deepEqual(regionWords(world.memory, port.region), room.readTrace().values);
  const accepted = world.takeSnapshot();
  const displacement = { ...world.fields.port(field.name), cell: [0, 0, 0] };
  const wrongCell = { tick: 12, level: 0, seed: 0, cell, inputs: new Map([[field.name, displacement]]) };
  assert.throws(() => room.step(wrongCell), {
    name: 'MargoError',
    code: 'state',
    message: /per sample in the room cell/,
  });
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
});

test('the same room wave field at 24, 30 and 60 fps and after a seek', async () => {
  const roomList = await Promise.all(Array.from({ length: 5 }, () => RoomSoundSolver.load()));
  const make = (frames = { num: 24, den: 1 }) =>
    new PhysicsWorld({ rate: frames }).add(roomList.pop(), { ...layout, speedOfSound: 343, airDamping: 1 });
  frameRateIndependent(make);
  seekEqualsContinuous(make, { at: 11, frames: 29 });
});
