// Independent reference for the Smith-GGX masking-shadowing terms the PBR shaders write (Heitz 2014, "Understanding the
// Masking-Shadowing Function in Microfacet-Based BRDFs", JCGT 3(2), https://jcgt.org/published/0003/02/03/): the GGX
// Lambda of eq. 72 and the height-correlated G2 of eq. 99, from the angle, not from the shaders' algebra.

/** GGX Lambda for a direction at cosine `c` to the normal and squared roughness alpha^2 `a2`. */
export const lambda = (c, a2) => (-1 + Math.sqrt(1 + (a2 * (1 - c * c)) / (c * c))) / 2;
/** Height-correlated G2(v, l) = 1 / (1 + Lambda(v) + Lambda(l)). */
export const correlatedG2 = (nl, nv, a2) => 1 / (1 + lambda(nl, a2) + lambda(nv, a2));
/** Separable G1(v) G1(l) with G1 = 1 / (1 + Lambda), the 2021 glTF Appendix B form. */
export const separableG2 = (nl, nv, a2) => 1 / ((1 + lambda(nl, a2)) * (1 + lambda(nv, a2)));
/**
 * A WGSL or GLSL expression over `names` as a JavaScript function: sqrt, max, min and pow on scalars, step(edge, x),
 * and dot and cross on 3-vectors passed as arrays (the GGX D denominator max(|n x h|^2, step(nh, 0)) + a2 nh^2,
 * KB6016c). A name may be an object, so `s.n` reads a member.
 */
export const shaderExpression = (text, names) => shaderStatements(`let result=${text};`, names, 'result');
/**
 * WGSL statements (`let x=...;` each, with the functions of {@link shaderExpression}) over `names` as a JavaScript
 * function that returns the name `result` after them.
 */
export const shaderStatements = (text, names, result) => {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    step = (edge, x) => (x < edge ? 0 : 1),
    body = text.replace(/\b(sqrt|max|pow|min)\(/g, 'Math.$1(').replace(/\blet\b/g, 'const'),
    run = new Function('dot', 'cross', 'step', ...names, `${body}\nreturn ${result};`);
  return (...values) => run(dot, cross, step, ...values);
};
/** The (nl, nv, a2) grid the tests sweep: grazing to normal, roughness 0.05 to 1. */
export function* smithGrid() {
  for (const nl of [0.02, 0.1, 0.3, 0.6, 0.9, 1])
    for (const nv of [0.02, 0.15, 0.5, 0.8, 1])
      for (const roughness of [0.05, 0.2, 0.5, 0.8, 1]) yield [nl, nv, roughness ** 4];
}
