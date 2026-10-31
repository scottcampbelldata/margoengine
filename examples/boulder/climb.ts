// How the climber's body gets from one stance to the next. No engine imports beyond tween: this owns the four contacts,
// the pelvis and the moving limb's path, and writes plain numbers that climber.ts hands to the IK solvers.
import { smoothDamp } from '@margoengine/tween';
import { CHARACTER, RIG } from './rig.ts';
import { LEFT_FOOT, RIGHT_FOOT, wallAt, wallNormalAbove, type Hold, type Point } from './wall.ts';

// Past about 110 degrees of flexion the thigh and calf armour touch (private/handoffs/boulder-a0-report.md). This hip to
// ankle distance is about 102 degrees, so a stance never asks for the touching range.
export const MIN_LEG_REACH = 0.33;
export const MAX_LEG_REACH = 0.5;
/** A stance that misses by less than this, metres, counts as reachable; a limb takes up the rest. */
export const REACH_TOLERANCE = 0.022;
const ARM_MARGIN = 0.985;
export const MIN_ARM_REACH = 0.28;
const PELVIS_OFFSET = 0.29;
const PELVIS_MIN = 0.22;
const CHEST_MIN = 0.22;
const HEAD_MIN = 0.28;

function normalize(v: Point): Point {
  // Math.sqrt: Math.hypot boxes its result, once per call, every frame.
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
  v[0] /= l;
  v[1] /= l;
  v[2] /= l;
  return v;
}
function cross(a: ArrayLike<number>, b: ArrayLike<number>, out: Point): Point {
  const x = a[1] * b[2] - a[2] * b[1],
    y = a[2] * b[0] - a[0] * b[2],
    z = a[0] * b[1] - a[1] * b[0];
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

/** The torso's frame: right, up and back (out of the wall) as unit vectors. */
export interface Frame {
  right: Point;
  up: Point;
  back: Point;
}
export const newFrame = (): Frame => ({ right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1] });

/** Writes a frame from the up direction and the wall normal it should face. */
export function frameFrom(up: ArrayLike<number>, normal: ArrayLike<number>, out: Frame): Frame {
  out.up[0] = up[0];
  out.up[1] = up[1];
  out.up[2] = up[2];
  normalize(out.up);
  cross(out.up, normal, out.right);
  normalize(out.right);
  cross(out.right, out.up, out.back);
  return out;
}

/** origin + frame * local. Torso local +X is right, +Y up, +Z back: the rig's rest frame, facing -Z. */
export function place(frame: Frame, local: readonly number[], origin: readonly number[], out: Point): Point {
  out[0] = origin[0] + frame.right[0] * local[0] + frame.up[0] * local[1] + frame.back[0] * local[2];
  out[1] = origin[1] + frame.right[1] * local[0] + frame.up[1] * local[1] + frame.back[1] * local[2];
  out[2] = origin[2] + frame.right[2] * local[0] + frame.up[2] * local[1] + frame.back[2] * local[2];
  return out;
}

export interface PelvisResult {
  position: Point;
  frame: Frame;
  /** Largest amount, metres, by which a limb misses its reach range or the body misses the wall limit. 0 is feasible. */
  error: number;
}
export const newPelvis = (): PelvisResult => ({ position: [0, 0, 0], frame: newFrame(), error: 0 });

const scratch: Point = [0, 0, 0],
  scratchNormal: Point = [0, 0, 0],
  scratchUp: Point = [0, 0, 0],
  joint: Point = [0, 0, 0],
  faceLocal: Point = [0, 0, 0];

function torsoFrame(contacts: readonly Point[], bound: readonly boolean[], pelvis: Point, frame: Frame): void {
  // A free hand has no say: its contact is wherever it last held on.
  const both = bound[0] && bound[1],
    hx = both ? (contacts[0][0] + contacts[1][0]) / 2 : 0,
    fx = both ? (contacts[2][0] + contacts[3][0]) / 2 : 0;
  // The torso follows the wall under the chest, leaning a little back from it and toward the hands' side.
  const n = scratchNormal;
  wallAt(pelvis[1] + 0.35, n);
  scratchUp[0] = (hx - fx) * 0.25;
  scratchUp[1] = n[2] + n[1] * 0.1;
  scratchUp[2] = -n[1] + n[2] * 0.1;
  frameFrom(scratchUp, n, frame);
}

function pushOffWall(out: PelvisResult, localY: number, min: number, target: number): number {
  const p = out.position,
    n = scratchNormal;
  place(out.frame, [0, localY, 0], p, scratch);
  const z = wallAt(scratch[1], n),
    gap = (scratch[2] - z) * n[2];
  if (gap < min) {
    p[1] += n[1] * (min - gap);
    p[2] += n[2] * (min - gap);
    return min - gap;
  }
  if (target > 0 && gap > target) {
    p[1] -= n[1] * (gap - target) * 0.5;
    p[2] -= n[2] * (gap - target) * 0.5;
  }
  return 0;
}

/**
 * Finds a pelvis that reaches every bound contact and stays clear of the wall: repeated projection onto each limb's
 * reach shell and the wall limit. `error` reports what is still missed; under a few millimetres counts as feasible.
 */
export function solvePelvis(contacts: readonly Point[], bound: readonly boolean[], out: PelvisResult): PelvisResult {
  const p = out.position;
  let total = 0;
  p[0] = p[1] = p[2] = 0;
  for (let i = 0; i < 4; i++)
    if (bound[i]) {
      const w = i < 2 ? 0.25 : 0.35;
      total += w;
      p[0] += contacts[i][0] * w;
      p[1] += contacts[i][1] * w;
      p[2] += contacts[i][2] * w;
    }
  p[0] /= total || 1;
  p[1] /= total || 1;
  p[2] /= total || 1;
  for (let step = 0; step < 64; step++) {
    torsoFrame(contacts, bound, p, out.frame);
    let error = 0;
    // A body hangs under its hands: nothing else may slide it sideways when a limb runs short of room.
    if (bound[0] && bound[1]) p[0] += ((contacts[0][0] + contacts[1][0]) / 2 - p[0]) * 0.08;
    for (let i = 0; i < 4; i++) {
      if (!bound[i]) continue;
      place(out.frame, RIG.roots[i], p, joint);
      const dx = contacts[i][0] - joint[0],
        dy = contacts[i][1] - joint[1],
        dz = contacts[i][2] - joint[2],
        d = Math.hypot(dx, dy, dz) || 1e-6,
        max = i < 2 ? (RIG.upper[i] + RIG.lower[i]) * ARM_MARGIN : MAX_LEG_REACH,
        min = i < 2 ? MIN_ARM_REACH : MIN_LEG_REACH,
        miss = d > max ? d - max : d < min ? d - min : 0;
      if (miss !== 0) {
        // Over half of the miss each pass, so the limbs share a correction instead of fighting.
        p[0] += (dx / d) * miss * 0.55;
        p[1] += (dy / d) * miss * 0.55;
        p[2] += (dz / d) * miss * 0.55;
        error = Math.max(error, Math.abs(miss));
      }
    }
    out.error = Math.max(
      error,
      pushOffWall(out, 0, PELVIS_MIN, PELVIS_OFFSET),
      pushOffWall(out, RIG.roots[0][1], CHEST_MIN, 0),
      pushOffWall(out, RIG.head[1] + CHARACTER.faceAbove, HEAD_MIN, 0),
    );
  }
  return out;
}

/** Where the wrist sits for a hand on a hold, and where the ankle sits for a foot on it. */
export function contactPoint(limb: number, hold: Hold, out: Point): Point {
  const [x, y, z] = hold.position,
    n = hold.normal;
  if (limb === LEFT_FOOT || limb === RIGHT_FOOT) {
    // The toe of the shoe rests on top of the hold: the ankle is back from it, above it and, since the foot turns out,
    // across from it toward the body.
    out[0] = x + (limb === LEFT_FOOT ? CHARACTER.ankle.across : -CHARACTER.ankle.across);
    out[1] = y + hold.radius * 0.7 + CHARACTER.ankle.up;
    out[2] = z + CHARACTER.ankle.out;
    return out;
  }
  // The fingers hook over the top of the hold, so the wrist hangs below and out from it.
  out[0] = x;
  out[1] = y - CHARACTER.wrist.below + n[1] * CHARACTER.wrist.out;
  out[2] = z + n[2] * CHARACTER.wrist.out;
  return out;
}

/** A foot standing on the mat: the stance a route starts from and a fall ends in. */
export function matFoot(limb: number, x: number, matTop: number, out: Point): Point {
  out[0] = x + (limb === LEFT_FOOT ? -0.14 : 0.14);
  out[1] = matTop + CHARACTER.ankleHeight;
  out[2] = 0.42;
  return out;
}

export type ClimbEvent = 'contact' | 'short' | 'landed';

/**
 * The climber's state. `contacts` are where each limb is planted; `targets` are where each limb should be this frame.
 * Call `update` every frame. A frame allocates nothing; a move's planning does, a little, on the click that starts it.
 */
export class Climb {
  readonly contacts: Point[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  readonly targets: Point[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  /** Which hold each limb is on; -1 for a free limb or a foot on the mat. */
  readonly on: number[] = [-1, -1, -1, -1];
  /** The wall's outward normal under the hold each hand is on or on its way to. */
  readonly handNormals: Point[] = [
    [0, 0, 1],
    [0, 0, 1],
  ];
  /** False for an arm that hangs free (after a fall). */
  readonly bound = [true, true, true, true];
  readonly pelvis: Point = [0, 0, 0];
  readonly frame = newFrame();
  /** The point the head looks at, always a metre from the face: see `update`. */
  readonly look: Point = [0, 1, 1.5];
  /** The limb on its way to a hold, or -1. */
  moving = -1;
  /** How far the moving limb has come, 0 to 1 and eased. A typed slot, so a frame allocates nothing. */
  readonly travel = new Float64Array(1);
  /** True while a fall plays. */
  falling = false;
  /** Called when a hold is taken, a reach comes up short, or a fall lands. */
  onEvent: ((event: ClimbEvent, limb: number, point: Point) => void) | null = null;
  private readonly plan = newPelvis();
  private readonly velocity = new Float64Array(3);
  private readonly upVelocity = new Float64Array(3);
  private readonly lookVelocity = new Float64Array(3);
  private readonly pelvisGoal = new Float64Array(3);
  private readonly pelvisNow = new Float64Array(3);
  private readonly upGoal = new Float64Array(3);
  private readonly upNow = new Float64Array([0, 1, 0]);
  private readonly lookGoal = new Float64Array(3);
  private readonly lookNow = new Float64Array([0, 0, -1]);
  private readonly lookWanted = new Float64Array(3);
  private readonly from: Point = [0, 0, 0];
  private readonly to: Point = [0, 0, 0];
  private readonly lift: Point = [0, 0, 1];
  private readonly normal: Point = [0, 0, 1];
  private liftHeight = 0;
  // A typed slot: a double field would box on every write once V8 has seen it hold an integer.
  private readonly clock = new Float64Array(1);
  private duration = 0;
  private toHold = -1;
  private returning = false;
  private fallTime = 0;
  private fallDuration = 0;
  private fallDrop = 0;
  private readonly fallFrom: Point = [0, 0, 0];

  readonly holds: readonly Hold[];

  constructor(holds: readonly Hold[]) {
    this.holds = holds;
  }

  /** Places the climber at once, with no motion: every limb on its contact, the pelvis on its solved place. */
  teleport(holdsOn: readonly number[], positions: readonly Point[]): void {
    for (let i = 0; i < 4; i++) {
      this.on[i] = holdsOn[i];
      this.bound[i] = true;
      for (let a = 0; a < 3; a++) this.contacts[i][a] = this.targets[i][a] = positions[i][a];
      if (i < 2 && holdsOn[i] >= 0)
        for (let a = 0; a < 3; a++) this.handNormals[i][a] = this.holds[holdsOn[i]].normal[a];
    }
    solvePelvis(this.contacts, this.bound, this.plan);
    for (let a = 0; a < 3; a++) {
      this.pelvisGoal[a] = this.pelvisNow[a] = this.plan.position[a];
      this.upGoal[a] = this.upNow[a] = this.plan.frame.up[a];
      this.velocity[a] = this.upVelocity[a] = this.lookVelocity[a] = 0;
      this.lookGoal[a] = (positions[0][a] + positions[1][a]) / 2;
    }
    this.lookDirection(this.plan.frame, this.pelvisNow, this.lookNow);
    this.moving = -1;
    this.falling = false;
    this.commit();
  }

  /**
   * Walks the feet to their places on the mat with the arms still free, ready for `move` to send each hand to its first
   * hold. Used to start a route.
   */
  settle(feet: readonly Point[]): void {
    for (let i = 0; i < 4; i++) {
      this.on[i] = -1;
      this.bound[i] = i >= 2;
      if (i >= 2) for (let a = 0; a < 3; a++) this.contacts[i][a] = feet[i][a];
    }
    solvePelvis(this.contacts, this.bound, this.plan);
    for (let a = 0; a < 3; a++) {
      this.pelvisGoal[a] = this.plan.position[a];
      this.upGoal[a] = this.plan.frame.up[a];
    }
    this.moving = -1;
    this.falling = false;
  }

  /**
   * Starts moving `limb` to hold `index`. Returns false when the climber is busy. A hold out of reach from this stance
   * makes the limb stretch toward it and come back (the `short` event), and the stance stays as it was.
   */
  move(limb: number, index: number): boolean {
    if (this.moving >= 0 || this.falling) return false;
    const hold = this.holds[index],
      contact = this.contacts[limb],
      wasBound = this.bound[limb],
      // A free arm leaves from where it hangs.
      leaving = wasBound ? contact : this.targets[limb];
    for (let a = 0; a < 3; a++) this.from[a] = leaving[a];
    contactPoint(limb, hold, contact);
    this.bound[limb] = true;
    if (limb < 2) for (let a = 0; a < 3; a++) this.handNormals[limb][a] = hold.normal[a];
    solvePelvis(this.contacts, this.bound, this.plan);
    for (let a = 0; a < 3; a++) this.to[a] = contact[a];
    this.returning = false;
    if (this.plan.error < REACH_TOLERANCE) this.toHold = index;
    else {
      // Back on the old stance. The limb stretches as far as this stance lets it, then returns.
      for (let a = 0; a < 3; a++) contact[a] = this.from[a];
      this.bound[limb] = wasBound;
      this.toHold = -1;
      solvePelvis(this.contacts, this.bound, this.plan);
      place(this.plan.frame, RIG.roots[limb], this.plan.position, joint);
      const max = limb < 2 ? (RIG.upper[limb] + RIG.lower[limb]) * ARM_MARGIN : MAX_LEG_REACH,
        dx = this.to[0] - joint[0],
        dy = this.to[1] - joint[1],
        dz = this.to[2] - joint[2],
        d = Math.hypot(dx, dy, dz);
      if (d > max) {
        this.to[0] = joint[0] + (dx / d) * max;
        this.to[1] = joint[1] + (dy / d) * max;
        this.to[2] = joint[2] + (dz / d) * max;
      }
    }
    // The limb leaves along the wall normal and comes back in along it, so it arcs out round the holds between.
    const distance = Math.hypot(this.to[0] - this.from[0], this.to[1] - this.from[1], this.to[2] - this.from[2]);
    wallAt(this.to[1], this.lift);
    this.liftHeight = Math.min(0.1, 0.03 + distance * 0.18);
    if (!wasBound) {
      // A hand coming up from where it hangs swings out to the side, round the shoulder and clear of the chest, and off
      // the wall, so it has turned to its grip before the fingers come near the wall.
      const side = limb === 0 ? -0.8 : 0.8;
      this.lift[0] = side + this.lift[0] * 0.6;
      this.lift[1] = this.lift[1] * 0.6;
      this.lift[2] = this.lift[2] * 0.6;
      this.liftHeight = 0.32;
    }
    this.moving = limb;
    this.travel[0] = 0;
    this.clock[0] = 0;
    this.duration = 0.42 + distance * 0.75;
    for (let a = 0; a < 3; a++) {
      this.pelvisGoal[a] = this.plan.position[a];
      this.upGoal[a] = this.plan.frame.up[a];
      this.lookGoal[a] = hold.position[a];
    }
    return true;
  }

  /** Looks at a point when no move is running; a move overrides it. */
  lookAt(x: number, y: number, z: number): void {
    if (this.moving >= 0) return;
    this.lookGoal[0] = x;
    this.lookGoal[1] = y;
    this.lookGoal[2] = z;
  }

  /** True while a foot stands on a hold or is on its way to one. */
  footOnHold(limb: number): boolean {
    return this.on[limb] >= 0 || (this.moving === limb && this.toHold >= 0);
  }

  /** Lets go with everything: the climber drops onto the mat below, then stands. */
  fall(matTop: number): void {
    if (this.falling) return;
    this.moving = -1;
    this.falling = true;
    this.fallTime = 0;
    for (let a = 0; a < 3; a++) this.fallFrom[a] = this.pelvisNow[a];
    for (let i = 0; i < 4; i++) this.on[i] = -1;
    const x = this.pelvisNow[0];
    matFoot(LEFT_FOOT, x, matTop, this.contacts[LEFT_FOOT]);
    matFoot(RIGHT_FOOT, x, matTop, this.contacts[RIGHT_FOOT]);
    this.bound[0] = this.bound[1] = false;
    const stand = matTop + 0.6;
    this.fallDrop = Math.max(0, this.fallFrom[1] - stand);
    this.fallDuration = Math.max(0.05, Math.sqrt((2 * this.fallDrop) / 9.81));
  }

  /** Advances one frame, `dt` in seconds. Zero keeps everything where it is. */
  update(dt: number): void {
    if (dt > 0) {
      if (this.falling) this.stepFall(dt);
      else if (this.moving >= 0) this.stepMove(dt);
      const glide = Math.min(1, dt * 7);
      if (!this.falling)
        for (let i = 0; i < 4; i++)
          if (i !== this.moving)
            for (let a = 0; a < 3; a++) this.targets[i][a] += (this.contacts[i][a] - this.targets[i][a]) * glide;
      // Two calls: choosing the smooth time with ?: makes a number V8 boxes on every frame.
      if (this.falling) smoothDamp(this.pelvisNow, this.pelvisGoal, this.velocity, 0.02, 8, dt, this.pelvisNow);
      else smoothDamp(this.pelvisNow, this.pelvisGoal, this.velocity, 0.22, 8, dt, this.pelvisNow);
      smoothDamp(this.upNow, this.upGoal, this.upVelocity, 0.3, 3, dt, this.upNow);
      // The gaze turns as a direction. Damping the point itself would pull it past the nose on the way from a foot to a
      // hand, and the head would whip round as it went by.
      this.lookDirection(this.frame, this.pelvisNow, this.lookWanted);
      smoothDamp(this.lookNow, this.lookWanted, this.lookVelocity, 0.25, 4, dt, this.lookNow);
    }
    this.commit();
  }

  private stepMove(dt: number): void {
    const limb = this.moving;
    this.clock[0] += dt;
    const t = Math.min(1, this.clock[0] / this.duration),
      k = t * t * t * (t * (t * 6 - 15) + 10),
      arc = Math.sin(Math.PI * t) * this.liftHeight,
      target = this.targets[limb];
    this.travel[0] = k;
    for (let a = 0; a < 3; a++) target[a] = this.from[a] + (this.to[a] - this.from[a]) * k + this.lift[a] * arc;
    if (t < 1) return;
    if (this.toHold >= 0) {
      this.on[limb] = this.toHold;
      this.moving = -1;
      this.onEvent?.('contact', limb, this.holds[this.toHold].position);
    } else if (!this.returning) {
      this.returning = true;
      this.onEvent?.('short', limb, this.to);
      for (let a = 0; a < 3; a++) {
        const reached = this.to[a];
        this.to[a] = this.from[a];
        this.from[a] = reached;
      }
      this.clock[0] = 0;
    } else this.moving = -1;
  }

  private stepFall(dt: number): void {
    this.fallTime += dt;
    const t = Math.min(1, this.fallTime / this.fallDuration),
      p = this.pelvisGoal;
    p[0] = this.fallFrom[0];
    p[1] = this.fallFrom[1] - this.fallDrop * t * t;
    p[2] = this.fallFrom[2] + (0.46 - this.fallFrom[2]) * t;
    for (let i = 2; i < 4; i++) {
      const c = this.contacts[i],
        target = this.targets[i];
      for (let a = 0; a < 3; a++) target[a] += (c[a] - target[a]) * Math.min(1, dt * 9);
    }
    this.upGoal[0] = 0;
    this.upGoal[1] = 1;
    this.upGoal[2] = 0;
    if (t >= 1) {
      this.falling = false;
      this.onEvent?.('landed', LEFT_FOOT, this.contacts[LEFT_FOOT]);
    }
  }

  /** The middle of the face, into `scratch`. */
  private faceAt(frame: Frame, pelvis: ArrayLike<number>): void {
    faceLocal[0] = RIG.head[0];
    faceLocal[1] = RIG.head[1] + CHARACTER.faceAbove;
    faceLocal[2] = RIG.head[2];
    place(frame, faceLocal, pelvis as unknown as Point, scratch);
  }

  /** Writes the unit direction from the face to the look goal. */
  private lookDirection(frame: Frame, pelvis: ArrayLike<number>, out: Float64Array): void {
    this.faceAt(frame, pelvis);
    const x = this.lookGoal[0] - scratch[0],
      y = this.lookGoal[1] - scratch[1],
      z = this.lookGoal[2] - scratch[2],
      l = Math.sqrt(x * x + y * y + z * z) || 1;
    out[0] = x / l;
    out[1] = y / l;
    out[2] = z / l;
  }

  private commit(): void {
    for (let a = 0; a < 3; a++) this.pelvis[a] = this.pelvisNow[a];
    wallNormalAbove(this.pelvis, 0.35, this.normal);
    if (!this.bound[0] && !this.bound[1]) {
      // Off the wall: upright, facing the wall squarely.
      this.normal[0] = 0;
      this.normal[1] = 0;
      this.normal[2] = 1;
    }
    frameFrom(this.upNow, this.normal, this.frame);
    this.faceAt(this.frame, this.pelvis);
    const n = this.lookNow,
      l = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) || 1;
    for (let a = 0; a < 3; a++) this.look[a] = scratch[a] + n[a] / l;
  }
}

/** The distance from a hip joint to its ankle, for the knee limit check. */
export function legReach(frame: Frame, pelvis: Point, limb: number, ankle: Point): number {
  place(frame, RIG.roots[limb], pelvis, scratch);
  return Math.hypot(ankle[0] - scratch[0], ankle[1] - scratch[1], ankle[2] - scratch[2]);
}
