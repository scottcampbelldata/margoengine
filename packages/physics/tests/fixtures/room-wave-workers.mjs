import { RoomSoundSolver } from '../../dist/room-sound.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

export const acousticCell = [-936_192_403, 691_223_804, -874_719_251];
const samples = 4;

export function expectedRoomWaveWork(dimensions, threads) {
  const [nx, ny, nz] = dimensions;
  const pairsPerSample = ((nx + 2 + (nx % 2)) * (ny + 2) * nz) / 2;
  const workers = Array.from({ length: threads }, (_, part) => {
    const from = Math.floor((part * pairsPerSample) / threads);
    const to = Math.floor(((part + 1) * pairsPerSample) / threads);
    return { samples, pairs: (to - from) * samples };
  });
  return { threads, samples, pairs: pairsPerSample * samples, workers };
}

export async function roomWaveRun(dimensions, threads, shared) {
  const [nx, ny, nz] = dimensions;
  const wall = Math.floor(nx / 2);
  const air = new Uint8Array(nx * ny * nz).fill(1);
  const reflection = new Float64Array(air.length);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = x + nx * (y + ny * z);
        if (x === wall && (y !== 3 || z !== 2)) air[i] = 0;
        reflection[i] = 0.35 + (i % 5) / 10;
      }
    }
  }
  const room = await RoomSoundSolver.load({ threads });
  try {
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared) }).add(
      room,
      {
        grid: { dimensions, spacing: 0.5, air, reflection },
        speedOfSound: 60,
        airDamping: 0.025,
        source: [2, 2, 2],
        receiver: [nx - 3, 2, 2],
      },
      acousticCell,
    );
    const fields = () =>
      room.exportPorts(0).map(({ field }) => {
        const { cell, region } = world.fields.port(field);
        return { cell: [...cell], rows: regionWords(region.memory ?? world.memory, region).slice() };
      });
    const cold = world.takeSnapshot();
    world.advance(4);
    const checkpoint = world.takeSnapshot();
    const finish = () => {
      world.shiftOrigin(acousticCell);
      let peak = 0;
      for (let frame = 5; frame <= 22; frame++) {
        world.advance(frame);
        for (const pressure of room.readTrace().values) peak = Math.max(peak, Math.abs(pressure));
      }
      return {
        snapshot: world.takeSnapshot(),
        fields: fields(),
        trace: room.readTrace(),
        work: room.workCounts(),
        solid: room.pressureAt([wall, 2, 2]),
        peak,
      };
    };
    const accepted = finish();
    world.restoreSnapshot(checkpoint.bytes);
    const restoredCells = fields().map(({ cell }) => cell);
    const replay = finish();
    return { cold, accepted, replay, restoredCells };
  } finally {
    room[Symbol.dispose]();
  }
}
