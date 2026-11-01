// Shared inputs and host guard for the CPU transport checks and the Chromium hardware proof.
export function requireFieldIntegrationHost(name) {
  // Factory calls this worker DEV; its Windows hostname is SCOTT-DEV. Adapter validation remains mandatory.
  if (!['DEV', 'SCOTT-DEV'].includes(name.toUpperCase()))
    throw new Error('Run this hardware proof on DEV with its NVIDIA RTX A6000');
}

export const fieldNames = [
  'height',
  'slope',
  'aspect',
  'curvature',
  'tpi',
  'temperature',
  'coldest',
  'warmest',
  'gdd5',
  'season',
  'treeline',
  'rainfall',
  'alpha',
  'moisture',
  'exposure',
  'waterDistance',
  'soil',
  'profile',
  'plan',
];

export const fieldNameSets = [
  fieldNames,
  ['temperature', 'rainfall', 'alpha', 'moisture', 'exposure', 'waterDistance'],
  ['height', 'soil', 'profile', 'plan'],
];

export function fieldIntegrationCases() {
  return [
    {
      seed: 7,
      origin: [-256000, -192000],
      size: [512000, 384000],
      regionResolution: 16,
      cell: 1000,
      tileSize: 128000,
      climate: { latitude: 45, seaLevel: 120, rainfall: 900, wind: [3, 1], coldAir: 3 },
    },
    {
      seed: 0x165536,
      origin: [64000, -384000],
      size: [1024000, 768000],
      regionResolution: 32,
      cell: 4000,
      tileSize: 512000,
      climate: { latitude: -33, seaLevel: 100, rainfall: 12000, wind: [-2, 3], coldAir: 10, inland: 0 },
    },
  ].map((spec) => {
    const cells = spec.tileSize / spec.cell,
      edgeX = (Math.floor(spec.size[0] / (spec.regionResolution * 1000)) * spec.regionResolution * 1000) / spec.cell,
      edgeZ = (Math.floor(spec.size[1] / (spec.regionResolution * 1000)) * spec.regionResolution * 1000) / spec.cell;
    return {
      ...spec,
      rectangles: [
        { ox: 13, oz: 17, width: 7, depth: 19 },
        { ox: 31, oz: 47, width: 33, depth: 5 },
        { ox: cells - 3, oz: cells - 3, width: 7, depth: 11 },
        { ox: -1, oz: -1, width: cells + 2, depth: cells + 2 },
        { ox: -40, oz: -3, width: 9, depth: 7 },
        { ox: edgeX + 10, oz: edgeZ + 10, width: 5, depth: 9 },
        { ox: edgeX - 1, oz: edgeZ - 1, width: 3, depth: 3 },
        { ox: edgeX, oz: edgeZ, width: 1, depth: 1 },
      ],
    };
  });
}

// Same seeded relief, water sources, quantization and corner grid construction as world.ts #buildRegion.
export function frameFor(module, spec) {
  const heights = module.heightsOf(undefined, spec.origin, spec.size, spec.seed, module.createRelief),
    climate = module.quantizeClimate(spec.climate),
    step = spec.regionResolution * 1000,
    nx = module.divFloor(spec.size[0], step) + 1,
    nz = module.divFloor(spec.size[1], step) + 1,
    region = module.buildRegion(
      heights.grid(0, 0, nx, nz, step),
      nx,
      nz,
      step,
      climate,
      heights.relief?.waterCells(spec.origin, step, nx, nz),
    );
  return { heights, climate, region, cell: spec.cell };
}
