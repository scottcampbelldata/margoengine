import { WAVE_SPECTRUM_FIELD, WaveSolver } from '@margoengine/physics/waves';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

export const signedCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const delta = [4_100_000, -21_500_000, 17_300_000];
export const rebasedCell = signedCell.map((value, i) => value - delta[i]);

export function transportOptions(variant) {
  const cells = variant === 0 ? [13, 9] : variant === 1 ? [19, 11] : [1, 1];
  const periodic = variant === 0 ? ['z'] : variant === 1 ? ['x'] : ['x', 'z'];
  const [nx, nz] = cells;
  const cellSize = 59;
  const directions = variant === 1 ? 9 : 7;
  const count = variant === 1 ? 7 : 5;
  const depths = Array.from({ length: nx * nz }, (_, i) => {
    const x = i % nx;
    const z = Math.floor(i / nx);
    return (x === 2 && z === 3) || (x >= nx - 2 && z < 3 && nx > 1) ? 0 : 8 + 0.7 * x + 0.3 * z;
  });
  const depth = (x, z) => depths[Math.floor(x / cellSize + nx / 2) + nx * Math.floor(z / cellSize + nz / 2)];
  const options = {
    cells,
    cellSize,
    depth,
    directions,
    frequencies: { min: 0.055, max: 0.4, count },
    physics: variant === 0 ? 'wam3' : 'st4',
    start: { height: 0.9, period: 8, direction: 0.23 },
    swell: { height: 0.7, period: 9, direction: -0.72 },
    periodic,
    interval: 6,
    timeScale: 360,
    originCellSize: 4096,
  };
  const wetCells = depths.filter((value) => value > 0).length;
  const wetFaces = (along, across, transposed) => {
    const periodicAxis = periodic.includes(transposed ? 'z' : 'x');
    function wet(p, q) {
      if (!periodicAxis && (p < 0 || p >= along)) return false;
      const wrapped = (p + along) % along;
      return depths[transposed ? q + nx * wrapped : wrapped + nx * q] > 0;
    }
    let total = 0;
    for (let q = 0; q < across; q++) for (let p = 0; p <= along; p++) total += Number(wet(p - 1, q) || wet(p, q));
    return total;
  };
  return { options, bins: count * directions, wetCells, wetFaces: wetFaces(nx, nz, false) + wetFaces(nz, nx, true) };
}

export async function followWaveTransport(variant, threads, shared = threads > 1) {
  const id = 'signed-wave-transport';
  using waves = threads ? await WaveSolver.load(id, { threads }) : new WaveSolver(id);
  const { options, bins, wetCells, wetFaces } = transportOptions(variant);
  const world = new PhysicsWorld({
    rate: { num: 60, den: 1 },
    memory: worldMemory(shared),
    cellSize: 4096,
  })
    .add(waves, options)
    .setCell(id, signedCell);
  world.advance(1);
  const from = world.takeSnapshot();
  function run() {
    world.shiftOrigin(delta);
    const work = [];
    for (let tick = 2; tick <= 4; tick++) {
      world.advance(tick);
      work.push(waves.readNativeWork());
    }
    const port = world.fields.port(WAVE_SPECTRUM_FIELD.name);
    return {
      accepted: world.takeSnapshot(),
      values: regionWords(world.memory, port.region).slice(),
      sample: waves.field.sample(-13, 10),
      cell: Array.from(port.cell),
      fieldCell: Array.from(waves.field.cell),
      time: waves.time,
      work,
    };
  }
  const result = run();
  world.restoreSnapshot(from.bytes);
  return { ...result, replay: run(), bins, wetCells, wetFaces };
}
