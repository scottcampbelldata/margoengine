// The WGSL varying of instanced quads that read exact atlas texels: the clip position, the texel coordinate, the
// cell's first and last texel (flat, so a quad never reads past its rectangle) and the colour to multiply with.
export const texelVarying = `struct Varying{
  @builtin(position) position:vec4f,
  @location(0) texel:vec2f,
  @location(1) @interpolate(flat) low:vec2f,
  @location(2) @interpolate(flat) high:vec2f,
  @location(3) @interpolate(flat) tint:vec4f,
}`;
