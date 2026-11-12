/**
 * Shader rounding of colour exports to the nearest binary16, applied by no pipeline now (docs/known-bugs.md, "environment
 * fog-all `fog.enabled = false` one binary16 step from no fog"). The Radeon 680M narrows every float colour export to
 * binary16 toward zero, an 8-bit or 10-bit UNORM one too before its UNORM rounding. 3adffdee0 rounded such outputs in
 * the shader on the WebGL2 layer, on the belief that native WebGPU on the same GPU rounds to nearest; it does not:
 * native Direct3D 12 and ANGLE Direct3D 11 truncate the same 32,764 of 65,536 values, so the rounding made the layer
 * store halves native never does (dof compat-check). Kept, with its tests, for the API report until its removal is
 * approved.
 */

import type { GLSLLocation } from '../glsl/emit.js';

/** Formats whose colour export the driver narrows to binary16 first: 16-bit float, 8-bit and 10-bit UNORM. */
const NARROWED = /^((r|rg|rgba)16float|(r|rg|rgba|bgra)8unorm(-srgb)?|rgb10a2unorm)$/;

/**
 * The nearest binary16 of each component, as a float32, by round half to even: the step is 2^(e - 10) for a value of
 * exponent e, at least 2^-24 (subnormal halves); scaling by powers of two and roundEven are exact. Values the half
 * range cannot hold, infinities and NaN pass through unchanged.
 * @internal
 */
export const HALF_ROUND_GLSL = `vec4 _margoHalf(vec4 v) {
  vec4 a = abs(v);
  uvec4 e = floatBitsToUint(max(a, vec4(6.103515625e-5))) & 0x7f800000u;
  vec4 r = roundEven(a * uintBitsToFloat(0x84000000u - e)) * uintBitsToFloat(e - 0x05000000u);
  r = uintBitsToFloat(floatBitsToUint(r) | (floatBitsToUint(v) & 0x80000000u));
  return mix(v, r, lessThan(a, vec4(65520.0)));
}
`;

/**
 * The fragment shader with every float output to a narrowed target rounded to the nearest binary16 after main runs
 * (main is renamed and wrapped, so an early return or discard keeps its meaning). Unchanged when no output needs it.
 * @internal
 */
export function roundHalfExports(
  source: string,
  targets: readonly (GPUColorTargetState | null | undefined)[],
  outputs: readonly GLSLLocation[],
): string {
  const writes = outputs.flatMap(({ location, kind, components }) => {
    const format = targets[location]?.format;
    if (kind !== 'float' || !format || !NARROWED.test(format)) return [];
    const o = `_o${location}`,
      widen = components === 4 ? o : `vec4(${o}${', 0.0'.repeat(components === 1 ? 0 : 4 - components)})`,
      pick = ['', '.x', '.xy', '.xyz', ''][components];
    return [`${o} = _margoHalf(${widen})${pick};`];
  });
  if (!writes.length || !source.includes('void main() {')) return source;
  return (
    source.replace('void main() {', `${HALF_ROUND_GLSL}void _margoHalfMain() {`) +
    `\nvoid main() { _margoHalfMain(); ${writes.join(' ')} }\n`
  );
}
