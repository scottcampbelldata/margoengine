import type { HorseBody } from './anatomy.js';
import { GAITS, preferredSpeed, stride, type Gait, type Stride } from './gaits.js';
import type { HorseClip, HorseSkeleton } from './model.js';

/** Reduce stride length for the tightest authored limb while preserving world speed and ground-relative cadence. */
export function strideReachScale(skeleton: HorseSkeleton, nominal: HorseSkeleton): number {
  const horizontalReach = (rig: HorseSkeleton, leg: readonly number[]): number => {
    const rest = leg.slice(0, -1).map((joint) => rig.joints[joint]!.rest);
    const top = rest[0]!,
      fetlock = rest.at(-1)!,
      length = rest.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[1] - rest[i]![1], p[2] - rest[i]![2]), 0);
    return Math.sqrt(Math.max(0, length ** 2 - (top[1] - fetlock[1]) ** 2)) - Math.abs(top[2] - fetlock[2]);
  };
  const reachScale = Math.min(
    1,
    ...skeleton.legs.map((leg, i) => horizontalReach(skeleton, leg) / horizontalReach(nominal, nominal.legs[i]!)),
  );
  if (!(reachScale > 0)) throw new RangeError('Use a horse skeleton with all four legs bent in the rest pose');
  return reachScale;
}

/** Shared clip metadata for generated horses and runtime rigs. */
export function horseClipPlan(body: HorseBody, speeds?: Partial<Record<Gait, number>>, reachScale = 1) {
  const clips: HorseClip[] = [{ name: 'stand', speed: 0, strideLength: 0, duration: 4, duty: 1 }],
    strides: (Stride | null)[] = [null];
  for (const gait of GAITS) {
    const speed = speeds?.[gait] ?? preferredSpeed(body, gait);
    if (!(speed > 0 && Number.isFinite(speed)))
      throw new RangeError(`Horse speeds.${gait} needs a finite speed above 0 m/s`);
    const timing = stride(body, speed, gait);
    const cycle = { ...timing, length: timing.length * reachScale, duration: timing.duration * reachScale };
    strides.push(cycle);
    clips.push({ name: gait, speed, strideLength: cycle.length, duration: cycle.duration, duty: cycle.duty });
  }
  return { clips, strides };
}
