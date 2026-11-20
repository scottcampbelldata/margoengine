import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react';
import type { Mesh as MeshHandle } from '@margoengine/core';
import type { AccumulatedLight, AmbientShadowOptions, AmbientShadows } from '@margoengine/studio/accumulate-ambient';
import type { ContactSource } from '@margoengine/studio';
import { parseColor, type ColorInput } from '@margoengine/math/color';
import type { Vec3 } from '@margoengine/math';
import { Mesh, type MeshProps } from './components.js';
import { casters } from './casters.js';
import { subscribeFrame } from './frame-priority.js';
import { live, report, useMesh, useScene, type Registry } from './internal.js';
import { optionalPeer } from './optional.js';
import { rangeError } from '../../shared/errors.js';

/** Props of `<AccumulativeShadows>`: drei's names, every one optional. */
export interface AccumulativeShadowsProps extends Omit<MeshProps, 'scale' | 'castShadow' | 'receiveShadow'> {
  /**
   * Frames to accumulate, each taking every `amount` sample of every `<RandomizedLight>` child (at most 1024 samples in
   * all), then the shadow holds. `Infinity` keeps sampling as a moving average over `blend` frames. Default 40.
   */
  frames?: number;
  /** With `frames={Infinity}`, the moving-average length in frames. Default 100. */
  blend?: number;
  /** With `frames={Infinity}`, stop after this many frames (a settled scene stops costing). Default Infinity. */
  limit?: number;
  /** Plane side in world units (times the group's x scale), centred on the group. Default 10. */
  scale?: number;
  /**
   * `true`: each rendered frame takes one frame's samples (every light's `amount`), so `frames` finish in that many
   * rendered frames. `false`: every frame in the first rendered frame. Default false.
   */
  temporal?: boolean;
  /** Darkness where every sample is blocked, 0..1. Default 1. */
  opacity?: number;
  /** Shadow colour: hex string, `[r, g, b]` linear 0..1 or a `color(...)` string. Default black. */
  color?: ColorInput;
  /** Square shadow texture size in texels, 16..4096. Default 1024. */
  resolution?: number;
  /** Caster fragments with alpha below this cast no shadow (a glass at opacity 0.3 casts none), 0..1. Default 0.65. */
  alphaTest?: number;
  /** Scale of `color` before tone mapping: 0 turns it black, 2 doubles it. Default 2. */
  colorBlend?: number;
  /** Tone map the plane colour like a lit surface (PBR Neutral); false clamps it like unlit output. Default true. */
  toneMapped?: boolean;
  /** Called with the native catcher (`AmbientShadows` of `@margoengine/studio/accumulate-ambient`) once attached. */
  onReady?: (shadows: AmbientShadows) => void;
  onError?: (error: unknown) => void;
  children?: ReactNode;
}
/** The ref of `<AccumulativeShadows>`, drei's methods. */
export interface AccumulativeShadowsHandle {
  /** The group mesh (the plane itself is drawn by the native catcher, not a mesh). */
  getMesh(): MeshHandle | null;
  /** Clears the accumulated samples; accumulation starts again from scratch. */
  reset(): void;
  /** Restarts the accumulation for `frames` frames (default 1) until the `frames` prop changes. */
  update(frames?: number): void;
  /** The native catcher, null until attached. */
  readonly shadows: AmbientShadows | null;
}
/** Props of `<RandomizedLight>`: drei's names, every one optional. */
export interface RandomizedLightProps {
  /** Light position in the parent `<AccumulativeShadows>`' space; only its direction from the group counts. Default [0, 0, 0]. */
  position?: Vec3;
  /** Jiggle radius at `position`, same units; larger gives softer shadows. Default 5. */
  radius?: number;
  /** Samples per frame. Default 8. */
  amount?: number;
  /** Relative weight against the other lights. Default 1. */
  intensity?: number;
  /** Share of samples taken from the whole sky (ambient occlusion), 0..1. Default 0.5. */
  ambient?: number;
  /** drei's light switch. `false` leaves this light out. Default true. */
  castShadow?: boolean;
  /**
   * Shadow bias in normalized shadow-camera depth (times far - near in world units): positive lets casters just
   * behind the plane shade it, negative drops casters just above it. Default 0.
   */
  bias?: number;
  /** Shadow map texels per side of the shadow camera window: each plane point reads its texel's centre. Default 512. */
  mapSize?: number;
  /** Half side of the square shadow camera window around the light's axis; outside it nothing shades. Default 10. */
  size?: number;
  /** Shadow camera near distance from the light: closer casters do not cast. Default 0.5. */
  near?: number;
  /** Shadow camera far distance from the light: farther casters do not cast. Default 500. */
  far?: number;
  /** drei's own jiggle count outside AccumulativeShadows; inside one the parent's `frames` count. Accepted, unused. */
  frames?: number;
}
type Light = Required<
  Pick<RandomizedLightProps, 'position' | 'radius' | 'amount' | 'intensity' | 'ambient' | 'bias' | 'mapSize' | 'size' | 'near' | 'far'>
>;
const Lights = /* @__PURE__ */ createContext<Set<{ current: Light | null }> | null>(null);
// A light this many times its own distance from the group: the drei lights are directional, and at 1000 times the
// perspective of a disk light differs from parallel projection by under 0.1% of a caster's height.
const FAR = 1000;
const pbrSource = Symbol.for('margoengine.pbr-source.v1');
const positive = (v: number, infinite = false) => (v >= 1 && Number.isFinite(v)) || (infinite && v === Infinity);
const length = (m: ArrayLike<number>, o: number) => Math.hypot(m[o], m[o + 1], m[o + 2]);

/** The native options for the group's world matrix `m`, the lights and the props; throws for invalid values. */
export function accumulativeOptions(
  m: ArrayLike<number>,
  lights: readonly Light[],
  props: Pick<
    AccumulativeShadowsProps,
    | 'frames' | 'blend' | 'limit' | 'scale' | 'temporal' | 'opacity' | 'color' | 'resolution' | 'alphaTest' | 'colorBlend' | 'toneMapped'
  >,
): AmbientShadowOptions {
  const { frames = 40, blend = 100, limit = Infinity, scale = 10, temporal = false, opacity = 1, resolution = 1024 } =
    props;
  const sx = length(m, 0),
    up = [m[4], m[5], m[6]].map((v) => v / length(m, 4)),
    origin = [m[12], m[13], m[14]];
  let amount = 0,
    weight = 0,
    ambient = 0,
    height = Infinity;
  const disks: AccumulatedLight[] = lights.map((l) => {
    const p = l.position,
      d = [0, 1, 2].map((i) => m[i] * p[0] + m[i + 4] * p[1] + m[i + 8] * p[2]),
      h = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
    if (!positive(l.amount) || !(h > 0)) height = NaN;
    amount += l.amount;
    weight += l.intensity;
    ambient += l.intensity * l.ambient;
    height = Math.min(height, 0.999 * FAR * h);
    // drei's shadow camera stands at the light in world units (the group scale moves it, not its frustum); this one
    // FAR times as far along the same axis, so its distances grow by (FAR - 1) times the light's distance. Bias is in
    // normalized orthographic depth, (far - near) world units.
    const reach = (FAR - 1) * Math.hypot(d[0], d[1], d[2]);
    return {
      position: origin.map((o, i) => o + FAR * d[i]) as unknown as Vec3,
      radius: FAR * sx * l.radius,
      intensity: l.intensity,
      bias: l.bias && l.bias * (l.far - l.near),
      size: l.size,
      mapSize: l.mapSize,
      near: l.near + reach,
      far: l.far + reach,
    };
  });
  if (!positive(frames, true) || !positive(blend) || !positive(limit, true) || Number.isNaN(height))
    throw rangeError(
      'AccumulativeShadows: frames, blend, limit and each RandomizedLight amount must be 1 or more, and each light above the plane; pass valid props',
      'react-arguments',
    );
  const cap = (n: number) => Math.min(1024, Math.round(n * amount)),
    endless = frames === Infinity;
  return {
    position: origin as unknown as Vec3,
    up: up as unknown as Vec3,
    size: scale * sx,
    height,
    opacity,
    color: parseColor(props.color ?? [0, 0, 0]).slice(0, 3) as unknown as Vec3,
    resolution,
    temporal,
    lights: disks,
    ambient: weight > 0 ? ambient / weight : 0.5,
    frames: endless ? (limit === Infinity ? Infinity : cap(limit)) : cap(frames),
    blend: endless ? Math.round(blend * amount) : undefined,
    samples: Math.min(1024, amount),
    alphaTest: props.alphaTest ?? 0.65,
    colorBlend: props.colorBlend ?? 2,
    toneMapped: props.toneMapped ?? true,
  };
}
function Binding({
  props,
  lights,
  control,
}: {
  props: AccumulativeShadowsProps;
  lights: Set<{ current: Light | null }>;
  control: { shadows: AmbientShadows | null; frames: number | null; reset: boolean };
}) {
  const scene = useScene(),
    registry = useMesh(),
    latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    let active = true,
      attaching = false,
      seen = '',
      shadows: AmbientShadows | null = null;
    const added = new Map<object, { target: object; remove: () => void }>();
    const fail = (error: unknown) => {
      if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
    };
    // A mesh drawn by <TextureMaterial> or another materials owner casts through its materials mesh (its own geometry
    // is cleared); the materials mesh is re-added when the owner rebuilds it.
    const target = (entry: object): object | null => {
      if (!('attachments' in entry)) return entry;
      const mesh = live(entry as Registry);
      return (mesh && (mesh as unknown as Record<symbol, object | undefined>)[pbrSource]) || mesh;
    };
    // Every castShadow mesh and model of the Canvas casts, as in drei; re-added when its mesh is recreated.
    const sync = (s: AmbientShadows) => {
      const set = casters(scene.engine);
      for (const [entry, was] of added)
        if (!set.has(entry) || target(entry) !== was.target) {
          was.remove();
          added.delete(entry);
        }
      for (const entry of set) {
        const t = target(entry);
        if (!t || added.has(entry)) continue;
        added.set(entry, { target: t, remove: s.add(t as ContactSource | MeshHandle) });
      }
    };
    const look = () => {
      const root = live(registry);
      if (!root || attaching) return;
      const used = [...lights].map((l) => l.current).filter((l): l is Light => !!l);
      if (!used.length) {
        shadows?.dispose();
        shadows = control.shadows = null;
        for (const was of added.values()) was.remove();
        added.clear();
        return;
      }
      scene.engine.store.tick(false);
      try {
        const options = accumulativeOptions(
            root.matrix,
            used,
            control.frames === null ? latest.current : { ...latest.current, frames: control.frames },
          ),
          key = JSON.stringify(options, (_, v: unknown) => (v === Infinity ? 'Infinity' : v));
        if (shadows) {
          // Only a changed value is written: the catcher restarts its sum when its lighting or frames change.
          if (key !== seen) {
            const target = shadows.options as Record<string, unknown>;
            Object.assign(target, options);
            if (options.blend === undefined) delete target.blend;
          }
          seen = key;
          if (control.reset) shadows.invalidate();
          control.reset = false;
          sync(shadows);
          return;
        }
        attaching = true;
        optionalPeer('@margoengine/studio', () => import('@margoengine/studio/accumulate-ambient'))
          .then((api) => {
            if (!active || scene.engine.disposed) return;
            const made = api.AmbientShadows.attach(scene.engine, options);
            shadows = control.shadows = made;
            seen = key;
            control.reset = false;
            sync(made);
            latest.current.onReady?.(made);
          })
          .catch(fail)
          .finally(() => {
            attaching = false;
          });
      } catch (error) {
        fail(error);
      }
    };
    const stop = subscribeFrame(scene.frames, look, -50);
    return () => {
      active = false;
      stop();
      for (const was of added.values()) was.remove();
      shadows?.dispose();
      control.shadows = null;
    };
  }, [scene, registry, lights, control]);
  return null;
}
/**
 * drei's AccumulativeShadows: a ground plane under the group that averages the shadows of every `castShadow` mesh and
 * model in the Canvas from its `<RandomizedLight>` children, soft area-light penumbrae plus sky occlusion, by
 * `AmbientShadows` of `@margoengine/studio/accumulate-ambient`. The group's world position and up axis place the plane.
 * Needs WebGPU or the WebGL2 compatibility layer.
 */
export const AccumulativeShadows = /* @__PURE__ */ forwardRef<AccumulativeShadowsHandle, AccumulativeShadowsProps>(
  function AccumulativeShadows(
    {
      frames,
      blend,
      limit,
      scale,
      temporal,
      opacity,
      color,
      resolution,
      alphaTest,
      colorBlend,
      toneMapped,
      onReady,
      onError,
      children,
      ...props
    },
    ref,
  ) {
    const lights = useRef<Set<{ current: Light | null }>>(null!),
      control = useRef<{ shadows: AmbientShadows | null; frames: number | null; reset: boolean; group: unknown }>(
        null!,
      );
    lights.current ??= new Set();
    control.current ??= { shadows: null, frames: null, reset: false, group: null };
    const c = control.current;
    // A new `frames` prop ends an update(frames) override.
    useEffect(() => {
      c.frames = null;
    }, [c, frames]);
    useImperativeHandle(
      ref,
      () => ({
        getMesh: () => c.group as MeshHandle | null,
        reset: () => void (c.reset = true),
        update: (n = 1) => {
          c.frames = n;
          c.reset = true;
        },
        get shadows() {
          return c.shadows;
        },
      }),
      [c],
    );
    const options = {
      frames, blend, limit, scale, temporal, opacity, color, resolution, alphaTest, colorBlend, toneMapped, onReady, onError,
    };
    return (
      <Mesh {...props} ref={(m) => void (c.group = m)}>
        <Binding props={options} lights={lights.current} control={c} />
        <Lights.Provider value={lights.current}>{children}</Lights.Provider>
      </Mesh>
    );
  },
);
/**
 * drei's RandomizedLight inside `<AccumulativeShadows>`: a disk of light around `position` (its direction from the
 * group, as drei's directional lights) sampled `amount` times per frame, mixed with `ambient` sky occlusion. Outside an
 * `<AccumulativeShadows>` it does nothing.
 */
export function RandomizedLight({
  position = [0, 0, 0],
  radius = 5,
  amount = 8,
  intensity = 1,
  ambient = 0.5,
  castShadow = true,
  bias = 0,
  mapSize = 512,
  size = 10,
  near = 0.5,
  far = 500,
}: RandomizedLightProps): null {
  const set = useContext(Lights),
    light = useRef<{ current: Light | null }>(null!);
  light.current ??= { current: null };
  light.current.current = castShadow ? { position, radius, amount, intensity, ambient, bias, mapSize, size, near, far } : null;
  useEffect(() => {
    if (!set) return;
    const l = light.current;
    set.add(l);
    return () => void set.delete(l);
  }, [set]);
  return null;
}
