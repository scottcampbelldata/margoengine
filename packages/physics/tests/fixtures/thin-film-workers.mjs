import { ThinFilmSolver } from '@margoengine/physics/thin-film';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

export function equalFilmWords(left, right) {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

export async function followThinFilm(threads = 1, shared = threads > 1, suspended = false) {
  const id = 'signed-thin-film-matrix';
  using film = await ThinFilmSolver.load({ id, threads });
  const signed = [1_170_000_000, -1_070_000_000, 2_000_000_000];
  const delta = [4_100_000, -21_500_000, 17_300_000];
  const cells = suspended ? [27, 23] : [35, 29];
  const spacing = suspended ? 0.01 : 0.015;
  const n = cells[0] * cells[1];
  const depth = Float64Array.from(
    { length: n },
    (_, i) => 0.00085 + 0.000073 * Math.cos((i % cells[0]) * 0.42) * Math.sin(Math.floor(i / cells[0]) * 0.51),
  );
  const options = { cells, spacing, depth, originCellSize: 1, origin: [0.2, -0.13, 0.4], rainRate: 5e-6, suspended };
  if (suspended) {
    options.viscosity = 0.032;
    options.surfaceTension = 0.021;
  } else {
    options.wetting = { precursorDepth: 0.00013, contactAngle: 0.11 };
    options.wettingAngleMap = Float64Array.from({ length: n }, (_, i) => 0.103 + 0.001 * (i % cells[0]));
    options.contactAngleHysteresis = [0.035, 0.18];
  }
  const world = new PhysicsWorld({
    rate: { num: 60, den: 1 },
    memory: worldMemory(shared),
    cellSize: 1,
    gravity: suspended ? [0, 0, 0] : [0, -9.81, 0],
  })
    .add(film, options)
    .setCell(id, signed);
  world.advance(2);
  const start = world.takeSnapshot();
  function run() {
    world.shiftOrigin(delta);
    const receipts = [];
    for (let tick = 3; tick <= 6; tick++) {
      world.advance(tick);
      receipts.push(film.workCounts());
    }
    const ports = [world.fields.port(film.filmField.name), world.fields.port(film.dripsField.name)];
    return {
      accepted: world.takeSnapshot(),
      depths: film.depths(),
      budget: film.budget,
      ports: ports.map(({ region }) => regionWords(world.memory, region).slice()),
      cell: Array.from(ports[0].cell),
      receipts,
    };
  }
  const result = run();
  world.restoreSnapshot(start.bytes);
  const replay = run();
  return {
    ...result,
    replay,
    n,
    exact:
      equalFilmWords(result.accepted.bytes, replay.accepted.bytes) &&
      result.ports.every((words, i) => equalFilmWords(words, replay.ports[i])),
  };
}
