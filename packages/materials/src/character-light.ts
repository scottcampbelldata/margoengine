// What the hair, eye and skin shading models share: each is one WGSL function light(n, v, l, base), the surface's response
// to one light with its cosine included, put in place of the sun's direct_light and of the clustered loops' per-light BRDF,
// so every light but an area light reaches the same model.
import { clusterBrdf } from '../../shared/light-terms.js';

const direct = /fn direct_light\(s:Surface,v:vec3f,l:vec3f\)->vec3f \{[^}]*\}/,
  localTerm = 'result+=' + clusterBrdf + '*nl*',
  surfaceEnd = /if\((?:margoFaceTest&&)?!facing&&f\.settings\.z<0\.5\)\{discard;\}/g,
  vertex = /let p=f\.model\*vec4f\([^;]*,1\);/;
const missing = (label: string) =>
  new TypeError(`${label} needs a PbrMaterial without anisotropy or a thin film, and matching gltf-pro and materials versions`);
/** `code` whose sun goes through WGSL function `light`, and `statements` run at the end of the surface. */
export function shaded(code: string, light: string, statements: string, label: string): string {
  if (code.includes('fn margoDirect(') || !direct.test(code)) throw missing(label);
  const out = code
    .replace(direct, `fn direct_light(s:Surface,v:vec3f,l:vec3f)->vec3f {return ${light}(s.n,v,l,s.base.rgb)*f.radiance.rgb*f.light.w;}`)
    .replace(surfaceEnd, (found) => `${statements}\n  ${found}`);
  if (!out.includes(statements)) throw missing(label);
  return out;
}
/** `code`, with its lighting composed, whose clustered lights go through `light` too. */
export const localShaded = (code: string, light: string): string => code.split(localTerm).join(`result+=${light}(n,v,l,base)*`);
/**
 * `code` handing the fragment `fields` (`@location` declarations) that `statements` set in the vertex stage, where
 * `margoObjectModel` is the mesh's or the instance's matrix (gltf-pro's instanced vertex stage turns it into the instance's).
 */
export function vertexFields(code: string, fields: string, statements: string, label: string): string {
  const model = code.includes('let margoObjectModel=') ? '' : 'let margoObjectModel=f.model;',
    out = code
      .replace(/(struct Out \{[^}]*?)\n\}/, `$1, ${fields}\n}`)
      .replace(vertex, (found) => `${found}${model}${statements}`);
  if (!out.includes(statements)) throw missing(label);
  return out;
}
/** A WGSL float literal, whatever the number's text. */
export const float = (v: number): string => v.toExponential();
/** `vec3f(x,y,z)` of three numbers. */
export const vec3 = (v: readonly number[]): string => `vec3f(${v.map(float).join(',')})`;
/** Throws unless `v` is three finite numbers with some length. */
export function direction(v: unknown, label: string): readonly number[] {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => Number.isFinite(Math.fround(n))) || !Math.hypot(...v))
    throw new TypeError(`${label} must be three finite numbers with some length; pass a direction such as [0, 1, 0]`);
  return v;
}
/** Throws unless `v` is a finite number within `low` (excluded) and `high` (included). */
export function within(v: unknown, low: number, high: number, label: string): number {
  if (typeof v !== 'number' || !(v > low) || !(v <= high))
    throw new RangeError(`${label} must be above ${low} and at most ${high}; pass a number in that range`);
  return v;
}
