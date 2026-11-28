import { loadTracerRandomKernel, TRACER_FIELD, TracerSolver } from '@margoengine/physics/tracers';
import { PhysicsWorld, regionWords } from '@margoengine/physics/world';

export function equalTracerWords(left, right) {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

export async function followTracers(threads, plumeSlots = 4235) {
  using kernel = threads === undefined ? undefined : await loadTracerRandomKernel({ threads });
  const tracer = new TracerSolver('signed-oil-and-plume');
  const signed = [1_170_000_000, -1_070_000_000, 2_000_000_000];
  const delta = [4_100_000, -21_500_000, 17_300_000];
  const flowOffset = [1, 1, -1];
  const bedOffset = [-1, 0, 1];
  let basis = signed;
  let calls = { water: 0, bed: 0, flowX: 0, bedZ: 0 };
  const water = {
    medium: 'water',
    get cell() {
      return basis.map((value, axis) => value + flowOffset[axis]);
    },
    sample(x, y, z, time, out) {
      calls.water++;
      calls.flowX += x;
      out.velocity[0] = 0.17 + 0.03 * y + time * 0.1;
      out.velocity[1] = 0.004 * z;
      out.velocity[2] = 0.024 * x;
      out.density = 1025;
      out.temperature = 285;
      return out;
    },
  };
  const bed = {
    get cell() {
      return basis.map((value, axis) => value + bedOffset[axis]);
    },
    sample(x, z) {
      calls.bed++;
      calls.bedZ += z;
      return { elevation: -1.49 + 0.002 * x - 0.003 * z };
    },
  };
  const dt = 1 / 60;
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, seed: 0xef6b2101, cellSize: 1 })
    .add(tracer, {
      cellSize: 1,
      water,
      bed,
      capacity: plumeSlots + 212,
      particleMass: 1,
      randomKernel: kernel,
      horizontalDiffusivity: 0.02,
      verticalDiffusivity: 0.003,
      sources: [
        { material: 'dye', position: [0, -0.55, 0], rate: 60 * plumeSlots, stop: dt },
        { material: 'sand', position: [0.25, -1.51, 0], rate: 60 * 5, stop: dt },
        { material: 'oil', position: [0, 0, 0.9], rate: 60 * 64, stop: dt },
      ],
    })
    .setCell('signed-oil-and-plume', signed);
  world.advance(3);
  const start = world.takeSnapshot();
  function run() {
    calls = { water: 0, bed: 0, flowX: 0, bedZ: 0 };
    kernel?.resetWork();
    world.shiftOrigin(delta);
    basis = signed.map((value, axis) => value - delta[axis]);
    world.advance(8);
    const { region, cell } = tracer.exportPorts(7).find(({ field }) => field === TRACER_FIELD.name);
    return {
      accepted: world.takeSnapshot(),
      fields: regionWords(world.memory, region).slice(),
      cell: Array.from(cell),
      counts: kernel?.workCounts(),
      budget: tracer.budget,
      calls,
    };
  }
  const result = run();
  world.restoreSnapshot(start.bytes);
  const replay = run();
  const exact =
    equalTracerWords(result.accepted.bytes, replay.accepted.bytes) && equalTracerWords(result.fields, replay.fields);
  return { ...result, replay, exact };
}
