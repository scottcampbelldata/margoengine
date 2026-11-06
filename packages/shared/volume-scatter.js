// KHR_materials_volume_scatter (draft, Khronos pull request 2453): how much of the light that enters a volume scatters.
// The spec gives the extinction sigma_t = -log(attenuationColor) / attenuationDistance and turns the multi-scatter
// albedo into the single-scatter one (Kulla and Conty 2017): rho_ss = 1 - d^2, d = 4.09712 + 4.20863 m -
// sqrt(9.59217 + 41.6808 m + 17.7126 m^2). A rasterizer cannot walk the medium, so the rest is Margo's reading: scattering
// over a depth x is 1 - exp(-s x), s = sigma_s (1 - g) (the similarity relation for the Henyey-Greenstein anisotropy g,
// at most sigma_t), and that light leaves the surface as a diffuse lobe of the multi-scatter colour, which the spec's own
// figure compares a dense medium to. What crosses the whole depth is exp(-(sigma_a + s) x).
/** Extinction per world unit of one channel; 0 with no attenuation distance. Zero colour counts as 1e-6, as Beer's law does in the transmission shader. */
export const scatterExtinction = (color, distance) =>
  distance === Infinity ? 0 : Math.min(-Math.log(Math.max(color, 0.000001)) / distance, 1e30);
/** [share scattered, share that crosses] of one channel over `depth`: the reference for `margoScatterShares`. */
export function scatterShares(extinction, color, anisotropy, depth) {
  const d = 4.09712 + 4.20863 * color - Math.sqrt(9.59217 + 41.6808 * color + 17.7126 * color * color),
    absorbed = extinction * d * d,
    scattered = Math.max(Math.min((extinction - absorbed) * (1 - anisotropy), extinction), 0);
  return [1 - Math.exp(-scattered * depth), Math.exp(-(absorbed + scattered) * depth)];
}
/** `margoScatterShares(extinction, colour, anisotropy, depth)`: column 0 the share scattered, column 1 the share that crosses. One WGSL text for gltf-pro and `@margoengine/materials`. */
export const volumeScatterWgsl = `fn margoScatterShares(extinction:vec3f,color:vec3f,anisotropy:f32,depth:f32)->mat2x3f {
  let m=clamp(color,vec3f(0),vec3f(1)); let d=4.09712+4.20863*m-sqrt(9.59217+41.6808*m+17.7126*m*m);
  let absorbed=extinction*d*d; let scattered=max(min((extinction-absorbed)*(1-anisotropy),extinction),vec3f(0));
  return mat2x3f(1-exp(-scattered*depth),exp(-(absorbed+scattered)*depth));
}
`;
