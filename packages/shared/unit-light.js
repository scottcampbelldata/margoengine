/**
 * Writes a light's unit direction (normalized in float64, rounded once into `out`) and its w component at
 * out[offset..offset+3]. Shaders read it as is: a normalize of a uniform-only value is evaluated by some drivers on
 * two paths whose results differ by an ulp (ANGLE D3D11 on NVIDIA, depending on GPU load), so one frame could shade
 * differently from the next.
 */
export function unitLight(out, offset, d) {
  const k = Math.hypot(d[0], d[1], d[2]);
  out[offset] = d[0] / k;
  out[offset + 1] = d[1] / k;
  out[offset + 2] = d[2] / k;
  out[offset + 3] = d[3];
}
