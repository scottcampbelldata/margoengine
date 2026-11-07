// @margoengine/cinematic/group: several subjects in one shot. The fit is exact: a sphere touches a side of the view when
// its distance to that side's plane equals its radius, which gives the camera distance, or the field of view, in closed
// form for each subject, and the largest answer wins.
import type { CameraPose, StageContext } from './brain.js';
import { type CameraTarget, readTarget } from './target.js';

export type { CameraTarget } from './target.js';

/** One subject of a group. */
export interface GroupMember {
  target: CameraTarget;
  /** Radius of a sphere around the point that must stay in view, in world units, 0 or more. Default 0. */
  radius?: number;
  /** Pull on the centre of the shot, 0 or more; 0 leaves the member out of the shot altogether. Default 1. */
  weight?: number;
}

/** Settings of a {@link GroupFraming}. */
export interface GroupFramingOptions {
  /**
   * `'dolly'` (default) moves the camera along its view. `'zoom'` keeps the camera where it stands, aims at the group and
   * changes the field of view. `'both'` moves within its limits, then zooms for the rest.
   */
  mode?: 'dolly' | 'zoom' | 'both';
  /** Share of the screen kept clear at each side, 0 or more and below 0.5. Default 0.1. */
  padding?: number;
  /** Nearest the camera comes to the centre of the group, above 0. Default 1. */
  minDistance?: number;
  /** Farthest it goes, at least `minDistance`; may be Infinity. Default Infinity. */
  maxDistance?: number;
  /** Narrowest field of view in degrees. Default 10. */
  minFov?: number;
  /** Widest field of view in degrees, at least `minFov`, below 180. Default 100. */
  maxFov?: number;
  /** How fast the shot follows, in 1/seconds, above 0. Default 4. */
  damping?: number;
}

const checkMember = (member: GroupMember): void => {
  if (!((member.radius ?? 0) >= 0 && (member.radius ?? 0) < Infinity) || !((member.weight ?? 1) >= 0))
    throw new RangeError('Invalid group member; pass a finite radius and a weight of 0 or more');
};
const isMember = (value: CameraTarget | GroupMember): value is GroupMember => 'target' in value;

/**
 * A stage that keeps several subjects in view. It aims at their weighted centre and moves or zooms until all of them
 * fit. The view direction comes from the pose, so the stage goes after whatever sets the angle of the shot.
 */
export class GroupFraming {
  /** The subjects. Add, remove and edit them at any time. */
  readonly members: GroupMember[];
  /** The centre of the shot after the last update, smoothed, in world units. */
  readonly center = new Float64Array(3);
  /** False when the limits stopped the shot from holding every member at the last update. */
  fits = true;
  private readonly mode: 'dolly' | 'zoom' | 'both';
  private readonly padding: number;
  private readonly minDistance: number;
  private readonly maxDistance: number;
  private readonly minFov: number;
  private readonly maxFov: number;
  private readonly damping: number;
  private readonly point = new Float64Array(3);
  private readonly goal = new Float64Array(3);
  private readonly back = new Float64Array(3);
  private readonly right = new Float64Array(3);
  private readonly top = new Float64Array(3);
  private distance = 0;
  private fov = 0;
  private started = false;
  /** @throws RangeError for a value outside what {@link GroupFramingOptions} allows, or a bad member. */
  constructor(members: readonly (CameraTarget | GroupMember)[], options: GroupFramingOptions = {}) {
    const {
      mode = 'dolly',
      padding = 0.1,
      minDistance = 1,
      maxDistance = Infinity,
      minFov = 10,
      maxFov = 100,
      damping = 4,
    } = options;
    if (mode !== 'dolly' && mode !== 'zoom' && mode !== 'both')
      throw new RangeError("Invalid group mode; pass 'dolly', 'zoom' or 'both'");
    if (!(padding >= 0 && padding < 0.5)) throw new RangeError('Invalid group padding; pass 0 or more and below 0.5');
    if (!(minDistance > 0 && minDistance < Infinity && maxDistance >= minDistance))
      throw new RangeError('Invalid group distance; pass a minDistance above 0 and a maxDistance at least as large');
    if (!(minFov > 0 && maxFov >= minFov && maxFov < 180))
      throw new RangeError('Invalid group fov; pass a minFov above 0 and a maxFov at least as large, below 180');
    if (!(damping > 0 && damping < Infinity)) throw new RangeError('Invalid group damping; pass a rate above 0');
    this.members = members.map((value) => (isMember(value) ? value : { target: value }));
    this.members.forEach(checkMember);
    this.mode = mode;
    this.padding = padding;
    this.minDistance = minDistance;
    this.maxDistance = maxDistance;
    this.minFov = minFov;
    this.maxFov = maxFov;
    this.damping = damping;
  }
  /** Forgets the shot: the next update frames the group at once, as after a teleport. */
  reset(): void {
    this.started = false;
  }
  /** Writes the weighted centre to `goal`; false when no member counts. */
  private weighted(): boolean {
    const { goal, point } = this;
    let total = 0;
    goal.fill(0);
    for (const member of this.members) {
      checkMember(member);
      const weight = member.weight ?? 1;
      if (!weight) continue;
      readTarget(member.target, point);
      total += weight;
      for (let i = 0; i < 3; i++) goal[i] += point[i] * weight;
    }
    if (!total) return false;
    for (let i = 0; i < 3; i++) goal[i] /= total;
    return true;
  }
  /** The axes of a view from `back`: right and top, with up as near world up as the view allows. */
  private axes(up: Float64Array): void {
    const { back: b, right: r, top: t } = this;
    r[0] = up[1] * b[2] - up[2] * b[1];
    r[1] = up[2] * b[0] - up[0] * b[2];
    r[2] = up[0] * b[1] - up[1] * b[0];
    let size = Math.hypot(r[0], r[1], r[2]);
    if (size < 1e-9) {
      // Looking along up: any side will do.
      const small = Math.abs(b[0]) < 0.9;
      r[0] = small ? 0 : -b[2];
      r[1] = small ? b[2] : 0;
      r[2] = small ? -b[1] : b[0];
      size = Math.hypot(r[0], r[1], r[2]);
    }
    r[0] /= size;
    r[1] /= size;
    r[2] /= size;
    t[0] = b[1] * r[2] - b[2] * r[1];
    t[1] = b[2] * r[0] - b[0] * r[2];
    t[2] = b[0] * r[1] - b[1] * r[0];
  }
  /** The smallest camera distance from the centre that holds every member at these half-angle tangents. */
  private fitDistance(tanX: number, tanY: number): number {
    const { back: b, right: r, top: t, center: c, point } = this,
      sinX = tanX / Math.hypot(1, tanX),
      sinY = tanY / Math.hypot(1, tanY);
    let need = 0;
    for (const member of this.members) {
      if (!(member.weight ?? 1)) continue;
      readTarget(member.target, point);
      const qx = point[0] - c[0],
        qy = point[1] - c[1],
        qz = point[2] - c[2],
        radius = member.radius ?? 0,
        x = Math.abs(qx * r[0] + qy * r[1] + qz * r[2]),
        y = Math.abs(qx * t[0] + qy * t[1] + qz * t[2]),
        z = qx * b[0] + qy * b[1] + qz * b[2];
      need = Math.max(need, z + x / tanX + radius / sinX, z + y / tanY + radius / sinY);
    }
    return need;
  }
  /** The half-angle tangent up the screen that holds every member from `distance`, or Infinity when none can. */
  private fitTan(distance: number, aspect: number, share: number): number {
    const { back: b, right: r, top: t, center: c, point } = this;
    let need = 0;
    for (const member of this.members) {
      if (!(member.weight ?? 1)) continue;
      readTarget(member.target, point);
      const qx = point[0] - c[0],
        qy = point[1] - c[1],
        qz = point[2] - c[2],
        radius = member.radius ?? 0,
        x = Math.abs(qx * r[0] + qy * r[1] + qz * r[2]),
        y = Math.abs(qx * t[0] + qy * t[1] + qz * t[2]),
        depth = distance - (qx * b[0] + qy * b[1] + qz * b[2]);
      for (let axis = 0; axis < 2; axis++) {
        const side = axis ? y : x,
          reach = Math.hypot(side, depth);
        if (depth <= 0 || reach <= radius) return Infinity;
        const angle = Math.atan2(side, depth) + Math.asin(radius / reach);
        if (angle >= Math.PI / 2) return Infinity;
        need = Math.max(need, Math.tan(angle) / (share * (axis ? 1 : aspect)));
      }
    }
    return need;
  }
  /** Stage hook. With no member that counts it leaves the pose alone. @throws RangeError for a bad member or target. */
  update(pose: CameraPose, delta: number, context: StageContext): void {
    if (!this.weighted()) return;
    const { position, target } = pose,
      { center, goal, back } = this,
      keep = this.started ? Math.exp(-this.damping * delta) : 0;
    for (let i = 0; i < 3; i++) center[i] = goal[i] + (center[i] - goal[i]) * keep;
    const zoomOnly = this.mode === 'zoom';
    let bx = position[0] - (zoomOnly ? center[0] : target[0]),
      by = position[1] - (zoomOnly ? center[1] : target[1]),
      bz = position[2] - (zoomOnly ? center[2] : target[2]);
    const reach = Math.hypot(bx, by, bz);
    if (!(reach > 0)) {
      bx = 0;
      by = 0;
      bz = 1;
    }
    const size = reach > 0 ? reach : 1;
    back[0] = bx / size;
    back[1] = by / size;
    back[2] = bz / size;
    this.axes(pose.up);
    const share = 1 - 2 * this.padding,
      tanFov = Math.tan((pose.fov * Math.PI) / 360) * share,
      minD = this.minDistance,
      maxD = this.maxDistance;
    let wantDistance = zoomOnly ? reach : this.fitDistance(tanFov * context.aspect, tanFov);
    const fitted = wantDistance;
    if (!zoomOnly) wantDistance = Math.min(maxD, Math.max(minD, wantDistance));
    let wantFov = pose.fov,
      fits = zoomOnly || wantDistance >= fitted;
    if (this.mode !== 'dolly') {
      const tan = this.fitTan(wantDistance, context.aspect, share),
        low = this.minFov,
        high = this.maxFov,
        fov = tan === Infinity ? Infinity : (Math.atan(tan) * 360) / Math.PI;
      // 'both' only zooms for what the distance limits left over.
      const free = zoomOnly || wantDistance !== fitted;
      if (free) wantFov = Math.min(high, Math.max(low, fov));
      fits = fov <= high;
    }
    if (this.started) {
      this.distance = wantDistance + (this.distance - wantDistance) * keep;
      this.fov = wantFov + (this.fov - wantFov) * keep;
    } else {
      this.distance = wantDistance;
      this.fov = wantFov;
    }
    this.started = true;
    this.fits = fits;
    pose.fov = this.fov;
    for (let i = 0; i < 3; i++) {
      target[i] = center[i];
      if (!zoomOnly) position[i] = center[i] + back[i] * this.distance;
    }
  }
}
