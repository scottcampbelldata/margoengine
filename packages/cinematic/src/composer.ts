// @margoengine/cinematic/composer: framing for a moving subject. The camera turns only as much as the zones ask, so a
// small move of the subject leaves the picture still. The turn is solved exactly: given where the subject should land on
// screen, one closed form gives the pitch and the heading with no roll, so nothing drifts or needs iterating.
import type { CameraPose, StageContext } from './brain.js';
import { type CameraTarget, readTarget } from './target.js';

export type { CameraTarget } from './target.js';

/** Settings of a {@link FramingComposer}. Screen sizes are shares of the screen: 1 is its full width or height. */
export interface FramingComposerOptions {
  /** Where the subject sits, as [x, y] from the top left: [0.5, 0.5] is the centre. Default [0.5, 0.5]. */
  screen?: readonly [number, number];
  /** Full [width, height] of the box around `screen` where the subject moves freely. Default [0.1, 0.1]. */
  deadZone?: readonly [number, number];
  /** Full [width, height] of the box the subject never leaves; between the boxes the camera catches up. At least `deadZone`. Default [0.8, 0.8]. */
  softZone?: readonly [number, number];
  /** How fast the camera catches up, in 1/seconds (higher is stiffer), as one number or [horizontal, vertical]. Above 0. Default 4. */
  damping?: number | readonly [number, number];
  /** Seconds to aim ahead of the subject along its velocity, 0 or more. Default 0. */
  lookahead?: number;
  /** How fast the measured velocity follows the subject, in 1/seconds, above 0. Lower is calmer. Default 6. */
  lookaheadSmoothing?: number;
  /** Aim ahead vertically too. Turn it off for a platformer, so a jump does not nod the camera. Default true. */
  lookaheadVertical?: boolean;
}

const pair = (value: number | readonly [number, number], what: string): readonly [number, number] => {
  const both = typeof value === 'number' ? ([value, value] as const) : value;
  if (both?.length !== 2 || !(Number.isFinite(both[0]) && Number.isFinite(both[1])))
    throw new RangeError(`Invalid composer ${what}; pass two finite numbers`);
  return both;
};
/** How far short of straight up or down the view may turn, in radians. */
const POLE = 1e-3;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * A stage that aims the camera so `target` stays in a dead zone and soft zone on screen, with lookahead. Put it after
 * the stage that places the camera. It turns the camera and never moves it, and it works without roll: `pose.roll` is
 * left as it is and not counted.
 */
export class FramingComposer {
  /** What the camera frames. Change it at any time; call `reset` to snap to the new subject. */
  target: CameraTarget;
  /** Where the subject was on screen after the last update, as [x, y] from the top left. */
  readonly onScreen = new Float64Array([0.5, 0.5]);
  /** The point aimed at after lookahead, in world units. */
  readonly aimPoint = new Float64Array(3);
  private readonly sx: number;
  private readonly sy: number;
  private readonly deadX: number;
  private readonly deadY: number;
  private readonly softX: number;
  private readonly softY: number;
  private readonly rateX: number;
  private readonly rateY: number;
  private readonly lookahead: number;
  private readonly smoothing: number;
  private readonly vertical: boolean;
  private readonly current = new Float64Array(3);
  private readonly previous = new Float64Array(3);
  private readonly velocity = new Float64Array(3);
  private readonly forward = new Float64Array(3);
  private started = false;
  /** @throws RangeError for a value outside what {@link FramingComposerOptions} allows. */
  constructor(target: CameraTarget, options: FramingComposerOptions = {}) {
    const {
        screen = [0.5, 0.5],
        deadZone = [0.1, 0.1],
        softZone = [0.8, 0.8],
        damping = 4,
        lookahead = 0,
        lookaheadSmoothing = 6,
        lookaheadVertical = true,
      } = options,
      [sx, sy] = pair(screen, 'screen'),
      [dw, dh] = pair(deadZone, 'deadZone'),
      [ww, wh] = pair(softZone, 'softZone'),
      [rx, ry] = pair(damping, 'damping');
    if (sx < 0 || sx > 1 || sy < 0 || sy > 1) throw new RangeError('Invalid composer screen; pass x and y from 0 to 1');
    if (dw < 0 || dh < 0 || ww < dw || wh < dh)
      throw new RangeError('Invalid composer zones; pass a deadZone of 0 or more and a softZone at least as large');
    if (!(rx > 0 && ry > 0)) throw new RangeError('Invalid composer damping; pass a rate above 0');
    if (!(lookahead >= 0 && lookahead < Infinity) || !(lookaheadSmoothing > 0 && lookaheadSmoothing < Infinity))
      throw new RangeError('Invalid composer lookahead; pass 0 or more seconds and a smoothing above 0');
    this.target = target;
    // Everything below works in screen units of -1..1 with y up, so a share of the screen is a half size in those units.
    this.sx = sx * 2 - 1;
    this.sy = 1 - sy * 2;
    this.deadX = dw;
    this.deadY = dh;
    this.softX = ww;
    this.softY = wh;
    this.rateX = rx;
    this.rateY = ry;
    this.lookahead = lookahead;
    this.smoothing = lookaheadSmoothing;
    this.vertical = lookaheadVertical;
  }
  /** Forgets the aim and the velocity: the next update puts the subject on its screen point, as after a teleport. */
  reset(): void {
    this.started = false;
    this.velocity.fill(0);
  }
  private aim(delta: number, ux: number, uy: number, uz: number): void {
    const { current, previous, velocity, aimPoint } = this;
    if (this.started && delta > 0) {
      const keep = Math.exp(-this.smoothing * delta);
      for (let i = 0; i < 3; i++)
        velocity[i] = (current[i] - previous[i]) / delta + (velocity[i] - (current[i] - previous[i]) / delta) * keep;
    }
    previous.set(current);
    let vx = velocity[0],
      vy = velocity[1],
      vz = velocity[2];
    if (!this.vertical) {
      const along = vx * ux + vy * uy + vz * uz;
      vx -= along * ux;
      vy -= along * uy;
      vz -= along * uz;
    }
    aimPoint[0] = current[0] + vx * this.lookahead;
    aimPoint[1] = current[1] + vy * this.lookahead;
    aimPoint[2] = current[2] + vz * this.lookahead;
  }
  /** Stage hook. @throws RangeError for a bad target, or a camera standing on its subject's axis with no up. */
  update(pose: CameraPose, delta: number, context: StageContext): void {
    readTarget(this.target, this.current);
    const { position, up } = pose,
      upSize = Math.hypot(up[0], up[1], up[2]);
    if (!(upSize > 0)) throw new RangeError('Invalid camera up; pass a direction that is not zero');
    const ux = up[0] / upSize,
      uy = up[1] / upSize,
      uz = up[2] / upSize;
    this.aim(delta, ux, uy, uz);
    const point = this.aimPoint;
    let dx = point[0] - position[0],
      dy = point[1] - position[1],
      dz = point[2] - position[2];
    const distance = Math.hypot(dx, dy, dz);
    // The camera on its subject has no direction to it: keep the view it has.
    if (!(distance > 1e-9)) {
      if (this.started) for (let i = 0; i < 3; i++) pose.target[i] = position[i] + this.forward[i];
      return;
    }
    dx /= distance;
    dy /= distance;
    dz /= distance;
    const tanY = Math.tan((pose.fov * Math.PI) / 360),
      tanX = tanY * context.aspect,
      f = this.forward;
    let nx = this.sx,
      ny = this.sy;
    if (this.started) {
      // Screen axes of the view held from the last frame, with no roll.
      let rx = f[1] * uz - f[2] * uy,
        ry = f[2] * ux - f[0] * uz,
        rz = f[0] * uy - f[1] * ux;
      const rs = Math.hypot(rx, ry, rz);
      rx /= rs;
      ry /= rs;
      rz /= rs;
      const tx = ry * f[2] - rz * f[1],
        ty = rz * f[0] - rx * f[2],
        tz = rx * f[1] - ry * f[0],
        x = dx * rx + dy * ry + dz * rz,
        y = dx * tx + dy * ty + dz * tz,
        z = dx * f[0] + dy * f[1] + dz * f[2],
        softX = this.softX,
        softY = this.softY;
      // A subject beside or behind the camera has no screen point; it counts as past the soft zone on its side.
      const front = z > 1e-6,
        px = front ? x / z / tanX : Math.sign(x) * 1e6,
        py = front ? y / z / tanY : Math.sign(y) * 1e6,
        ex = px - this.sx,
        ey = py - this.sy,
        // What lies past the dead zone decays; the rest stays where it is.
        deadX = clamp(ex, -this.deadX, this.deadX),
        deadY = clamp(ey, -this.deadY, this.deadY);
      nx = this.sx + clamp(deadX + (ex - deadX) * Math.exp(-this.rateX * delta), -softX, softX);
      ny = this.sy + clamp(deadY + (ey - deadY) * Math.exp(-this.rateY * delta), -softY, softY);
    }
    this.solve(nx, ny, tanX, tanY, dx, dy, dz, ux, uy, uz, position, pose.target, distance);
    this.onScreen[0] = (nx + 1) / 2;
    this.onScreen[1] = (1 - ny) / 2;
    this.started = true;
  }
  /**
   * Finds the view with no roll that puts the unit direction `d` at screen point (nx, ny). In the camera's axes d is
   * c = (nx tanX, ny tanY, 1) made unit. Its height along up is cy cos(p) + cz sin(p) for a view pitched by p, a single
   * cosine that gives p; the heading is then the angle left over between d and c around up.
   */
  private solve(
    nx: number,
    ny: number,
    tanX: number,
    tanY: number,
    dx: number,
    dy: number,
    dz: number,
    ux: number,
    uy: number,
    uz: number,
    position: Float64Array,
    target: Float64Array,
    distance: number,
  ): void {
    const f = this.forward;
    let cx = nx * tanX,
      cy = ny * tanY,
      cz = 1;
    const size = Math.hypot(cx, cy, cz);
    cx /= size;
    cy /= size;
    cz /= size;
    const height = dx * ux + dy * uy + dz * uz,
      reach = Math.hypot(cy, cz),
      limit = Math.PI / 2 - POLE,
      pitch = clamp(Math.atan2(cz, cy) - Math.acos(clamp(height / reach, -1, 1)), -limit, limit),
      cp = Math.cos(pitch),
      sp = Math.sin(pitch);
    // The subject's direction across the ground, as an angle in the plane at a right angle to up.
    let hx = dx - height * ux,
      hy = dy - height * uy,
      hz = dz - height * uz;
    let hs = Math.hypot(hx, hy, hz);
    if (hs < 1e-9) {
      // Straight above or below: keep the heading of the view held so far, or pick one.
      hx = f[0] - (f[0] * ux + f[1] * uy + f[2] * uz) * ux;
      hy = f[1] - (f[0] * ux + f[1] * uy + f[2] * uz) * uy;
      hz = f[2] - (f[0] * ux + f[1] * uy + f[2] * uz) * uz;
      hs = Math.hypot(hx, hy, hz);
      if (hs < 1e-9) {
        hx = Math.abs(ux) < 0.9 ? 1 - ux * ux : -ux * uy;
        hy = Math.abs(ux) < 0.9 ? -ux * uy : 1 - uy * uy;
        hz = Math.abs(ux) < 0.9 ? -ux * uz : -uy * uz;
        hs = Math.hypot(hx, hy, hz);
      }
    }
    hx /= hs;
    hy /= hs;
    hz /= hs;
    // Around up, c sits at this angle from the view's heading: right-hand side is cx, ahead is cz cos p - cy sin p.
    const turn = Math.atan2(cx, cz * cp - cy * sp),
      c = Math.cos(turn),
      s = Math.sin(turn);
    // Heading = h turned back by `turn`, toward the left of h, which is up x h.
    const lx = uy * hz - uz * hy,
      ly = uz * hx - ux * hz,
      lz = ux * hy - uy * hx,
      ax = hx * c + lx * s,
      ay = hy * c + ly * s,
      az = hz * c + lz * s;
    f[0] = ax * cp + ux * sp;
    f[1] = ay * cp + uy * sp;
    f[2] = az * cp + uz * sp;
    target[0] = position[0] + f[0] * distance;
    target[1] = position[1] + f[1] * distance;
    target[2] = position[2] + f[2] * distance;
  }
}
