import { createContext, forwardRef, useContext, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { parseColor, type ColorInput } from '@margoengine/math/color';
import type { Vec3 } from '@margoengine/math';
import type { Line as NativeLine, LineOptions } from '@margoengine/lines';
import { subscribeFrame } from './frame-priority.js';
import { useCommit, useCreated, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { attachBinding, detachBinding } from './package-binding.js';
import { fault, rangeError } from '../../shared/errors.js';

/**
 * A live segment of `<Segments>`, the ref of `<Segment>`. Its arrays are read every frame: write `start`, `end` or
 * `color` in place (in `useFrame`, say) and the batch redraws, uploading only when a value changed.
 */
export interface SegmentHandle {
  /** Start point, in the batch's space. */
  readonly start: [number, number, number];
  /** End point, in the batch's space. */
  readonly end: [number, number, number];
  /** Linear rgb, 0..1 or brighter. */
  readonly color: [number, number, number];
}
/** Props of `<Segment>`; `start` and `end` are required. */
export interface SegmentProps {
  start: Vec3;
  end: Vec3;
  /** Colour of the whole segment (hex string, number or linear rgb). Default white. */
  color?: ColorInput;
}
/** Props of `<Segments>`: the native line material and transform of `@margoengine/lines`, every one optional. */
export interface SegmentsProps extends Omit<LineOptions, 'positions' | 'colors' | 'mode'> {
  /** Most segments drawn, in mount order; later ones wait until earlier ones unmount. Default 1000. */
  limit?: number;
  /** Alias for width, in CSS pixels (or world units with worldUnits). Default 1. */
  lineWidth?: number;
  children?: ReactNode;
  onError?: (error: unknown) => void;
}
const Batch = /* @__PURE__ */ createContext<Set<SegmentHandle> | null>(null);
let serial = 0;
const owners = new WeakMap<NativeLine, () => void>();
/**
 * drei's Segments: every `<Segment>` inside is drawn by one native, antialiased line in segment mode, so a thousand
 * segments are one draw. The ref is the native line (material and matrix setters).
 */
export const Segments = /* @__PURE__ */ forwardRef<NativeLine, SegmentsProps>(function Segments(
  { limit = 1000, lineWidth, children, onError, ...options },
  ref,
) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw rangeError('Segments limit must be a positive integer; pass the most segments to draw', 'react-arguments');
  const scene = useScene(),
    [set] = useState(() => new Set<SegmentHandle>()),
    latest = useRef(options),
    drawn = useRef<Float32Array>(new Float32Array(0)),
    scratch = useRef<Float32Array>(new Float32Array(0));
  latest.current = options;
  const { mesh, material, matrix, ...style } = options;
  const line = useCreated(
    scene,
    {
      load: () => optionalPeer('@margoengine/lines', () => import('@margoengine/lines')),
      create: (api) => {
        const made = new api.Line({
          ...latest.current,
          mesh: latest.current.mesh === undefined && !matrix ? scene.registry?.current : latest.current.mesh,
          width: lineWidth ?? latest.current.width,
          mode: 'segments',
        });
        const plugin = new api.Lines({ name: `react-segments:${++serial}` });
        plugin.add(made);
        attachBinding(scene, plugin);
        owners.set(made, () => detachBinding(scene, plugin));
        drawn.current = new Float32Array(0);
        return made;
      },
      dispose: (made) => {
        owners.get(made)?.();
        made.dispose();
      },
      ref,
      onError,
    },
    [scene.world, scene.registry, lineWidth, mesh, material, matrix, JSON.stringify(style)],
  );
  // Before the frame's draw: gather the segments, and upload only when a point or colour changed.
  const draw = useRef<() => void>(() => {});
  draw.current = () => {
    if (!line) return;
    const count = Math.min(limit, set.size);
    if (scratch.current.length !== count * 12) scratch.current = new Float32Array(count * 12);
    const values = scratch.current;
    let i = 0;
    for (const segment of set) {
      if (i === count) break;
      const o = i * 12;
      values.set(segment.start, o);
      values.set(segment.end, o + 3);
      values.set(segment.color, o + 6);
      values.set(segment.color, o + 9);
      i++;
    }
    const last = drawn.current;
    if (last.length === values.length && last.every((v, k) => v === values[k])) return;
    drawn.current = values.slice();
    const positions = new Float32Array(count * 6),
      colors = new Float32Array(count * 6);
    for (let s = 0; s < count; s++) {
      positions.set(values.subarray(s * 12, s * 12 + 6), s * 6);
      colors.set(values.subarray(s * 12 + 6, s * 12 + 12), s * 6);
    }
    line.setPositions(positions, count ? colors : null);
  };
  // useFrame's subscription without importing the Canvas module into this entry.
  useCommit(() => subscribeFrame(scene.frames, () => draw.current(), -50), [scene.frames]);
  return <Batch.Provider value={set}>{children}</Batch.Provider>;
});
/** One segment of the enclosing `<Segments>`; its ref is the live {@link SegmentHandle}. */
export const Segment = /* @__PURE__ */ forwardRef<SegmentHandle, SegmentProps>(function Segment(
  { start, end, color = '#ffffff' },
  ref,
) {
  const set = useContext(Batch);
  if (!set) throw fault('state', 'Segment requires <Segments>; render it inside one', 'react-usage');
  const [segment] = useState<SegmentHandle>(() => ({ start: [0, 0, 0], end: [0, 0, 0], color: [1, 1, 1] }));
  const key = typeof color === 'object' ? JSON.stringify(color) : color;
  useCommit(() => {
    segment.start.splice(0, 3, start[0], start[1], start[2]);
    segment.end.splice(0, 3, end[0], end[1], end[2]);
  }, [segment, start[0], start[1], start[2], end[0], end[1], end[2]]);
  useCommit(() => {
    parseColor(color, segment.color);
  }, [segment, key]);
  useCommit(() => {
    set.add(segment);
    return () => {
      set.delete(segment);
    };
  }, [set, segment]);
  useImperativeHandle(ref, () => segment, [segment]);
  return null;
});
