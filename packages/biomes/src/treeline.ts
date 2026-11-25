import { rangeError } from '../../shared/errors.js';
import { definePlacementGraph, type GraphNode, type PlacementGraph } from './graph.js';

/** Species selectors and local elevation for a patchy subalpine transition. */
export interface AlpineTreelineOptions {
  /** Nominal treeline in metres above sea level, from -500 to 9,000. */
  readonly elevation: number;
  /** Selectors for upright mature trees, in the same format as PlacementGraph.outputs. */
  readonly mature: readonly string[];
  /** Selectors for younger upright trees. Default none. */
  readonly young?: readonly string[];
  /** Selectors for low, wind-stunted trees. */
  readonly stunted: readonly string[];
  /** Vertical size of the transition, 12 to 400 m. Default 140. */
  readonly width?: number;
  /** Size of the world-anchored shelter patches, 20 to 2,000 m. Default 160. */
  readonly patchSize?: number;
  /** Seed for the shelter patches, as a signed 32-bit integer. Default 0. */
  readonly seed?: number;
}

/**
 * An alpine forest placement graph with separate mature, young and stunted cohorts. Low mature forest stays dense,
 * exposed ground thins sooner, and sheltered pockets support islands of young and wind-stunted trees higher up.
 * The profile is a density multiplier. Species ranges and their biome's climate envelope also need to cover it.
 * @example
 * const graph = alpineTreelineGraph({ elevation: 3450, mature: ['fir'], stunted: ['krummholz'] });
 */
export function alpineTreelineGraph(options: AlpineTreelineOptions): PlacementGraph {
  const { elevation, width = 140, patchSize = 160, seed = 0, mature, young = [], stunted } = options;
  if (
    !Number.isFinite(elevation) ||
    elevation < -500 ||
    elevation > 9000 ||
    !Number.isFinite(width) ||
    width < 12 ||
    width > 400 ||
    !Number.isInteger(patchSize) ||
    patchSize < 20 ||
    patchSize > 2000 ||
    !Number.isInteger(seed) ||
    seed < -2147483648 ||
    seed > 2147483647
  )
    throw rangeError('Set a valid treeline elevation, width 12..400 m, patchSize 20..2000 m and int32 seed', 'biomes');
  const outputs: Record<string, string> = Object.create(null);
  for (const [cohort, selectors] of [
    ['mature', mature],
    ['young', young],
    ['stunted', stunted],
  ] as const) {
    if (!Array.isArray(selectors) || (cohort !== 'young' && !selectors.length))
      throw rangeError('Provide at least one selector for both mature and stunted trees', 'biomes');
    for (const selector of selectors) {
      if (typeof selector !== 'string' || !selector || Object.hasOwn(outputs, selector))
        throw rangeError('Treeline cohorts require distinct, nonempty species selectors', 'biomes');
      outputs[selector] = cohort;
    }
  }
  // An open height range has a 50 m feather at blend 0.15. Vary the effective upper slope of each cohort with shelter.
  const below = (id: string, top: number, feather: number): GraphNode => ({
    id,
    op: 'range',
    field: 'height',
    range: [null, elevation + width * top],
    blend: (0.15 * width * feather) / 50,
  });
  return definePlacementGraph({
    nodes: [
      { id: 'patch', op: 'noise', scale: patchSize, seed },
      {
        id: 'pockets',
        op: 'curve',
        input: 'patch',
        points: [
          [0.25, 0.04],
          [0.52, 0.36],
          [0.75, 1],
        ],
      },
      { id: 'hollow', op: 'range', field: 'curvature', range: [null, -0.003], blend: 0.25 },
      { id: 'exposed', op: 'range', field: 'exposure', range: [0.52, null], blend: 0.8 },
      { id: 'leeward', op: 'invert', input: 'exposed' },
      { id: 'contour', op: 'multiply', inputs: ['hollow', 'leeward'] },
      {
        id: 'boost',
        op: 'curve',
        input: 'contour',
        points: [
          [0, 0.12],
          [1, 0.67],
        ],
      },
      { id: 'shelter', op: 'multiply', inputs: ['pockets', 'leeward'] },
      { id: 'pocket-shelter', op: 'max', inputs: ['shelter', 'boost'] },
      below('mature-exposed', -0.48, 0.48),
      below('mature-sheltered', 0.18, 0.55),
      { id: 'mature', op: 'blend', inputs: ['mature-exposed', 'mature-sheltered'], by: 'pocket-shelter' },
      below('young-exposed', -0.18, 0.58),
      below('young-sheltered', 0.4, 0.5),
      { id: 'young', op: 'blend', inputs: ['young-exposed', 'young-sheltered'], by: 'pocket-shelter' },
      {
        id: 'stunted-band',
        op: 'range',
        field: 'height',
        range: [elevation - 0.65 * width, elevation + 0.57 * width],
        blend: 0.36,
      },
      { id: 'stunted', op: 'multiply', inputs: ['stunted-band', 'pocket-shelter'] },
    ],
    outputs,
  });
}
