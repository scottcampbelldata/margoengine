import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { EnginePlugin } from '@margoengine/core';
import type { Vec3 } from '@margoengine/core/extension';
import { report, useScene } from './internal.js';

/** Props of `<CameraShake>`; every prop is optional. Angles are radians, frequencies cycles of noise per second. */
export interface CameraShakeProps {
  /** Largest turn left and right. Default 0.1. */
  maxYaw?: number;
  /** Largest tilt up and down. Default 0.1. */
  maxPitch?: number;
  /** Largest roll about the view direction. Default 0.1. */
  maxRoll?: number;
  /** Default 0.1. */
  yawFrequency?: number;
  /** Default 0.1. */
  pitchFrequency?: number;
  /** Default 0.1. */
  rollFrequency?: number;
  /** Starting intensity in 0..1; the angles scale with its square. Default 1. */
  intensity?: number;
  /** Let the intensity fall to 0 at `decayRate` per second. Default false. */
  decay?: boolean;
  /** Intensity lost per second while `decay` is on. Default 0.65. */
  decayRate?: number;
  /** Called when the shake cannot attach. The Canvas's onError hears it too. */
  onError?: (error: unknown) => void;
}
/** A ref to `<CameraShake>`. */
export interface CameraShakeRef {
  getIntensity(): number;
  /** Sets the intensity, clamped to 0..1; for example 1 on a hit, with `decay` fading it out. */
  setIntensity(value: number): void;
}
// murmur3's 32-bit finalizer (Appleby): a well-mixed hash of a lattice index.
function hash(i: number, seed: number): number {
  let h = Math.imul(i ^ seed, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0x80000000 - 1;
}
/**
 * One-dimensional gradient noise in about -1..1 (Perlin 2002, "Improving Noise": a random slope at each integer, blended
 * with the quintic fade 6t^5 - 15t^4 + 10t^3), smooth in time so the shake has no jumps.
 */
export function shakeNoise(x: number, seed: number): number {
  const i = Math.floor(x),
    t = x - i,
    a = hash(i, seed) * t,
    b = hash(i + 1, seed) * (t - 1),
    fade = t * t * t * (t * (t * 6 - 15) + 10);
  return 2 * (a + (b - a) * fade);
}
// Rodrigues' rotation of v about the unit axis k by angle.
function rotate(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle),
    s = Math.sin(angle),
    dot = (k[0] * v[0] + k[1] * v[1] + k[2] * v[2]) * (1 - c);
  return [
    v[0] * c + (k[1] * v[2] - k[2] * v[1]) * s + k[0] * dot,
    v[1] * c + (k[2] * v[0] - k[0] * v[2]) * s + k[1] * dot,
    v[2] * c + (k[0] * v[1] - k[1] * v[0]) * s + k[2] * dot,
  ];
}
function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}
const same = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
type Camera = { position: Vec3; target: Vec3; up: Vec3 };
let shakes = 0;
/**
 * Shakes the camera with smooth noise: it turns the view about the camera position (yaw, pitch) and rolls it, on top of
 * whatever places the camera (controls, `<Bounds>`, your code), and puts the camera back on unmount. Intensity follows
 * the trauma model: angles scale with intensity squared, so a fading shake eases out (Eiserloh, "Math for Game
 * Programmers: Juicing Your Cameras With Math", GDC 2016).
 */
export const CameraShake = /* @__PURE__ */ forwardRef<CameraShakeRef, CameraShakeProps>(function CameraShake(
  {
    maxYaw = 0.1,
    maxPitch = 0.1,
    maxRoll = 0.1,
    yawFrequency = 0.1,
    pitchFrequency = 0.1,
    rollFrequency = 0.1,
    intensity = 1,
    decay = false,
    decayRate = 0.65,
    onError,
  },
  ref,
) {
  const scene = useScene(),
    options = { maxYaw, maxPitch, maxRoll, yawFrequency, pitchFrequency, rollFrequency, decay, decayRate, onError },
    latest = useRef(options),
    level = useRef(intensity);
  latest.current = options;
  useEffect(() => {
    level.current = Math.min(1, Math.max(0, intensity));
  }, [intensity]);
  useImperativeHandle(
    ref,
    () => ({
      getIntensity: () => level.current,
      setIntensity: (value: number) => {
        level.current = Math.min(1, Math.max(0, value));
      },
    }),
    [],
  );
  useEffect(() => {
    const engine = scene.engine,
      seed = Math.imul(++shakes, 0x27d4eb2f);
    let time = 0,
      camera: Camera | null = null,
      base: { target: Vec3; up: Vec3 } | null = null,
      applied: { target: Vec3; up: Vec3 } | null = null;
    // Puts back each part the last shake set that nothing has changed since: whatever moved the target or up in between
    // (controls, a fit, your code) owns that part's new value, and an untouched part loses its shake.
    const settle = (current: Camera) => {
      if (camera !== current || !base || !applied) return;
      if (same(current.target, applied.target)) current.target = [...base.target];
      if (same(current.up, applied.up)) current.up = [...base.up];
    };
    const plugin: EnginePlugin = {
      name: `react-camera-shake-${seed >>> 0}`,
      setup() {},
      // After every frame callback (controls included), before the camera matrix is built for this frame.
      onPreUpdate(delta) {
        const current = engine.camera as unknown as Camera,
          o = latest.current;
        settle(current);
        camera = current;
        base = { target: [...current.target], up: [...current.up] };
        time += delta;
        if (o.decay) level.current = Math.max(0, level.current - o.decayRate * delta);
        const shake = level.current * level.current,
          yaw = o.maxYaw * shake * shakeNoise(time * o.yawFrequency, seed),
          pitch = o.maxPitch * shake * shakeNoise(time * o.pitchFrequency, seed + 1),
          roll = o.maxRoll * shake * shakeNoise(time * o.rollFrequency, seed + 2);
        const p = current.position,
          forward: Vec3 = [base.target[0] - p[0], base.target[1] - p[1], base.target[2] - p[2]],
          up = unit(base.up),
          right = unit([
            forward[1] * up[2] - forward[2] * up[1],
            forward[2] * up[0] - forward[0] * up[2],
            forward[0] * up[1] - forward[1] * up[0],
          ]);
        // Yaw about the camera's up, pitch about its turned right axis, then roll about the new view direction.
        const turnedRight = rotate(right, up, yaw),
          view = rotate(rotate(forward, up, yaw), turnedRight, pitch),
          rolled = rotate(rotate(up, turnedRight, pitch), unit(view), roll);
        current.target = [p[0] + view[0], p[1] + view[1], p[2] + view[2]];
        current.up = rolled;
        applied = { target: [...current.target], up: [...rolled] };
      },
    };
    try {
      engine.use(plugin);
    } catch (error) {
      report(scene, error, latest.current.onError);
      return;
    }
    return () => {
      engine.removePlugin(plugin.name);
      if (camera && !engine.disposed) settle(camera);
    };
  }, [scene]);
  return null;
});
