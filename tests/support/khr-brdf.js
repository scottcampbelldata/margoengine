// CPU reference for the BRDF terms gltf-pro shades extended materials with, written from the Khronos extension
// specifications (KHR_materials_iridescence "Iridescence Fresnel", KHR_materials_anisotropy "Implementation",
// KHR_materials_diffuse_transmission "Material Structure Updates") in double precision. packages/gltf-pro/tests and
// scripts/gltf-pro-materials-gpu-check.js compare the WGSL against it.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, k) => a.map((v) => v * k);
const add = (a, b) => a.map((v, i) => v + b[i]);
const length = (a) => Math.sqrt(dot(a, a));
const normalize = (a) => scale(a, 1 / length(a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mix = (a, b, t) => a + (b - a) * t;
const schlick = (f0, c) => f0 + (1 - f0) * (1 - c) ** 5;
export const vec = { dot, scale, add, length, normalize, cross };

/** The iridescence spec's evalSensitivity: Fourier-space CIE response for an optical path difference (nm) and phase shift, as linear Rec. 709. */
export function sensitivity(opd, shift) {
  const phase = 2 * Math.PI * opd * 1e-9,
    val = [5.4856e-13, 4.4201e-13, 5.2481e-13],
    pos = [1.681e6, 1.7953e6, 2.2084e6],
    variance = [4.3278e9, 9.3046e9, 6.6121e9];
  const xyz = [0, 1, 2].map(
    (i) =>
      val[i] *
      Math.sqrt(2 * Math.PI * variance[i]) *
      Math.cos(pos[i] * phase + shift[i]) *
      Math.exp(-phase * phase * variance[i]),
  );
  xyz[0] +=
    9.747e-14 *
    Math.sqrt(2 * Math.PI * 4.5282e9) *
    Math.cos(2.2399e6 * phase + shift[0]) *
    Math.exp(-4.5282e9 * phase * phase);
  const [x, y, z] = xyz.map((v) => v / 1.0685e-7);
  // XYZ_TO_REC709 (column-major in the spec's GLSL).
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}

/** The iridescence spec's iridescent_fresnel(outsideIor = 1, iridescenceIor, baseF0, thickness nm, cosTheta1). */
export function iridescentFresnel(baseF0, cosTheta1, thickness, iridescenceIor, outsideIor = 1) {
  const sinTheta2Sq = (outsideIor / iridescenceIor) ** 2 * (1 - cosTheta1 ** 2),
    cosTheta2Sq = 1 - sinTheta2Sq;
  if (cosTheta2Sq < 0) return [1, 1, 1];
  const cosTheta2 = Math.sqrt(cosTheta2Sq),
    iorToF0 = (t, i) => ((t - i) / (t + i)) ** 2;
  const R12 = schlick(iorToF0(iridescenceIor, outsideIor), cosTheta1),
    T121 = 1 - R12;
  const phi12 = iridescenceIor < outsideIor ? Math.PI : 0,
    phi21 = Math.PI - phi12;
  // gltf-pro clamps F0 + 0.0001 to 0.9999 so a white metal stays finite (the spec only adds 0.0001).
  const baseIor = baseF0.map((f) => {
    const s = Math.sqrt(Math.min(f + 0.0001, 0.9999));
    return (1 + s) / (1 - s);
  });
  const R23 = baseIor.map((b) => schlick(iorToF0(b, iridescenceIor), cosTheta2));
  const phi = baseIor.map((b) => phi21 + (b < iridescenceIor ? Math.PI : 0)),
    opd = 2 * iridescenceIor * thickness * cosTheta2;
  const R123 = R23.map((r) => Math.min(Math.max(R12 * r, 1e-5), 0.9999)),
    r123 = R123.map(Math.sqrt);
  const Rs = R23.map((r, i) => (T121 * T121 * r) / (1 - R123[i]));
  const I = Rs.map((r) => R12 + r);
  let Cm = Rs.map((r) => r - T121);
  for (let m = 1; m <= 2; m++) {
    Cm = Cm.map((c, i) => c * r123[i]);
    const Sm = sensitivity(
      m * opd,
      phi.map((p) => m * p),
    );
    for (let i = 0; i < 3; i++) I[i] += Cm[i] * 2 * Sm[i];
  }
  return I.map((v) => Math.max(v, 0));
}

/** KHR_materials_anisotropy D_GGX_anisotropic. */
export function anisotropicD(NdotH, TdotH, BdotH, at, ab) {
  const a2 = at * ab,
    f = [ab * TdotH, at * BdotH, a2 * NdotH],
    w2 = a2 / dot(f, f);
  return (a2 * w2 * w2) / Math.PI;
}
/** KHR_materials_anisotropy V_GGX_anisotropic (height-correlated Smith visibility, 1/(4 NdotL NdotV) included). */
export function anisotropicV(NdotL, NdotV, BdotV, TdotV, TdotL, BdotL, at, ab) {
  const GGXV = NdotL * length([at * TdotV, ab * BdotV, NdotV]),
    GGXL = NdotV * length([at * TdotL, ab * BdotL, NdotL]);
  return Math.min(Math.max(0.5 / (GGXV + GGXL), 0), 1);
}
/** Isotropic GGX D with alpha = roughness^2 (glTF 2.0 Appendix B). */
export const isotropicD = (NdotH, alpha) =>
  (alpha * alpha) / (Math.PI * (NdotH * NdotH * (alpha * alpha - 1) + 1) ** 2);
/** Separable Smith visibility as gltf-pro's base shader evaluates it: G1(v) G1(l) / (4 NdotL NdotV). */
export const separableV = (NdotL, NdotV, alpha) => {
  const a2 = alpha * alpha;
  return 1 / ((NdotV + Math.sqrt(a2 + (1 - a2) * NdotV * NdotV)) * (NdotL + Math.sqrt(a2 + (1 - a2) * NdotL * NdotL)));
};

/**
 * Directional-light response (radiance factor, light intensity 1) of a surface as the specs layer it: the specular BRDF
 * (anisotropic when `anisotropy` > 0) with Fresnel mixed toward the thin-film Fresnel (rgb_mix: diffuse weighted by
 * 1 - its largest channel), and under it the dielectric base: Lambert reflection of the base colour mixed with the
 * diffuse BTDF of the diffuse transmission colour (light from the back), both reduced by transmission.
 * Surface: {base, f0 (dielectric F0), metal, roughness, n, t (anisotropy tangent), anisotropy, transmission,
 * iridescence: {factor, fresnel}, diffuseTransmission: {factor, color}}.
 */
export function direct(s, v, l) {
  const h = normalize(add(v, l)),
    NdotL = Math.max(dot(s.n, l), 0),
    NdotV = Math.max(dot(s.n, v), 1e-4),
    NdotH = Math.max(dot(s.n, h), 0),
    VdotH = Math.max(dot(v, h), 0);
  const f0 = s.f0.map((f, i) => mix(f, s.base[i], s.metal)),
    F = f0.map((f) => schlick(f, VdotH)),
    irid = s.iridescence ?? { factor: 0, fresnel: [0, 0, 0] };
  const fr = F.map((f, i) => mix(f, irid.fresnel[i], irid.factor)),
    kd = F.map((f) => mix(1 - f, 1 - Math.max(...irid.fresnel), irid.factor));
  const alpha = s.roughness * s.roughness;
  let spec;
  if (s.anisotropy > 0) {
    const t = s.t,
      b = cross(s.n, t),
      at = mix(alpha, 1, s.anisotropy ** 2);
    spec =
      anisotropicD(NdotH, dot(t, h), dot(b, h), at, alpha) *
      anisotropicV(NdotL, NdotV, dot(b, v), dot(t, v), dot(t, l), dot(b, l), at, alpha);
  } else spec = isotropicD(NdotH, alpha) * separableV(NdotL, NdotV, alpha);
  const dt = s.diffuseTransmission ?? { factor: 0, color: [0, 0, 0] },
    back = Math.max(-dot(s.n, l), 0);
  return [0, 1, 2].map(
    (i) =>
      (kd[i] *
        (1 - s.metal) *
        (1 - s.transmission) *
        (s.base[i] * (1 - dt.factor) * NdotL + dt.color[i] * dt.factor * back)) /
        Math.PI +
      spec * fr[i] * NdotL,
  );
}
