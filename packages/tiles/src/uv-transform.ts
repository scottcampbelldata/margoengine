/**
 * KHR_texture_transform as the two rows of one 2x3 affine map, uv' = T * R * S * uv. Rotation uses the sign
 * that `@margoengine/gltf-pro/coordinates` renders with (u' = c*u + s*v, v' = -s*u + c*v; checked there against
 * the Khronos TextureTransformTest and TextureTransformMultiTest references), so a property or feature-ID texture
 * read on the CPU, highlighted on the GPU and drawn by the model all sample the same texel.
 */
export type UVRows = readonly [number, number, number, number, number, number];

export function uvRows(scale: readonly number[], offset: readonly number[], rotation: number): UVRows {
  const c = Math.cos(rotation),
    s = Math.sin(rotation);
  return [c * scale[0], s * scale[1], offset[0], -s * scale[0], c * scale[1], offset[1]];
}

export function applyUV(m: UVRows, u: number, v: number): [number, number] {
  return [m[0] * u + m[1] * v + m[2], m[3] * u + m[4] * v + m[5]];
}

/** The same map as a WGSL expression over the vec2f expression `p`. */
export function uvRowsWGSL(m: UVRows, p: string): string {
  const n = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`);
  return `(vec2f(dot(vec2f(${n(m[0])},${n(m[1])}),${p})+${n(m[2])},dot(vec2f(${n(m[3])},${n(m[4])}),${p})+${n(m[5])}))`;
}
