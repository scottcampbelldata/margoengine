// Browser and Node share exactly this fixed functional matrix. No timing or random retries.
export const PLACEMENT_FLOW_CASE_COUNT = 9;
export function placementCases(module) {
  const plants = [
    {
      id: 'thomas',
      mesh: 'oak',
      radius: 6,
      density: 35,
      cluster: { kind: 'thomas', parents: 12, spread: 9 },
      stands: { scale: 64, cover: 0.6 },
    },
    { id: 'matern', mesh: 'shrub', radius: 1, density: 80, cluster: { kind: 'matern', parents: 25, spread: 6 } },
    { id: 'fat-tail', mesh: 'shrub', radius: 0.6, density: 40, cluster: { kind: '2dt', parents: 18, spread: 4 } },
  ];
  const custom = module.defineBiome({
    id: 'j6',
    climate: {},
    ground: [{ material: 'grass' }],
    plants,
    rocks: [{ id: 'rock', mesh: 'rock', radius: 1.5, density: 20 }],
    details: [{ id: 'grass', mesh: 'grass', density: 3 }],
  });
  return [
    { name: 'cluster-stand-corner', x: 0, z: 0, options: { seed: 7, biomes: [custom] } },
    { name: 'cluster-stand-seam', x: 1, z: 1, options: { seed: 0xffffffff, biomes: [custom] } },
    { name: 'temperate-corner', x: 0, z: 1, options: { seed: 19, biomes: [module.presets.temperate] } },
  ].map((s) => ({
    ...s,
    options: {
      size: [256, 256],
      tileSize: 128,
      resolution: 4,
      backend: 'cpu',
      height: { field: () => 100 },
      climate: { coldAir: 0 },
      ...s.options,
    },
    placement: {
      rounds: 6,
      exclusions: [
        {
          kind: 'line',
          points: [
            [-128, -80],
            [128, 60],
          ],
          width: 6,
          verge: 2,
        },
      ],
    },
  }));
}
export function flowCases() {
  return [
    {
      name: 'flat-sea-outlet',
      grid: {
        nx: 11,
        nz: 9,
        step: 16000,
        height: Int32Array.from({ length: 99 }, (_, i) => {
          const x = i % 11,
            z = Math.floor(i / 11);
          return z === 0 ? (x === 5 ? -20 : 9000) : x === 0 || x === 10 || z === 8 ? 9000 : 5000;
        }),
      },
      options: { sea: 0, multiple: true, channelCells: 4 },
    },
    {
      name: 'seeded-partial',
      grid: {
        nx: 7,
        nz: 19,
        step: 3000,
        height: Int32Array.from({ length: 133 }, (_, i) => 1000 + (Math.imul(i ^ 65535, 2654435761) >>> 19)),
      },
      options: { channelCells: 5 },
    },
    {
      name: 'binary64-height-boundaries',
      grid: {
        nx: 3,
        nz: 3,
        step: 16000,
        height: Int32Array.of(-2147483648, -1, 2147483647, 0, 2147483647, -2147483647, 1, 0, -1),
      },
      options: { multiple: true },
    },
    { name: 'all-ocean', grid: { nx: 2, nz: 2, step: 1000, height: new Int32Array(4).fill(-1) }, options: { sea: 0 } },
  ];
}
export function tileBytes(t) {
  return [
    new TextEncoder().encode(
      JSON.stringify({
        x: t.x,
        z: t.z,
        origin: t.origin,
        size: t.size,
        count: t.count,
        species: t.species,
        candidates: t.stats.candidates,
        accepted: t.stats.accepted,
        unresolved: t.stats.unresolved,
        rounds: [...t.stats.rounds],
      }),
    ),
    t.instances,
    t.canopy.data,
    t.exclusion.data,
    ...t.density.flatMap((d) => [new TextEncoder().encode(JSON.stringify([d.id, d.mesh, d.density])), d.data]),
  ];
}
export function flowBytes(h) {
  return ['height', 'filled', 'direction', 'flow', 'shares', 'twi', 'hand', 'lake', 'channel', 'water']
    .filter((k) => h[k])
    .map((k) => new Uint8Array(h[k].buffer, h[k].byteOffset, h[k].byteLength));
}
