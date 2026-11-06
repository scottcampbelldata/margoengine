// Inertialization: a state change plays the new pose at once, and the difference between where the old motion was
// heading and the new pose is carried as an offset that fades out by itself (D. Bollo, "Inertialization: High-Performance
// Animation Transitions in Gears of War", GDC 2018). Only the new state is sampled, where a crossfade samples and mixes
// two poses for the whole fade.
//
// Each offset is one number along one line, x(t). Its speed has the shape (1 - s)^3 (v0 + k s) with s = t / t1: the triple
// root at s = 1 ends the offset with no speed, acceleration or jerk, k makes it travel exactly x0, and it cannot cross
// zero as long as t1 <= 5 x0 / |v0| when it is already closing, so t1 is cut to that.
//
// The speed an offset starts with is the old motion's less the new pose's, and the new pose's speed is only known one
// frame after the switch. So the first frame after a switch continues the old motion, the second measures the new pose
// against the first, and the fade starts from there; the output's speed does not jump along the offset.
import { MargoError } from '@margoengine/math/errors';
import { multiply, multiplyByConjugate } from './ccd.js';
import type { Animator, Pose } from './index.js';

/** Options of {@link addInertialization}. */
export interface InertializationOptions {
  /**
   * Seconds an offset takes to fade, above 0. Default: each transition's own `duration`, so a state graph keeps its
   * timing and a transition of 0 stays a hard cut.
   */
  duration?: number;
}

/** An inertialization handle: what is fading now, and its remover. */
export interface Inertialization {
  /** True from a switch until its offsets have faded. */
  readonly active: boolean;
  /** Seconds until the longest offset has faded, 0 when idle. */
  readonly remaining: number;
  /**
   * Fades whatever jump the next frame's pose makes, for a pop the state graph did not cause (a clip time set by hand, a
   * layer switched on). `duration` defaults to the option, or 0.2 seconds.
   */
  smooth(duration?: number): void;
  /** Stops at once: offsets drop and transitions crossfade again. */
  dispose(): void;
  [Symbol.dispose](): void;
}

const EPSILON = 1e-7,
  IDLE = 0,
  SWITCHED = 1,
  MEASURE = 2,
  DEFAULT_FADE = 0.2;

/** The rotation vector of the unit quaternion at q[o], the short way round, into out[v]; returns its angle. */
function logarithm(q: Float64Array, o: number, out: Float64Array, v: number): number {
  const sign = q[o + 3] < 0 ? -1 : 1,
    x = q[o] * sign,
    y = q[o + 1] * sign,
    z = q[o + 2] * sign,
    s = Math.sqrt(x * x + y * y + z * z),
    angle = 2 * Math.atan2(s, q[o + 3] * sign),
    k = s > 1e-12 ? angle / s : 2;
  out[v] = x * k;
  out[v + 1] = y * k;
  out[v + 2] = z * k;
  return angle;
}
/** The unit quaternion of the rotation vector at v[o] times `scale`, into out[q]. */
function exponent(v: Float64Array, o: number, scale: number, out: Float64Array, q: number): void {
  const x = v[o] * scale,
    y = v[o + 1] * scale,
    z = v[o + 2] * scale,
    angle = Math.sqrt(x * x + y * y + z * z),
    s = angle > 1e-12 ? Math.sin(angle / 2) / angle : 0.5;
  out[q] = x * s;
  out[q + 1] = y * s;
  out[q + 2] = z * s;
  out[q + 3] = Math.cos(angle / 2);
}

/**
 * Replaces `animator`'s crossfades with inertialization: every state change switches to the new pose at once and fades
 * the difference out over `options.duration`, keeping the old motion's speed along the way. It runs on the finished pose
 * (states, layers), before foot IK and solvers, so their targets are still met; positions, rotations, scales and morph
 * weights all carry. Returns the handle; dispose it to go back to crossfades.
 * @throws RangeError for a `duration` that is not above 0.
 */
export function addInertialization(animator: Animator, options: InertializationOptions = {}): Inertialization {
  const checked = (value: number | undefined, label: string): number | undefined => {
    if (value !== undefined && !(value > 0 && value < Infinity))
      throw new RangeError(`${label} must be a finite number of seconds above 0`);
    return value;
  };
  const fixed = checked(options?.duration, 'Inertialization duration'),
    nodes = animator.animation.model.nodes.length,
    rotations = nodes * 4,
    vectors = nodes * 3,
    // Rotations: this frame's, the last two outputs, the new pose a frame ago; quaternions, xyzw per node.
    now = new Float64Array(rotations),
    last = new Float64Array(rotations),
    before = new Float64Array(rotations),
    target = new Float64Array(rotations),
    // Old motion's turn speed, each offset's axis and a work quaternion.
    turnSpeed = new Float64Array(vectors),
    axes = new Float64Array(vectors),
    work = new Float64Array(8),
    workVector = new Float64Array(3);
  // Everything else is one flat row: position and scale of each node, then morph weights. A group is one slice of the
  // row with one offset, so a position's three numbers fade along one straight line.
  const groupAt: number[] = [],
    groupSize: number[] = [],
    morphNodes: number[] = [],
    morphAt: number[] = [];
  let width = nodes * 6,
    row = new Float64Array(0),
    lastRow = row,
    beforeRow = row,
    targetRow = row,
    speed = row,
    direction = row,
    // One curve per group, then one per node's rotation: offset, speed, length (0 for none).
    starts = row,
    speeds = row,
    lengths = row;
  const allocate = (pose: Pose) => {
    for (let i = 0; i < nodes; i++) {
      groupAt.push(i * 6, i * 6 + 3);
      groupSize.push(3, 3);
    }
    for (const [node, weights] of pose.weights) {
      morphNodes.push(node);
      morphAt.push(width);
      groupAt.push(width);
      groupSize.push(weights.length);
      width += weights.length;
    }
    row = new Float64Array(width);
    lastRow = new Float64Array(width);
    beforeRow = new Float64Array(width);
    targetRow = new Float64Array(width);
    speed = new Float64Array(width);
    direction = new Float64Array(width);
    const curves = groupAt.length + nodes;
    starts = new Float64Array(curves);
    speeds = new Float64Array(curves);
    lengths = new Float64Array(curves);
  };
  const gather = (pose: Pose) => {
    for (let i = 0; i < nodes; i++) {
      const p = pose.position[i],
        s = pose.scale[i],
        q = pose.rotation[i],
        at = i * 6,
        t = i * 4;
      for (let c = 0; c < 3; c++) {
        row[at + c] = p[c];
        row[at + 3 + c] = s[c];
      }
      for (let c = 0; c < 4; c++) now[t + c] = q[c];
    }
    for (let m = 0; m < morphNodes.length; m++) {
      const weights = pose.weights.get(morphNodes[m]);
      if (weights) for (let j = 0; j < weights.length; j++) row[morphAt[m] + j] = weights[j];
    }
  };
  const scatter = (pose: Pose) => {
    for (let i = 0; i < nodes; i++) {
      const p = pose.position[i],
        s = pose.scale[i],
        q = pose.rotation[i],
        at = i * 6,
        t = i * 4;
      for (let c = 0; c < 3; c++) {
        p[c] = row[at + c];
        s[c] = row[at + 3 + c];
      }
      for (let c = 0; c < 4; c++) q[c] = now[t + c];
    }
    for (let m = 0; m < morphNodes.length; m++) {
      const weights = pose.weights.get(morphNodes[m]);
      if (weights) for (let j = 0; j < weights.length; j++) weights[j] = row[morphAt[m] + j];
    }
  };
  let phase = IDLE,
    frames = 0,
    gap = 0,
    elapsed = 0,
    fade = DEFAULT_FADE,
    longest = 0,
    live = false,
    disposed = false;
  // Curve c at `elapsed`.
  const curveAt = (c: number): number => {
    const t1 = lengths[c],
      x0 = starts[c],
      v0 = speeds[c],
      k = (-20 * x0) / t1 - 5 * v0,
      p = 1 - elapsed / t1,
      p4 = p * p * p * p,
      first = (1 - p4) / 4;
    return x0 + t1 * (v0 * first + k * (first - (1 - p4 * p) / 5));
  };
  // Curve c for an offset x0 moving at v0 (a negative v0 closes it): the rule that it never crosses zero sets its length.
  const fit = (c: number, x0: number, v0: number) => {
    starts[c] = x0;
    speeds[c] = v0;
    lengths[c] = x0 < EPSILON ? 0 : v0 < 0 ? Math.min(fade, (-5 * x0) / v0) : fade;
    longest = Math.max(longest, lengths[c]);
  };
  // The speeds of the last two outputs; zero with fewer than two.
  const measureMotion = () => {
    if (frames < 2 || !(gap > 0)) {
      speed.fill(0);
      turnSpeed.fill(0);
      return;
    }
    for (let i = 0; i < width; i++) speed[i] = (lastRow[i] - beforeRow[i]) / gap;
    for (let i = 0; i < nodes; i++) {
      multiplyByConjugate(work, 0, last, i * 4, before, i * 4);
      logarithm(work, 0, turnSpeed, i * 3);
      for (let c = 0; c < 3; c++) turnSpeed[i * 3 + c] /= gap;
    }
  };
  // The old motion carried on by `step` from the last output, into the row and rotations.
  const continueMotion = (step: number) => {
    for (let i = 0; i < width; i++) row[i] = lastRow[i] + speed[i] * step;
    for (let i = 0; i < nodes; i++) {
      exponent(turnSpeed, i * 3, step, work, 0);
      multiply(now, i * 4, work, 0, last, i * 4);
    }
  };
  // The row and rotations hold the new pose; fits every curve so the fade starts at the old motion carried on.
  const startFade = (step: number) => {
    longest = 0;
    elapsed = 0;
    for (let g = 0; g < groupAt.length; g++) {
      const at = groupAt[g],
        end = at + groupSize[g];
      let squared = 0,
        v0 = 0;
      for (let j = at; j < end; j++) {
        direction[j] = lastRow[j] + speed[j] * step - row[j];
        squared += direction[j] * direction[j];
      }
      const x0 = Math.sqrt(squared);
      if (x0 >= EPSILON)
        for (let j = at; j < end; j++) {
          direction[j] /= x0;
          v0 += direction[j] * (speed[j] - (row[j] - targetRow[j]) / step);
        }
      fit(g, x0, v0);
    }
    const base = groupAt.length;
    for (let i = 0; i < nodes; i++) {
      const t = i * 4,
        v = i * 3;
      exponent(turnSpeed, v, step, work, 0);
      multiply(work, 4, work, 0, last, t);
      multiplyByConjugate(work, 0, work, 4, now, t);
      const x0 = logarithm(work, 0, axes, v);
      let v0 = 0;
      if (x0 >= EPSILON) {
        multiplyByConjugate(work, 0, now, t, target, t);
        logarithm(work, 0, workVector, 0);
        for (let c = 0; c < 3; c++) {
          axes[v + c] /= x0;
          v0 += axes[v + c] * (turnSpeed[v + c] - workVector[c] / step);
        }
      }
      fit(base + i, x0, v0);
    }
    live = true;
  };
  // Adds what is left of every offset onto the gathered pose; ends the fade when nothing is left.
  const applyFade = () => {
    let left = false;
    for (let g = 0; g < groupAt.length; g++) {
      if (!(elapsed < lengths[g])) continue;
      left = true;
      const x = curveAt(g),
        at = groupAt[g],
        end = at + groupSize[g];
      for (let j = at; j < end; j++) row[j] += direction[j] * x;
    }
    const base = groupAt.length;
    for (let i = 0; i < nodes; i++) {
      if (!(elapsed < lengths[base + i])) continue;
      left = true;
      exponent(axes, i * 3, curveAt(base + i), work, 0);
      multiply(now, i * 4, work, 0, now, i * 4);
    }
    live = left;
  };
  const removeStep = animator.addLateStep((pose, step) => {
    if (!row.length) allocate(pose);
    gather(pose);
    if (!(step > 0)) {
      // Paused: the same offsets at the same moment.
      if (phase === IDLE && live) {
        applyFade();
        scatter(pose);
      }
      return;
    }
    if (phase === SWITCHED && frames < 1) phase = IDLE;
    if (phase === SWITCHED) {
      measureMotion();
      targetRow.set(row);
      target.set(now);
      continueMotion(step);
      phase = MEASURE;
    } else if (phase === MEASURE) {
      startFade(step);
      applyFade();
      phase = IDLE;
    } else if (live) {
      elapsed += step;
      applyFade();
    }
    if (phase !== IDLE || live) scatter(pose);
    const oldest = beforeRow;
    beforeRow = lastRow;
    lastRow = oldest;
    lastRow.set(row);
    before.set(last);
    last.set(now);
    gap = step;
    frames++;
  });
  const handle: Inertialization = {
    get active() {
      return live || phase !== IDLE;
    },
    get remaining() {
      return phase !== IDLE ? fade : live ? Math.max(0, longest - elapsed) : 0;
    },
    smooth(duration) {
      if (disposed) throw new MargoError('disposed', 'Inertialization is disposed; add a new one');
      fade = checked(duration, 'Inertialization smooth duration') ?? fixed ?? DEFAULT_FADE;
      if (phase === IDLE) phase = SWITCHED;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      removeStep();
      removeListener();
    },
    [Symbol.dispose]() {
      handle.dispose();
    },
  };
  const removeListener = animator.on('statechange', (event) => {
    if (fixed === undefined && event.duration === 0) return;
    animator.cancelFade();
    handle.smooth(fixed ?? event.duration);
  });
  return handle;
}
