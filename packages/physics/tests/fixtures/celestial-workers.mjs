import { CelestialSolver, INSOLATION_FIELD, TIDAL_POTENTIAL_FIELD } from '@margoengine/physics/celestial';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const startCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const celestialCell = startCell.map((coordinate, axis) => coordinate - shift[axis]);
export const bodies = ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
const century = 36525 * 86400;
const rate = { num: 60, den: 1 };

export function expectedCelestialWork(threads) {
  const planets = 8 / threads;
  return {
    threads,
    planets: 8,
    pairedPlanets: 8,
    keplerIterations: 48,
    workers: Array.from({ length: threads }, () => ({
      planets,
      pairedPlanets: planets,
      keplerIterations: 6 * planets,
    })),
  };
}

export async function followCelestial(t, timeScale, threads, shared = threads > 1, rebase = true) {
  using sky = threads ? await CelestialSolver.load({ threads }) : new CelestialSolver();
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared), cellSize: 4096 }).add(
    sky,
    { epoch: { ttSeconds: t * century, ut1Seconds: t * century - 70, tdbSeconds: t * century + 0.0008 }, timeScale },
    startCell,
  );
  world.advance(2);
  const checkpoint = world.takeSnapshot();

  function run() {
    if (rebase) world.shiftOrigin(shift);
    const work = [];
    const before = sky.epoch;
    const prior = sky.position('mercury');
    for (let frame = 3; frame <= 9; frame++) {
      world.advance(frame);
      work.push(sky.readNativeWork());
    }
    const ports = Object.fromEntries(
      [INSOLATION_FIELD, TIDAL_POTENTIAL_FIELD].map(({ name }) => {
        const port = world.fields.port(name);
        return [name, { cell: Array.from(port.cell), words: regionWords(world.memory, port.region).slice() }];
      }),
    );
    return {
      state: {
        before,
        prior,
        snapshot: world.takeSnapshot(),
        epoch: sky.epoch,
        rotation: sky.rotation,
        ports,
        positions: bodies.map((body) => sky.position(body)),
        light: sky.insolation({ latitude: 0.42, longitude: -1.35, height: 800 }),
        tide: sky.tide([6378137, 0, 0]),
      },
      work,
    };
  }

  const accepted = run();
  world.restoreSnapshot(checkpoint.bytes);
  return { accepted, replay: run() };
}
