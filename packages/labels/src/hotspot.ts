import { createScreenPoint, projectPoint, type Backend, type ScreenPoint } from '@margoengine/math/mat4';
import { rangeError } from '../../shared/errors.js';

/** One posed primitive: stride-20 interleaved vertices (xyz first), triangle indices and the node's world matrix. */
export interface HotspotSnapshot {
  vertices: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** Column-major 4x4 world matrix of the primitive's node. */
  matrix: ArrayLike<number>;
  primitiveIndex?: number;
}
/** Anything that poses a mesh on demand: `Skin.picking` from `@margoengine/animation`, or a morph or physics source with the same method. */
export interface HotspotSource {
  posePickingGeometry(): readonly HotspotSnapshot[];
}
/** Where a hotspot sits: a triangle of a primitive and weights of its three corners. */
export interface HotspotOptions {
  /** Index of the primitive (default 0). */
  primitiveIndex?: number;
  /** Triangle index: its corners are `indices[3 * face .. 3 * face + 2]`. */
  face: number;
  /** Weights of the triangle's first, second and third corner; must be 0 or more and sum to 1 (within 1e-3). Default the centre. */
  barycentric?: readonly [number, number, number];
}

/**
 * A fixed point inside a triangle of a deformed mesh (skinned or morphed): its world position is the barycentric
 * blend of the triangle's three posed corners, so it follows the surface as the pose changes. `project` gives its
 * screen position for a label. The blend P = wa*A + wb*B + wc*C is the standard affine combination of a triangle's
 * corners (Moebius, 1827, "Der barycentrische Calcul").
 */
export class Hotspot {
  readonly primitiveIndex: number;
  readonly face: number;
  readonly barycentric: readonly [number, number, number];
  private readonly point: ScreenPoint = createScreenPoint();
  constructor(
    private readonly source: HotspotSource,
    options: HotspotOptions,
  ) {
    const b = options.barycentric ?? [1 / 3, 1 / 3, 1 / 3];
    if (
      !Number.isInteger(options.face) ||
      options.face < 0 ||
      b.length !== 3 ||
      !b.every((w) => Number.isFinite(w) && w >= -1e-6) ||
      Math.abs(b[0] + b[1] + b[2] - 1) > 1e-3
    )
      throw rangeError(
        'Hotspot needs an integer face of 0 or more and three barycentric weights of 0 or more that sum to 1; fix the options',
        'labels',
      );
    this.primitiveIndex = options.primitiveIndex ?? 0;
    this.face = options.face;
    this.barycentric = [b[0], b[1], b[2]];
    this.snapshot();
  }
  /** A hotspot where a pick hit the mesh: takes `primitiveIndex`, `faceIndex` and `barycoord` from a `Raycaster` hit. */
  static fromHit(
    source: HotspotSource,
    hit: { primitiveIndex?: number; faceIndex: number; barycoord: ArrayLike<number> },
  ): Hotspot {
    return new Hotspot(source, {
      primitiveIndex: hit.primitiveIndex,
      face: hit.faceIndex,
      barycentric: [hit.barycoord[0], hit.barycoord[1], hit.barycoord[2]],
    });
  }
  private snapshot(): HotspotSnapshot {
    const list = this.source.posePickingGeometry(),
      s = list.find((p, i) => (p.primitiveIndex ?? i) === this.primitiveIndex);
    if (!s || this.face * 3 + 2 >= s.indices.length)
      throw rangeError(
        'Hotspot primitive or face is not in the posed mesh; pass a primitiveIndex and face that exist',
        'labels',
      );
    return s;
  }
  /** World position at the current pose. `out` is written and returned (default a new array). */
  worldPosition(out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const s = this.snapshot(),
      m = s.matrix;
    let x = 0,
      y = 0,
      z = 0;
    for (let c = 0; c < 3; c++) {
      const at = s.indices[this.face * 3 + c] * 20,
        w = this.barycentric[c];
      x += w * s.vertices[at];
      y += w * s.vertices[at + 1];
      z += w * s.vertices[at + 2];
    }
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    return out;
  }
  /**
   * Screen position in CSS pixels at the current pose. `matrix` is the camera's view-projection (`camera.matrix`).
   * The returned point is reused by the next call.
   */
  project(matrix: ArrayLike<number>, width: number, height: number, backend: Backend = 'webgpu'): ScreenPoint {
    const [x, y, z] = this.worldPosition();
    return projectPoint(matrix, x, y, z, width, height, backend, this.point);
  }
  /** Moves a label to the hotspot's current world position; call it each frame after the pose updates. */
  pin(label: { setPosition(position: [number, number, number]): unknown }): void {
    label.setPosition(this.worldPosition());
  }
}
