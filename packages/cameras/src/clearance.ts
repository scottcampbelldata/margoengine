// Whether a camera can see its subject: the ground between them, and the things standing near the sight lines (trees,
// hedges, posts) as upright cylinders. CPU only and deterministic; for placing shot cameras before rendering them.
//
// Method: rays through a regular grid of frame points and rays at points on the subject. Each ray is marched over the
// height field and cut by each cylinder (the quadratic in the ground plane, then the height range inside it). A cylinder
// passes `1 - opacity` of what crosses it, so a bare winter crown hides part of what is behind it and a trunk all of it.
// Viewpoint quality by the visible share of the subject: D. Vazquez, M. Feixas, M. Sbert and W. Heidrich, "Viewpoint
// selection using viewpoint entropy", VMV 2001, https://www.cs.ubc.ca/labs/imager/tr/2001/vazquez2001a/ ; occlusion
// of a target tested by rays to points on it, as camera controllers do: M. Christie, P. Olivier and J.-M. Normand,
// "Camera control in computer graphics", Computer Graphics Forum 27(8), 2008, https://doi.org/10.1111/j.1467-8659.2008.01181.x
import type { Vec3 } from '@margoengine/core/extension';
import { rangeError } from '../../shared/errors.js';

/** An upright cylinder in the way of a view: a trunk, a crown, a hedge bush or a post. Metres, y up. */
export interface Occluder {
  readonly x: number;
  readonly z: number;
  /** Its lowest and highest y (world heights, not heights above the ground). */
  readonly bottom: number;
  readonly top: number;
  readonly radius: number;
  /** The share of a crossing ray it stops, 0 to 1. Default 1 (solid). */
  readonly opacity?: number;
}

/** What can stand between a camera and its subject. */
export interface SightScene {
  /** Ground height at `(x, z)`. Default none (nothing is below ground). */
  readonly ground?: (x: number, z: number) => number;
  readonly occluders?: readonly Occluder[];
}

/** A camera and what it films, world coordinates. */
export interface SightView {
  readonly position: Vec3;
  readonly target: Vec3;
  /** Vertical field of view, degrees. */
  readonly fov: number;
  /** Width over height. Default 16 / 9. */
  readonly aspect?: number;
  /** The subject: its foot `centre`, `width` across and `height`, metres. Default a 1 m box centred on `target`. */
  readonly subject?: { readonly centre: Vec3; readonly width: number; readonly height: number };
}

/** What {@link sightClearance} accepts as clear. */
export interface ClearanceLimits {
  /** Least share of the subject seen, 0 to 1. Default 0.5. */
  readonly subject?: number;
  /** Foreground: nearer than this share of the distance to the subject, 0 to 1. Default 0.4. */
  readonly near?: number;
  /** Most of the frame the foreground occluders may cover, 0 to 1. Default 0.15. */
  readonly foreground?: number;
  /** Most of the frame's middle (half its width and height) they may cover, 0 to 1. Default 0.05. */
  readonly centre?: number;
  /** No occluder in frame nearer the lens than this, metres. Default 4. */
  readonly lens?: number;
}

/** The measures of one view. */
export interface Clearance {
  /** Share of the subject seen past the ground and the occluders, 0 to 1. */
  readonly subject: number;
  /** Share of the frame covered by foreground occluders, 0 to 1. */
  readonly foreground: number;
  /** The same for the frame's middle. */
  readonly centre: number;
  /** Distance to the nearest occluder in frame within the foreground or the lens limit, metres (`Infinity` for none). */
  readonly lens: number;
  /** Whether every measure is within the limits. */
  readonly clear: boolean;
  /** How far outside the limits the view is: 0 when clear, larger when worse. */
  readonly penalty: number;
}

const COLUMNS = 32,
  ROWS = 18;

/** A mutable three-vector for the working rays. */
type V3 = [number, number, number];

const check = (ok: boolean, what: string) => {
  if (!ok) throw rangeError(`Camera clearance: ${what}`, 'camera-clearance');
};

const finite3 = (v: Vec3) => v?.length === 3 && [v[0], v[1], v[2]].every(Number.isFinite);

/** Where a ray `o + t d` (unit `d`) first enters a cylinder, or `Infinity`. 0 when it starts inside. */
function enter(o: Vec3, d: Vec3, c: Occluder): number {
  const px = o[0] - c.x,
    pz = o[2] - c.z,
    a = d[0] * d[0] + d[2] * d[2],
    b = px * d[0] + pz * d[2],
    k = px * px + pz * pz - c.radius * c.radius;
  let from = 0,
    to = Infinity;
  if (a < 1e-12) {
    if (k > 0) return Infinity;
  } else {
    const disc = b * b - a * k;
    if (disc <= 0) return Infinity;
    const root = Math.sqrt(disc);
    from = Math.max(0, (-b - root) / a);
    to = (-b + root) / a;
  }
  if (Math.abs(d[1]) < 1e-12) {
    if (o[1] < c.bottom || o[1] > c.top) return Infinity;
  } else {
    const u = (c.bottom - o[1]) / d[1],
      v = (c.top - o[1]) / d[1];
    from = Math.max(from, Math.min(u, v));
    to = Math.min(to, Math.max(u, v));
  }
  return from < to ? from : Infinity;
}

/** Whether the ground rises over the ray before `end`: steps grow with distance (0.5 m near, 1% of the way far out). */
function underground(o: Vec3, d: Vec3, end: number, ground: (x: number, z: number) => number): boolean {
  for (let t = 0.5; t < end; t += Math.max(0.5, t * 0.01))
    if (o[1] + d[1] * t < ground(o[0] + d[0] * t, o[2] + d[2] * t)) return true;
  return false;
}

/**
 * Measures what a camera sees of its subject past the ground and the occluders, and whether something covers the lens or
 * the foreground. A long lens low over rising ground scores `subject` 0; a trunk a few metres off raises `centre`.
 * @throws RangeError for a view with no direction, a field of view outside (0, 180) or an
 *   occluder with a radius or height range that is not positive.
 * @example
 * const seen = sightClearance(
 *   { position: [0, 2, 100], target: [0, 2, 0], fov: 20 },
 *   { ground: () => 0, occluders: [{ x: 0, z: 92, bottom: 0, top: 15, radius: 0.6 }] },
 * );
 * if (!seen.clear) console.log(seen.centre, seen.subject);
 */
export function sightClearance(view: SightView, scene: SightScene = {}, limits: ClearanceLimits = {}): Clearance {
  const { position: o, target, fov, aspect = 16 / 9 } = view;
  check(finite3(o) && finite3(target), 'position and target must be three finite numbers');
  check(fov > 0 && fov < 180 && aspect > 0, 'fov must be inside (0, 180) degrees and aspect above 0');
  const want = {
    subject: limits.subject ?? 0.5,
    near: limits.near ?? 0.4,
    foreground: limits.foreground ?? 0.15,
    centre: limits.centre ?? 0.05,
    lens: limits.lens ?? 4,
  };
  const f: V3 = [target[0] - o[0], target[1] - o[1], target[2] - o[2]],
    reach = Math.hypot(f[0], f[1], f[2]),
    flat = Math.hypot(f[0], f[2]);
  check(flat > 1e-6, 'the view must not be empty or straight up or down');
  f[0] /= reach;
  f[1] /= reach;
  f[2] /= reach;
  // Right is level; up completes the frame.
  const r: V3 = [-f[2] * (reach / flat), 0, f[0] * (reach / flat)],
    u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]],
    th = Math.tan((fov * Math.PI) / 360),
    tw = th * aspect;
  const subject = view.subject ?? { centre: [target[0], target[1] - 0.5, target[2]] as Vec3, width: 1, height: 1 },
    away = Math.hypot(subject.centre[0] - o[0], subject.centre[2] - o[2]),
    // What stands inside the subject's own footprint is the subject, not something in front of it.
    stop = Math.max(0, away - subject.width / 2);
  // Only cylinders that can cross a ray in frame: ahead of the lens and inside the horizontal field.
  const half = Math.atan(tw),
    hx = f[0] * (reach / flat),
    hz = f[2] * (reach / flat),
    seen: Occluder[] = [];
  for (const c of scene.occluders ?? []) {
    check(c.radius > 0 && c.top > c.bottom, 'an occluder needs a radius above 0 and top above bottom');
    const dx = c.x - o[0],
      dz = c.z - o[2],
      distance = Math.hypot(dx, dz);
    if (distance - c.radius > Math.max(reach, away) + subject.width) continue;
    if (distance > c.radius) {
      const angle = Math.abs(Math.atan2(dx * hz - dz * hx, dx * hx + dz * hz));
      if (angle > half + Math.asin(c.radius / distance) + 0.02) continue;
    }
    seen.push(c);
  }
  // The frame: foreground cover and the nearest thing to the lens.
  const nearEnd = want.near * away,
    // Only what stands in the foreground or by the lens can cover the frame.
    close = Math.max(nearEnd, want.lens),
    front = seen.filter((c) => Math.hypot(c.x - o[0], c.z - o[2]) - c.radius < close);
  let covered = 0,
    middle = 0,
    middleRays = 0,
    lens = Infinity;
  for (let j = 0; j < ROWS; j++)
    for (let i = 0; i < COLUMNS; i++) {
      const sx = (((i + 0.5) / COLUMNS) * 2 - 1) * tw,
        sy = (((j + 0.5) / ROWS) * 2 - 1) * th,
        d: V3 = [f[0] + r[0] * sx + u[0] * sy, f[1] + r[1] * sx + u[1] * sy, f[2] + r[2] * sx + u[2] * sy],
        l = Math.hypot(d[0], d[1], d[2]);
      d[0] /= l;
      d[1] /= l;
      d[2] /= l;
      let pass = 1;
      for (const c of front) {
        const t = enter(o, d, c);
        if (t >= close) continue;
        // What is under the ground hides nothing.
        if (scene.ground && t < lens && underground(o, d, t, scene.ground)) continue;
        lens = Math.min(lens, t);
        if (t < nearEnd) pass *= 1 - (c.opacity ?? 1);
      }
      covered += 1 - pass;
      if (Math.abs((i + 0.5) / COLUMNS - 0.5) < 0.25 && Math.abs((j + 0.5) / ROWS - 0.5) < 0.25) {
        middle += 1 - pass;
        middleRays++;
      }
    }
  // The subject: 5 points across by 3 up, the lowest at its foot (a bank that hides the foot shows).
  const across: V3 = [r[0], 0, r[2]];
  let visible = 0,
    points = 0;
  for (const h of [0.05, 0.5, 0.95])
    for (const w of [-0.4, -0.2, 0, 0.2, 0.4]) {
      const x = subject.centre[0] + across[0] * w * subject.width,
        z = subject.centre[2] + across[2] * w * subject.width,
        // Each point stands on the ground under it, or on the subject's foot where that is higher.
        foot = Math.max(subject.centre[1], scene.ground?.(x, z) ?? subject.centre[1]),
        d: V3 = [x - o[0], foot + h * subject.height - o[1], z - o[2]],
        l = Math.hypot(d[0], d[1], d[2]);
      points++;
      if (l < 1e-6) continue;
      d[0] /= l;
      d[1] /= l;
      d[2] /= l;
      // The ground counts all the way to the point; occluders only up to the subject's footprint.
      if (scene.ground && underground(o, d, l - Math.max(1, l * 0.01), scene.ground)) continue;
      const end = (l * stop) / Math.max(away, 1e-6);
      let pass = 1;
      for (const c of seen) if (enter(o, d, c) < end) pass *= 1 - (c.opacity ?? 1);
      visible += pass;
    }
  const share = visible / points,
    foreground = covered / (COLUMNS * ROWS),
    centre = middle / middleRays,
    penalty =
      Math.max(0, want.subject - share) * 4 +
      Math.max(0, foreground - want.foreground) * 2 +
      Math.max(0, centre - want.centre) * 4 +
      (lens < want.lens ? 1 + (want.lens - lens) / want.lens : 0);
  return { subject: share, foreground, centre, lens, clear: penalty === 0, penalty };
}

/** The pick of {@link clearestShot}. */
export interface ClearShot<T> {
  readonly choice: T;
  /** Its worst view's measures. */
  readonly clearance: Clearance;
}

/**
 * The first camera choice, in the order given (best first: a turn before a lift), whose every view is clear; when none
 * is, the one whose worst view is least bad. A moving shot passes its start, middle and end as its views.
 * @throws RangeError for no choices or a choice with no views.
 * @example
 * const lifts = [1.7, 3, 6, 12];
 * const best = clearestShot(lifts, (h) => [{ position: [0, h, 100], target: [0, 2, 0], fov: 20 }], {
 *   ground: (x, z) => (Math.abs(z - 50) < 10 ? 4 : 0),
 * });
 * console.log(best.choice, best.clearance.clear); // the lowest height that sees over the bank
 */
export function clearestShot<T>(
  choices: Iterable<T>,
  views: (choice: T) => readonly SightView[],
  scene: SightScene = {},
  limits: ClearanceLimits = {},
): ClearShot<T> {
  let best: ClearShot<T> | undefined;
  for (const choice of choices) {
    let worst: Clearance | undefined;
    for (const view of views(choice)) {
      const c = sightClearance(view, scene, limits);
      if (!worst || c.penalty > worst.penalty) worst = c;
      // A view already worse than the best choice's worst cannot win.
      if (best && worst.penalty >= best.clearance.penalty) break;
    }
    check(worst !== undefined, 'every choice needs at least one view');
    const clearance = worst as Clearance;
    if (!best || clearance.penalty < best.clearance.penalty) best = { choice, clearance };
    if (best.clearance.clear) break;
  }
  check(best !== undefined, 'give at least one choice');
  return best as ClearShot<T>;
}
