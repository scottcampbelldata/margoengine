// CPU reference of the physical material terms, written from the Khronos glTF 2.0 specification (Appendix B, "BRDF
// Implementation") and the KHR_materials_ior, _specular, _clearcoat, _sheen, _transmission and _volume extension texts.
// The unit tests check the formulas; examples/package-benchmarks/physical-gpu.mjs compares the real GPU against them.
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = a => Math.sqrt(dot(a, a));
export const scale = (a, s) => a.map(x => x * s);
export const add = (a, b) => a.map((x, i) => x + b[i]);
export const normalize = a => scale(a, 1 / length(a));
const clamp01 = x => Math.min(Math.max(x, 0), 1);

/** KHR_materials_ior + KHR_materials_specular: dielectric F0 = min(((ior-1)/(ior+1))^2 x specularColor, 1) x specular. */
export const dielectricF0 = (ior = 1.5, specularColor = [1, 1, 1], specular = 1) => specularColor.map(c => Math.min(((ior - 1) / (ior + 1)) ** 2 * c, 1) * specular);
/** Schlick's Fresnel approximation (Appendix B.3.4). */
export const schlick = (f0, cos) => f0 + (1 - f0) * (1 - clamp01(cos)) ** 5;
/** Trowbridge-Reitz (GGX) distribution, alpha = roughness^2 (Appendix B.3.2). */
export const ggxD = (alpha, nh) => alpha * alpha / (Math.PI * (nh * nh * (alpha * alpha - 1) + 1) ** 2);
/** Smith masking for GGX, one direction (separable form). */
export const smithG1 = (alpha, cos) => 2 * cos / (cos + Math.sqrt(alpha * alpha + (1 - alpha * alpha) * cos * cos));
/** KHR_materials_sheen: Charlie distribution (Estevez and Kulla), alpha = sheenRoughness^2. */
export const charlieD = (alpha, nh) => (2 + 1 / alpha) * (1 - nh * nh) ** (0.5 / alpha) / (2 * Math.PI);
/** KHR_materials_sheen visibility, Neubelt and Pettineo's approximation: 1 / (4 (NdotL + NdotV - NdotL NdotV)). */
export const sheenV = (nl, nv) => 1 / (4 * (nl + nv - nl * nv));
/** KHR_materials_clearcoat layering: mix(base, coat, clearcoat x Fresnel(0.04, NdotV)). */
export const clearcoatMix = (base, coat, clearcoat, nv) => {const f = clearcoat * schlick(0.04, nv); return base.map((b, i) => b * (1 - f) + coat[i] * f);};

/** GLSL/WGSL refract(i, n, eta) for unit vectors; zero on total internal reflection. */
export function refract(i, n, eta) {
  const c = dot(n, i), k = 1 - eta * eta * (1 - c * c);
  return k < 0 ? [0, 0, 0] : add(scale(i, eta), scale(n, -(eta * c + Math.sqrt(k))));
}
/** Where the refracted ray leaves the volume: `thickness` (world units) along refract(-v, n, 1/ior); thin-walled (0) stays put. */
export const exitPoint = (position, v, n, ior, thickness) => thickness > 0 ? add(position, scale(normalize(refract(scale(v, -1), n, 1 / Math.max(ior, 1))), thickness)) : position;
/** KHR_materials_volume (Beer-Lambert): attenuationColor^(path / attenuationDistance) per channel. */
export const volumeTransmittance = (attenuationColor, attenuationDistance, path) => attenuationColor.map(c => path > 0 ? c ** (path / attenuationDistance) : 1);
/** Mip level of the scene copy a rough surface reads: log2(width) x roughness x clamp(2 ior - 2, 0, 1). */
export const transmissionLod = (width, roughness, ior) => Math.log2(width) * roughness * clamp01(ior * 2 - 2);
/**
 * KHR_materials_transmission's specular BTDF lobe as the base layer receives it: the light behind (`behind`, already read
 * along the refracted ray) x base colour x volume transmittance x the dielectric's transmitted share (1 - Fresnel at NdotV),
 * for the non-metallic, transmissive share of the surface.
 */
export function transmitted({n, v, base, f0, metal = 0, transmission = 1, behind, transmittance = [1, 1, 1]}) {
  const nv = clamp01(dot(n, v));
  return base.map((b, i) => (1 - metal) * transmission * (1 - schlick(f0[i] * (1 - metal) + b * metal, nv)) * b * transmittance[i] * behind[i]);
}
