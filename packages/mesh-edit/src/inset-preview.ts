/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math';
import { MeshRegionInsetSession, cloneInsetResult } from './inset-session.js';
import type { RegionInsetResult } from './inset.js';
import { snapshotPaintScene } from './paint-snapshot.js';
import { appendPaintIslandIndex, paintIslandIndex, type PaintIslandIndex } from './paint-common.js';
import { fillPreparedMeshPaintFaces } from './paint.js';
import { allocatePreparedFaceUV, prepareFaceUVAllocation } from './uv.js';
import { clonePolygonMesh } from './result.js';
import type { MeshEditOptions, PolygonMesh } from './types.js';
import type { PaintAtlas, PaintGeometry, PaintObject, PaintOptions, PaintScene } from './paint-types.js';

/** Options for one preview: UV density and an optional border fill. Without `color` the atlas is unchanged. */
export interface RegionInsetPreviewOptions extends PaintOptions {
  /** Texels per world unit for the new islands, 0.25 to 128; default 16. A full atlas throws rather than lowering it. */
  pixelsPerUnit?: number;
  /** Hex colour for the border faces. Each preview starts from the captured atlas, not the previous fill. */
  color?: string;
}
/** One preview: the inset result, its geometry with the new UVs, and the filled atlas (null without a fill). */
export interface RegionInsetPreviewResult {
  topology: RegionInsetResult;
  geometry: PaintGeometry;
  texture: PaintAtlas | null;
}
type Frame = {
  width: number;
  density: number;
  topology: RegionInsetResult;
  geometry: PaintGeometry;
  scene: PaintScene;
  index: PaintIslandIndex | null;
};
function strictGeometry(object: PaintObject): PolygonMesh {
  return {
    vertices: object.vertices,
    faces: object.faces.map((face) => ({
      id: face.id,
      vertices: face.vertices,
      uv: face.uv.map((uv) => {
        if (uv.length !== 2 || uv.some((value) => !Number.isFinite(value)))
          throw new TypeError('Inset preview needs finite two-component corner UVs; repair the source face UVs first.');
        return [uv[0], uv[1]];
      }),
    })),
  };
}

/**
 * Live inset preview for an editor: inset geometry, UV islands for the new border faces and an optional border
 * fill, in one object.
 * The constructor copies the scene's geometry, UVs, transforms, eligibility and RGBA bytes; recapture after any
 * document, atlas or policy change. UV allocation follows the same rules as `allocateMeshFaceUV`. Only the last
 * width and density are cached, so changing just the colour or dither reuses the layout; a new width or density
 * rebuilds it at exactly that density. Width 0 or an empty selection creates no IDs or islands. A failed width
 * returns nothing and leaves the cache intact. Each result owns its arrays.
 * @throws TypeError for a bad scene, selection, UVs, options, colour or ID; RangeError for a bad matrix, width or
 * density, collapsed geometry or a full atlas; MargoError `unsupported` for an unsupported region, `state` when
 * called from inside its own `createId`, and `disposed` after dispose.
 */
export class MeshRegionInsetPreview {
  #scene: PaintScene | null;
  #object: PaintObject | null;
  #kernel: MeshRegionInsetSession;
  #allocation: ReturnType<typeof prepareFaceUVAllocation> | null = null;
  #baseIndex: PaintIslandIndex | null = null;
  #frame: Frame | null = null;
  #busy = false;
  constructor(input: PaintScene, objectId: string, faceIds: readonly string[], options: MeshEditOptions = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new TypeError('Inset preview constructor options need an object; supply createId or omit options.');
    const scene = snapshotPaintScene(input),
      object = scene.objects.find((o) => o.id === objectId);
    if (!object) throw new TypeError('Inset preview needs an existing object ID; select a mesh in the captured scene.');
    if (!object.canProject) throw new TypeError('Inset preview needs a projectable mesh; unlock projection first.');
    // Draft paint UVs are not converted or repaired: the ordinary geometry constructor checks strict corner UVs.
    this.#kernel = new MeshRegionInsetSession(strictGeometry(object), faceIds, {
      ...options,
      worldMatrix: object.worldMatrix,
    });
    this.#scene = scene;
    this.#object = object;
  }
  /** Whether {@link MeshRegionInsetPreview.dispose} has been called. */
  get disposed(): boolean {
    return this.#scene === null;
  }
  #open(): PaintScene {
    if (!this.#scene)
      throw new MargoError('disposed', 'Inset preview is disposed; capture a new MeshRegionInsetPreview.');
    return this.#scene;
  }
  /** Preview the inset at `width`, with new UV islands and an optional border fill. */
  inset(width = 0.1, options: RegionInsetPreviewOptions = {}): RegionInsetPreviewResult {
    const scene = this.#open();
    if (this.#busy)
      throw new MargoError(
        'state',
        'Inset preview cannot reenter an active callback; finish the current preview before updating again.',
      );
    this.#busy = true;
    try {
      if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new TypeError('Inset preview options need an object; supply pixelsPerUnit/color or omit options.');
      const requested = options.pixelsPerUnit,
        density = requested === undefined ? 16 : requested,
        color = options.color;
      this.#open();
      let frame = this.#frame;
      if (!frame || frame.width !== width || frame.density !== density) {
        const topology = this.#kernel.inset(width);
        let geometry: PaintGeometry = topology.mesh;
        if (topology.changed) {
          const object = this.#object!;
          this.#allocation ??= prepareFaceUVAllocation(
            object.id,
            object.faces.map((f) => f.id),
            scene.objects,
            [scene.texture.width, scene.texture.height],
          );
          geometry = allocatePreparedFaceUV({ ...object, ...topology.mesh }, this.#allocation, density);
        }
        const objects = scene.objects.map((o) => (o.id === this.#object!.id ? { ...o, ...geometry } : o));
        frame = { width, density, topology, geometry, scene: { objects, texture: scene.texture }, index: null };
        this.#open();
        this.#frame = frame;
      }
      let texture: PaintAtlas | null = null;
      if (frame.topology.changed && color !== undefined) {
        if (!frame.index) {
          this.#baseIndex ??= paintIslandIndex(scene);
          const originalIds = new Set(this.#object!.faces.map((f) => f.id));
          frame.index = appendPaintIslandIndex(
            frame.scene,
            this.#baseIndex,
            this.#object!.id,
            frame.geometry.faces.filter((f) => !originalIds.has(f.id)),
          );
        }
        texture = fillPreparedMeshPaintFaces(
          frame.scene,
          frame.topology.borderFaces.map((f) => ({ objectId: this.#object!.id, faceId: f.faceId })),
          color,
          { mode: options.mode, secondaryColor: options.secondaryColor },
          frame.index,
        );
      }
      this.#open();
      return { topology: cloneInsetResult(frame.topology), geometry: clonePolygonMesh(frame.geometry), texture };
    } finally {
      this.#busy = false;
    }
  }
  /** Release everything captured. Safe to call more than once. */
  dispose(): void {
    this.#kernel.dispose();
    this.#scene = null;
    this.#object = null;
    this.#allocation = null;
    this.#baseIndex = null;
    this.#frame = null;
  }
  /** Same as `dispose()`, for `using` declarations. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
