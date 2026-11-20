import { useEffect, useRef } from 'react';
import type { ShadowOptions } from '@margoengine/shadows';
import { useCommit, useScene } from './internal.js';
import { loadShadows } from './shadows-loader.js';

export { ContactShadows, type ContactShadowsProps } from './contact-shadows.js';
export { BakeShadows } from './bake-shadows.js';

/** Live `@margoengine/shadows` options. `cascades` is fixed when the Canvas creates the shadows, so it is not here. */
export type ShadowsProps = Omit<ShadowOptions, 'cascades'>;
const saved = new WeakMap<object, Map<string, unknown>>();
/**
 * Turns on the Canvas's cascaded shadows for as long as it is mounted and sets their options (map size, distance,
 * bias, filter, fixed `bounds` or `frustum`). A prop that is removed again restores its default. Meshes cast with
 * `<Mesh castShadow>`, `<Box castShadow>` or `<Model castShadow>`; without a `<Shadows>` those props draw nothing.
 * Unmounting restores the options it set while another shadow user keeps the shadows on.
 * Needs WebGPU and `@margoengine/shadows`.
 */
export function Shadows(props: ShadowsProps): null {
  const scene = useScene(),
    set = useRef<{ shadows: object; keys: Set<string> } | null>(null);
  useEffect(() => scene.requestShadows(loadShadows), [scene.requestShadows]);
  // Unmounting restores what this component set, so the Canvas's other shadow users keep their own values.
  useEffect(
    () => () => {
      const last = set.current;
      set.current = null;
      const defaults = last && saved.get(last.shadows);
      if (!last || !defaults) return;
      const options = (last.shadows as { options: Record<string, unknown> }).options;
      for (const key of last.keys) {
        if (!defaults.has(key)) continue;
        const value = defaults.get(key);
        defaults.delete(key);
        if (value === undefined) delete options[key];
        else options[key] = value;
      }
    },
    [],
  );
  useCommit(() => {
    const shadows = scene.shadows;
    if (!shadows) return;
    if (set.current?.shadows !== shadows) set.current = { shadows, keys: new Set() };
    const keys = set.current.keys;
    const options = shadows.options as Record<string, unknown>,
      values = props as Record<string, unknown>;
    let defaults = saved.get(shadows);
    if (!defaults) saved.set(shadows, (defaults = new Map()));
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (!defaults.has(key)) defaults.set(key, options[key]);
      options[key] = value;
      keys.add(key);
    }
    // Only the props this component set and has since removed: another <Shadows> keeps its own.
    for (const key of keys)
      if (values[key] === undefined) {
        const value = defaults.get(key);
        keys.delete(key);
        defaults.delete(key);
        if (value === undefined) delete options[key];
        else options[key] = value;
      }
  });
  return null;
}

/** Props of `<SoftShadows>`: drei's names for the `'soft'` (PCSS) filter of `@margoengine/shadows`. */
export interface SoftShadowsProps {
  /**
   * Light size, in drei's unit (the larger, the softer). Shadows' `lightSize` is `size / 1250`, so drei's default 25 is
   * Shadows' default 0.02: a penumbra 0.02 world units wide per world unit between caster and receiver. Default 25.
   */
  size?: number;
  /**
   * Taps per lit pixel, a whole number from 1 to 128: both the comparison taps (Shadows' `samples`) and the blocker
   * search reads (`blockerSamples`). More is smoother and costs more. Default 10.
   */
  samples?: number;
  /**
   * Depth focus: the caster-to-receiver distance, world units, at which the shadow is sharpest (Shadows' `focus`).
   * Default 0: sharpest where a caster touches the receiver.
   */
  focus?: number;
}
/**
 * drei's SoftShadows: percentage-closer soft shadows (Fernando 2005) whose penumbrae widen with the distance between
 * caster and receiver. Turns the Canvas's shadows on as `<Shadows>` does, with the `'soft'` filter, and sets its light
 * size, tap counts and focus; unmounting restores Shadows' defaults. Needs WebGPU and `@margoengine/shadows`.
 */
export function SoftShadows({ size = 25, samples = 10, focus = 0 }: SoftShadowsProps): null {
  return Shadows({ filter: 'soft', lightSize: size / 1250, samples, blockerSamples: samples, focus });
}
