// KHR_materials_sheen in WGSL, shared by gltf/pbr's physical shader and @margoengine/materials' sheen lobe, so both
// shade the same layer. Each export returns a module-scope function under the caller's name (shaders keep their own
// prefixes). Sheen roughness is the perceptual value r; the distribution uses alpha = r^2 (KHR spec Overview).

/**
 * WGSL `fn <name>(roughness:f32,nl:f32,nv:f32,nh:f32)->f32`: the sheen BRDF without its colour. The Charlie
 * distribution of Estevez and Kulla 2017, D = (2 + 1/alpha) sin(theta_h)^(1/alpha) / (2 pi), written with
 * sin^2 = 1 - nh^2, times the paper's height-correlated visibility 1 / ((1 + Lambda(n.v) + Lambda(n.l)) 4 n.l n.v),
 * the form KHR_materials_sheen gives first. Lambda(c) = exp(L(c)) below c = 0.5, else exp(2 L(0.5) - L(1 - c)), with
 * L(x) = a / (1 + b x^c) + d x + e and a..e interpolated between the paper's Table 1 rows by w = (1 - alpha)^2. Unlike
 * the Neubelt and Pettineo 2013 visibility the spec also allows, this shadowing keeps the layered material
 * energy-conserving under albedo scaling (spec, "Albedo-scaling technique"). The non-physical terminator softening of
 * the paper's section 4 is left out (it is not reciprocal and not in the spec). Roughness below 1e-4 is raised to it
 * so 1/alpha stays finite; `<name>L` and `<name>Lambda` are its helpers.
 */
export const sheenBrdfWGSL = (name) => /* wgsl */ `fn ${name}L(x:f32,w:f32)->f32 {
  let p=mix(vec4f(21.5473,3.82987,0.19823,-1.9776),vec4f(25.3245,3.32435,0.16801,-1.27393),w);
  return p.x/(1.0+p.y*pow(max(x,1e-12),p.z))+p.w*x+mix(-4.32054,-4.85967,w);
}
fn ${name}Lambda(c:f32,w:f32)->f32 {return exp(select(2.0*${name}L(0.5,w)-${name}L(1.0-c,w),${name}L(c,w),c<0.5));}
fn ${name}(roughness:f32,nl:f32,nv:f32,nh:f32)->f32 {
  let sheenAlpha=max(roughness,0.0001)*max(roughness,0.0001);let sheenSpread=1.0/sheenAlpha;
  let sheenD=(2.0+sheenSpread)*pow(max(1.0-nh*nh,0.0),0.5*sheenSpread)/6.2831853;
  let sheenW=(1.0-sheenAlpha)*(1.0-sheenAlpha);
  return sheenD/max((1.0+${name}Lambda(nv,sheenW)+${name}Lambda(nl,sheenW))*4.0*nl*nv,0.000001);
}
`;

/**
 * WGSL `fn <name>(nv:f32,nl:f32,v:vec3f,l:vec3f)->f32`: the n.h to pass to {@link sheenBrdfWGSL}'s BRDF with the
 * clamped cosines `nv` (n.v raised to 1e-4) and `nl` (n.l, 0 to 1), unit `v` and `l`: (nv + nl) / |v + l|. For
 * h = (v + l) / |v + l| this is the identity n.h = (n.v + n.l) / |v + l|, so it equals dot(n, h) wherever n faces the
 * viewer. An interpolated or mapped shading normal can face away from the viewer at a silhouette (n.v < 0); n.v is then
 * raised to 1e-4 but dot(n, h) is not, and n.v = -n.l gives n.h = 0, the peak of the Charlie distribution, which for
 * sheen roughness near 0 is about 1e7 (KB3297d). From the clamped cosines the lobe is evaluated at the configuration
 * those cosines describe, a normal bent to face the viewer (Reshetov, Soupikov and Mark 2010; Keller et al. 2017).
 */
export const sheenHalfWGSL = (name) => /* wgsl */ `fn ${name}(nv:f32,nl:f32,v:vec3f,l:vec3f)->f32 {return clamp((nv+nl)/max(length(v+l),0.0001),0.0,1.0);}
`;

/**
 * Layout of {@link sheenAlbedoTable}: `size` x `size` nodes over u = (mu (R + k) / (R + k mu))^p and v = sqrt(r),
 * both in [0, 1], with R = max(r, 1e-4) (scripts/sheen-albedo-fit.mjs explains the choice).
 */
export const sheenAlbedoGrid = { size: 16, k: 0.1, p: 0.45 };

/**
 * ln(E R) at the nodes of {@link sheenAlbedoGrid}, row j (v = j / 15) after row, fitted by scripts/sheen-albedo-fit.mjs
 * to a numerical integration of {@link sheenBrdfWGSL}'s BRDF.
 */
export const sheenAlbedoTable = [
  -3.22, -3.22, -3.22, -3.22, -3.22, -3.22, -3.88, -4.89, -6.25, -8.85, -12.09, -21.05, -24, -24, -24, -24,
  -1.75, -1.75, -1.85, -2.07, -2.41, -2.9, -3.58, -4.31, -5.96, -8.09, -11.84, -18.65, -24, -24, -24, -24,
  -1.7, -1.68, -1.75, -1.95, -2.27, -2.71, -3.3, -4.1, -5.24, -6.67, -9.55, -14.09, -22.96, -24, -24, -24,
  -1.69, -1.63, -1.68, -1.86, -2.14, -2.52, -2.99, -3.64, -4.47, -5.72, -7.48, -10.23, -14.98, -24, -24, -24,
  -1.67, -1.59, -1.62, -1.78, -2.02, -2.33, -2.73, -3.23, -3.88, -4.74, -5.93, -7.64, -10.31, -14.93, -24, -24,
  -1.65, -1.55, -1.57, -1.7, -1.9, -2.16, -2.48, -2.88, -3.37, -4.01, -4.84, -5.97, -7.6, -10.17, -14.96, -24,
  -1.62, -1.49, -1.5, -1.62, -1.79, -2, -2.27, -2.59, -2.97, -3.45, -4.05, -4.84, -5.92, -7.52, -10.24, -19.62,
  -1.61, -1.43, -1.42, -1.52, -1.66, -1.85, -2.07, -2.33, -2.63, -3, -3.46, -4.04, -4.8, -5.87, -7.58, -12.5,
  -1.53, -1.33, -1.31, -1.4, -1.53, -1.68, -1.87, -2.08, -2.33, -2.63, -2.98, -3.42, -3.99, -4.75, -5.9, -8.73,
  -1.42, -1.21, -1.18, -1.26, -1.37, -1.5, -1.66, -1.84, -2.05, -2.29, -2.57, -2.92, -3.36, -3.91, -4.73, -6.47,
  -1.27, -1.05, -1.02, -1.08, -1.18, -1.3, -1.44, -1.59, -1.77, -1.97, -2.2, -2.49, -2.83, -3.26, -3.86, -4.98,
  -1.09, -0.86, -0.83, -0.88, -0.97, -1.08, -1.2, -1.34, -1.49, -1.66, -1.86, -2.1, -2.38, -2.71, -3.17, -3.93,
  -0.87, -0.65, -0.61, -0.66, -0.75, -0.85, -0.96, -1.08, -1.22, -1.37, -1.54, -1.75, -1.98, -2.26, -2.62, -3.16,
  -0.64, -0.43, -0.39, -0.44, -0.52, -0.62, -0.72, -0.84, -0.97, -1.1, -1.26, -1.44, -1.65, -1.88, -2.17, -2.58,
  -0.43, -0.22, -0.18, -0.24, -0.32, -0.41, -0.51, -0.62, -0.74, -0.87, -1.02, -1.18, -1.37, -1.57, -1.82, -2.13,
  -0.28, -0.09, -0.05, -0.1, -0.18, -0.27, -0.37, -0.48, -0.59, -0.71, -0.85, -1, -1.16, -1.34, -1.55, -1.81,
];

/**
 * WGSL `const <name>Table` and `fn <name>(mu:f32,roughness:f32)->f32`: the directional albedo E(mu, r) of
 * {@link sheenBrdfWGSL}'s BRDF for the cosine `mu` (n.v or n.l), as min(E, 1): clamp(exp(T(u, v)) / R, 0, 1), T read
 * bilinearly from `table` ({@link sheenAlbedoTable} unless a test passes its own) on {@link sheenAlbedoGrid}. Shaders
 * scale the layer under the sheen by 1 - max(sheen colour) E and light the sheen's ambient with sheen colour x E x
 * irradiance (KHR spec "Albedo-scaling technique"; its table lookup is in x = n.v, y = sheen roughness).
 */
export const sheenAlbedoWGSL = (name, table = sheenAlbedoTable) => /* wgsl */ `const ${name}Table=array<f32,256>(${table.map((v) => (Number.isInteger(v) ? v + '.0' : v)).join(',')});
fn ${name}(mu:f32,roughness:f32)->f32 {
  let sheenR=clamp(roughness,0.0001,1.0);let sheenMu=clamp(mu,0.0001,1.0);
  let sheenU=pow(sheenMu*(sheenR+${sheenAlbedoGrid.k})/(sheenR+${sheenAlbedoGrid.k}*sheenMu),${sheenAlbedoGrid.p})*15.0;let sheenV=sqrt(clamp(roughness,0.0,1.0))*15.0;
  let sheenI=min(u32(sheenU),14u);let sheenJ=min(u32(sheenV),14u);let sheenS=sheenU-f32(sheenI);let sheenT=sheenV-f32(sheenJ);
  let sheenN=sheenJ*16u+sheenI;
  let sheenLog=mix(mix(${name}Table[sheenN],${name}Table[sheenN+1u],sheenS),mix(${name}Table[sheenN+16u],${name}Table[sheenN+17u],sheenS),sheenT);
  return clamp(exp(sheenLog)/sheenR,0.0,1.0);
}
`;
