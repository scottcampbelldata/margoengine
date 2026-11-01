import type { EngineKernel } from '@margoengine/core';
import type { Clustered, PointLight, SpotLight } from './index.js';

/** A named flicker shape, or your own: seconds in, a brightness scale of 0 or more out. */
export type FlickerCurve = 'candle' | 'fire' | 'fluorescent' | 'pulse' | 'strobe' | ((time: number) => number);
/** How one light flickers. */
export interface FlickerOptions {
  /** Default `'candle'`. */
  curve?: FlickerCurve;
  /** Multiplies time. Default 1. */
  speed?: number;
  /** Keeps lights with one curve out of step. Default: the light's place in the list. */
  seed?: number;
}
/** A light with its flicker; a light without one keeps its intensity. */
export type FlickerLight = (PointLight | SpotLight) & { flicker?: FlickerOptions };

// Value noise from 0 to 1, smooth between whole numbers.
const hash = (n: number): number => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};
function noise(x: number): number {
  const i = Math.floor(x),
    f = x - i;
  return hash(i) + (hash(i + 1) - hash(i)) * f * f * (3 - 2 * f);
}
/**
 * The brightness scale of a flicker curve at `time` seconds, the same every time for one seed. Named curves stay
 * within 0 to 1.
 * @throws TypeError for an unknown curve.
 * @throws RangeError when your own curve returns a negative or non-finite value.
 */
export function flickerAt(curve: FlickerCurve, time: number, seed = 0): number {
  const at = time + seed * 17.3;
  if (typeof curve === 'function') {
    const value = curve(time);
    if (!(value >= 0 && Number.isFinite(value)))
      throw new RangeError('Invalid flicker curve result; return a finite brightness of 0 or more');
    return value;
  }
  switch (curve) {
    case 'candle':
      return 0.8 + 0.2 * (0.7 * noise(at * 7) + 0.3 * noise(at * 19));
    case 'fire':
      return 0.5 + 0.5 * (0.6 * noise(at * 4) + 0.4 * noise(at * 11));
    case 'fluorescent':
      return hash(Math.floor(at * 12)) > 0.9 ? 0.15 : 1;
    case 'pulse':
      return 0.5 + 0.5 * Math.sin(at * 2 * Math.PI);
    case 'strobe':
      return at - Math.floor(at) < 0.1 ? 1 : 0;
    default:
      throw new TypeError(
        'Invalid flicker curve; use candle, fire, fluorescent, pulse, strobe or a function of seconds',
      );
  }
}
/**
 * Sets `lights` on `clustered` and scales their intensities by their flicker curves every frame, on the CPU, with one
 * `setLights` a frame. Returns a function that stops it and puts the steady intensities back.
 */
export function animateFlicker(
  engine: EngineKernel,
  clustered: Clustered,
  lights: readonly FlickerLight[],
): () => void {
  const live = lights.map((light) => ({ ...light }));
  let time = 0;
  const apply = () => {
    lights.forEach((light, i) => {
      if (light.flicker) {
        const { curve = 'candle', speed = 1, seed = i } = light.flicker;
        live[i].intensity = (light.intensity ?? 1) * flickerAt(curve, time * speed, seed);
      }
    });
    clustered.setLights(live);
  };
  apply();
  const stop = engine.onFrame((_, delta) => {
    time += delta;
    apply();
  });
  return () => {
    stop();
    clustered.setLights(lights);
  };
}
