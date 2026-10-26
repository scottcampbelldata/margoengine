import { PbrMaterial } from '@margoengine/core/extension';
/** Frozen PBR presets for factory models: machinedSteel, carbonSteel, galvanizedZinc, anodizedAluminum, coloredAnodizedAluminum, neoprene and powderCoat. */
export const industrialMaterials = Object.freeze({
  machinedSteel: Object.freeze({ color: '#a9b0b6', roughness: 0.25, metalness: 1 }),
  carbonSteel: Object.freeze({ color: '#727b83', roughness: 0.35, metalness: 1 }),
  galvanizedZinc: Object.freeze({ color: '#b9c2c8', roughness: 0.45, metalness: 0.95 }),
  anodizedAluminum: Object.freeze({ color: '#c7ccd0', roughness: 0.2, metalness: 0.9 }),
  coloredAnodizedAluminum: Object.freeze({ color: '#46749a', roughness: 0.2, metalness: 0.9 }),
  neoprene: Object.freeze({ color: '#202326', roughness: 0.85, metalness: 0 }),
  powderCoat: Object.freeze({ color: '#e6a326', roughness: 0.3, metalness: 0 }),
});
/**
 * A new PbrMaterial from a preset in {@link industrialMaterials}; `color` replaces the preset colour. Throws a TypeError for an unknown name.
 *
 * @example
 * mesh.material = industrialMaterial('machinedSteel', '#b0b8c0');
 */
export function industrialMaterial(name: keyof typeof industrialMaterials, color?: string): PbrMaterial {
  const preset = industrialMaterials[name];
  if (!preset) throw new TypeError('Unknown industrial material name; choose one of the keys of industrialMaterials.');
  return new PbrMaterial({ ...preset, ...(color ? { color } : {}) });
}
