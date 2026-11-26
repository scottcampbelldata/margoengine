import { MargoError } from '@margoengine/math/errors';
import { Quaternion } from '@margoengine/math/quaternion';
import {
  type Landmark,
  type LandmarkFrame,
  type LandmarkSource,
  OneEuroFilter,
  type OneEuroOptions,
} from './landmarks.js';

const HELP = '; see https://margoengine.com/errors#body-driver';

// Pose and hand landmarks to bone rotations on a humanoid skeleton: each bone turns its rest direction (toward its
// child) onto the landmark direction, with a second (side) direction fixing the twist of the hips, chest and hands.
// Sources: docs/clean-room.md, "Webcam landmarks".

/** The skeleton parts the driver uses; a `Skeleton` from `@margoengine/animation` fits. */
export interface SkeletonLike {
  readonly names: readonly string[];
  readonly parents: readonly number[];
  getPose(bone: number): { translation: ArrayLike<number>; rotation: ArrayLike<number> };
  setPose(bone: number, pose: { rotation: [number, number, number, number] }): unknown;
}
/** A landmark index, or several averaged (a midpoint). */
export type LandmarkRef = number | readonly number[];
/** One driven bone. Bone names are VRM humanoid names (`hips`, `leftUpperArm`, `leftIndexProximal`, ...). */
export interface BoneTarget {
  /** The bone to rotate. */
  bone: string;
  /** Landmarks whose direction `from` -> `to` the bone follows. */
  from: LandmarkRef;
  to: LandmarkRef;
  /** The bone whose rest position gives the rest direction; default the bone's own rest offset from its parent. */
  tip?: string;
  /** A second direction that fixes the twist about the first, with the two bones giving it at rest. */
  side?: { from: LandmarkRef; to: LandmarkRef; tipFrom: string; tipTo: string };
  /** Joint limit: the largest turn from the bone's rest rotation relative to its parent, in radians. Default pi (none). */
  limit?: number;
}
/** Which landmarks drive the skeleton. */
export type BodyPart = 'pose' | 'hands';

// BlazePose (MediaPipe Pose Landmarker) topology; left and right are the subject's.
const HIPS = [23, 24],
  SHOULDERS = [11, 12];
/** The body bones driven by the 33 Pose Landmarker points. */
export const POSE_TARGETS: readonly BoneTarget[] = [
  {
    bone: 'hips',
    from: HIPS,
    to: SHOULDERS,
    tip: 'neck',
    side: { from: 24, to: 23, tipFrom: 'rightUpperLeg', tipTo: 'leftUpperLeg' },
  },
  {
    bone: 'upperChest',
    from: HIPS,
    to: SHOULDERS,
    tip: 'neck',
    side: { from: 12, to: 11, tipFrom: 'rightUpperArm', tipTo: 'leftUpperArm' },
    limit: 1,
  },
  { bone: 'neck', from: SHOULDERS, to: [7, 8], tip: 'head', limit: 1 },
  ...(['left', 'right'] as const).flatMap((s): BoneTarget[] => {
    const o = s === 'left' ? 0 : 1;
    return [
      { bone: `${s}UpperArm`, from: 11 + o, to: 13 + o, tip: `${s}LowerArm` },
      { bone: `${s}LowerArm`, from: 13 + o, to: 15 + o, tip: `${s}Hand`, limit: 2.7 },
      { bone: `${s}UpperLeg`, from: 23 + o, to: 25 + o, tip: `${s}LowerLeg` },
      { bone: `${s}LowerLeg`, from: 25 + o, to: 27 + o, tip: `${s}Foot`, limit: 2.7 },
      { bone: `${s}Foot`, from: 29 + o, to: 31 + o, tip: `${s}Toes`, limit: 1.2 },
    ];
  }),
];
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;
/** The hand and finger bones driven by the 21 Hand Landmarker points of one hand. */
export function handTargets(side: 'left' | 'right'): BoneTarget[] {
  const s = side;
  const out: BoneTarget[] = [
    {
      bone: `${s}Hand`,
      from: 0,
      to: 9,
      tip: `${s}MiddleProximal`,
      side: { from: 17, to: 5, tipFrom: `${s}LittleProximal`, tipTo: `${s}IndexProximal` },
    },
    { bone: `${s}ThumbMetacarpal`, from: 1, to: 2, tip: `${s}ThumbProximal`, limit: 1.6 },
    { bone: `${s}ThumbProximal`, from: 2, to: 3, tip: `${s}ThumbDistal`, limit: 1.6 },
    { bone: `${s}ThumbDistal`, from: 3, to: 4, limit: 1.6 },
  ];
  FINGERS.forEach((f, i) => {
    const base = 5 + i * 4;
    out.push(
      { bone: `${s}${f}Proximal`, from: base, to: base + 1, tip: `${s}${f}Intermediate`, limit: 1.75 },
      { bone: `${s}${f}Intermediate`, from: base + 1, to: base + 2, tip: `${s}${f}Distal`, limit: 1.9 },
      { bone: `${s}${f}Distal`, from: base + 2, to: base + 3, limit: 1.6 },
    );
  });
  return out;
}

type V = [number, number, number];
type Q = [number, number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V): V => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const quat = (q: Quaternion): Q => [q.x, q.y, q.z, q.w];
const of = (q: ArrayLike<number>) => new Quaternion(q[0], q[1], q[2], q[3]);
const mul = (a: Q, b: Q): Q => quat(of(a).multiply(of(b)));
const inv = (a: Q): Q => [-a[0], -a[1], -a[2], a[3]];
const rotate = (q: Q, v: V): V => {
  // v + 2w (u x v) + 2 u x (u x v)
  const u: V = [q[0], q[1], q[2]],
    t = cross(u, v).map((c) => 2 * c) as V,
    c = cross(u, t);
  return [v[0] + q[3] * t[0] + c[0], v[1] + q[3] * t[1] + c[1], v[2] + q[3] * t[2] + c[2]];
};
/** The rotation taking an orthonormal frame built from (d0, s0) onto the one from (d1, s1). */
const frame = (d: V, s: V): number[] => {
  const y = unit(d),
    z = unit(cross(s, y)),
    x = cross(y, z);
  return [...x, 0, ...y, 0, ...z, 0, 0, 0, 0, 1];
};
const fromMatrix = (m: number[]): Q => quat(new Quaternion().setFromRotationMatrix({ elements: m } as never));
const align = (d0: V, d1: V, s0?: V, s1?: V): Q => {
  if (!s0 || !s1) return quat(new Quaternion().setFromUnitVectors(arg(unit(d0)), arg(unit(d1))));
  return mul(fromMatrix(frame(d1, s1)), inv(fromMatrix(frame(d0, s0))));
};
const arg = (v: V) => ({ x: v[0], y: v[1], z: v[2] });
/** Limit a rotation's angle to `limit` radians, keeping its axis. */
const clampAngle = (q: Q, limit: number): Q => {
  const w = q[3] < 0 ? -1 : 1,
    angle = 2 * Math.acos(Math.min(1, Math.abs(q[3])));
  if (angle <= limit) return q;
  const s = Math.sin(angle / 2) || 1,
    half = limit / 2,
    k = (Math.sin(half) / s) * w;
  return [q[0] * k, q[1] * k, q[2] * k, Math.cos(half)];
};

/**
 * Each bone's depth below its root, after checking `parents` is a forest: as long as the bone list, every entry -1 or
 * another bone's index, and every chain reaching a root within `count` steps.
 */
const boneDepths = (count: number, parents: readonly number[]): number[] => {
  if (!Array.isArray(parents) || parents.length !== count)
    throw new MargoError('state', 'BodyDriver skeleton parents must be an array as long as names' + HELP);
  parents.forEach((p, i) => {
    if (!Number.isInteger(p) || p < -1 || p >= count || p === i)
      throw new MargoError('state', 'BodyDriver skeleton parents must each be -1 or another bone index' + HELP);
  });
  return parents.map((_, i) => {
    let depth = 0;
    for (let p = parents[i]; p >= 0; p = parents[p])
      if (++depth >= count)
        throw new MargoError('state', 'BodyDriver skeleton parents form a cycle; every chain must reach a root' + HELP);
    return depth;
  });
};

/** {@link BodyDriver} options; every one is optional. */
export interface BodyDriverOptions {
  /**
   * Humanoid bone name to skeleton bone: an index map (what `humanoidBones` in `@margoengine/rigging/retarget` returns)
   * or name to name. Default: bones named with the humanoid names (case-insensitive).
   */
  bones?: ReadonlyMap<string, number> | Readonly<Record<string, string>>;
  /** Which landmarks drive bones. Default both. */
  parts?: readonly BodyPart[];
  /** Points below this visibility (when the detector gives it) leave their bone at its last rotation. Default 0.5. */
  minVisibility?: number;
  /** Tracks below this score are not trusted. Default 0.5. */
  minScore?: number;
  /** Seconds the last pose is held through lost tracking before the bones return to rest. Default 0.5. */
  hold?: number;
  /** One-euro filter on each landmark direction, or false for raw values. Default `{ minCutoff: 1.5, beta: 0.3 }`. */
  smoothing?: OneEuroOptions | false;
  /** Swap left and right, for a mirrored (selfie) picture. Default false. */
  mirror?: boolean;
  /** Frame width over height, used when only image points are given. Default 1. */
  aspect?: number;
  /** Largest swing per bone name in radians, over the targets' own limits. */
  limits?: Readonly<Record<string, number>>;
}
/** The driver's latest result. */
export interface BodyState {
  /** False once tracking has been lost for longer than `hold`. */
  readonly tracked: boolean;
  /** Bones written by the last update. */
  readonly driven: number;
  /** Frame time in ms. */
  readonly time: number;
}
interface Bound {
  target: BoneTarget;
  part: BodyPart;
  hand?: 'left' | 'right';
  index: number;
  parent: number;
  restDir: V;
  restSide?: V;
  restWorld: Q;
  restLocal: Q;
  calibrated?: { dir: V; side?: V };
  limit: number;
  filters: OneEuroFilter[];
}
// Mirror swaps each pose point with its other-side twin (BlazePose pairs 1-4, 2-5, 3-6, 7-8, ... 31-32).
const POSE_TWIN = Array.from({ length: 33 }, (_, i) =>
  i === 0 ? 0 : i <= 6 ? (i <= 3 ? i + 3 : i - 3) : i % 2 ? i + 1 : i - 1,
);

/**
 * Drives a humanoid skeleton from pose and hand landmark frames: every mapped bone turns from its rest direction onto
 * the landmark direction (a second direction fixes the twist where the points give one), within a swing limit,
 * smoothed by the one-euro filter, holding the last good rotation for points the detector cannot see.
 * Create it with the skeleton in its rest pose (T-pose or A-pose).
 */
export class BodyDriver implements Disposable {
  private readonly bound: Bound[] = [];
  private readonly restWorld: Q[] = [];
  private readonly options: Required<Omit<BodyDriverOptions, 'bones' | 'limits' | 'smoothing'>> & {
    smoothing: OneEuroOptions | false;
  };
  private lastGood = -Infinity;
  private current: BodyState = { tracked: false, driven: 0, time: 0 };
  private disposed = false;
  /** @throws RangeError for an option out of range; MargoError `state` when no target bone is in the skeleton. */
  constructor(
    readonly skeleton: SkeletonLike,
    options: BodyDriverOptions = {},
  ) {
    const {
      parts = ['pose', 'hands'],
      minVisibility = 0.5,
      minScore = 0.5,
      hold = 0.5,
      smoothing = { minCutoff: 1.5, beta: 0.3 },
      mirror = false,
      aspect = 1,
      bones,
      limits = {},
    } = options;
    if (!(minVisibility >= 0 && minVisibility <= 1) || !(minScore >= 0 && minScore <= 1))
      throw new RangeError('Body minVisibility and minScore must be in 0..1' + HELP);
    if (!(hold >= 0)) throw new RangeError('Body hold must be seconds >= 0' + HELP);
    for (const value of Object.values(limits))
      if (!(value >= 0 && value <= Math.PI)) throw new RangeError('Body limits must be radians in 0..pi' + HELP);
    if (!(aspect > 0) || !Number.isFinite(aspect))
      throw new RangeError('Body aspect must be a finite width / height above 0' + HELP);
    if (!skeleton || !Array.isArray(skeleton.names) || typeof skeleton.setPose !== 'function')
      throw new TypeError('BodyDriver needs a skeleton with names, parents, getPose and setPose' + HELP);
    if (smoothing) new OneEuroFilter(smoothing);
    const depths = boneDepths(skeleton.names.length, skeleton.parents);
    this.options = { parts, minVisibility, minScore, hold, smoothing, mirror, aspect };
    const lower = new Map(skeleton.names.map((n, i) => [n.toLowerCase(), i]));
    const find = (name: string | undefined): number => {
      if (name === undefined) return -1;
      if (bones instanceof Map) return bones.get(name) ?? -1;
      const mapped = (bones as Record<string, string> | undefined)?.[name] ?? name;
      return lower.get(mapped.toLowerCase()) ?? -1;
    };
    // Rest pose, model space.
    const restPos: V[] = [];
    // Parents before children (validated acyclic), so each bone reads its parent's rest transform.
    const order = skeleton.names.map((_, i) => i).sort((a, b) => depths[a] - depths[b]);
    for (const i of order) {
      const p = skeleton.getPose(i),
        parent = skeleton.parents[i],
        t: V = [p.translation[0], p.translation[1], p.translation[2]],
        r: Q = [p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]];
      if (parent < 0) {
        this.restWorld[i] = r;
        restPos[i] = t;
        continue;
      }
      const pr = this.restWorld[parent],
        pp = restPos[parent],
        o = rotate(pr, t);
      this.restWorld[i] = mul(pr, r);
      restPos[i] = [pp[0] + o[0], pp[1] + o[1], pp[2] + o[2]];
    }
    const add = (target: BoneTarget, part: BodyPart, hand?: 'left' | 'right') => {
      const index = find(target.bone);
      if (index < 0) return;
      const tip = find(target.tip),
        parent = skeleton.parents[index];
      const restDir =
        tip >= 0 ? sub(restPos[tip], restPos[index]) : parent >= 0 ? sub(restPos[index], restPos[parent]) : null;
      if (!restDir || len(restDir) < 1e-9) return;
      let restSide: V | undefined;
      if (target.side) {
        const a = find(target.side.tipFrom),
          b = find(target.side.tipTo);
        if (a < 0 || b < 0) return;
        restSide = sub(restPos[b], restPos[a]);
      }
      const r = skeleton.getPose(index).rotation;
      this.bound.push({
        target,
        part,
        hand,
        index,
        parent,
        restDir: unit(restDir),
        restSide,
        restWorld: this.restWorld[index],
        restLocal: [r[0], r[1], r[2], r[3]],
        limit: limits[target.bone] ?? target.limit ?? Math.PI,
        filters: smoothing ? Array.from({ length: 6 }, () => new OneEuroFilter(smoothing)) : [],
      });
    };
    if (parts.includes('pose')) for (const t of POSE_TARGETS) add(t, 'pose');
    if (parts.includes('hands'))
      for (const s of ['left', 'right'] as const) for (const t of handTargets(s)) add(t, 'hands', s);
    if (!this.bound.length)
      throw new MargoError('state', 'No humanoid bone of the targets is in the skeleton; pass a bones map' + HELP);
    // Parents first, so each bone reads its parent's new rotation.
    this.bound.sort((a, b) => depths[a.index] - depths[b.index]);
  }
  /** Bone names the driver writes, in update order. */
  get bones(): string[] {
    return this.bound.map((b) => this.skeleton.names[b.index]);
  }
  /** The latest result. */
  get state(): BodyState {
    return this.current;
  }
  private points(
    frame: LandmarkFrame,
    part: BodyPart,
    hand?: 'left' | 'right',
  ): { pts: readonly Landmark[]; world: boolean } | undefined {
    const { minScore, mirror } = this.options;
    const want = mirror ? (hand === 'left' ? 'right' : 'left') : hand;
    const track = part === 'pose' ? frame.poses[0] : frame.hands.find((h) => h.handedness === want);
    if (!track || (track.score ?? 1) < minScore) return undefined;
    return track.worldLandmarks ? { pts: track.worldLandmarks, world: true } : { pts: track.landmarks, world: false };
  }
  private point(points: readonly Landmark[], ref: LandmarkRef, pose: boolean, world: boolean): V | null {
    const { mirror, aspect, minVisibility } = this.options;
    const refs = typeof ref === 'number' ? [ref] : ref;
    let x = 0,
      y = 0,
      z = 0;
    for (const r of refs) {
      const p = points[mirror && pose ? POSE_TWIN[r] : r];
      if (!p || (p.visibility ?? 1) < minVisibility || (p.presence ?? 1) < minVisibility) return null;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
      const k = world ? 1 : aspect;
      // Detector frame (x right, y down, z away from the camera) to model space (y up, facing the camera along +z).
      x += (mirror ? -p.x : p.x) * k;
      y -= p.y;
      z -= p.z * k;
    }
    return [x / refs.length, y / refs.length, z / refs.length];
  }
  private directions(b: Bound, frame: LandmarkFrame): { dir: V; side?: V } | null {
    const found = this.points(frame, b.part, b.hand);
    if (!found) return null;
    const { pts, world } = found,
      isPose = b.part === 'pose';
    const t = b.target,
      a = this.point(pts, t.from, isPose, world),
      c = this.point(pts, t.to, isPose, world);
    if (!a || !c || len(sub(c, a)) < 1e-9) return null;
    let side: V | undefined;
    if (t.side) {
      const s0 = this.point(pts, t.side.from, isPose, world),
        s1 = this.point(pts, t.side.to, isPose, world);
      if (!s0 || !s1) return null;
      side = sub(s1, s0);
    }
    return { dir: sub(c, a), side };
  }
  /**
   * Take this frame as the rest pose: the person stands as the skeleton's rest pose (T-pose or A-pose). Bones it cannot
   * see keep the skeleton's own rest directions. @throws MargoError `state` when the frame shows none of the bones.
   */
  calibrate(frame: LandmarkFrame): this {
    this.check();
    let found = 0;
    for (const b of this.bound) {
      const d = this.directions(b, frame);
      b.calibrated = d ? { dir: unit(d.dir), side: d.side && unit(d.side) } : undefined;
      if (d) found++;
      for (const f of b.filters) f.reset();
    }
    if (!found) throw new MargoError('state', 'Calibrate on a frame where the body or hands are visible' + HELP);
    return this;
  }
  private check(): void {
    if (this.disposed) throw new MargoError('disposed', 'The body driver is disposed; create a new BodyDriver' + HELP);
  }
  /**
   * Pose the skeleton from one frame (its first pose and one hand per side). `time` (ms) defaults to the frame's.
   * @throws MargoError `disposed` after dispose.
   */
  update(frame: LandmarkFrame, time = frame.time): BodyState {
    this.check();
    const { hold, smoothing } = this.options,
      t = time / 1000,
      sk = this.skeleton;
    const world = new Map<number, Q>();
    const worldOf = (i: number): Q => {
      if (i < 0) return [0, 0, 0, 1];
      const known = world.get(i);
      if (known) return known;
      const r = sk.getPose(i).rotation,
        w = mul(worldOf(sk.parents[i]), [r[0], r[1], r[2], r[3]]);
      world.set(i, w);
      return w;
    };
    let driven = 0;
    for (const b of this.bound) {
      const d = this.directions(b, frame);
      if (!d) continue;
      let { dir, side } = d;
      if (smoothing) {
        const f = b.filters;
        dir = dir.map((v, k) => f[k].filter(v, t)) as V;
        if (side) side = side.map((v, k) => f[3 + k].filter(v, t)) as V;
      }
      const from = b.calibrated ?? { dir: b.restDir, side: b.restSide };
      const delta = align(from.dir, dir, from.side ?? b.restSide, side);
      // The joint limit bounds the turn from the bone's rest rotation relative to its parent.
      const local = mul(
        b.restLocal,
        clampAngle(mul(inv(b.restLocal), mul(inv(worldOf(b.parent)), mul(delta, b.restWorld))), b.limit),
      );
      const l = Math.hypot(...local);
      // A degenerate turn keeps the bone's last pose rather than writing a garbage rotation.
      if (!Number.isFinite(l) || l === 0) continue;
      sk.setPose(b.index, { rotation: local.map((v) => v / l) as Q });
      world.set(b.index, mul(worldOf(b.parent), local));
      // Children cached from the old pose are stale.
      for (const [k] of world) if (k !== b.index && this.isBelow(k, b.index)) world.delete(k);
      driven++;
    }
    if (driven) this.lastGood = t;
    else if (t - this.lastGood > hold) {
      for (const b of this.bound) sk.setPose(b.index, { rotation: [...b.restLocal] as Q });
      return (this.current = { tracked: false, driven: 0, time });
    }
    return (this.current = { tracked: driven > 0 || this.current.tracked, driven, time });
  }
  private isBelow(i: number, ancestor: number): boolean {
    // Bounded by the bone count as well as by the constructor's cycle check.
    const parents = this.skeleton.parents;
    for (let p = parents[i], steps = 0; p >= 0 && steps < parents.length; p = parents[p], steps++)
      if (p === ancestor) return true;
    return false;
  }
  /** Update from every frame of `source` until it ends or `signal` aborts. */
  async drive(
    source: LandmarkSource,
    { signal, onUpdate }: { signal?: AbortSignal; onUpdate?: (state: BodyState) => void } = {},
  ): Promise<void> {
    signal?.throwIfAborted();
    const stop = () => source.dispose();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      for await (const frame of source) {
        if (this.disposed) break;
        const state = this.update(frame);
        onUpdate?.(state);
      }
    } finally {
      signal?.removeEventListener('abort', stop);
    }
    signal?.throwIfAborted();
  }
  /** Release the driver; later calls throw. The skeleton keeps its last pose. */
  dispose(): void {
    this.disposed = true;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
