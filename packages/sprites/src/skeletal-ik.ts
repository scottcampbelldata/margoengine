import { rangeError } from '../../shared/errors.js';
import type { Bone, Skeleton2D } from './skeletal.js';

/** Iterative IK controls. Distances are in skeleton world units. */
export interface IKOptions2D {
  /** Rotation blend, 0 to 1. Default 1. */
  mix?: number;
  /** Maximum chain sweeps, 1 to 1024. Default 64. */
  iterations?: number;
  /** Target distance considered reached. Default 0.001. */
  tolerance?: number;
  /** Positive elbow angle in bone local coordinates. Default true. */
  bendPositive?: boolean;
}
/** Residual after applying the blended solution; unreachable targets return converged false. */
export interface IKResult2D {
  distance: number;
  iterations: number;
  converged: boolean;
}
const angle = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));
const end = (bone: Bone): [number, number] => [
  bone.world[4] + bone.world[0] * bone.length,
  bone.world[5] + bone.world[1] * bone.length,
];
const local = (bone: Bone, x: number, y: number): [number, number] => {
  const p = bone.parent?.world;
  if (!p) return [x - bone.x, y - bone.y];
  const det = p[0] * p[3] - p[1] * p[2];
  if (Math.abs(det) < 1e-12) throw rangeError('IK needs invertible parent transforms', 'sprite-options');
  x -= p[4];
  y -= p[5];
  return [(p[3] * x - p[2] * y) / det - bone.x, (-p[1] * x + p[0] * y) / det - bone.y];
};
const controls = (o: IKOptions2D) => {
  const mix = o.mix ?? 1,
    iterations = o.iterations ?? 64,
    tolerance = o.tolerance ?? 0.001;
  if (
    !(mix >= 0 && mix <= 1) ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > 1024 ||
    !Number.isFinite(tolerance) ||
    tolerance <= 0
  )
    throw rangeError('Invalid IK mix, iterations or tolerance', 'sprite-options');
  return { mix, iterations, tolerance };
};
const chain = (s: Skeleton2D, names: readonly string[], target: readonly [number, number]): Bone[] => {
  if (!names.length || target.length !== 2 || !target.every(Number.isFinite))
    throw rangeError('IK needs a chain and finite target', 'sprite-options');
  const bones = names.map((n) => s.bone(n));
  if (bones.some((b, i) => !b || (i > 0 && b.parent !== bones[i - 1])))
    throw rangeError('IK bones must form a contiguous chain', 'sprite-options');
  if (bones.some((b) => !Number.isFinite(b!.length) || b!.length < 0))
    throw rangeError('IK needs finite nonnegative bone lengths', 'sprite-options');
  return bones as Bone[];
};
const result = (tip: Bone, target: readonly [number, number], iterations: number, tolerance: number): IKResult2D => {
  const p = end(tip),
    distance = Math.hypot(p[0] - target[0], p[1] - target[1]);
  return { distance, iterations, converged: distance <= tolerance };
};

/** CCD in each joint's parent coordinates, preserving translations and scales, including reflected ancestors. */
export function solveChainIK(
  s: Skeleton2D,
  names: readonly string[],
  target: readonly [number, number],
  options: IKOptions2D = {},
): IKResult2D {
  const bones = chain(s, names, target),
    { mix, iterations, tolerance } = controls(options),
    before = bones.map((b) => b.rotation),
    tip = bones.at(-1)!;
  s.update();
  if (mix === 0) return result(tip, target, 0, tolerance);
  // A straight chain cannot fold toward a collinear inner target without an initial bend.
  if (bones.length > 1 && result(tip, target, 0, tolerance).distance > tolerance) {
    const a = bones[0].world,
      p = end(tip),
      dx = target[0] - a[4],
      dy = target[1] - a[5];
    if (Math.abs((p[0] - a[4]) * dy - (p[1] - a[5]) * dx) < 1e-10)
      bones[1].rotation += (options.bendPositive === false ? -1 : 1) * 0.1;
  }
  let used = 0;
  for (; used < iterations; used++) {
    s.update();
    if (result(tip, target, used, tolerance).converged) break;
    for (let i = bones.length - 1; i >= 0; i--) {
      const b = bones[i],
        p = end(tip),
        a = local(b, p[0], p[1]),
        t = local(b, target[0], target[1]);
      if (Math.hypot(...a) > 1e-12 && Math.hypot(...t) > 1e-12)
        b.rotation += angle(Math.atan2(t[1], t[0]) - Math.atan2(a[1], a[0]));
      s.update();
    }
  }
  for (let i = 0; i < bones.length; i++) bones[i].rotation = before[i] + angle(bones[i].rotation - before[i]) * mix;
  s.update();
  return result(tip, target, used, tolerance);
}

/** Law-of-cosines two-bone IK, with chain solving for nonuniform first-bone scale. */
export function solveTwoBoneIK(
  s: Skeleton2D,
  rootName: string,
  tipName: string,
  target: readonly [number, number],
  options: IKOptions2D = {},
): IKResult2D {
  const [root, tip] = chain(s, [rootName, tipName], target),
    { mix, tolerance } = controls(options);
  s.update();
  if (mix === 0) return result(tip, target, 0, tolerance);
  if (Math.abs(Math.abs(root.scaleX) - Math.abs(root.scaleY)) > 1e-12)
    return solveChainIK(s, [rootName, tipName], target, options);
  const [tx, ty] = local(root, target[0], target[1]),
    l1 = Math.hypot(tip.x, tip.y),
    l2 = tip.length * Math.abs(tip.scaleX),
    scale = Math.abs(root.scaleX);
  if (l1 === 0 || l2 === 0 || scale === 0) return solveChainIK(s, [rootName, tipName], target, options);
  const d = Math.hypot(tx, ty) / scale,
    cosine = Math.max(-1, Math.min(1, (d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2))),
    bend = (options.bendPositive === false ? -1 : 1) * Math.acos(cosine),
    tr = Math.atan2(tip.y, tip.x) + bend - (tip.scaleX < 0 ? Math.PI : 0),
    vx = root.scaleX * (tip.x + Math.cos(tr) * tip.length * tip.scaleX),
    vy = root.scaleY * (tip.y + Math.sin(tr) * tip.length * tip.scaleX),
    rr = Math.atan2(ty, tx) - Math.atan2(vy, vx);
  root.rotation += angle(rr - root.rotation) * mix;
  tip.rotation += angle(tr - tip.rotation) * mix;
  s.update();
  return result(tip, target, 1, tolerance);
}
