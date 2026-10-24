// KHR_materials_sheen in WGSL, shared by gltf-pro's physical shader and @margoengine/materials' sheen lobe, so both
// shade the same layer. Each export returns a module-scope function under the caller's name (shaders keep their own
// prefixes). Sheen roughness is the perceptual value r; the distribution uses alpha = r^2 (KHR spec Overview).

/**
 * WGSL `fn <name>(roughness:f32,nl:f32,nv:f32,nh:f32)->f32`: the sheen BRDF without its colour. The Charlie
 * distribution of Estevez and Kulla 2017, D = (2 + 1/alpha) sin(theta_h)^(1/alpha) / (2 pi), written with
 * sin^2 = 1 - nh^2, times the visibility the KHR spec allows, 1 / (4 (nl + nv - nl nv)) (Neubelt and Pettineo 2013),
 * kept at most 1 because the albedo fit below was made for that clamp. Roughness below 1e-4 is raised to it so 1/alpha
 * stays finite.
 */
export const sheenBrdfWGSL = (name) => /* wgsl */ `fn ${name}(roughness:f32,nl:f32,nv:f32,nh:f32)->f32 {
  let sheenAlpha=max(roughness,0.0001)*max(roughness,0.0001);let sheenSpread=1.0/sheenAlpha;
  let sheenD=(2.0+sheenSpread)*pow(max(1.0-nh*nh,0.0),0.5*sheenSpread)/6.2831853;
  return sheenD*min(1.0,1.0/max(4.0*(nl+nv-nl*nv),0.000001));
}
`;

/**
 * WGSL `fn <name>(mu:f32,roughness:f32)->f32`: the directional albedo E(mu, r) of {@link sheenBrdfWGSL}'s BRDF for
 * the cosine `mu` (n.v or n.l), as min(E, 1). Fitted by scripts/sheen-albedo-fit.mjs to a numerical integration of
 * that BRDF: clamp(exp(b - x (c1 + x c2)), 0, 1) with x = mu / r and b, c1, c2 linear in [1, q, r, q r],
 * q = r^2 / (r^2 + 0.046698). Shaders scale the layer under the sheen by 1 - max(sheen colour) E and light the sheen's
 * ambient with sheen colour x E x irradiance (KHR spec "Albedo-scaling technique"). Uses only let, vec4f, dot, max, exp
 * and clamp, so tests evaluate the same text in JavaScript.
 */
export const sheenAlbedoWGSL = (name) => /* wgsl */ `fn ${name}(mu:f32,roughness:f32)->f32 {
  let sheenR2=roughness*roughness;let sheenKnee=sheenR2/(sheenR2+0.046698);
  let sheenBasis=vec4f(1.0,sheenKnee,roughness,sheenKnee*roughness);let sheenX=mu/max(roughness,0.0001);
  return clamp(exp(dot(sheenBasis,vec4f(0.67486,-1.0569,1.2955,-1.6596))-sheenX*(dot(sheenBasis,vec4f(0.78851,0.09914,-0.27042,0.61309))+sheenX*dot(sheenBasis,vec4f(0.072685,0.29184,-0.084342,-0.10518)))),0.0,1.0);
}
`;
