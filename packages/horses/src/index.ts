/// <reference lib="esnext.disposable" preserve="true" />
// A horse in one call: addHorse(engine) builds the horse of ./model.js for its breed group, coat and markings, loads it
// through @margoengine/gltf/pbr, shades its coat, mane and tail with strand hair (@margoengine/materials/hair, along
// the hair's direction: Kajiya and Kay 1989) and skins it with dual quaternions (@margoengine/animation/dqs). Its gait
// follows its speed: the pose is ./model.js horsePose at a stride phase taken from the distance travelled over the
// stride length, so a stance hoof never slides at any speed, and gait changes cross-fade. Film time is exact:
// advanceTime steps a fixed 1/240 s clock, and seek(t) replays every speed and heading set since time 0.
import type { Engine } from '@margoengine/core';
import type { Engine as EngineKernel } from '@margoengine/core/extension';
import type { PBRModel } from '@margoengine/gltf/pbr-model';
import type { Animation } from '@margoengine/animation';
import type { MaterialInstallation } from '@margoengine/materials';
import type { hair as hairFeature, HairOptions } from '@margoengine/materials/hair';
import { captureScene } from '../../shared/scene-scope.js';
import type { HorseBody } from './anatomy.js';
import { GAIT_PATTERNS, froude, hoofPhase, stride, type Gait, type Stride } from './gaits.js';
import { horseClipPlan, strideReachScale } from './clip-plan.js';
import { horseGrounding } from './grounding.js';
import {
  horseDocument,
  horseJointTranslation,
  horsePose,
  horseSkeleton,
  horseTailFlick,
  poseHooves,
  poseSaddle,
  type HorseClip,
  type HorseModelOptions,
  type HorsePose,
  type HorseSkeleton,
} from './model.js';

/** Anything a horse can join for shadows or ambient occlusion: `Shadows`, a `GTAO` pass, a scene's `parts`. */
export interface HorseReceiver {
  add(source: never, ...rest: never[]): unknown;
}

/** An artist's skinned horse posed by the package's runtime gait controller. The caller owns the model. */
export interface HorseSkin {
  /** Loaded skinned glTF in the same engine and in metres, facing +Z. */
  readonly model: PBRModel;
  /** Native or fitted skeleton in the rig's model space. */
  readonly skeleton: HorseSkeleton;
  /** Apply the solved model-space pose to the skin's joints. Root placement and yaw are applied by the controller. */
  applyPose(pose: HorsePose): void;
}

/** Options of {@link addHorse}. Every one is optional; the defaults give a bay riding horse standing at the origin. */
export interface HorseOptions extends HorseModelOptions {
  /** Use an existing skinned horse and preserve its materials. Default builds a procedural horse. */
  readonly skin?: HorseSkin;
  /** Starting position on the ground, `[x, z]`. Default `[0, 0]`. */
  position?: readonly [number, number];
  /** Starting heading in radians about +Y, 0 facing +Z. Default 0. */
  heading?: number;
  /** Ground height in metres. Fits and plants individual hooves on the supplied surface. Default flat ground at 0. */
  ground?: (x: number, z: number) => number;
  /** Most the speed changes per second, m/s^2. Default 3 (a riding horse reaches a gallop in about 4 s). */
  acceleration?: number;
  /** Most the heading turns per second, radians. Default 1.2. */
  turnRate?: number;
  /** Seconds a gait change cross-fades. Default 0.3. */
  fade?: number;
  /** Strand hair on the coat (along the body and down the legs), or false. Default `{strands: 400, specular: 0.45}`. */
  coatHair?: HairOptions | false;
  /** Strand hair on the mane and tail cards, or false. Default `{strands: 1024}`. */
  maneHair?: HairOptions | false;
  /** Shadows to cast into, or false. Default the `Shadows` attached to the scene, if any. */
  shadows?: HorseReceiver | false;
  /** An ambient occlusion pass to join. Default none. */
  occlusion?: HorseReceiver | false;
}

/** The horse's place and rider seat in world space at the current time. */
export interface HorseFrame {
  readonly position: readonly [number, number, number];
  readonly heading: number;
  /** The saddle seat point in world space. */
  readonly saddle: readonly [number, number, number];
  /** The trunk's world rotation (quaternion): yaw, then the trunk's pitch. */
  readonly saddleRotation: readonly [number, number, number, number];
}

/** What {@link addHorse} returns. Dispose it (or use `using`) to take the horse off the engine. */
export interface Horse {
  readonly model: PBRModel;
  readonly animation: Animation;
  readonly materials: MaterialInstallation | undefined;
  readonly body: HorseBody;
  readonly skeleton: HorseSkeleton;
  readonly clips: readonly HorseClip[];
  /** Film time in seconds. */
  readonly time: number;
  /** The speed asked for, m/s; the horse eases to it at `acceleration`. */
  speed: number;
  /** The heading asked for, radians; the horse turns to it at `turnRate`. */
  heading: number;
  /** Force a gait (a collected canter, an extended walk) or `'auto'` to follow the speed. Default `'auto'`. */
  gait: Gait | 'auto';
  /** The speed now, m/s. */
  readonly currentSpeed: number;
  /** The gait now, or `'stand'`. */
  readonly currentGait: Gait | 'stand';
  /** Metres travelled since time 0. */
  readonly distance: number;
  /** The pose now. */
  readonly pose: HorsePose;
  /** Position, heading and the saddle now. */
  frame(): HorseFrame;
  /** Flicks the tail from the current film time. Strength defaults to 1 and side to left. */
  flickTail(strength?: number, side?: 'left' | 'right'): void;
  /** Moves film time forward by `delta` seconds (fixed 1/240 s steps inside). */
  advanceTime(delta: number): this;
  /** Jumps to film time `time`, replaying every speed, heading and gait set since 0: the same as playing up to it. */
  seek(time: number): this;
  /** Called after every fixed step with the step length (a rider's seat follows here). Returns the remover. */
  onStep(step: (dt: number, horse: Horse) => void, reset?: () => void): () => void;
  dispose(): void;
  [Symbol.dispose](): void;
}

const STEP = 1 / 240;
type MotionKey = 'speed' | 'heading' | 'gait';
type TailAction = { strength: number; side: -1 | 1 };
type Command = { at: number; key: MotionKey; value: number | string } | { at: number; key: 'tail'; value: TailAction };

const receiver = (value: unknown, what: string): HorseReceiver | undefined => {
  if (value === undefined || value === false) return undefined;
  if (!value || typeof (value as HorseReceiver).add !== 'function')
    throw new TypeError(`addHorse ${what} must have an add() method (Shadows, a GTAO pass) or be false`);
  return value as HorseReceiver;
};
const finite = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RangeError(`Horse ${what} must be a finite number`);
  return v;
};
const qmul = (a: readonly number[], b: readonly number[]): [number, number, number, number] => [
  a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!,
  a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!,
  a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!,
  a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!,
];
/** Normalised blend of two quaternions (shortest way). */
function nlerp(a: readonly number[], b: readonly number[], t: number): [number, number, number, number] {
  const s = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]! < 0 ? -1 : 1,
    q = [0, 1, 2, 3].map((i) => a[i]! * (1 - t) + s * b[i]! * t),
    l = Math.hypot(...q) || 1;
  return q.map((v) => v / l) as [number, number, number, number];
}
/** Pose blend: `t` of `b` over `a`. */
export function blendPoses(a: HorsePose, b: HorsePose, t: number): HorsePose {
  const blend = (from: readonly number[] | undefined, to: readonly number[] | undefined): [number, number, number] =>
    [0, 1, 2].map((k) => (from?.[k] ?? 0) * (1 - t) + (to?.[k] ?? 0) * t) as [number, number, number];
  return {
    rotations: a.rotations.map((q, i) => nlerp(q, b.rotations[i]!, t)),
    bodyOffset: blend(a.bodyOffset, b.bodyOffset),
    ...(a.scapulaOffsets || b.scapulaOffsets
      ? {
          scapulaOffsets: [
            blend(a.scapulaOffsets?.[0], b.scapulaOffsets?.[0]),
            blend(a.scapulaOffsets?.[1], b.scapulaOffsets?.[1]),
          ] as const,
        }
      : {}),
  };
}

/**
 * The motion state of one horse, stepped on a fixed clock: speed easing, turning, the odometer, the gait with a fade
 * and the stride phase of each gait. Shared by {@link addHorse} and usable alone (a pure simulation).
 */
export class HorseMotion {
  speed = 0;
  heading: number;
  x: number;
  z: number;
  distance = 0;
  gait: Gait | 'stand' = 'stand';
  previous: Gait | 'stand' = 'stand';
  /** Fade from `previous` to `gait`, 0 to 1. */
  fade = 1;
  /** Odometer reading where each gait's phase is 0. */
  private readonly start = new Map<string, number>();
  constructor(
    readonly body: HorseBody,
    readonly options: {
      position?: readonly [number, number];
      heading?: number;
      acceleration?: number;
      turnRate?: number;
      fade?: number;
    } = {},
  ) {
    this.x = options.position?.[0] ?? 0;
    this.z = options.position?.[1] ?? 0;
    this.heading = options.heading ?? 0;
  }
  /** The gait a speed asks for, with 5 percent hysteresis around each boundary so a steady speed never flickers. */
  pick(speed: number, forced: Gait | 'auto'): Gait | 'stand' {
    if (speed < 0.05) return 'stand';
    if (forced !== 'auto') return forced;
    const fr = froude(this.body, speed),
      now = this.gait;
    const order: Gait[] = ['walk', 'trot', 'canter', 'gallop'];
    let g: Gait = 'gallop';
    // Leave a gait upward only past 1.05 of its top, drop into it from above only below 0.95 of its top.
    for (const k of order)
      if (fr < GAIT_PATTERNS[k].froude[1] * (now === 'stand' || order.indexOf(now) <= order.indexOf(k) ? 1.05 : 0.95)) {
        g = k;
        break;
      }
    return g;
  }
  /** Speed after one acceleration-limited step toward the target, in metres per second. */
  speedAfter(dt: number, target: number): number {
    const dv = target - this.speed;
    const limit = (this.options.acceleration ?? 3) * dt;
    return this.speed + Math.max(-limit, Math.min(limit, dv));
  }
  step(dt: number, target: { speed: number; heading: number; gait: Gait | 'auto' }): void {
    const turn = this.options.turnRate ?? 1.2,
      fadeTime = this.options.fade ?? 0.3;
    this.speed = this.speedAfter(dt, target.speed);
    let dh = target.heading - this.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    // A standing horse turns on the spot more slowly than a moving one.
    this.heading += Math.max(-turn * dt, Math.min(turn * dt, dh));
    this.x += Math.sin(this.heading) * this.speed * dt;
    this.z += Math.cos(this.heading) * this.speed * dt;
    this.distance += this.speed * dt;
    const g = this.pick(this.speed, target.gait);
    if (g !== this.gait) {
      this.previous = this.gait;
      this.gait = g;
      this.fade = fadeTime > 0 ? 0 : 1;
      if (g !== 'stand' && !this.start.has(g)) this.start.set(g, this.distance);
    }
    this.fade = Math.min(1, this.fade + (fadeTime > 0 ? dt / fadeTime : 1));
  }
  /** Stride phase 0 to 1 of a gait whose clip covers `strideLength` metres a stride. */
  phase(gait: Gait, strideLength: number): number {
    return this.phaseAt(gait, strideLength, this.distance);
  }
  /** The phase at another odometer reading (a display time between fixed steps). */
  phaseAt(gait: Gait, strideLength: number, distance: number): number {
    const p = (distance - (this.start.get(gait) ?? 0)) / strideLength;
    return p - Math.floor(p);
  }
}

/**
 * Builds a horse and puts it in the engine's scene: a measured body for its breed group, coat, markings, mane and tail,
 * strand hair shading, dual quaternion skinning and gaits that follow `horse.speed`. Resolves to a {@link Horse}.
 * @example
 * const horse = await addHorse(engine, {type: 'cavalry', coat: 'bay'});
 * horse.speed = 4; // eases into a trot
 * horse.advanceTime(1 / 30); // or seek(12.5) for a film frame
 * @throws TypeError or RangeError for bad options.
 */
export async function addHorse(engine: Engine, options: HorseOptions = {}): Promise<Horse> {
  const skin = options.skin,
    doc = skin ? undefined : horseDocument(options),
    skeleton = skin?.skeleton ?? doc!.skeleton,
    body = skeleton.body,
    clips = doc?.clips ?? horseClipPlan(body, options.speeds, strideReachScale(skeleton, horseSkeleton(body))).clips,
    acceleration = options.acceleration ?? 3,
    turnRate = options.turnRate ?? 1.2,
    fade = options.fade ?? 0.3;
  if (!(acceleration > 0 && acceleration < Infinity))
    throw new RangeError('addHorse acceleration must be above 0 m/s^2');
  if (!(turnRate > 0 && turnRate < Infinity))
    throw new RangeError('addHorse turnRate must be above 0 radians a second');
  if (!(fade >= 0 && fade < Infinity)) throw new RangeError('addHorse fade must be 0 or more seconds');
  const ground = options.ground ?? (() => 0);
  if (typeof ground !== 'function') throw new TypeError('addHorse ground must be a function (x, z) => height');
  const grounding = options.ground ? horseGrounding(skeleton, ground) : undefined;
  const explicitShadows = receiver(options.shadows, 'shadows'),
    occlusion = receiver(options.occlusion, 'occlusion'),
    // The scene this call was made for, kept across the lazy imports: the model and everything it brings belong to it.
    scope = captureScene(engine);
  if (skin && (skin.model.root.engine !== engine || typeof skin.applyPose !== 'function'))
    throw new TypeError('Pass an authored horse skin from this engine and a function that applies its pose');
  // The loader, skinning and hair shading load on the first horse, so importing this entry costs only the horse maths.
  const [{ parseGLTFAsync }, { Animation }, { dualQuaternionSkinning }, { install }, { hair }] = await Promise.all([
    import('@margoengine/gltf/pbr'),
    import('@margoengine/animation'),
    import('@margoengine/animation/dqs'),
    import('@margoengine/materials'),
    import('@margoengine/materials/hair'),
  ]);
  const model =
      skin?.model ?? ((await scope.run(() => parseGLTFAsync(engine as never, doc!.doc, doc!.buffers))) as PBRModel),
    shadows =
      options.shadows === undefined
        ? ((engine as unknown as EngineKernel).sceneOf(model as never)?.plugins.get('shadows') as
            | HorseReceiver
            | undefined)
        : explicitShadows,
    features: Record<string, ReturnType<typeof hairFeature>[]> = {};
  if (!skin && options.coatHair !== false)
    features.Coat = [hair({ direction: 'u', strands: 400, specular: 0.45, ...(options.coatHair || {}) })];
  if (!skin && options.maneHair !== false) {
    features.Mane = [hair({ strands: 1024, ...(options.maneHair || {}) })];
    features.Tail = [hair({ strands: 1024, ...(options.maneHair || {}) })];
  }
  const cleanups: Array<() => void> = [],
    materials = Object.keys(features).length ? install(model, { features }) : undefined;
  if (materials) cleanups.push(() => materials.dispose());
  const animation = new Animation(model, { skinning: dualQuaternionSkinning }),
    kernel = engine as unknown as EngineKernel,
    into = kernel.sceneOf(model as never) ?? model.root.scene;
  kernel.use(animation, into);
  animation.playing = false;
  cleanups.push(() => animation.dispose());
  // Shadows and occlusion both take the model and may give back their own remover.
  for (const off of [shadows?.add(model as never), occlusion?.add(model as never)])
    if (typeof off === 'function') cleanups.push(off as () => void);

  const strides = new Map<Gait, Stride>();
  const phaseOffsets = new Map<Gait, number>();
  for (const c of clips) {
    if (c.name === 'stand') continue;
    strides.set(c.name, { ...stride(body, c.speed, c.name), length: c.strideLength, duration: c.duration });
  }
  const motionOptions = { position: options.position, heading: options.heading, acceleration, turnRate, fade };
  let motion = new HorseMotion(body, motionOptions),
    // Film time asked for, and whole fixed steps simulated: the motion lives on the grid ticks x STEP and is shown
    // carried forward to the film time, so a film time always shows the same thing however time was advanced.
    time = 0,
    ticks = 0,
    next = 0,
    prev = { x: motion.x, z: motion.z, heading: motion.heading, distance: motion.distance },
    target = { speed: 0, heading: options.heading ?? 0, gait: 'auto' as Gait | 'auto' },
    pose: HorsePose = horsePose(skeleton, null, 0, 0),
    interruptedFrom: HorsePose | undefined,
    outgoingDistance = 0;
  const commands: Command[] = [],
    tailActions: { at: number; value: TailAction }[] = [],
    listeners = new Set<{ step: (dt: number, horse: Horse) => void; reset?: () => void }>();
  const shown = () => {
    const a = Math.min(1, Math.max(0, (time - ticks * STEP) / STEP)),
      dh = Math.atan2(Math.sin(motion.heading - prev.heading), Math.cos(motion.heading - prev.heading));
    return {
      x: motion.x + (motion.x - prev.x) * a,
      z: motion.z + (motion.z - prev.z) * a,
      heading: motion.heading + dh * a,
      distance: motion.distance + (motion.distance - prev.distance) * a,
    };
  };
  const movingPose = (st: Stride, phase: number, at: number): HorsePose => {
    // The stride of a requested gait represents its cruising speed. Ease in its excursion at very low
    // speed so a newly requested canter or gallop cannot throw limbs into an extended pose from a stand.
    const lowSpeedWeight = Math.min(1, motion.speed / (st.speed * 0.85));
    return horsePose(skeleton, st, phase - Math.floor(phase), at, lowSpeedWeight ** 2 * (3 - 2 * lowSpeedWeight));
  };
  const gaitPose = (g: Gait | 'stand', distance: number, at: number): HorsePose => {
    if (g === 'stand') return horsePose(skeleton, null, 0, at);
    const st = strides.get(g)!;
    const phase = motion.phaseAt(g, st.length, distance) + (phaseOffsets.get(g) ?? 0);
    return movingPose(st, phase, at);
  };
  const retiringRate = (g: Gait | 'stand', speed: number): number =>
    g === 'stand' || speed === 0 ? 1 : Math.min(1, strides.get(g)!.speed / speed);
  const carriedDistance = (distance: number) =>
    outgoingDistance + (distance - motion.distance) * (1 - motion.fade) * retiringRate(motion.previous, motion.speed);
  const supportAt = (distance: number) => {
    const retiring = motion.fade < 0.5 && !interruptedFrom;
    const gait = retiring ? motion.previous : motion.gait;
    const stride = gait === 'stand' ? undefined : strides.get(gait);
    const phase =
      gait === 'stand' || !stride
        ? 0
        : motion.phaseAt(gait, stride.length, retiring ? carriedDistance(distance) : distance) +
          (phaseOffsets.get(gait) ?? 0);
    return [0, 1, 2, 3].map((hoof) => Boolean(stride && hoofPhase(stride, hoof, phase).stance));
  };
  const locomotionPose = (distance: number, at: number) => {
    const now = gaitPose(motion.gait, distance, at);
    if (motion.fade >= 1) return now;
    const t = motion.fade;
    const weight = t ** 3 * (10 + t * (-15 + 6 * t));
    return blendPoses(interruptedFrom ?? gaitPose(motion.previous, carriedDistance(distance), at), now, weight);
  };
  const computePose = (frame: ReturnType<typeof shown>, height: number) => {
    pose = locomotionPose(frame.distance, time);
    for (const action of tailActions)
      pose = horseTailFlick(skeleton, pose, time - action.at, action.value.strength, action.value.side);
    if (grounding) pose = grounding.fit(frame, height, time, pose);
  };
  const alignGait = (gait: Gait, from: HorsePose, after: HorsePose, at: number, lead: number) => {
    const st = strides.get(gait)!;
    const hooves = poseHooves(skeleton, from),
      anticipated = poseHooves(skeleton, after);
    let phase = 0,
      best = Infinity;
    const judge = (candidate: number) => {
      const placed = poseHooves(skeleton, movingPose(st, candidate, at));
      const next = poseHooves(skeleton, movingPose(st, candidate + (motion.speed * lead) / st.length, at + lead));
      const cost = placed.reduce((sum, p, i) => {
        const [x, y, z] = hooves[i]!;
        // Preserve the support sequence: keeping a loaded foot down takes precedence over matching swing height.
        const support = Math.abs(y) < 0.025 ? 4 : 1;
        const nextHoof = next[i]!;
        const mismatch = nextHoof.reduce(
          (v, axis, k) => v + (axis - p[k]! - (anticipated[i]![k]! - hooves[i]![k]!)) ** 2,
          0,
        );
        return sum + (p[0] - x) ** 2 + support * (p[1] - y) ** 2 + (p[2] - z) ** 2 + 2 * mismatch;
      }, 0);
      if (cost < best) {
        best = cost;
        phase = candidate;
      }
    };
    for (let i = 0; i < 24; i++) judge(i / 24);
    const nearest = phase;
    for (const delta of [-1 / 72, 1 / 72]) judge((nearest + delta + 1) % 1);
    phaseOffsets.set(gait, phase - motion.phaseAt(gait, st.length, motion.distance));
  };
  const movingJoints = ['body', 'scapulaL', 'scapulaR'].map((name) => skeleton.index(name));
  const apply = () => {
    const v = shown(),
      y = ground(v.x, v.z);
    computePose(v, y);
    const nodes = model.nodes as unknown as {
      setQuaternion(q: readonly number[]): unknown;
      setPosition(p: readonly number[]): unknown;
    }[];
    if (skin) skin.applyPose(pose);
    else {
      pose.rotations.forEach((q, i) => i > 0 && nodes[i]?.setQuaternion(q));
      for (const joint of movingJoints) nodes[joint]?.setPosition(horseJointTranslation(skeleton, pose, joint));
    }
    model.root.setPosition([v.x, y, v.z]);
    model.root.setQuaternion([0, Math.sin(v.heading / 2), 0, Math.cos(v.heading / 2)]);
  };
  const stepTo = (end: number) => {
    // Float drift from many small advances is snapped to the microsecond, so 75 steps of 1/30 s land on the 2.5 s a
    // seek does; a time that is not near a microsecond (a third) is left as it is.
    const snap = Math.round(end * 1e6) / 1e6;
    time = end = Math.abs(snap - end) < 1e-9 ? snap : end;
    // Whole steps only, counted, so float sums never drift.
    while ((ticks + 1) * STEP <= end + 1e-9) {
      const start = ticks * STEP;
      while (next < commands.length && commands[next]!.at <= start + 1e-9) {
        const c = commands[next++]!;
        if (c.key === 'tail') tailActions.push(c);
        else (target as Record<string, unknown>)[c.key] = c.value;
      }
      while (tailActions.length && start - tailActions[0]!.at >= 1) tailActions.shift();
      prev = { x: motion.x, z: motion.z, heading: motion.heading, distance: motion.distance };
      const priorGait = motion.gait;
      const incoming = motion.pick(motion.speedAfter(STEP, target.speed), target.gait);
      const previousFade = motion.fade;
      const interrupted = previousFade < 1;
      const lead = Math.min(0.12, fade * 0.4);
      const changing = incoming !== priorGait;
      const previousPose = changing ? locomotionPose(motion.distance, start) : undefined;
      const after = changing
        ? locomotionPose(motion.distance + motion.speed * retiringRate(priorGait, motion.speed) * lead, start + lead)
        : undefined;
      motion.step(STEP, target);
      const retiringDistance = (motion.distance - prev.distance) * retiringRate(motion.previous, motion.speed);
      if (previousPose) {
        outgoingDistance = prev.distance + retiringDistance * (1 - motion.fade / 2);
        interruptedFrom = interrupted ? previousPose : undefined;
        if (motion.gait !== 'stand') alignGait(motion.gait, previousPose, after!, start, lead);
      } else if (interrupted) {
        // Finish the old stride within its cadence while the new gait takes the load.
        outgoingDistance += retiringDistance * (1 - (previousFade + motion.fade) / 2);
      }
      ticks++;
      if (grounding)
        grounding.advance(motion, ticks * STEP, supportAt(motion.distance), () =>
          locomotionPose(motion.distance, ticks * STEP),
        );
      if (listeners.size) {
        const keep = time;
        time = ticks * STEP;
        computePose(motion, ground(motion.x, motion.z));
        for (const l of listeners) l.step(STEP, horse);
        time = keep;
      }
    }
    apply();
  };
  const record = (command: Command) => {
    // A later set at the same time replaces the earlier one; sets after now are cut (a re-shot from here). The set
    // takes effect at the next fixed step, as it does in a replay.
    for (let i = commands.length - 1; i >= 0; i--)
      if (
        commands[i]!.at > time + 1e-9 ||
        (commands[i]!.at >= time - 1e-9 && commands[i]!.key === command.key && i >= next)
      )
        commands.splice(i, 1);
    next = Math.min(next, commands.length);
    commands.push(command);
  };
  const asked = (key: MotionKey) => {
    for (let i = commands.length - 1; i >= 0; i--) if (commands[i]!.key === key) return commands[i]!.value;
    return key === 'speed' ? 0 : key === 'heading' ? (options.heading ?? 0) : 'auto';
  };
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    listeners.clear();
    for (const step of cleanups.reverse()) step();
    if (!skin) (model as unknown as { dispose?(): void }).dispose?.();
  };
  const horse: Horse = {
    model,
    animation,
    materials,
    body,
    skeleton,
    clips,
    get time() {
      return time;
    },
    get speed() {
      return asked('speed') as number;
    },
    set speed(v: number) {
      if (!(finite(v, 'speed') >= 0) || v > 25) throw new RangeError('Horse speed must be 0 to 25 m/s');
      record({ at: time, key: 'speed', value: v });
    },
    get heading() {
      return asked('heading') as number;
    },
    set heading(v: number) {
      record({ at: time, key: 'heading', value: finite(v, 'heading') });
    },
    get gait() {
      return asked('gait') as Gait | 'auto';
    },
    set gait(v: Gait | 'auto') {
      if (v !== 'auto' && !strides.has(v as Gait))
        throw new RangeError("Horse gait must be 'auto', 'walk', 'trot', 'canter' or 'gallop'");
      record({ at: time, key: 'gait', value: v });
    },
    get currentSpeed() {
      return motion.speed;
    },
    get currentGait() {
      return motion.gait;
    },
    get distance() {
      return shown().distance;
    },
    get pose() {
      return pose;
    },
    flickTail(strength = 1, side = 'left') {
      if (!(strength >= 0 && strength <= 1) || (side !== 'left' && side !== 'right'))
        throw new RangeError('Horse tail flick needs strength 0 to 1 and side left or right');
      record({ at: time, key: 'tail', value: { strength, side: side === 'left' ? 1 : -1 } });
    },
    frame() {
      const s = poseSaddle(skeleton, pose),
        v = shown(),
        h = v.heading,
        c = Math.cos(h),
        sn = Math.sin(h),
        y = ground(v.x, v.z);
      return {
        position: [v.x, y, v.z],
        heading: h,
        saddle: [
          v.x + c * s.position[0] + sn * s.position[2],
          y + s.position[1],
          v.z - sn * s.position[0] + c * s.position[2],
        ],
        saddleRotation: qmul([0, Math.sin(h / 2), 0, Math.cos(h / 2)], s.rotation),
      };
    },
    advanceTime(delta: number) {
      if (!(delta >= 0 && delta < Infinity))
        throw new RangeError('advanceTime needs a finite number of seconds, 0 or more');
      stepTo(time + delta);
      return horse;
    },
    seek(at: number) {
      if (!(at >= 0 && at < Infinity)) throw new RangeError('seek needs a finite film time in seconds, 0 or more');
      motion = new HorseMotion(body, motionOptions);
      phaseOffsets.clear();
      time = 0;
      ticks = 0;
      next = 0;
      tailActions.length = 0;
      grounding?.reset();
      interruptedFrom = undefined;
      outgoingDistance = 0;
      prev = { x: motion.x, z: motion.z, heading: motion.heading, distance: motion.distance };
      target = { speed: 0, heading: options.heading ?? 0, gait: 'auto' };
      for (const l of listeners) l.reset?.();
      stepTo(at);
      return horse;
    },
    onStep(step, reset) {
      if (typeof step !== 'function') throw new TypeError('onStep needs a function (dt, horse) => void');
      const entry = { step, reset };
      listeners.add(entry);
      return () => void listeners.delete(entry);
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
  try {
    apply();
  } catch (error) {
    dispose();
    throw error;
  }
  return horse;
}

export type { HorseBody, HorseBodyOptions, HorseType } from './anatomy.js';
export type { Gait } from './gaits.js';
export type { HorseClip, HorseCoat, HorseMarkings, HorseModelOptions, HorsePose, HorseSkeleton } from './model.js';
