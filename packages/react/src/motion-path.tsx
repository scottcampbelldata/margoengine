import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';
import type { Vec3 } from '@margoengine/math';
import { subscribeFrame } from './frame-priority.js';
import { useScene } from './internal.js';
import { fault, rangeError } from '../../shared/errors.js';

/** A 3D curve: any curve of `@margoengine/geometry` (`CatmullRomCurve3`, `CubicBezierCurve3`, `LineCurve3`, ...). */
export interface MotionCurve {
  getPointAt(u: number): ArrayLike<number>;
  getTangentAt(u: number): ArrayLike<number>;
  getLength(): number;
}
type Point = [number, number, number];
/** The live state of `<MotionPathControls>`, from `useMotion()` or its ref. */
export interface MotionState {
  /** Progress along the whole path, 0..1 by arc length. Write it to move (when `offset` is not set). */
  current: number;
  /** The curves, in order. */
  readonly curves: readonly MotionCurve[];
  /** The path point at `current`. */
  readonly point: Point;
  /** The unit tangent at `current`. */
  readonly tangent: Point;
  /** The point the object looks at this frame: the damped focus, or a step ahead along the path. */
  readonly focus: Point;
}
/** Props of `<MotionPathControls>`; `curves` is required. */
export interface MotionPathControlsProps {
  /** The path, one curve after another by arc length. */
  curves: readonly MotionCurve[];
  /** What moves: a `<Mesh>` ref. Default the Canvas camera. */
  object?: RefObject<EngineMesh | null>;
  /** Where it looks: a point or a `<Mesh>` ref. Default along the path. */
  focus?: Vec3 | RefObject<EngineMesh | null>;
  /** Target progress 0..1; `current` eases to it. Omitted, `current` moves only when you write it. */
  offset?: number;
  /** Time constant in seconds of the easing of `current` to `offset`; 0 jumps. Default 0.2. */
  damping?: number;
  /** Time constant in seconds of the easing of the look-at point; 0 follows at once. Default 0.1. */
  focusDamping?: number;
  /** Wrap progress past 1 back to 0 and ease the short way round. Default true. */
  loop?: boolean;
  children?: ReactNode;
}
const MotionContext = /* @__PURE__ */ createContext<MotionState | null>(null);
/** drei's useMotion: the live state of the enclosing `<MotionPathControls>`. */
export function useMotion(): MotionState {
  const state = useContext(MotionContext);
  if (!state)
    throw fault('state', 'useMotion requires MotionPathControls; call it inside a <MotionPathControls>', 'react-usage');
  return state;
}
function check(
  curves: readonly MotionCurve[],
  offset: number | undefined,
  damping: number,
  focusDamping: number,
): void {
  if (!Array.isArray(curves) || !curves.length || curves.some((c) => typeof c?.getPointAt !== 'function'))
    throw rangeError('MotionPathControls curves must be a non-empty array of 3D curves', 'react-arguments');
  if (offset !== undefined && !Number.isFinite(offset))
    throw rangeError('MotionPathControls offset must be a finite number from 0 to 1', 'react-arguments');
  if (!(damping >= 0 && Number.isFinite(damping)) || !(focusDamping >= 0 && Number.isFinite(focusDamping)))
    throw rangeError('MotionPathControls damping must be a finite number of 0 or more', 'react-arguments');
}
// Exponential easing that does not depend on the frame rate: after `tau` seconds 63% of the gap is closed.
const ease = (tau: number, delta: number) => (tau > 0 ? 1 - Math.exp(-delta / tau) : 1);
// Unit quaternion [x, y, z, w] turning +Z onto `forward`, with +Y kept as near world up as it can be.
function facing(f: Point): [number, number, number, number] {
  let ux = 0,
    uy = 1,
    uz = 0;
  if (Math.abs(f[1]) > 0.999) [ux, uy, uz] = [0, 0, f[1] > 0 ? -1 : 1];
  let xx = uy * f[2] - uz * f[1],
    xy = uz * f[0] - ux * f[2],
    xz = ux * f[1] - uy * f[0];
  const l = Math.hypot(xx, xy, xz);
  xx /= l;
  xy /= l;
  xz /= l;
  const yx = f[1] * xz - f[2] * xy,
    yy = f[2] * xx - f[0] * xz,
    yz = f[0] * xy - f[1] * xx,
    // Columns x, y, f of the rotation matrix.
    trace = xx + yy + f[2];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(yz - f[1]) * s, (f[0] - xz) * s, (xy - yx) * s, 0.25 / s];
  }
  if (xx > yy && xx > f[2]) {
    const s = 2 * Math.sqrt(1 + xx - yy - f[2]);
    return [0.25 * s, (yx + xy) / s, (f[0] + xz) / s, (yz - f[1]) / s];
  }
  if (yy > f[2]) {
    const s = 2 * Math.sqrt(1 + yy - xx - f[2]);
    return [(yx + xy) / s, 0.25 * s, (f[1] + yz) / s, (f[0] - xz) / s];
  }
  const s = 2 * Math.sqrt(1 + f[2] - xx - yy);
  return [(f[0] + xz) / s, (f[1] + yz) / s, 0.25 * s, (xy - yx) / s];
}
function at(
  curves: readonly MotionCurve[],
  lengths: readonly number[],
  total: number,
  u: number,
  out: Point,
  tangent?: Point,
): void {
  let distance = Math.min(Math.max(u, 0), 1) * total,
    i = 0;
  while (i < curves.length - 1 && distance > lengths[i]) distance -= lengths[i++];
  const local = lengths[i] > 0 ? Math.min(distance / lengths[i], 1) : 0,
    p = curves[i].getPointAt(local);
  out[0] = p[0];
  out[1] = p[1];
  out[2] = p[2] ?? 0;
  if (!tangent) return;
  const t = curves[i].getTangentAt(local),
    l = Math.hypot(t[0], t[1], t[2] ?? 0) || 1;
  tangent[0] = t[0] / l;
  tangent[1] = t[1] / l;
  tangent[2] = (t[2] ?? 0) / l;
}
/**
 * drei's MotionPathControls: moves the Canvas camera (or `object`) along `curves` by arc length, looking along the
 * path or at `focus`. Set `offset` to ease there, or write `current` through `useMotion()` or the ref yourself (in
 * `useFrame`, from a scroll position, ...). A mesh is turned so its +Z faces the look-at point.
 */
export const MotionPathControls = /* @__PURE__ */ forwardRef<MotionState, MotionPathControlsProps>(
  function MotionPathControls(
    { curves, object, focus, offset, damping = 0.2, focusDamping = 0.1, loop = true, children },
    ref,
  ) {
    check(curves, offset, damping, focusDamping);
    const scene = useScene(),
      [state] = useState<MotionState>(() => ({
        current: offset ?? 0,
        curves,
        point: [0, 0, 0],
        tangent: [0, 0, 1],
        focus: [0, 0, 0],
      })),
      props = useRef({ curves, object, focus, offset, damping, focusDamping, loop });
    props.current = { curves, object, focus, offset, damping, focusDamping, loop };
    (state as { curves: readonly MotionCurve[] }).curves = curves;
    useImperativeHandle(ref, () => state, [state]);
    useEffect(() => {
      let lengths: number[] = [],
        total = 0,
        measured: readonly MotionCurve[] | null = null,
        fresh = true;
      const ahead: Point = [0, 0, 0],
        wanted: Point = [0, 0, 0];
      return subscribeFrame(scene.frames, (_, delta) => {
        const p = props.current;
        if (measured !== p.curves) {
          lengths = p.curves.map((c) => c.getLength());
          total = lengths.reduce((a, b) => a + b, 0);
          measured = p.curves;
        }
        if (p.offset !== undefined) {
          let gap = p.offset - state.current;
          if (p.loop) gap -= Math.round(gap);
          state.current += gap * ease(p.damping, delta);
        }
        if (p.loop) state.current -= Math.floor(state.current);
        else state.current = Math.min(Math.max(state.current, 0), 1);
        at(p.curves, lengths, total, state.current, state.point, state.tangent);
        const look = p.focus;
        if (look && 'current' in look) {
          const mesh = look.current;
          if (mesh) {
            const m = mesh.engine.store.matrices,
              o = mesh.id * 16;
            wanted[0] = m[o + 12];
            wanted[1] = m[o + 13];
            wanted[2] = m[o + 14];
          }
        } else if (look) {
          wanted[0] = look[0];
          wanted[1] = look[1];
          wanted[2] = look[2];
        } else {
          // A small step ahead along the path (behind it at the very end).
          const step = Math.min(1e-3, 1 / Math.max(total, 1e-9));
          at(p.curves, lengths, total, Math.min(state.current + step, 1), ahead);
          if (state.current + step > 1) {
            at(p.curves, lengths, total, state.current - step, ahead);
            for (let i = 0; i < 3; i++) ahead[i] = 2 * state.point[i] - ahead[i];
          }
          for (let i = 0; i < 3; i++) wanted[i] = ahead[i];
        }
        const k = fresh || !look ? 1 : ease(p.focusDamping, delta);
        fresh = false;
        for (let i = 0; i < 3; i++) state.focus[i] += (wanted[i] - state.focus[i]) * k;
        const target = p.object?.current;
        if (target) {
          const forward: Point = [
              state.focus[0] - state.point[0],
              state.focus[1] - state.point[1],
              state.focus[2] - state.point[2],
            ],
            l = Math.hypot(...forward);
          target.setPosition(state.point);
          if (l > 1e-9) target.setQuaternion(facing([forward[0] / l, forward[1] / l, forward[2] / l]));
        } else if (!p.object) {
          // New arrays: the camera's may be the caller's own (a Canvas camera prop), never written in place.
          const camera = scene.engine.camera as unknown as { position: Vec3; target: Vec3 };
          camera.position = [state.point[0], state.point[1], state.point[2]];
          camera.target = [state.focus[0], state.focus[1], state.focus[2]];
        }
      });
    }, [scene.frames, scene.engine, state]);
    return <MotionContext.Provider value={state}>{children}</MotionContext.Provider>;
  },
);
