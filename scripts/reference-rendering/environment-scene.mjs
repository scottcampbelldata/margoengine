import { referenceCase } from './cases.mjs';
import { prepareScene } from './scene.mjs';

/** Constant radiance furnace. Preserve every source primitive/material; remove the direct sun. */
export function environmentScene(source) {
  const base = referenceCase('metallic-roughness');
  const settings = { ...base.settings, light: { ...base.settings.light, intensity: 0 }, environment: [0.3, 0.5, 0.7] };
  return { ...prepareScene(source, { ...base, settings }), settings };
}
