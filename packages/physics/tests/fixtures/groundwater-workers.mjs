import { TerrainBed } from '@margoengine/physics/earth';
import { GroundwaterSolver } from '@margoengine/physics/groundwater';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const startCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const expectedCell = startCell.map((coordinate, axis) => coordinate - shift[axis]);

export function expectedFaces(nx, nz, start, end) {
  let faceConductances = 0;
  let pairedFaceConductances = 0;
  for (let i = start; i < end; i++) {
    const east = i % nx + 1 < nx;
    const south = i + nx < nx * nz;
    faceConductances += Number(east) + Number(south);
    if (east && south) pairedFaceConductances += 2;
  }
  return { faceConductances, pairedFaceConductances };
}

export async function followGroundwater(nx, nz, threads, shared = threads > 1) {
  using aquifer = await GroundwaterSolver.load({ threads, followTerrain: true });
  const world = new PhysicsWorld({
    rate: { num: 60, den: 1 },
    memory: worldMemory(shared),
    cellSize: 4096,
  });
  const grid = { columns: nx, rows: nz, width: 1.5 * nx, depth: 0.9 * nz, centre: [0, 0] };
  const columns = (sample) => Array.from({ length: nx * nz }, (_, i) => sample(i, i % nx, Math.floor(i / nx)));
  const bottom = columns((_, x, z) => -3.2 + 0.05 * x - 0.035 * z);
  world
    .add(
      new TerrainBed(),
      { ...grid, elevations: (x, z) => 1.26 + 0.014 * x - 0.008 * z + 0.002 * x * z },
      startCell,
    )
    .add(aquifer, {
      grid,
      bottom,
      surface: 1.8,
      initialHead: columns((i, x, z) => i % 11 === 0 ? bottom[i] : 0.6 + 0.011 * x - 0.014 * z),
      conductivityX: columns((i) => i % 17 === 0 ? 0 : 0.02 + 0.003 * (i % 6)),
      conductivityZ: columns((i) => i % 13 === 0 ? 0 : 0.009 + 0.0015 * (i % 5)),
      specificYield: columns((i) => 0.24 + 0.025 * (i % 5)),
      recharge: columns((i) => i % 7 === 0 ? 0.31 : 0.001 + 0.0002 * (i % 3)),
      springElevation: columns((i) => i % 3 === 0 ? 0.25 : 0.9),
      springConductance: columns((i) => i % 4 === 0 ? 0 : 0.021 + 0.003 * (i % 5)),
      sideHeads: { minX: 0.91, maxX: 0.21, minZ: 0.4 },
      secondsPerSecond: 60,
    }, startCell);
  const initialStorage = aquifer.budget.storage;
  world.advance(1);
  const baseline = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const work = [];
    for (let frame = 2; frame <= 7; frame++) {
      world.advance(frame);
      work.push(aquifer.readNativeWork());
    }
    const ports = Object.fromEntries(
      aquifer.exportPorts(7).map(({ field }) => {
        const port = world.fields.port(field);
        return [field, { words: regionWords(world.memory, port.region).slice(), cell: Array.from(port.cell) }];
      }),
    );
    return {
      state: { snapshot: world.takeSnapshot(), ports, budget: aquifer.budget, initialStorage, wet: aquifer.read(0, 0) },
      work,
    };
  }
  const accepted = run();
  world.restoreSnapshot(baseline.bytes);
  return { accepted, replay: run() };
}
