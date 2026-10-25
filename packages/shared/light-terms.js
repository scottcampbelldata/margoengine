// Distance falloff and spot cone of clustered's per-light loop (and environment's volumetric local lights), as WGSL
// statements over the loop's `light` record, `l` (unit vector to the light) and `distance`. Both declare
// `let falloff:f32` and `var cone:f32`. The falloff is the windowed inverse power of Karis 2013 ("Real Shading in
// Unreal Engine 4"): window = clamp(1 - (d / range)^4, 0, 1)^2 (an unlimited range is stored as +Infinity, window 1),
// divided by max(d^decay, 2^-12). The floor 2^-12 (exact in float32) treats the light as a ball of radius 1/64 unit:
// nearer than that the falloff stops growing, so the peak at the light is window * 4096. Legacy lights (params.y 0
// point, 1 spot) square the distance by multiplication and fade the cone with a Hermite ramp between cos(outer) and
// cos(inner); decay-aware lights (params.y -(1 + decay) point, 2 + decay spot) raise d to `decay` and use WGSL's
// smoothstep, a hard edge when the two cosines are equal (penumbra 0).
export const legacyTerms =
  'let reach=distance/light.positionRange.w;let fade=clamp(1.0-reach*reach*reach*reach,0.0,1.0);let falloff=fade*fade/max(distance*distance,0.000244140625);var cone=1.0;if(light.params.y>0.5){let ramp=clamp((dot(-l,light.directionOuter.xyz)-light.directionOuter.w)/max(light.params.x-light.directionOuter.w,0.000001),0.0,1.0);cone=ramp*ramp*(3.0-2.0*ramp);}';
export const decayTerms =
  'let kind=light.params.y;let reach=distance/light.positionRange.w;let fade=clamp(1.0-reach*reach*reach*reach,0.0,1.0);let fresh=kind<-0.5||kind>1.5;let power=select(distance*distance,pow(max(distance,0.000001),select(-1.0-kind,kind-2.0,kind>1.5)),fresh);let falloff=fade*fade/max(power,0.000244140625);var cone=1.0;if(kind>0.5){let along=dot(-l,light.directionOuter.xyz);let lo=light.directionOuter.w;let hi=light.params.x;if(fresh){cone=select(select(0.0,1.0,along>=lo),smoothstep(lo,hi,along),hi>lo);}else{let ramp=clamp((along-lo)/max(hi-lo,0.000001),0.0,1.0);cone=ramp*ramp*(3.0-2.0*ramp);}}';
// The per-light BRDF of clustered's light loop (GGX with Fresnel, as gltf-pro's direct light), in the loop's locals (n, v,
// l, h, base, metal, nl, nv, d, g, fresnel). @margoengine/materials' Lambert and Phong put their own BRDF in its place.
// Lambert/pi + D G F / (4 nl nv): glTF 2.0 specification, Appendix B (B.3.5).
export const clusterBrdf = '((1-fresnel)*(1-metal)*base/3.14159265+d*g*fresnel/max(4*nl*nv,0.0001))';
// The cluster lookup that opens clustered's light loop and environment's volumetric local lights: from the pixel and
// world point `p` (a WGSL name), returns vec3f(0) outside the cluster depth range, else declares `cell`, `count` and
// `var result=vec3f(0)`.
export const clusterCell = (
  p,
) => /* wgsl */ `  let grid=clusterFrame.grid.xyz;let depth=-(clusterFrame.view*vec4f(${p},1)).z;
  if(depth<clusterFrame.depth.x||depth>clusterFrame.depth.y){return vec3f(0);}
  let screenPixel=pixel-clusterFrame.depth.zw*clusterFrame.screen.xy;
  let xy=min(vec2u(max(screenPixel,vec2f(0))/clusterFrame.screen.xy*vec2f(grid.xy)),grid.xy-vec2u(1));
  let near=clusterFrame.depth.x;let far=clusterFrame.depth.y;
  let z=min(u32(max(0.0,select(log(depth/near)/log(far/near),(depth-near)/(far-near),clusterFrame.intensity.w>0.5)*f32(grid.z))),grid.z-1);
  let cell=xy.x+grid.x*(xy.y+grid.y*z);let count=clusterCounts[cell];var result=vec3f(0);`;

// The GGX (Trowbridge-Reitz) microfacet terms every PBR shader in the engine writes, as source text over the names a2
// (roughness^4), nh, nv and nl. The Float forms spell 1.0 and 2.0 (as GLSL needs and some shaders write), so each
// shader's text stays as it was.
/** GGX normal distribution `a2 / (pi (nh^2 (a2 - 1) + 1)^2)` (Walter et al. 2007, eq. 33; glTF 2.0 Appendix B.3.2). */
export const ggxD = 'a2/(3.14159265*pow(nh*nh*(a2-1)+1,2.0))';
/** {@link ggxD} with float literals. */
export const ggxDFloat = 'a2/(3.14159265*pow(nh*nh*(a2-1.0)+1.0,2.0))';
/** Smith-GGX geometry term (uncorrelated, both directions): Walter et al. 2007, eq. 34. */
export const smithG = '2*nv/(nv+sqrt(a2+(1-a2)*nv*nv))*2*nl/max(nl+sqrt(a2+(1-a2)*nl*nl),0.0001)';
/** {@link smithG} with float literals. */
export const smithGFloat = '2.0*nv/(nv+sqrt(a2+(1.0-a2)*nv*nv))*2.0*nl/max(nl+sqrt(a2+(1.0-a2)*nl*nl),0.0001)';
/** GGX distribution denominator `nh^2 (a2 - 1) + 1` (float literals) over the name `nh` (default 'nh'). */
export const ggxDenominator = (nh = 'nh') => `${nh}*${nh}*(a2-1.0)+1.0`;
/** {@link ggxD} and {@link smithG} over other names, for shaders whose locals are prefixed. */
export const ggxNamed = (a2, nh, nv, nl) => [
  `${a2}/(3.14159265*pow(${nh}*${nh}*(${a2}-1)+1,2.0))`,
  `2*${nv}/(${nv}+sqrt(${a2}+(1-${a2})*${nv}*${nv}))*2*${nl}/max(${nl}+sqrt(${a2}+(1-${a2})*${nl}*${nl}),0.0001)`,
];
