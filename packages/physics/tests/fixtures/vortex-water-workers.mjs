import { TerrainBed } from '@margoengine/physics/earth';
import { FORCING_WORDS, ShallowWaterSolver, SURFACE_WATER_FIELD, SURFACE_WATER_FORCING_FIELD } from '@margoengine/physics/hydro';
import { StormVortex, VortexForcing } from '@margoengine/physics/vortices';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const initialCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const originShift = [4_100_000, -21_500_000, 17_300_000];
export const expectedCell = initialCell.map((coordinate, axis) => coordinate - originShift[axis]);
const radii = { cyclone: 30000, tornado: 120, waterspout: 35, dustDevil: 8, fireWhirl: 5 };

export async function followVortexWater(kind, nx, nz, threads, windStress = true, shared = threads > 1) {
  const loading = { id: 'natural-vortex-forcing', water: true };
  using forcing = threads === 0
    ? new VortexForcing(loading.id, loading)
    : await VortexForcing.load({ ...loading, threads });
  const memory = worldMemory(shared);
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory, cellSize: 4096 });
  const radius = radii[kind];
  const width = 4.2 * radius;
  const depth = 3.6 * radius;
  const dx = width / nx;
  const dz = depth / nz;
  const grid = { columns: nx, rows: nz, width, depth, centre: [0, 0] };
  const water = new ShallowWaterSolver('vortex-bay');
  const terrain = new TerrainBed();
  const vortex = new StormVortex({
    kind,
    compactProfile: kind === 'tornado' ? 'rankine' : 'burgers',
    cell: expectedCell,
    center: [-0.14 * radius, 0.08 * radius],
    translation: [0.1 * radius, -0.06 * radius],
    latitude: kind === 'fireWhirl' ? -21 : 24,
    groundY: kind === 'waterspout' ? 2.5 : 0,
    secondary: { radius: 1.64 * radius, width: 0.17 * radius, strength: 0.66 },
  });
  world
    .add(terrain, { ...grid, elevations: (x) => (x > width * 0.22 ? 5 : 0.02 * x / width) }, initialCell)
    .add(water, {
      bed: terrain.bed,
      depth: (x, z) => (x > width * 0.25 ? 0 : 2.4 + 0.12 * z / depth),
      roughness: 0,
    }, initialCell)
    .add(forcing, {
      vortex,
      probes: [[-radius, 10, 0], [radius, 11, 0.2 * radius]],
      water: {
        width: nx,
        depth: nz,
        spacing: [dx, dz],
        origin: [(dx - width) / 2, (dz - depth) / 2],
        level: 1.25,
        windStress,
      },
    }, initialCell)
    .couple([water.id, forcing.id], 'staggered');
  world.advance(1);
  const baseline = world.takeSnapshot();

  function run() {
    world.shiftOrigin(originShift);
    const work = [];
    for (let frame = 2; frame <= 7; frame++) {
      world.advance(frame);
      work.push(forcing.readNativeWork());
    }
    const force = forcing.exportPorts(7).find(({ field }) => field === SURFACE_WATER_FORCING_FIELD.name);
    const waterPort = world.fields.port(SURFACE_WATER_FIELD.name);
    const rows = regionWords(memory, force.region).slice();
    return {
      state: {
        snapshot: world.takeSnapshot(),
        forces: rows,
        dryForcing: rows.slice((nx - 1) * FORCING_WORDS, nx * FORCING_WORDS),
        water: regionWords(memory, waterPort.region).slice(),
        cell: Array.from(force.cell),
        waterCell: Array.from(waterPort.cell),
      },
      work,
    };
  }
  const accepted = run();
  world.restoreSnapshot(baseline.bytes);
  return { accepted, replay: run() };
}
