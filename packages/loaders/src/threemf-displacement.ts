// Reads the 3MF Consortium's Displacement Extension (https://github.com/3MFConsortium/spec_displacement): height maps,
// displacement vectors, coordinate groups and the displacement meshes that use them.
import { read3MF, type ThreeMFOptions, type ThreeMFResult } from './threemf.js';
import { displacementStage } from './threemf-displacement-read.js';
import type { BinaryInput } from './util.js';

/** A height map resource. */
export interface ThreeMFDisplacementMap {
  id: string;
  modelPath?: string;
  /** The package path of its PNG. */
  path: string;
  data: Uint8Array;
  channel: 'R' | 'G' | 'B' | 'A';
  tileU: string;
  tileV: string;
  filter: string;
}

/** A group of displacement coordinates over one map and one list of vectors. */
export interface ThreeMFDisplacementGroup {
  id: string;
  modelPath?: string;
  mapId: string;
  /** In model units, the height of a map value of 1. */
  height: number;
  /** In model units, the height of a map value of 0. */
  offset: number;
  /** `u v f` for each coordinate; `v` points up from the map's lower left corner. */
  coordinates: Float32Array;
  /** Each coordinate's unit displacement vector, `x y z`. */
  vectors: Float32Array;
}

/** A built displacement mesh. */
export interface ThreeMFDisplacementMesh {
  objectId: string;
  modelPath?: string;
  /** The base triangles, in the object's own coordinates and the model's unit. */
  positions: Float32Array;
  indices: Uint32Array;
  /** For each triangle, the index in `displacementGroups` of its coordinate group, or -1 when it is not displaced. */
  triangleGroups: Int32Array;
  /** Three for each triangle: each corner's coordinate in its group, or -1. */
  triangleCoordinates: Int32Array;
  /**
   * Each place the build puts the object: twelve numbers as a 3MF transform writes them, from the object's coordinates
   * to the result's units. The format displaces before it transforms.
   */
  instances: Float64Array[];
}

/** Options of {@link parse3MFDisplacement}. */
export interface ThreeMFDisplacementOptions extends ThreeMFOptions {
  /** Subdivide and move the displaced triangles. Default true; false gives the base triangles. */
  tessellate?: boolean;
  /** Samples along one texel of a displacement map. Default 1. */
  samplesPerTexel?: number;
  /** The most segments one base edge is split into, rounded down to a power of two: 1 to 65536. Default 256. */
  maxSegments?: number;
}

/** The result of {@link parse3MFDisplacement}. */
export interface ThreeMFDisplacementResult extends ThreeMFResult {
  maps: ThreeMFDisplacementMap[];
  displacementGroups: ThreeMFDisplacementGroup[];
  meshes: ThreeMFDisplacementMesh[];
}

/**
 * Parses a 3MF package with the displacement extension. Each displacement mesh is subdivided until a segment spans at
 * most one texel of its map (`samplesPerTexel`) and moved by it, as chapters 2 to 5 of the extension define, then
 * placed by the build: the result's triangles are the displaced surface, in groups marked `displaced`. The maps, the
 * coordinate groups and the base triangles are returned beside them. Self-intersections of a displaced surface are not
 * resolved.
 *
 * @throws LoaderError for a reference to a resource the package does not define, an index outside its group, a map
 * part that is missing or no PNG, a surface over `maxTriangles`, and what `parse3MF` throws.
 */
export async function parse3MFDisplacement(
  input: BinaryInput,
  options: ThreeMFDisplacementOptions = {},
): Promise<ThreeMFDisplacementResult> {
  const stage = displacementStage(options),
    read = await read3MF(input, options, stage.hooks);
  return { ...read, ...stage.result() };
}
