import { createContext, forwardRef, useContext, useEffect, useRef } from 'react';
import type { EngineKernel } from '@margoengine/core';
import type { Lightformer as NativeLightformer, LightformerForm } from '@margoengine/environment/lightformer';
import type { ColorInput } from '@margoengine/environment/main';
import { Mesh, type MeshProps, type MeshRef } from './components.js';
import { live, report, useMesh, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { rangeError } from '../../shared/errors.js';

type Vec3 = [number, number, number];

/**
 * @internal The Lightformers under an `<Environment>` still loading or attaching: its capture waits until none is, so a
 * single-frame capture never misses one.
 */
export const LightformerPending = /* @__PURE__ */ createContext<{ count: number } | null>(null);

/** Props of `<Lightformer>`; every prop is optional. */
export interface LightformerProps extends Omit<MeshProps, 'scale' | 'children'> {
  /** `'rect'` (1 x 1), `'circle'` (1 across), `'ring'` (1 across, open inside 0.5) or `'box'` (1 x 1 x 1). Default `'rect'`. */
  form?: LightformerForm;
  /** Radiance multiplier, finite and >= 0: the form emits `color x intensity`. Default 1. */
  intensity?: number;
  /** Colour: `'#rrggbb'`, `0xrrggbb` (sRGB) or linear `[r, g, b]`. Default white. */
  color?: ColorInput;
  /** Size: one number for all axes, `[width, height]` or `[x, y, z]`. Default 1. */
  scale?: number | readonly [number, number] | readonly [number, number, number];
  /**
   * A point, in the same space as `position`, the form's front (+Z) turns to face, keeping its up toward +Y; replaces
   * `rotation`. Default none.
   */
  target?: readonly [number, number, number];
  /** Called with the native Lightformer of `@margoengine/environment/lightformer` once it is attached. */
  onCreated?: (lightformer: NativeLightformer) => void;
  onError?: (error: unknown) => void;
}

function scaleOf(value: LightformerProps['scale']): Vec3 {
  const s =
    typeof value === 'number'
      ? [value, value, value]
      : Array.isArray(value) && value.length === 2
        ? [value[0], value[1], 1]
        : Array.isArray(value) && value.length === 3
          ? [...value]
          : null;
  if (!s || s.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
    throw rangeError('Lightformer scale must be a finite number, [width, height] or [x, y, z]; pass one of those', 'react-arguments');
  return s as Vec3;
}
/** Quaternion [x, y, z, w] turning +Z toward `d` with +Y kept up (a look-at basis; +Z up when `d` is vertical). */
export function faceToward(d: readonly number[]): [number, number, number, number] {
  const length = Math.hypot(d[0], d[1], d[2]);
  if (!(length > 0)) return [0, 0, 0, 1];
  const z = [d[0] / length, d[1] / length, d[2] / length],
    up = Math.abs(z[1]) > 0.999999 ? [0, 0, -Math.sign(z[1])] : [0, 1, 0];
  let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
  const xl = Math.hypot(x[0], x[1], x[2]);
  x = [x[0] / xl, x[1] / xl, x[2] / xl];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  // Rotation matrix columns x, y, z to a quaternion (Shoemake 1985, largest-diagonal branch).
  const [m00, m11, m22] = [x[0], y[1], z[2]],
    trace = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s];
  }
  return q;
}

interface Settings {
  form: LightformerForm;
  intensity: number;
  color: ColorInput;
  scale: Vec3;
  quaternion: [number, number, number, number];
  onCreated?: (lightformer: NativeLightformer) => void;
  onError?: (error: unknown) => void;
}
function LightformerBinding({ settings }: { settings: Settings }) {
  const scene = useScene(),
    registry = useMesh(),
    pending = useContext(LightformerPending),
    latest = useRef(settings),
    native = useRef<NativeLightformer | null>(null);
  latest.current = settings;
  useEffect(() => {
    let active = true,
      counted = pending !== null,
      value: NativeLightformer | undefined;
    if (pending) pending.count++;
    const settle = () => {
      if (counted) pending!.count--;
      counted = false;
    };
    void optionalPeer('@margoengine/environment', () => import('@margoengine/environment/lightformer'))
      .then((api) => {
        const mesh = live(registry);
        if (!active || scene.engine.disposed || !mesh) return;
        const s = latest.current;
        value = new api.Lightformer({ parent: mesh, form: s.form, color: s.color, intensity: s.intensity });
        (scene.world ?? scene.engine).use(value as unknown as Parameters<EngineKernel['use']>[0]);
        value.node.setScale(s.scale).setQuaternion(s.quaternion);
        native.current = value;
        settle();
        s.onCreated?.(value);
      })
      .catch((error) => {
        settle();
        if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
      })
      .finally(settle);
    return () => {
      active = false;
      settle();
      native.current = null;
      value?.dispose();
    };
  }, [scene, registry, pending]);
  const { form, intensity, color, scale, quaternion } = settings,
    key = Array.isArray(color) ? `[${color.join()}]` : String(color),
    shape = `${scale.join()}|${quaternion.join()}`;
  useEffect(() => {
    const value = native.current;
    if (!value) return;
    try {
      value.form = form;
      value.intensity = intensity;
      value.color = color;
      value.node.setScale(scale).setQuaternion(quaternion);
    } catch (error) {
      report(scene, error, latest.current.onError);
    }
    // The colour, scale and turn count by value: an inline array is a new object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, form, intensity, key, shape]);
  return null;
}

/**
 * drei's Lightformer: an emissive card (rect, circle, ring) or box that paints a studio light into the environment
 * when placed inside `<Environment>` (its children are captured into the lighting and hidden in the main view); outside
 * an Environment it is drawn as a bright unlit shape. Built on `Lightformer` of `@margoengine/environment/lightformer`;
 * WebGPU and the WebGL2 compatibility layer.
 */
export const Lightformer = /* @__PURE__ */ forwardRef<MeshRef, LightformerProps>(function Lightformer(
  { form = 'rect', intensity = 1, color = '#ffffff', scale = 1, target, rotation, onCreated, onError, ...props },
  ref,
) {
  const s = scaleOf(scale),
    position = props.position ?? [0, 0, 0],
    quaternion = target
      ? faceToward([target[0] - position[0], target[1] - position[1], target[2] - position[2]])
      : ([0, 0, 0, 1] as [number, number, number, number]);
  return (
    <Mesh {...props} rotation={target ? undefined : rotation} ref={ref}>
      <LightformerBinding settings={{ form, intensity, color, scale: s, quaternion, onCreated, onError }} />
    </Mesh>
  );
});
