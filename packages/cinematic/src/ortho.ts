import {
  VirtualCamera,
  type CameraPose,
  type CameraStage,
  type StageContext,
  type VirtualCameraOptions,
} from './brain.js';
import type { FramingComposerOptions } from './composer.js';
import type { GroupMember } from './group.js';
import { type CameraTarget, readTarget } from './target.js';

/** A virtual camera with an orthographic world height instead of a perspective field of view. */
export interface OrthographicCameraOptions extends Omit<VirtualCameraOptions, 'orthographicHeight'> {
  /** Full visible world height; width is height times aspect. Default 10. */
  height?: number;
}

const positive = (value: number, name: string): void => {
  if (!(value > 0 && Number.isFinite(value)))
    throw new RangeError(
      `Invalid orthographic ${name}; pass a finite value above 0. https://margoengine.com/docs/limits#cinematic-orthographic`,
    );
};
const heightOf = (pose: CameraPose): number => {
  const height = pose.orthographicHeight ?? 0;
  positive(height, 'height');
  return height;
};
const deltaCheck = (delta: number): void => {
  if (!(delta >= 0 && Number.isFinite(delta)))
    throw new RangeError('Invalid orthographic delta; pass finite seconds of 0 or more');
};

/** Add this camera to a CameraBrain; ordinary rigStage follow, noise, dolly and confiner stages still work. */
export class OrthographicCamera extends VirtualCamera {
  /** @throws RangeError for invalid camera options or height. */
  constructor({ height = 10, ...options }: OrthographicCameraOptions = {}) {
    positive(height, 'height');
    super({ ...options, orthographicHeight: height });
  }
  /** Full visible world height; changes the base pose before stages. */
  get height(): number {
    return this.base.orthographicHeight!;
  }
  /** @throws RangeError for a nonpositive or nonfinite height. */
  set height(value: number) {
    positive(value, 'height');
    this.base.orthographicHeight = value;
  }
}

/** A CameraProjection from cameras, structurally typed so this entry does not import that package. */
export interface OrthographicProjectionTarget {
  mode: 'orthographic' | 'perspective';
  height?: number;
  zoom: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

/**
 * Brain output stage: copy the blended world height to CameraProjection, replacing explicit bounds and zoom.
 * Perspective poses switch the projection back to perspective. Put this after the stages that change height.
 * @throws RangeError for a nonpositive or nonfinite authored orthographic height.
 */
export function orthographicOutput(projection: OrthographicProjectionTarget): CameraStage {
  return (pose) => {
    const height = pose.orthographicHeight;
    if (height === undefined) {
      projection.mode = 'perspective';
      return;
    }
    positive(height, 'height');
    projection.mode = 'orthographic';
    projection.height = height;
    projection.zoom = 1;
    projection.left = projection.right = projection.top = projection.bottom = undefined;
  };
}

// Right and screen-up, including roll and vertical views; the output is reused by both framing stages.
function axes(pose: CameraPose, right: Float64Array, up: Float64Array): void {
  let fx = pose.target[0] - pose.position[0],
    fy = pose.target[1] - pose.position[1],
    fz = pose.target[2] - pose.position[2];
  const length = Math.hypot(fx, fy, fz);
  positive(length, 'view direction');
  fx /= length;
  fy /= length;
  fz /= length;
  let ux = pose.up[0],
    uy = pose.up[1],
    uz = pose.up[2];
  positive(Math.hypot(ux, uy, uz), 'up direction');
  let rx = fy * uz - fz * uy,
    ry = fz * ux - fx * uz,
    rz = fx * uy - fy * ux;
  let r = Math.hypot(rx, ry, rz);
  if (r <= 1e-9 * Math.hypot(ux, uy, uz)) {
    ux = Math.abs(fx) < 0.9 ? 1 : 0;
    uy = Math.abs(fx) < 0.9 ? 0 : 1;
    uz = 0;
    rx = fy * uz - fz * uy;
    ry = fz * ux - fx * uz;
    rz = fx * uy - fy * ux;
    r = Math.hypot(rx, ry, rz);
  }
  rx /= r;
  ry /= r;
  rz /= r;
  ux = ry * fz - rz * fy;
  uy = rz * fx - rx * fz;
  uz = rx * fy - ry * fx;
  const c = Math.cos(pose.roll),
    s = Math.sin(pose.roll);
  right.set([rx * c - ux * s, ry * c - uy * s, rz * c - uz * s]);
  up.set([ux * c + rx * s, uy * c + ry * s, uz * c + rz * s]);
}
const dot = (a: Float64Array, b: Float64Array): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp = (x: number, low: number, high: number): number => Math.max(low, Math.min(high, x));
const pair = (value: number | readonly [number, number], name: string): readonly [number, number] => {
  const p = typeof value === 'number' ? ([value, value] as const) : value;
  if (p?.length !== 2 || !p.every(Number.isFinite))
    throw new RangeError(`Invalid orthographic ${name}; pass two finite numbers`);
  return p;
};

/**
 * Translate an orthographic view to frame a subject, preserving its direction and distance. Uses the same screen,
 * zones, damping and lookahead options as FramingComposer, including arbitrary up and camera roll.
 */
export class OrthographicFraming {
  /** Subject to frame; call reset after changing it when an immediate snap is desired. */
  target: CameraTarget;
  /** Predicted subject's screen point, from top left, after the last update. */
  readonly onScreen = new Float64Array([0.5, 0.5]);
  /** Subject position after velocity lookahead, in world units. */
  readonly aimPoint = new Float64Array(3);
  private readonly screen: readonly [number, number];
  private readonly dead: readonly [number, number];
  private readonly soft: readonly [number, number];
  private readonly rate: readonly [number, number];
  private readonly lookahead: number;
  private readonly smoothing: number;
  private readonly vertical: boolean;
  private readonly point = new Float64Array(3);
  private readonly previous = new Float64Array(3);
  private readonly velocity = new Float64Array(3);
  private readonly offset = new Float64Array(3);
  private readonly right = new Float64Array(3);
  private readonly up = new Float64Array(3);
  private readonly relative = new Float64Array(3);
  private started = false;
  /** @throws RangeError for invalid screen shares, zone sizes, damping or lookahead. */
  constructor(
    target: CameraTarget,
    {
      screen = [0.5, 0.5],
      deadZone = [0.1, 0.1],
      softZone = [0.8, 0.8],
      damping = 4,
      lookahead = 0,
      lookaheadSmoothing = 6,
      lookaheadVertical = true,
    }: FramingComposerOptions = {},
  ) {
    this.target = target;
    this.screen = [...pair(screen, 'screen')];
    this.dead = [...pair(deadZone, 'deadZone')];
    this.soft = [...pair(softZone, 'softZone')];
    this.rate = [...pair(damping, 'damping')];
    for (let i = 0; i < 2; i++) {
      if (!(this.screen[i] >= 0 && this.screen[i] <= 1 && this.dead[i] >= 0 && this.soft[i] >= this.dead[i]))
        throw new RangeError(
          'Invalid orthographic zones; pass screen in 0..1 and nonnegative deadZone no larger than softZone',
        );
      positive(this.rate[i], 'damping');
    }
    if (!(lookahead >= 0 && Number.isFinite(lookahead)))
      throw new RangeError('Invalid orthographic lookahead; pass finite seconds of 0 or more');
    positive(lookaheadSmoothing, 'lookahead smoothing');
    this.lookahead = lookahead;
    this.smoothing = lookaheadSmoothing;
    this.vertical = lookaheadVertical;
  }
  /** Forget translation and measured velocity; the next update snaps to the screen point. */
  reset(): void {
    this.started = false;
    this.offset.fill(0);
    this.velocity.fill(0);
  }
  /** Stage hook. @throws RangeError for invalid pose, delta, aspect or target. */
  update(pose: CameraPose, delta: number, { aspect }: StageContext): void {
    deltaCheck(delta);
    positive(aspect, 'aspect');
    const height = heightOf(pose),
      { point, previous, velocity, offset, right, up, relative } = this;
    readTarget(this.target, point);
    axes(pose, right, up);
    const keep = Math.exp(-this.smoothing * delta);
    for (let i = 0; i < 3; i++) {
      if (this.started && delta > 0) velocity[i] += ((point[i] - previous[i]) / delta - velocity[i]) * (1 - keep);
      previous[i] = point[i];
    }
    const upLength = Math.hypot(...pose.up),
      along = this.vertical ? 0 : dot(velocity, pose.up) / (upLength * upLength);
    for (let i = 0; i < 3; i++) {
      this.aimPoint[i] = point[i] + (velocity[i] - along * pose.up[i]) * this.lookahead;
      relative[i] = this.aimPoint[i] - pose.position[i] - offset[i];
    }
    const x = 0.5 + dot(relative, right) / (height * aspect),
      y = 0.5 - dot(relative, up) / height;
    const projected = [x, y],
      goal = [this.screen[0], this.screen[1]];
    if (this.started)
      for (let i = 0; i < 2; i++) {
        const e = projected[i] - this.screen[i],
          dead = clamp(e, -this.dead[i] / 2, this.dead[i] / 2);
        goal[i] += clamp(dead + (e - dead) * Math.exp(-this.rate[i] * delta), -this.soft[i] / 2, this.soft[i] / 2);
      }
    const dx = (x - goal[0]) * height * aspect,
      dy = (goal[1] - y) * height;
    for (let i = 0; i < 3; i++) {
      offset[i] += dx * right[i] + dy * up[i];
      pose.position[i] += offset[i];
      pose.target[i] += offset[i];
    }
    this.onScreen.set(goal);
    this.started = true;
  }
}

/** Orthographic group fit settings; radii and weights have the same meanings as GroupFraming. */
export interface OrthographicGroupOptions {
  /** Screen share kept clear at every edge, 0 to below 0.5. Default 0.1. */
  padding?: number;
  /** Minimum full world height. Default 0.01. */
  minHeight?: number;
  /** Maximum full world height, at least minHeight; Infinity is allowed. Default Infinity. */
  maxHeight?: number;
  /** Exponential catch-up rate in inverse seconds. Default 4. */
  damping?: number;
}

/** Aim at a weighted group centre and fit projected spheres by changing orthographic height, preserving view angle. */
export class OrthographicGroupFraming {
  /** Mutable group membership. Weight 0 omits a member. */
  readonly members: GroupMember[];
  /** Smoothed weighted centre after the last update. */
  readonly center = new Float64Array(3);
  /** Whether all participating spheres fit the padded screen at the actual output height. */
  fits = true;
  private readonly padding: number;
  private readonly min: number;
  private readonly max: number;
  private readonly rate: number;
  private readonly points: Float64Array[] = [];
  private readonly right = new Float64Array(3);
  private readonly up = new Float64Array(3);
  private readonly relative = new Float64Array(3);
  private readonly goal = new Float64Array(3);
  private height = 0;
  private started = false;
  /** @throws RangeError for invalid padding, size limits or damping. */
  constructor(
    members: readonly (CameraTarget | GroupMember)[],
    { padding = 0.1, minHeight = 0.01, maxHeight = Infinity, damping = 4 }: OrthographicGroupOptions = {},
  ) {
    positive(minHeight, 'minimum height');
    positive(damping, 'damping');
    if (!(maxHeight >= minHeight && padding >= 0 && padding < 0.5))
      throw new RangeError(
        'Invalid orthographic group; pass maxHeight at least minHeight and padding from 0 to below 0.5',
      );
    this.padding = padding;
    this.min = minHeight;
    this.max = maxHeight;
    this.rate = damping;
    this.members = members.map((m) => ('target' in m ? { ...m } : { target: m }));
  }
  /** Forget smoothing; the next update fits immediately. */
  reset(): void {
    this.started = false;
  }
  /** Stage hook. @throws RangeError for an invalid pose, delta, aspect, member radius, weight or target. */
  update(pose: CameraPose, delta: number, { aspect }: StageContext): void {
    deltaCheck(delta);
    positive(aspect, 'aspect');
    heightOf(pose);
    const { goal, relative, right, up } = this;
    axes(pose, right, up);
    goal.fill(0);
    let total = 0;
    for (const member of this.members) {
      const weight = member.weight ?? 1,
        radius = member.radius ?? 0;
      if (!(weight >= 0 && Number.isFinite(weight) && radius >= 0 && Number.isFinite(radius)))
        throw new RangeError('Invalid orthographic member; pass finite nonnegative radius and weight');
      total += weight;
    }
    if (!Number.isFinite(total))
      throw new RangeError('Invalid orthographic group weight; reduce weights to a finite sum');
    if (!total) {
      this.fits = true;
      this.started = false;
      return;
    }
    for (let i = 0; i < this.members.length; i++) {
      const member = this.members[i],
        weight = member.weight ?? 1;
      if (!weight) continue;
      const p = (this.points[i] ??= new Float64Array(3));
      readTarget(member.target, p);
      for (let k = 0; k < 3; k++) goal[k] += p[k] * (weight / total);
    }
    const keep = this.started ? Math.exp(-this.rate * delta) : 0;
    for (let k = 0; k < 3; k++) this.center[k] = goal[k] + (this.center[k] - goal[k]) * keep;
    let required = this.min;
    for (let i = 0; i < this.members.length; i++) {
      const member = this.members[i];
      if (!(member.weight ?? 1)) continue;
      for (let k = 0; k < 3; k++) relative[k] = this.points[i][k] - this.center[k];
      const radius = member.radius ?? 0;
      required = Math.max(
        required,
        (2 * (Math.abs(dot(relative, right)) + radius)) / (aspect * (1 - 2 * this.padding)),
        (2 * (Math.abs(dot(relative, up)) + radius)) / (1 - 2 * this.padding),
      );
    }
    const desired = clamp(required, this.min, this.max);
    this.height = desired + (this.height - desired) * keep;
    this.fits = required <= this.height * (1 + 1e-12);
    for (let k = 0; k < 3; k++) {
      pose.position[k] += this.center[k] - pose.target[k];
      pose.target[k] = this.center[k];
    }
    pose.orthographicHeight = this.height;
    this.started = true;
  }
}
