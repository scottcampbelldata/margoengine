import { useEffect } from 'react';
import type { ShadowOptions } from '@margoengine/shadows';
import { useCommit, useScene } from './internal.js';
import { loadShadows } from './shadows-loader.js';

export { ContactShadows, type ContactShadowsProps } from './contact-shadows.js';

/** Live `@margoengine/shadows` options. `cascades` is fixed when the Canvas creates the shadows, so it is not here. */
export type ShadowsProps = Omit<ShadowOptions, 'cascades'>;
const saved = new WeakMap<object, Map<string, unknown>>();
/**
 * Turns on the Canvas's cascaded shadows for as long as it is mounted and sets their options (map size, distance,
 * bias, filter, fixed `bounds` or `frustum`). A prop that is removed again restores its default. Meshes cast with
 * `<Mesh castShadow>`, `<Box castShadow>` or `<Model castShadow>`; without a `<Shadows>` those props draw nothing.
 * Needs WebGPU and `@margoengine/shadows`.
 */
export function Shadows(props: ShadowsProps): null {
  const scene = useScene();
  useEffect(() => scene.requestShadows(loadShadows), [scene.requestShadows]);
  useCommit(() => {
    const shadows = scene.shadows;
    if (!shadows) return;
    const options = shadows.options as Record<string, unknown>,
      values = props as Record<string, unknown>;
    let defaults = saved.get(shadows);
    if (!defaults) saved.set(shadows, (defaults = new Map()));
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (!defaults.has(key)) defaults.set(key, options[key]);
      options[key] = value;
    }
    for (const [key, value] of defaults)
      if (values[key] === undefined) {
        if (value === undefined) delete options[key];
        else options[key] = value;
      }
  });
  return null;
}
