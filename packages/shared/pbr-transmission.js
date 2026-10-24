import { margoError } from './errors.js';
// Transmission's energy split, shared by gltf-pro's native physical shader and extension-composited transmission:
// diffuse and ambient light scale by 1 - s.tr, so the transmitted light replaces only them and reflections keep
// their strength.
export const transmittedDiffuse = [
  ['s.base.rgb*(1-s.metal)+', 's.base.rgb*(1-s.metal)*(1-s.tr)+'],
  ['(1-s.metal)*s.base.rgb/', '(1-s.metal)*(1-s.tr)*s.base.rgb/'],
];

/** `code` with the transmission weight `s.tr` (zero until set) and its energy split, unless it already has them. */
export function transmissionWeight(code) {
  if (code.includes(' tr:f32')) return code;
  for (const [from, to] of [['emissive:vec3f}', 'emissive:vec3f, tr:f32}'], ...transmittedDiffuse]) {
    if (!code.includes(from))
      throw margoError(
        'unsupported',
        `PBR shader transmission target missing: ${from}; use matching @margoengine/gltf-pro and materials versions`,
      );
    code = code.replaceAll(from, to);
  }
  return code;
}
