// Independent reference for the Smith-GGX masking-shadowing terms the PBR shaders write (Heitz 2014, "Understanding the
// Masking-Shadowing Function in Microfacet-Based BRDFs", JCGT 3(2), https://jcgt.org/published/0003/02/03/): the GGX
// Lambda of eq. 72 and the height-correlated G2 of eq. 99, from the angle, not from the shaders' algebra.

/** GGX Lambda for a direction at cosine `c` to the normal and squared roughness alpha^2 `a2`. */
export const lambda = (c, a2) => (-1 + Math.sqrt(1 + (a2 * (1 - c * c)) / (c * c))) / 2;
/** Height-correlated G2(v, l) = 1 / (1 + Lambda(v) + Lambda(l)). */
export const correlatedG2 = (nl, nv, a2) => 1 / (1 + lambda(nl, a2) + lambda(nv, a2));
/** Separable G1(v) G1(l) with G1 = 1 / (1 + Lambda), the 2021 glTF Appendix B form. */
export const separableG2 = (nl, nv, a2) => 1 / ((1 + lambda(nl, a2)) * (1 + lambda(nv, a2)));
/** A WGSL or GLSL scalar expression over `names` as a JavaScript function (sqrt, max and pow only). */
export const shaderExpression = (text, names) =>
  new Function(
    ...names,
    `return ${text.replace(/\b(sqrt|max|pow|min)\(/g, 'Math.$1(')};`,
  );
/** The (nl, nv, a2) grid the tests sweep: grazing to normal, roughness 0.05 to 1. */
export function* smithGrid() {
  for (const nl of [0.02, 0.1, 0.3, 0.6, 0.9, 1])
    for (const nv of [0.02, 0.15, 0.5, 0.8, 1])
      for (const roughness of [0.05, 0.2, 0.5, 0.8, 1]) yield [nl, nv, roughness ** 4];
}
