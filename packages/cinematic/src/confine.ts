// @margoengine/cinematic/confine: walls for the camera. The result is always inside, so it holds whatever the stages
// before it did. A box is a clamp; an area is a polygon on the ground, handled by the nearest point of its outline.
import type { CameraPose } from './brain.js';

/** A {@link CameraConfiner} shape: a box. */
export interface ConfineBox {
  /** Lowest corner, in world units. */
  min: readonly [number, number, number];
  /** Highest corner. */
  max: readonly [number, number, number];
}

/** A {@link CameraConfiner} shape: an area of the level, as an outline on the ground (world x and z), convex or not. */
export interface ConfineArea {
  /** At least 3 [x, z] points in order, either way round. The outline must not cross itself. */
  area: readonly (readonly [number, number])[];
  /** Lowest camera height, world y. Default no limit. */
  bottom?: number;
  /** Highest camera height, world y. Default no limit. */
  top?: number;
}

/** Settings of a {@link CameraConfiner}. */
export interface CameraConfinerOptions {
  /** Space kept between the camera and every wall, 0 or more, in world units. Default 0. */
  margin?: number;
}

/** Passes of the push away from walls; a corner takes three, a narrow gap settles on the wall in the end. */
const PASSES = 8;
/** A point this close to the margin has cleared it, so a camera held on the margin stays still. */
const SLACK = 1 - 1e-9;

/**
 * A stage that keeps the camera inside a box or an area, however it got out. Put it last on a camera, after noise, or in
 * `brain.stages` to hold blends too. The camera keeps looking at the same point.
 */
export class CameraConfiner {
  /** True when the last update had to move the camera. */
  clamped = false;
  /** How far the last update moved the camera, in world units. */
  correction = 0;
  private readonly margin: number;
  private readonly low = new Float64Array([-Infinity, -Infinity, -Infinity]);
  private readonly high = new Float64Array([Infinity, Infinity, Infinity]);
  private readonly outline?: Float64Array;
  private readonly orientation: number = 1;
  private readonly near = new Float64Array(4);
  private edge = -1;
  /** @throws RangeError for a shape that is empty, or smaller than its margins. */
  constructor(shape: ConfineBox | ConfineArea, options: CameraConfinerOptions = {}) {
    const { margin = 0 } = options;
    if (typeof shape !== 'object' || shape === null)
      throw new RangeError('Invalid confiner shape; pass a box {min, max} or an area {area}');
    if (!(margin >= 0 && margin < Infinity)) throw new RangeError('Invalid confiner margin; pass 0 or more');
    this.margin = margin;
    if ('area' in shape) {
      const { area, bottom = -Infinity, top = Infinity } = shape;
      if (!Array.isArray(area) || area.length < 3)
        throw new RangeError('Invalid confiner area; pass at least 3 [x, z] points');
      const outline = new Float64Array(area.length * 2);
      area.forEach((point, i) => {
        const x = point?.[0],
          z = point?.[1];
        if (!(Number.isFinite(x) && Number.isFinite(z)))
          throw new RangeError('Invalid confiner area; pass at least 3 [x, z] points, all finite');
        outline[i * 2] = x;
        outline[i * 2 + 1] = z;
      });
      let twice = 0;
      for (let i = 0, n = area.length; i < n; i++) {
        const j = (i + 1) % n;
        twice += outline[i * 2] * outline[j * 2 + 1] - outline[j * 2] * outline[i * 2 + 1];
      }
      if (!twice) throw new RangeError('Invalid confiner area; pass an outline with some area');
      this.outline = outline;
      this.orientation = Math.sign(twice);
      this.low[1] = bottom + margin;
      this.high[1] = top - margin;
    } else {
      const { min, max } = shape;
      for (let i = 0; i < 3; i++) {
        if (!(Number.isFinite(min?.[i]) && Number.isFinite(max?.[i])))
          throw new RangeError('Invalid confiner box; pass finite min and max corners');
        this.low[i] = min[i] + margin;
        this.high[i] = max[i] - margin;
      }
    }
    for (let i = 0; i < 3; i++)
      if (!(this.low[i] <= this.high[i]))
        throw new RangeError('Invalid confiner bounds; each low side must be below its high side, margins included');
  }
  /** Writes the nearest point of the outline to `near`, with the inward normal of its edge. Returns the distance. */
  private nearest(x: number, z: number): number {
    const o = this.outline!,
      near = this.near,
      n = o.length / 2;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n,
        ax = o[i * 2],
        az = o[i * 2 + 1],
        ex = o[j * 2] - ax,
        ez = o[j * 2 + 1] - az,
        size = ex * ex + ez * ez,
        t = size ? Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / size)) : 0,
        px = ax + ex * t,
        pz = az + ez * t,
        d = Math.hypot(x - px, z - pz);
      if (d < best && size) {
        best = d;
        this.edge = i;
        const l = Math.sqrt(size) * this.orientation;
        near[0] = px;
        near[1] = pz;
        near[2] = -ez / l;
        near[3] = ex / l;
      }
    }
    return best;
  }
  /** Writes to `near` the corner where the margins of two edges meet. False when the edges are parallel. */
  private meet(a: number, b: number): boolean {
    const o = this.outline!,
      n = o.length / 2,
      line = (i: number): [number, number, number] => {
        const j = (i + 1) % n,
          ex = o[j * 2] - o[i * 2],
          ez = o[j * 2 + 1] - o[i * 2 + 1],
          l = Math.hypot(ex, ez) * this.orientation,
          nx = -ez / l,
          nz = ex / l;
        return [nx, nz, nx * o[i * 2] + nz * o[i * 2 + 1] + this.margin];
      },
      [ax, az, ac] = line(a),
      [bx, bz, bc] = line(b),
      det = ax * bz - az * bx;
    if (Math.abs(det) < 1e-9) return false;
    this.near[0] = (ac * bz - bc * az) / det;
    this.near[1] = (ax * bc - bx * ac) / det;
    return true;
  }
  /** Even-odd rule: a ray along +x crosses the outline an odd number of times from inside. */
  private inside(x: number, z: number): boolean {
    const o = this.outline!,
      n = o.length / 2;
    let odd = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const az = o[i * 2 + 1],
        bz = o[j * 2 + 1];
      if (az > z !== bz > z && x < o[i * 2] + ((z - az) / (bz - az)) * (o[j * 2] - o[i * 2])) odd = !odd;
    }
    return odd;
  }
  private holdArea(position: Float64Array): void {
    const near = this.near,
      margin = this.margin,
      clear = margin * SLACK;
    let x = position[0],
      z = position[2],
      last = -1,
      before = -1;
    for (let pass = 0; pass < PASSES; pass++) {
      const inside = this.inside(x, z),
        distance = this.nearest(x, z);
      if (inside && distance >= clear) {
        position[0] = x;
        position[2] = z;
        return;
      }
      // Two walls pushing the camera back and forth are a corner too sharp for pushes to settle in: go to its tip.
      const edge = this.edge,
        corner = edge === before && edge !== last && this.meet(edge, last);
      before = last;
      last = edge;
      if (corner) {
        x = near[0];
        z = near[1];
        continue;
      }
      // Away from the wall through the nearest point; on the wall itself the edge says which way is in.
      const away = distance > 1e-12 ? (inside ? 1 : -1) / distance : 0,
        nx = away ? (x - near[0]) * away : near[2],
        nz = away ? (z - near[1]) * away : near[3];
      x = near[0] + nx * margin;
      z = near[1] + nz * margin;
    }
    // A gap narrower than two margins has no spot that clears both walls: the wall itself is inside.
    if (!this.inside(x, z)) {
      this.nearest(x, z);
      x = near[0];
      z = near[1];
    }
    position[0] = x;
    position[2] = z;
  }
  /** Stage hook. */
  update(pose: CameraPose): void {
    const { position } = pose,
      x = position[0],
      y = position[1],
      z = position[2];
    for (let i = 0; i < 3; i++) position[i] = Math.min(this.high[i], Math.max(this.low[i], position[i]));
    if (this.outline) this.holdArea(position);
    this.correction = Math.hypot(position[0] - x, position[1] - y, position[2] - z);
    this.clamped = this.correction > 0;
  }
}
