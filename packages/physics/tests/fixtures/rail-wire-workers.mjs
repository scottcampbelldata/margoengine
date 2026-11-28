import { RailRoute, RailSolver } from '../../dist/rail.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

export const railWorkerCell = [-955_121_884, 736_221_938, -804_221_539];
const intervals = 6;

export async function railWireRun(nodes, threads, shared) {
  const spans = (nodes - 1) / intervals;
  const track = new RailRoute([{ centre: [0, 0, 0] }, { centre: [0, 0, spans * 32] }]);
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.80665, 0], memory: worldMemory(shared) });
  const rail = await RailSolver.load(world.memory, { threads });
  try {
    world.add(
      rail,
      {
        cars: [{ track, distance: 42, speed: 10 }],
        wire: { track, spanLength: 32, nodesPerSpan: intervals, pantographs: [{ car: 0, energized: true }] },
      },
      railWorkerCell,
    );
    const coldWork = rail.wireWorkCounts();
    const start = world.takeSnapshot();
    world.advance(5);
    const checkpoint = world.takeSnapshot();
    const sum = (frame) =>
      rail.exportPorts(frame).map(({ cell, region }) => ({
        cell: [...cell],
        words: regionWords(region.memory ?? world.memory, region).slice(),
      }));
    function finish() {
      world.shiftOrigin(railWorkerCell);
      let contact = 0;
      for (let frame = 6; frame <= 30; frame++) {
        world.advance(frame);
        contact = Math.max(contact, rail.readPantograph(0).contactForce);
      }
      const snapshot = world.takeSnapshot();
      return { snapshot, contact, fields: sum(30), work: rail.wireWorkCounts(), position: rail.read(0) };
    }
    const accepted = finish();
    world.restoreSnapshot(checkpoint.bytes);
    const restoredCells = rail.exportPorts(5).map(({ cell }) => [...cell]);
    const replay = finish();
    return { start, accepted, replay, restoredCells, coldWork, cell: [...railWorkerCell] };
  } finally {
    rail[Symbol.dispose]();
  }
}

export function expectedRailWireWork(nodes, threads) {
  const rows = nodes - 2;
  const workers = Array.from({ length: threads }, (_, part) => {
    const left = Math.floor((part * rows) / threads);
    const right = Math.floor(((part + 1) * rows) / threads);
    const positionRows = right - left;
    const velocityRows = positionRows - (Math.floor(right / intervals) - Math.floor(left / intervals));
    return { velocityRows, positionRows, simdNodePairs: velocityRows + positionRows };
  });
  const velocityRows = rows - Math.floor(rows / intervals);
  return { threads, velocityRows, positionRows: rows, simdNodePairs: velocityRows + rows, workers };
}
