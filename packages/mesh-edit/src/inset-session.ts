/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError, type MutableVec3 } from '@margoengine/math';
import { meshSelectionVertices } from './components.js';
import { prepareInsetRegionPlacement } from './inset-plane.js';
import {
  insetMeshRegion,
  insetResult,
  resolveInsetMetric,
  type RegionInsetOptions,
  type RegionInsetResult,
} from './inset.js';
import { assertPolygonMesh } from './polygon.js';
import { clonePolygonMesh, faceIdFactory } from './result.js';
import { prepareRegionCaps, replaceRegionCaps } from './region-topology.js';
import type { PolygonMesh } from './types.js';

/** Deep copy of an inset result, so callers can edit it without touching the session's cache. */
export function cloneInsetResult(result: RegionInsetResult): RegionInsetResult {
  return {
    ...result,
    mesh: clonePolygonMesh(result.mesh),
    vertexMap: result.vertexMap.map((v) => [...v]),
    faceMap: Object.fromEntries(Object.entries(result.faceMap).map(([id, v]) => [id, [...v]])),
    edgeMap: Object.fromEntries(Object.entries(result.edgeMap).map(([id, v]) => [id, [...v]])),
    createdVertices: [...result.createdVertices],
    removedVertices: [...result.removedVertices],
    createdFaces: [...result.createdFaces],
    removedFaces: [...result.removedFaces],
    createdEdges: [...result.createdEdges],
    removedEdges: [...result.removedEdges],
    affectedFaces: [...result.affectedFaces],
    diagnostics: [...result.diagnostics],
    capFaces: [...result.capFaces],
    borderFaces: result.borderFaces.map((face) => ({ ...face })),
    regions: result.regions.map((region) => ({
      ...region,
      faces: [...region.faces],
      boundaryEdges: [...region.boundaryEdges],
      boundaryLoops: region.boundaryLoops.map((loop) => [...loop]),
    })),
  };
}

/**
 * Repeated inset previews of one selection at different widths.
 * The constructor copies the mesh, selection and optional world matrix; later edits to them need a new session.
 * The first positive width prepares the topology, boundary loops and interior offsets once. Every width is still
 * fully validated. Border face IDs are created once, by the first valid result, and stay the same for later widths.
 * Each result owns its arrays. Width 0 or an empty selection returns an unchanged copy without creating IDs.
 * A failed width returns nothing and leaves the prepared state intact.
 * @throws TypeError for a bad mesh, selection, options or ID; RangeError for a bad width or matrix, or collapsed
 * geometry; MargoError `unsupported` for a non-planar or ambiguous region, `state` when called from inside its own
 * `createId`, and `disposed` after dispose.
 */
export class MeshRegionInsetSession {
  #source: PolygonMesh | null;
  #faces: string[];
  #options: RegionInsetOptions;
  #metric: ReturnType<typeof resolveInsetMetric>;
  #preparation: ReturnType<typeof prepareRegionCaps> | null = null;
  #placements: ReturnType<typeof prepareInsetRegionPlacement>[] = [];
  #template: RegionInsetResult | null = null;
  #busy = false;

  constructor(mesh: PolygonMesh, faceIds: readonly string[], options: RegionInsetOptions = {}) {
    meshSelectionVertices(mesh, { mode: 'face', faces: faceIds });
    this.#source = clonePolygonMesh(mesh);
    this.#faces = [...faceIds];
    this.#metric = resolveInsetMetric(options);
    this.#options = { worldMatrix: this.#metric.world, createId: options.createId };
    faceIdFactory(this.#source, this.#options);
  }

  /** Whether {@link MeshRegionInsetSession.dispose} has been called. */
  get disposed(): boolean {
    return this.#source === null;
  }
  #open(): PolygonMesh {
    if (!this.#source)
      throw new MargoError('disposed', 'Inset session is disposed; capture a new MeshRegionInsetSession.');
    return this.#source;
  }

  /** Inset the captured selection by `width` (0 or more). */
  inset(width = 0.1): RegionInsetResult {
    const source = this.#open();
    if (this.#busy)
      throw new MargoError(
        'state',
        'Inset session cannot reenter its ID callback; finish the current inset before evaluating again.',
      );
    if (!Number.isFinite(width) || width < 0)
      throw new RangeError(
        'Inset width must be finite and nonnegative; choose a positive metric width or zero for no change.',
      );
    this.#busy = true;
    try {
      if (width === 0 || !this.#faces.length) return insetMeshRegion(source, this.#faces, width, this.#options);
      if (!this.#preparation) {
        const preparation = prepareRegionCaps(source, this.#faces),
          placements = preparation.regions.map((region) =>
            prepareInsetRegionPlacement(source, region, this.#metric.world, this.#metric.inverse),
          );
        this.#preparation = preparation;
        this.#placements = placements;
      }
      const placements = this.#placements.map((evaluate) => evaluate(width));
      let result: RegionInsetResult;
      if (!this.#template) {
        result = insetResult(
          replaceRegionCaps(
            source,
            this.#faces,
            this.#options,
            false,
            (_, index) => ({ positions: placements[index].positions, offset: [0, 0, 0] }),
            this.#preparation,
          ),
          placements.map((placement) => placement.loops),
          width,
        );
        this.#open();
        this.#template = cloneInsetResult(result);
      } else {
        result = cloneInsetResult(this.#template);
        let at = 0;
        for (const placement of placements)
          for (const point of placement.positions)
            result.mesh.vertices[result.createdVertices[at++]] = point as MutableVec3;
        for (const region of result.regions) region.width = width;
        assertPolygonMesh(result.mesh);
      }
      this.#open();
      return result;
    } finally {
      this.#busy = false;
    }
  }

  /** Release everything captured. Safe to call more than once. */
  dispose(): void {
    this.#source = null;
    this.#faces = [];
    this.#options = {};
    this.#metric = {};
    this.#preparation = null;
    this.#placements = [];
    this.#template = null;
  }
  /** Same as `dispose()`, for `using` declarations. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
