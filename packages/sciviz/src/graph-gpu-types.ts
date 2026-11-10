import type { Graph } from './graph.js';

/** Force model from Fruchterman and Reingold (1991), or Jacomy et al. (2014). */
export type GraphForceModel = 'fruchterman-reingold' | 'forceatlas2';

/** Layout settings; lengths and positions are in the figure's data units. */
export interface GPUGraphOptions {
  /** Default 'forceatlas2'. */
  readonly model?: GraphForceModel;
  /** Default 2. */
  readonly dimensions?: 2 | 3;
  /** xyz per node. Default seeded square/cube with unit density. Snapshotted. */
  readonly positions?: ArrayLike<number>;
  /** Default 1. */
  readonly seed?: number;
  /** FR ideal edge length. Default 1. */
  readonly length?: number;
  /** FR step cap. Default max(1, side/10). */
  readonly temperature?: number;
  /** FR cooling per iteration. Default 0.97. */
  readonly cooling?: number;
  /** FR minimum temperature as a multiple of length. Default 0.05. */
  readonly simmer?: number;
  /** Centre gravity. Default 0.01 (FR), 1 (FA2). */
  readonly gravity?: number;
  /** FA2 repulsion multiplier. Default 2. */
  readonly scaling?: number;
  /** FA2 logarithmic attraction. Default false. */
  readonly linLog?: boolean;
  /** FA2 gravity proportional to distance. Default false. */
  readonly strongGravity?: boolean;
  /** Divide each edge's attraction by its source degree + 1. Default false. */
  readonly dissuadeHubs?: boolean;
  /** FA2 edge-weight exponent. Default 1. */
  readonly weightInfluence?: number;
  /** FA2 global swinging tolerance. Default 1. */
  readonly jitterTolerance?: number;
  /** Barnes-Hut opening angle; 0 is exact. Default 0.7. */
  readonly theta?: number;
  /** Power-of-two leaf grid side. Default 128 in 2D, 16 in 3D; maximum 512 / 64. */
  readonly gridSide?: number;
  /** Data-unit radius per node for FA2 overlap prevention. Default 0, disabled. */
  readonly radii?: ArrayLike<number>;
  /** Nodes with a nonzero value stay fixed while still exerting forces. Default none. */
  readonly fixed?: ArrayLike<number>;
}

/** Deterministic work counters, never a wall-clock speed claim. */
export interface GPUGraphWork {
  /** Completed/enqueued layout iterations. */
  readonly iterations: number;
  /** Dispatches issued by this layout. */
  readonly dispatches: number;
  /** Comparator invocations, including padding and both threads of each bitonic pair. */
  readonly sortComparisons: number;
  /** Directed adjacency entries evaluated per iteration (self loops excluded). */
  readonly adjacencyEntries: number;
  /** Bytes in this layout's persistent GPU arrays, excluding transient compute uniforms/readbacks. */
  readonly bufferBytes: number;
}

/** A graph with snapshotted validated edges and optional positive edge weights. */
export type GPUGraph = Graph;
