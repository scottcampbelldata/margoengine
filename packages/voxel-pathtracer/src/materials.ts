// Material builders: one-line constructors for palette materials, for editors that switch a material's type.
import type { TraceMaterial, TraceMaterialType, TraceVec3 } from './types.js';

/** A diffuse material for palette index `id`; `color` is linear RGB. */
export function diffuse(id: number, color: TraceVec3, roughness = 0.8): TraceMaterial {
  return { id, type: 'diffuse', color, roughness };
}

/** A metal material for palette index `id`. */
export function metal(id: number, color: TraceVec3, roughness = 0.2, metalness = 1): TraceMaterial {
  return { id, type: 'metal', color, roughness, metalness };
}

/** A glass material for palette index `id`. */
export function glass(id: number, color: TraceVec3, roughness = 0): TraceMaterial {
  return { id, type: 'glass', color, roughness };
}

/** An emissive material for palette index `id`; `emission` multiplies `color`. */
export function emit(id: number, color: TraceVec3, emission = 4): TraceMaterial {
  return { id, type: 'emit', color, emission };
}

/** A blend (glass and diffuse) material for palette index `id`. */
export function blend(id: number, color: TraceVec3, metalness = 0, roughness = 0.4): TraceMaterial {
  return { id, type: 'blend', color, metalness, roughness };
}

/** A scattering medium (cloud or fog volume) for palette index `id`. */
export function media(id: number, color: TraceVec3): TraceMaterial {
  return { id, type: 'media', color };
}

/** The builders by material type, with default parameters. */
export const materialBuilders: Record<TraceMaterialType, (id: number, color: TraceVec3) => TraceMaterial> = {
  diffuse,
  metal,
  glass,
  emit,
  blend,
  media,
  plastic: (id, color) => ({ id, type: 'plastic', color, roughness: 0.3 }),
};

/**
 * Checks a material list for a scene: returns a copy of `materials` in the same order.
 * @throws RangeError when an id is outside 1-255 or used twice.
 */
export function paletteFromMaterials(materials: readonly TraceMaterial[]): TraceMaterial[] {
  const seen = new Set<number>();
  for (const m of materials) {
    if (!Number.isInteger(m.id) || m.id < 1 || m.id > 255)
      throw new RangeError(`Material id ${m.id} is outside 1-255; use a palette index from 1 to 255`);
    if (seen.has(m.id)) throw new RangeError(`Material id ${m.id} is used twice; give each material its own id`);
    seen.add(m.id);
  }
  return materials.slice();
}
