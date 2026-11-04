import * as m from './gpu-placement-flow-source.mjs';
import { presetWorlds, R16 } from '../src/presets.ts';
import { hydrologyOf, hydrologyOfAsync } from '../src/hydrology.ts';

export const BACKEND_PLACEMENT_CASE_COUNT = 14;

export function backendHydrologyCases() {
  const island = presetWorlds.island;
  return [
    { name: 'coast-south', options: { size: [512, 512], height: { relief: { coast: 'south', relief: 600 } } } },
    { name: 'island', options: { size: [512, 512], height: { relief: island.relief }, climate: island.climate } },
    {
      name: 'samples-flats',
      options: {
        size: [256, 256],
        tileSize: 128,
        regionResolution: 16,
        height: { samples: m.flowCases()[0].grid.height, width: 11, depth: 9, unit: 'mm' },
      },
    },
  ];
}

function equalRecord(a, b, label) {
  if (ArrayBuffer.isView(a)) {
    if (!ArrayBuffer.isView(b) || a.constructor !== b.constructor || a.byteLength !== b.byteLength)
      throw Error(label + ': typed array shape differs');
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) throw Error(label + ': byte ' + i + ' differs');
  } else if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object') throw Error(label + ': record missing');
    const keys = Object.keys(a).filter((key) => typeof a[key] !== 'function');
    const other = Object.keys(b).filter((key) => typeof b[key] !== 'function');
    if (String(keys) !== String(other)) throw Error(label + ': record keys differ');
    for (const key of keys) equalRecord(a[key], b[key], label + '.' + key);
  } else if (a !== b) throw Error(label + ': value differs');
}

export async function runBackendPlacementCases(device) {
  const island = presetWorlds.island;
  const clearing = m.defineBiome({
    id: 'clearing',
    climate: { custom: { 'mask/clearing': [0.5, null] } },
    ground: [{ material: 'grass' }],
  });
  // Reuse the landed fixture's exclusions, alongside the requested default, R16 and island worlds.
  const shared = m.placementCases(m)[0];
  const cases = [
    {
      ...shared,
      name: 'cluster-stand-bands',
      tiles: [
        [0, 0],
        [1, 0],
      ],
    },
    {
      name: 'default',
      options: {},
      tiles: [
        [8, 8],
        [9, 8],
      ],
    },
    {
      name: 'R16-mountain',
      options: {
        seed: R16.seed,
        origin: R16.origin,
        size: R16.size,
        tileSize: R16.tileSize,
        resolution: R16.resolution,
        regionResolution: R16.regionResolution,
        height: { relief: R16.relief },
        climate: R16.climate,
        biomes: R16.biomes.map((id) => m.presets[id]),
      },
      tiles: [
        [51, 1],
        [52, 1],
      ],
    },
    {
      name: 'island-clearing-exclusions',
      options: {
        climate: island.climate,
        height: { relief: island.relief },
        biomes: [...island.biomes, clearing],
      },
      placement: shared.placement,
      paint: true,
      tiles: [
        [8, 8],
        [9, 8],
      ],
    },
  ];
  let gpuCases = 0,
    coldBands = 0;
  for (const spec of cases) {
    const cpu = await m.BiomeWorld.create({ ...spec.options, backend: 'cpu', workers: 0 });
    let gpu, cp, gp;
    try {
      gpu = await m.BiomeWorld.create({ ...spec.options, backend: 'gpu', workers: 0, device });
      const loads = [],
        tile = gpu.tile.bind(gpu),
        part = gpu.tilePart.bind(gpu);
      gpu.tile = (x, z, options) => {
        loads.push([x, z, 'whole']);
        return tile(x, z, options);
      };
      gpu.tilePart = (x, z, window, options) => {
        loads.push([x, z, 'band']);
        return part(x, z, window, options);
      };
      if (spec.paint) {
        const cells = cpu.tileSize / cpu.resolution;
        const data = Uint8Array.from({ length: cells * cells }, (_, i) => {
          const x = i % cells,
            z = Math.floor(i / cells);
          return x >= cells / 4 && x < (3 * cells) / 4 && z >= cells / 4 && z < (3 * cells) / 4 ? 255 : 0;
        });
        for (const [x, z] of spec.tiles) {
          cpu.writeLayer('paint/clearing', x, z, data);
          gpu.writeLayer('paint/clearing', x, z, data);
        }
      }
      cp = m.BiomePlacement.attach(cpu, spec.placement);
      gp = m.BiomePlacement.attach(gpu, spec.placement);
      for (const [i, [x, z]] of spec.tiles.entries()) {
        // The first request is cold; the second explicitly promotes an upcoming neighbour.
        const options = i === 0 ? {} : { ahead: [[x + 1, z]] };
        loads.length = 0;
        const expected = await cp.tile(x, z, options);
        const actual = await gp.tile(x, z, options);
        if (i === 0 && loads.some(([, , kind]) => kind === 'band')) coldBands++;
        if (i > 0 && loads.find(([tx, tz]) => tx === x + 1 && tz === z)?.[2] !== 'whole' && x + 1 < gpu.tilesX)
          throw Error(spec.name + ': ahead neighbour was not loaded whole');
        equalRecord(expected, actual, spec.name + ' tile ' + x + ',' + z);
        equalRecord(await cp.digest(x, z), await gp.digest(x, z), spec.name + ' digest');
        if (spec.name === 'R16-mountain' && !(await cpu.tile(x, z)).layer('height').data.some((h) => h > 900000))
          throw Error('R16 fixture must include mountain heights above 900 m');
        if (spec.paint) {
          const ids = (await cpu.tile(x, z)).layer('biome').data;
          if (!ids.includes(cpu.biomes.length - 1)) throw Error('Painted clearing missing from island fixture');
          if (i === 0 && !actual.exclusion.data.some((v) => v > 0)) throw Error('Island exclusion is not exercised');
        }
        console.log('placement parity: ' + spec.name + ' ' + x + ',' + z + (i ? ' ahead' : ' cold'));
        gpuCases++;
      }
    } finally {
      gp?.dispose();
      cp?.dispose();
      gpu?.dispose();
      cpu.dispose();
    }
  }
  if (!coldBands) throw Error('No cold GPU placement exercised neighbour bands');
  for (const spec of backendHydrologyCases()) {
    const cpu = await m.BiomeWorld.create({ ...spec.options, backend: 'cpu', workers: 0 });
    let gpu;
    try {
      gpu = await m.BiomeWorld.create({ ...spec.options, backend: 'gpu', workers: 0, device });
      for (const options of [{}, { multiple: true, channelCells: 4, lakeDepth: 500 }]) {
        const label = spec.name + (options.multiple ? ' multiple' : ' default');
        equalRecord(hydrologyOf(cpu, options), await hydrologyOfAsync(gpu, options), label);
        console.log('hydrology parity: ' + label);
        gpuCases++;
      }
    } finally {
      gpu?.dispose();
      cpu.dispose();
    }
  }
  if (gpuCases !== BACKEND_PLACEMENT_CASE_COUNT) throw Error('Backend placement case matrix incomplete: ' + gpuCases);
  return gpuCases;
}
