import { NonlinearSea } from '@margoengine/physics/rogue';

export const signedCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];

export function seaOptions(components, withRogue) {
  const frequencies = Float64Array.of(0.055, 0.071, 0.096, 0.134, 0.168, 0.231);
  const directions = Float64Array.of(-Math.PI, -Math.PI / 2, 0, Math.PI / 2);
  const energy = Float64Array.from([0.17, 0.08, 1, 0.22]);
  const sample = {
    frequencies,
    directions,
    energy: Float64Array.from({ length: frequencies.length * directions.length }, (_, i) => {
      const density = [0.25, 2.8, 5.6, 2.4, 0.8, 0.14][Math.floor(i / directions.length)];
      return density * energy[i % directions.length];
    }),
    depth: withRogue ? 30 : Infinity,
    density: 1025,
  };
  return {
    components,
    seed: 0x8eff31dc,
    at: [-19, 8],
    waves: { cell: signedCell.slice(), sample: () => sample },
    rogues: withRogue ? [{ position: [14, -28], time: 32, crest: 2.4 }] : false,
  };
}

export async function sampleRoguePairs(components, withRogue, threads) {
  const options = seaOptions(components, withRogue);
  using sea = threads ? await NonlinearSea.load(options, { threads }) : new NonlinearSea(options);
  const points = [
    [-19, 8, 5],
    [26, -39, 32.5],
    [-11, -15, 40],
    [513.25, -1009.75, 131],
    [14, -28, 32],
  ];
  const cellSize = 4096;
  // Form each signed physical position in the input field's cell, then present its local offset to the surface.
  const local = points.map(([x, z, time]) => [
    x + signedCell[0] * cellSize - sea.cell[0] * cellSize,
    z + signedCell[2] * cellSize - sea.cell[2] * cellSize,
    time,
  ]);
  const evaluate = ([x, z, t]) => ({
    elevation: sea.elevation(x, z, t),
    linear: sea.linearElevation(x, z, t),
    pressure: sea.pressure(x, -1.5, z, t),
    water: sea.water.sample(x, -1, z, t),
    surface: sea.sample(x, z, t),
    work: sea.readNativeWork(),
  });
  const first = local.map(evaluate);
  const replay = local.slice().reverse().map(evaluate).reverse();
  return { first, replay, cell: Array.from(sea.cell), waterCell: Array.from(sea.water.cell), local, points };
}
