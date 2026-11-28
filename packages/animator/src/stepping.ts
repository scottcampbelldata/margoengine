// Stepping: a biped walks a planned row of footfalls (stepping stones, a path, a stair), heel down and toe off, with the
// pelvis planned ahead so the knees stay near straight under load and bend only where a long or high step needs it.
//
// Each step moves one foot from its last footfall to the next. A planted foot pins its heel at touchdown and its toe at
// lift-off (Kovar, Schreiner and Gleicher 2002), the swing foot follows a minimum-jerk path with a clearance pulse, and
// the pelvis travels between the support points on a Hermite rhythm (Coros, Beaudoin, Yin and van de Panne 2008). The
// pelvis height is the highest the legs allow with the knee bent no less than `kneeFlexion` (default 8 degrees; level
// walking holds the loaded knee at about 5 to 20 degrees and peaks near 60 degrees in swing, Perry and Burnfield, Gait
// Analysis, 2010), planned over every route the footfalls may take, rate limited and smoothed, then lowered only where
// the smoothing would rise above that limit. The centre of mass so vaults over the stance leg the way an inverted
// pendulum does: about 4 to 5 cm of vertical travel on level ground (Saunders, Inman and Eberhart 1953; Gard, Miff and
// Kuo 2004), instead of a crouch that holds the knees bent all the way across. Kept out of the Animator class: the
// planner is plain maths and drives any IK (the full-body solver in `@margoengine/animator/fbik`, for one).
import type { Vec3 } from '@margoengine/core/extension';

type Point = [number, number, number];

/** One leg of {@link Stepping}: where its hip sits on the character and how long its bones are. */
export interface StepLeg {
  /** Hip joint offset from the character root in the rest pose, metres. */
  hip: Vec3;
  /** Hip to knee length, metres. */
  thigh: number;
  /** Knee to ankle length, metres. */
  shin: number;
}

/** The foot of {@link Stepping}, in the unrotated foot frame (+y up, +z toward the toes), metres. */
export interface StepFoot {
  /** The ankle from the footfall point on the sole (default [0, 0.074, -0.064]). */
  ankle?: Vec3;
  /** The heel contact from the ankle (default [0, -0.074, -0.064]): the pin at touchdown. */
  heel?: Vec3;
  /** The toe contact from the ankle (default [0, -0.074, 0.202]): the pin at lift-off. */
  toe?: Vec3;
}

/** Options of {@link createStepper}. */
export interface Stepping {
  /** Left leg then right leg (the left at +x). The left foot swings first. */
  legs: readonly [StepLeg, StepLeg];
  /** Standing footfall points, left then right. */
  start: readonly [Vec3, Vec3];
  /** Footfall points to walk, in order; the feet alternate, left first. Read live each step (default the first route). */
  footfall?: (step: number) => Vec3;
  /** Every route `footfall` may return, each as long as the walk; the pelvis is planned to suit all of them. */
  routes: readonly (readonly Vec3[])[];
  /** Foot contact geometry. */
  foot?: StepFoot;
  /** Seconds the body takes to settle after the last footfall (default 0.58). */
  settle?: number;
  /** The least the knee bends while it carries weight, radians (default 8 degrees). */
  kneeFlexion?: number;
  /** Most the pelvis rises or falls, metres per second (default 0.64). */
  liftRate?: number;
}

/** One foot of a {@link StepperPose}. */
export interface StepFootPose {
  /** World ankle target. */
  ankle: Vec3;
  /** Foot turn about +y, radians. */
  yaw: number;
  /** Foot pitch about its own +x, radians (positive lifts the heel). */
  pitch: number;
  /** The planted contact (heel or toe, from the ankle), or null while the foot swings. */
  pin: Vec3 | null;
  /** World point the pin holds, or null while the foot swings. */
  reference: Vec3 | null;
}

/** The gait signals an upper body follows; see {@link upperBodyMotion}. */
export interface StepMotion {
  /** 0 standing to 1 walking. */
  activity: number;
  /** Cosine of the stride rhythm, times activity. */
  sway: number;
  /** Stride rhythm, radians (pi per step). */
  rhythm: number;
  /** 0-1 weight shift toward the support foot ahead of a step. */
  brace: number;
  /** 0-1 load absorption after touchdown. */
  absorb: number;
  /** 0-1 look toward the next footfall. */
  anticipation: number;
  /** Sideways offset of the next footfall from the support foot, metres, clamped to 0.65. */
  coming: number;
  /** 0-1 progress of the settle after the last footfall. */
  settling: number;
  /** Sideways lean toward the support foot, metres. */
  lean: number;
  /**
   * Pelvic list while standing on uneven ground, radians: positive raises the left hip. The pelvis tilts with the line
   * between the feet (their height difference over the hip width, at most 0.12 rad) so both legs stand near straight, and the tilt fades as
   * walking starts. Already counted in the planned root height; {@link upperBodyMotion} turns it into pelvis and chest
   * roll.
   */
  list: number;
}

/** What a {@link Stepper} sets each frame. */
export interface StepperPose {
  /** World position for the character root. */
  readonly root: Vec3;
  /** Left foot then right foot. */
  readonly feet: readonly [StepFootPose, StepFootPose];
  /** Signals for the upper body. */
  readonly motion: StepMotion;
}

/** A biped stepping along its footfalls; see {@link createStepper}. */
export interface Stepper extends StepperPose {
  /** Footfalls in the walk. */
  readonly count: number;
  /** The step under way (0 to count; count once every footfall is made). */
  readonly step: number;
  /** Progress through the step under way, or through the settle, 0-1. */
  readonly phase: number;
  /** Seconds walked since the start. */
  readonly time: number;
  /** True while walking or settling. */
  readonly moving: boolean;
  /** True once the walk and its settle are done. */
  readonly completed: boolean;
  /** Seconds each step takes. */
  readonly durations: readonly number[];
  /** The planned root height at a time in seconds. */
  pelvisHeight(seconds: number): number;
  /** Starts walking (from the start again after a finished walk). */
  start(): void;
  /** Back to standing at the start. */
  reset(): void;
  /** Advances by `dt` seconds and updates the pose. */
  update(dt: number): void;
}

const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const between = (a: Vec3, b: Vec3, t: number): Point => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const smooth = (t: number): number => t ** 3 * (10 + t * (-15 + 6 * t));
const ease = (value: number, from: number, to: number): number => smooth(clamp((value - from) / (to - from)));
const pulse = (u: number): number => (4 * u * (1 - u)) ** 3;
const hermite = (p0: number, p1: number, m0: number, m1: number, duration: number, t: number): number => {
  const t2 = t * t,
    t3 = t2 * t;
  return mix(p0, p1, 3 * t2 - 2 * t3) + duration * ((t3 - 2 * t2 + t) * m0 + (t3 - t2) * m1);
};

/** Rotates a foot-frame point by a yaw about +y after a pitch about +x. */
export function rotateFoot([x, y, z]: Vec3, yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch),
    sp = Math.sin(pitch),
    cy = Math.cos(yaw),
    sy = Math.sin(yaw);
  const zz = y * sp + z * cp;
  return [x * cy + zz * sy, y * cp - z * sp, -x * sy + zz * cy];
}

/** Hip to ankle distance of a two-bone leg whose knee bends by `flexion` radians from straight. */
export function legReach(leg: Pick<StepLeg, 'thigh' | 'shin'>, flexion: number): number {
  const { thigh: a, shin: b } = leg;
  return Math.sqrt(a * a + b * b + 2 * a * b * Math.cos(flexion));
}

/** Knee flexion from straight, radians, of a two-bone leg whose hip and ankle are `distance` apart. */
export function kneeFlexionAt(leg: Pick<StepLeg, 'thigh' | 'shin'>, distance: number): number {
  const { thigh: a, shin: b } = leg;
  const cosine = (distance * distance - a * a - b * b) / (2 * a * b);
  return Math.acos(Math.max(-1, Math.min(1, cosine)));
}

interface Footfall {
  location: Vec3;
  yaw: number;
}

interface Crossing {
  durations: number[];
  stations: number[];
  zSlopes: number[];
  rhythmSlopes: number[];
}

interface GaitSample extends StepMotion {
  x: number;
  y: number;
  z: number;
  feet: [StepFootPose, StepFootPose];
  next: Footfall;
}

function slopes(values: readonly number[], durations: readonly number[]): number[] {
  const speeds = durations.map((duration, i) => (values[i + 1]! - values[i]!) / duration);
  return [0, ...speeds.slice(1).map((speed, i) => (2 * speed * speeds[i]!) / (speed + speeds[i]! || 1)), 0];
}

// Standing (at the start and at rest) the hips sit over the middle of the two ankles, `ankleZ` from the footfall
// points, so both legs carry the body equally straight; while walking they travel between the footfall points.
function crossing(start: readonly [Vec3, Vec3], landings: readonly Vec3[], ankleZ: number): Crossing {
  const route = [start[1], ...landings];
  const stations = [(start[0][2] + start[1][2]) / 2 + ankleZ];
  const durations: number[] = [];
  for (let i = 0; i < landings.length; i++) {
    const a = route[i]!,
      b = route[i + 1]!;
    const last = i === landings.length - 1;
    stations.push(last ? mix(a[2], b[2], 0.5) + ankleZ : mix(a[2], b[2], 0.56));
    durations.push(0.66 + 0.44 * (b[2] - a[2]) + 0.45 * Math.abs(a[1] - b[1]) + (i === 0 ? 0.12 : last ? 0.09 : 0));
  }
  return {
    durations,
    stations,
    zSlopes: slopes(stations, durations),
    rhythmSlopes: slopes(
      stations.map((_, i) => i),
      durations,
    ),
  };
}

function gaitFor(foot: StepFoot, span: number) {
  const ankleAt = foot.ankle ?? [0, 0.074, -0.064],
    heel = foot.heel ?? [0, -0.074, -0.064],
    toe = foot.toe ?? [0, -0.074, 0.202];
  const boot = (location: Vec3, yaw: number, pitch: number, pin: Vec3): StepFootPose => {
    const flat = rotateFoot(ankleAt, yaw, 0);
    const settled = rotateFoot(pin, yaw, 0),
      rock = rotateFoot(pin, yaw, pitch);
    const reference: Vec3 = [
      location[0] + flat[0] + settled[0],
      location[1] + flat[1] + settled[1],
      location[2] + flat[2] + settled[2],
    ];
    return {
      ankle: [reference[0] - rock[0], reference[1] - rock[1], reference[2] - rock[2]],
      yaw,
      pitch,
      pin,
      reference,
    };
  };
  const footYaw = (from: Vec3, to: Vec3, side: number): number =>
    side * 0.078 + Math.atan2(to[0] - from[0], Math.max(0.25, to[2] - from[2])) * 0.28;
  const swingBoot = (
    from: Footfall,
    to: Footfall,
    side: number,
    phase: number,
    leave: number,
    land: number,
    spacing: number,
    rolled: number,
  ): StepFootPose => {
    const rise = to.location[1] - from.location[1];
    // Toe-off: the foot leaves pitched steeply over its toe (the toe joint near 55 degrees of extension, Perry 2010).
    const toePitch = 0.85 - 0.2 * clamp((rise + 0.04) / 0.22);
    const heelPitch = -0.16 + 0.065 * clamp((rise + 0.025) / 0.2);
    // Pre-swing: the foot keeps rolling over its toe from the heel rise it carried out of terminal stance.
    if (phase <= leave)
      return boot(from.location, from.yaw, mix(rolled, toePitch, ease(phase, rolled > 0 ? 0 : leave * 0.34, leave)), toe);
    if (phase >= land)
      return boot(to.location, to.yaw, heelPitch * (1 - ease(phase, land, Math.min(1, land + 0.16))), heel);
    const u = (phase - leave) / (land - leave);
    const travel = smooth(u + 0.72 * u * (1 - u));
    const clearance = pulse(u + 0.34 * u * (1 - u));
    const takeoff = boot(from.location, from.yaw, toePitch, toe);
    const touchdown = boot(to.location, to.yaw, heelPitch, heel);
    const ankle = between(takeoff.ankle, touchdown.ankle, travel);
    ankle[0] += side * 0.033 * clearance;
    ankle[1] += clearance * (0.05 + 0.04 * spacing + 0.23 * Math.max(0, rise));
    const pitch = mix(toePitch, heelPitch, ease(u, 0.18, 0.89)) - 0.061 * clearance;
    return { ankle, pitch, yaw: mix(from.yaw, to.yaw, travel), pin: null, reference: null };
  };
  const sample = (
    path: Crossing,
    placed: readonly [Footfall, Footfall],
    landing: Vec3 | null,
    step: number,
    phase: number,
    settling = 0,
  ): GaitSample => {
    const count = path.durations.length;
    const swing = step % 2,
      support = 1 - swing;
    const origin = placed[swing]!,
      fixed = placed[support]!;
    const active = step < count && landing !== null;
    const standing = (a: Vec3, b: Vec3): Point => {
      const middle = between(a, b, 0.5);
      middle[2] += ankleAt[2];
      return middle;
    };
    const from = step === 0 || step === count ? standing(origin.location, fixed.location) : between(origin.location, fixed.location, 0.56);
    const to = active ? (step === count - 1 ? standing(fixed.location, landing) : between(fixed.location, landing, 0.56)) : from;
    const side = swing === 0 ? 1 : -1;
    const takeoff = step === 0 ? 0.25 : 0.158;
    const land = step === count - 1 ? 0.79 : 0.82;
    const next: Footfall = active ? { location: landing, yaw: footYaw(origin.location, landing, side) } : origin;
    const spacing = Math.hypot(fixed.location[0] - next.location[0], fixed.location[2] - next.location[2]);
    // Terminal stance: once the body passes over the support foot its heel rises, pivoting on the toe, so the trailing
    // leg stays long while the other foot reaches forward (heel-off near 31 percent of the gait cycle, Perry 2010).
    // The rise grows with the step; the last step comes to rest on flat feet.
    const heelRise = (a: Footfall, b: Footfall): number =>
      0.3 * clamp((Math.hypot(a.location[0] - b.location[0], a.location[2] - b.location[2]) - 0.25) / 0.45);
    const rolled = step > 0 && step < count ? heelRise(origin, fixed) : 0;
    const rising = active && step < count - 1 ? heelRise(fixed, next) * ease(phase, 0.45, 1) : 0;
    const feet = placed.map((sole, i) =>
      active && i === swing
        ? swingBoot(sole, next, side, phase, takeoff, land, spacing, rolled)
        : rising > 0
          ? boot(sole.location, sole.yaw, rising, toe)
          : boot(sole.location, sole.yaw, 0, heel),
    ) as [StepFootPose, StepFootPose];
    const pacing = active
      ? hermite(step, step + 1, path.rhythmSlopes[step]!, path.rhythmSlopes[step + 1]!, path.durations[step]!, phase)
      : step;
    const rhythm = pacing * Math.PI;
    const activity = active ? ease(pacing, 0, 0.54) * (1 - ease(pacing, count - 0.53, count)) : 0;
    const brace = active ? ease(phase, 0.02, 0.39) * (1 - ease(phase, 0.49, 0.96)) : 0;
    const absorb = active ? pulse(clamp((phase - land) / (1 - land))) : 0;
    const transfer = smooth(phase);
    const x = mix(mix(from[0], to[0], transfer), fixed.location[0], 0.53 * brace);
    const z = active
      ? hermite(path.stations[step]!, path.stations[step + 1]!, path.zSlopes[step]!, path.zSlopes[step + 1]!,
          path.durations[step]!, phase)
      : from[2];
    const list =
      (1 - activity) * Math.max(-0.12, Math.min(0.12, Math.atan2(feet[0].ankle[1] - feet[1].ankle[1], span)));
    // The height the body would take on straight legs over the support (the root stands on the soles in the rest
    // pose), with a small load absorption after touchdown. The planner keeps the pelvis at or below it.
    const y = mix(from[1], to[1], transfer) - 0.02 * absorb;
    const coming = active ? Math.min(0.65, Math.max(-0.65, next.location[0] - fixed.location[0])) : 0;
    const anticipation = active ? 0.4 * Math.sin(2 * Math.PI * phase) ** 2 + 0.6 * brace : 0;
    return {
      x, y, z, feet, next, list, rhythm, activity, brace, absorb, anticipation, coming, settling,
      sway: Math.cos(rhythm) * activity,
      lean: (fixed.location[0] - x) * brace,
    };
  };
  return { sample, ankleZ: ankleAt[2], initial: (start: readonly [Vec3, Vec3]): [Footfall, Footfall] =>
    [{ location: start[0], yaw: 0.078 }, { location: start[1], yaw: -0.078 }] };
}

function finiteLeg(leg: StepLeg): void {
  if (!(leg.thigh > 0 && leg.shin > 0) || !leg.hip.every(Number.isFinite))
    throw new RangeError('Stepping legs need a finite hip offset and positive thigh and shin lengths');
}

/**
 * Creates a biped that walks a row of footfalls. Each frame `update(dt)` sets `root` (the character root position),
 * `feet` (ankle targets, rotations and planted pins for an IK solver) and `motion` (signals for the upper body, see
 * {@link upperBodyMotion}). The pelvis is planned once, over every route, when the stepper is made.
 */
export function createStepper(options: Stepping): Stepper {
  const { legs, start, routes } = options;
  legs.forEach(finiteLeg);
  const first = routes[0];
  if (!first || first.length === 0 || routes.some((route) => route.length !== first.length))
    throw new RangeError('Stepping needs at least one route, and every route as long as the first');
  const settle = options.settle ?? 0.58,
    flexion = options.kneeFlexion ?? (8 * Math.PI) / 180,
    liftRate = options.liftRate ?? 0.64;
  if (!(settle > 0) || !(flexion >= 0 && flexion < Math.PI / 2) || !(liftRate > 0))
    throw new RangeError('Stepping needs a positive settle and lift rate and a knee flexion from 0 to 90 degrees');
  const footfall = options.footfall ?? ((step: number) => first[step]!);
  const span = legs[0].hip[0] - legs[1].hip[0];
  if (!(span > 0)) throw new RangeError('Stepping needs the left hip at +x of the right hip');
  const gait = gaitFor(options.foot ?? {}, span);
  const count = first.length;
  const path = crossing(start, first, gait.ankleZ);
  const reaches = legs.map((leg) => legReach(leg, flexion));
  // The highest root that leaves every planted leg within its loaded reach of its ankle target. A swing foot never
  // holds the body down: its path is the one that gives way, as a swing knee folds (to about 60 degrees, Perry 2010).
  const ceiling = (pose: GaitSample): number => {
    let height = pose.y;
    for (let i = 0; i < 2; i++) {
      if (pose.feet[i]!.pin === null) continue;
      const reach = reaches[i]!;
      const [hx, hip, hz] = legs[i]!.hip,
        target = pose.feet[i]!.ankle;
      // The list turns the pelvis about its middle: the left hip rises by half the span times its sine.
      const hy = hip + (i === 0 ? 0.5 : -0.5) * span * Math.sin(pose.list);
      const gap = Math.hypot(pose.x + hx - target[0], pose.z + hz - target[2]);
      height = Math.min(height, target[1] - hy + Math.sqrt(Math.max(0, reach * reach - gap * gap)));
    }
    return height;
  };
  const pelvisHeight = planPelvis(path, start, routes, settle, liftRate, ceiling, gait);

  let placed = gait.initial(start),
    elapsed = 0,
    step = 0,
    time = 0,
    moving = false,
    completed = false,
    phase = 0;
  const root: Point = [0, 0, 0];
  let current = gait.sample(path, placed, null, 0, 0);
  const pose = (dt: number): void => {
    if (moving) {
      elapsed += dt;
      time += dt;
    }
    while (moving && step < count && elapsed >= path.durations[step]!) {
      elapsed -= path.durations[step]!;
      const next = gait.sample(path, placed, footfall(step), step, 1).next;
      placed = (step % 2 === 0 ? [next, placed[1]] : [placed[0], next]) as [Footfall, Footfall];
      step++;
    }
    if (moving && step === count && elapsed >= settle) {
      moving = false;
      completed = true;
    }
    const stepping = moving && step < count;
    const settling = step === count ? clamp(elapsed / settle) : 0;
    phase = stepping ? elapsed / path.durations[step]! : settling;
    current = gait.sample(path, placed, stepping ? footfall(step) : null, step, phase, settling);
    root[0] = current.x;
    // The plan is sampled every 18 ms; the live ceiling keeps every planted leg in reach between samples too.
    root[1] = Math.min(pelvisHeight(time), ceiling(current));
    root[2] = current.z;
  };
  pose(0);
  return {
    root,
    count,
    durations: path.durations,
    get feet() { return current.feet; },
    get motion(): StepMotion { return current; },
    get step() { return step; },
    get phase() { return phase; },
    get time() { return time; },
    get moving() { return moving; },
    get completed() { return completed; },
    pelvisHeight,
    start() {
      if (moving) return;
      if (completed) this.reset();
      moving = true;
    },
    reset() {
      placed = gait.initial(start);
      elapsed = step = time = 0;
      moving = completed = false;
      pose(0);
    },
    update(dt: number) {
      if (!(dt >= 0)) throw new RangeError('Stepper update needs a nonnegative time step');
      pose(dt);
    },
  };
}

// Plans the root height ahead of each footfall, as the lowest of every route's reach ceiling, so the hips lower before a
// long step instead of dropping at the instant a leg runs out of length.
function planPelvis(
  path: Crossing,
  start: readonly [Vec3, Vec3],
  routes: readonly (readonly Vec3[])[],
  settle: number,
  liftRate: number,
  ceiling: (pose: GaitSample) => number,
  gait: ReturnType<typeof gaitFor>,
): (seconds: number) => number {
  const interval = 0.018;
  const ends = path.durations.reduce((times, duration) => [...times, times.at(-1)! + duration], [0]);
  const finalTime = ends.at(-1)!;
  const samples = Math.ceil((finalTime + settle) / interval) + 2;
  const limit = new Float64Array(samples).fill(Infinity);
  for (const route of routes) {
    let planted = gait.initial(start),
      step = 0;
    for (let i = 0; i < samples; i++) {
      const time = i * interval;
      while (step < route.length && time >= ends[step + 1]!) {
        const next = gait.sample(path, planted, route[step]!, step, 1).next;
        planted = (step % 2 === 0 ? [next, planted[1]] : [planted[0], next]) as [Footfall, Footfall];
        step++;
      }
      const rest = step === route.length;
      const phase = rest ? clamp((time - finalTime) / settle) : (time - ends[step]!) / path.durations[step]!;
      const target = gait.sample(path, planted, rest ? null : route[step]!, step, phase, rest ? phase : 0);
      limit[i] = Math.min(limit[i]!, ceiling(target));
    }
  }
  // Rate limit both ways, so the hips start lowering early enough for the deepest point.
  const maxStep = liftRate * interval;
  for (let i = 1; i < samples; i++) limit[i] = Math.min(limit[i]!, limit[i - 1]! + maxStep);
  for (let i = samples - 2; i >= 0; i--) limit[i] = Math.min(limit[i]!, limit[i + 1]! + maxStep);
  // A centred raised-cosine filter keeps the acceleration smooth. Where it rises above the limit, lower it by the
  // filtered window maximum of that excess: at every sample the result is at or below the limit, and nowhere else is
  // it lowered (a flat subtraction of the worst case would hold the knees bent all the way).
  const radius = 10;
  const weights = Array.from({ length: 2 * radius + 1 }, (_, i) => 0.5 + 0.5 * Math.cos((Math.PI * (i - radius)) / (radius + 1)));
  const sum = weights.reduce((total, value) => total + value, 0);
  const at = (values: ArrayLike<number>, i: number): number => values[Math.min(samples - 1, Math.max(0, i))]!;
  const filter = (values: ArrayLike<number>): Float64Array =>
    Float64Array.from({ length: samples }, (_, i) =>
      weights.reduce((total, weight, j) => total + at(values, i + j - radius) * weight, 0) / sum);
  const filtered = filter(limit);
  const excess = filtered.map((value, i) => Math.max(0, value - limit[i]!));
  const widest = Float64Array.from({ length: samples }, (_, i) => {
    let most = 0;
    for (let j = -radius; j <= radius; j++) most = Math.max(most, at(excess, i + j));
    return most;
  });
  const lowered = filter(widest);
  const keys = filtered.map((value, i) => Math.min(limit[i]!, value - lowered[i]!));
  return (seconds: number): number => {
    const key = Math.min(samples - 2, Math.max(0, seconds / interval));
    const i = Math.floor(key),
      t = key - i;
    const a = keys[i]!,
      b = keys[i + 1]!;
    const enter = (b - keys[Math.max(0, i - 1)]!) / 2;
    const leave = (keys[Math.min(samples - 1, i + 2)]! - a) / 2;
    return Math.min(hermite(a, b, enter, leave, 1, t), mix(limit[i]!, limit[i + 1]!, t));
  };
}

/** Upper-body angles of {@link upperBodyMotion}, radians, each about the joint's world axis named. */
export interface UpperBodyAngles {
  /** Pelvis turn about +y. */
  pelvisYaw: number;
  /** Pelvis roll about +z. */
  pelvisRoll: number;
  /** Lower spine pitch about +x (positive leans forward). */
  lumbar: number;
  /** Chest turn about +y. */
  chestYaw: number;
  /** Chest roll about +z. */
  chestRoll: number;
  /** Head pitch about +x. */
  headPitch: number;
  /** Head turn about +y. */
  headYaw: number;
  /** Left arm then right arm. */
  arms: [UpperArmAngles, UpperArmAngles];
}

/** One arm of {@link UpperBodyAngles}. */
export interface UpperArmAngles {
  /** Shoulder swing about +x. */
  swing: number;
  /** Shoulder spread about +z. */
  spread: number;
  /** Elbow bend about +x (negative bends the forearm forward). */
  elbow: number;
  /** Wrist bend about +x. */
  wrist: number;
  /** Finger curl scale: 1 the hand's resting curl. */
  curl: number;
}

/**
 * Upper-body follow-through for a {@link Stepper}: the pelvis and chest counter-rotate with the stride, arms swing
 * opposite the legs with the elbow trailing (Collins, Adamczyk and Kuo 2009), the torso leans over the support foot
 * while it braces and the head looks toward the next footfall (Matthis, Barton and Fajen 2017).
 */
export function upperBodyMotion(motion: StepMotion): UpperBodyAngles {
  const { activity, sway, rhythm, brace, lean, absorb, coming, anticipation, settling } = motion;
  const settle = Math.sin(Math.PI * settling) ** 2;
  const arm = (i: 0 | 1): UpperArmAngles => {
    const side = i === 0 ? 1 : -1;
    const stroke = -side * Math.cos(rhythm - (i === 0 ? 0.18 : 0.33)) * activity;
    const follow = -side * Math.cos(rhythm - (i === 0 ? 0.47 : 0.63)) * activity;
    return {
      swing: (i === 0 ? 0.244 : 0.218) * stroke - 0.048 * brace - 0.031 * settle,
      spread: side * (-0.036 + 0.115 * brace + 0.11 * Math.max(0, side * lean)),
      elbow: -0.079 + 0.087 * follow - 0.122 * brace - 0.025 * settle,
      wrist: 0.032 * follow + 0.028 * absorb,
      curl: 1 + 0.21 * follow - 0.14 * brace,
    };
  };
  return {
    pelvisYaw: -0.06 * sway,
    pelvisRoll: -0.16 * lean + motion.list,
    lumbar: 0.043 + 0.088 * brace + 0.041 * absorb - 0.021 * settle,
    chestYaw: 0.101 * sway - 0.056 * coming * anticipation,
    chestRoll: 0.34 * lean - 0.018 * Math.sin(rhythm) * activity - motion.list,
    headPitch: 0.019 + 0.11 * anticipation - 0.038 * absorb - 0.035 * settle,
    headYaw: 0.135 * coming * anticipation - 0.04 * sway,
    arms: [arm(0), arm(1)],
  };
}
