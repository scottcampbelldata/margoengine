// WGSL distance falloff and spot cone of one clustered light record (`light`, its unit vector `l` from the shaded point
// and `distance`), shared by @margoengine/clustered's light loop and @margoengine/environment's volumetric fog.
// As written before lights had a decay.
export const legacyTerms = /* wgsl */ `let falloff=pow(max(0.0,1-pow(distance/light.positionRange.w,4.0)),2.0)/max(distance*distance,0.01);
    var cone=1.0;if(light.params.y>0.5){cone=clamp((dot(-l,light.directionOuter.xyz)-light.directionOuter.w)/max(light.params.x-light.directionOuter.w,0.00001),0.0,1.0);cone*=cone*(3-2*cone);}`;
// The same terms once any light sets `decay` or `angle` (clustered `setLights`): params.y holds 0 (point) or 1 (spot)
// for a light that sets neither, which keeps the terms above, and -(1 + decay) (point) or 2 + decay (spot) for one that
// does, so every `params.y > 0.5` spot test elsewhere still holds. Those lights get window / max(d^decay, 0.01) and the
// cone smoothstep(cos outer, cos inner, dot(-L, direction)), a hard edge when the two are equal (penumbra 0).
export const decayTerms = /* wgsl */ `let kind=light.params.y;let legacy=kind==0.0||kind==1.0;let decay=select(-1.0-kind,kind-2.0,kind>0.5);
    let falloff=pow(max(0.0,1-pow(distance/light.positionRange.w,4.0)),2.0)/select(max(pow(max(distance,0.0001),decay),0.01),max(distance*distance,0.01),legacy);
    var cone=1.0;if(kind>0.5){let x=dot(-l,light.directionOuter.xyz);let lo=light.directionOuter.w;let hi=light.params.x;
      if(legacy){cone=clamp((x-lo)/max(hi-lo,0.00001),0.0,1.0);}else if(hi>lo){cone=clamp((x-lo)/(hi-lo),0.0,1.0);}else{cone=select(0.0,1.0,x>=lo);}
      cone*=cone*(3-2*cone);}`;
// The per-light BRDF of clustered's light loop (GGX with Fresnel, as gltf-pro's direct light), in the loop's locals (n, v,
// l, h, base, metal, nl, nv, d, g, fresnel). @margoengine/materials' Lambert and Phong put their own BRDF in its place.
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

// The GGX (Trowbridge-Reitz) microfacet terms every PBR shader in the engine writes, as source text over the caller's
// variable names (WGSL; GLSL takes the same text with `float`). `float` writes 1.0 and 2.0 instead of 1 and 2, the
// spelling GLSL needs and some shaders use, so each shader's text stays as it was.
const one = (float) => (float ? '1.0' : '1');
/** GGX distribution denominator `nh^2 (a2 - 1) + 1` (`a2` = roughness^4). */
export const ggxDenominator = (a2, nh, float = false) => `${nh}*${nh}*(${a2}-${one(float)})+${one(float)}`;
/** GGX normal distribution `a2 / (pi (nh^2 (a2 - 1) + 1)^2)`. */
export const ggxD = (a2, nh, float = false) => `${a2}/(3.14159265*pow(${ggxDenominator(a2, nh, float)},2.0))`;
/** Smith-GGX geometry term (uncorrelated, both directions). */
export const smithG = (a2, nv, nl, float = false) => {
  const o = one(float),
    t = float ? '2.0' : '2';
  return `${t}*${nv}/(${nv}+sqrt(${a2}+(${o}-${a2})*${nv}*${nv}))*${t}*${nl}/max(${nl}+sqrt(${a2}+(${o}-${a2})*${nl}*${nl}),0.0001)`;
};
