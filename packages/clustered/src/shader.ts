import { clusterBrdf, clusterCell, decayTerms, ggxD, legacyTerms, smithG } from '../../shared/light-terms.js';
const declarations = (group: number) => /* wgsl */ `
struct ClusterFrame {view:mat4x4f,grid:vec4u,screen:vec4f,depth:vec4f,intensity:vec4f}
struct ClusterLight {positionRange:vec4f,colorIntensity:vec4f,directionOuter:vec4f,params:vec4f}
@group(${group}) @binding(4) var<uniform> clusterFrame:ClusterFrame;
@group(${group}) @binding(5) var<storage,read> clusterLights:array<ClusterLight>;
`;
// Clustered shading (Olsson, Billeter & Assarsson 2012): exponential depth slices, sphere-AABB and cone-sphere culling.
// The 1024 indices per cell is Margo's cap.
export const cullingShader =
  declarations(0) +
  /* wgsl */ `
@group(0) @binding(6) var<storage,read_write> clusterCounts:array<u32>;
@group(0) @binding(7) var<storage,read_write> clusterIndices:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) invocation:vec3u){
  let id=invocation.x;let grid=clusterFrame.grid.xyz;if(id>=grid.x*grid.y*grid.z){return;}
  let cell=vec3u(id%grid.x,(id/grid.x)%grid.y,id/(grid.x*grid.y));
  let ortho=clusterFrame.intensity.w>0.5;let near=clusterFrame.depth.x;let far=clusterFrame.depth.y;
  var z0=near*pow(far/near,f32(cell.z)/f32(grid.z));
  var z1=near*pow(far/near,f32(cell.z+1)/f32(grid.z));
  if(ortho){z0=mix(near,far,f32(cell.z)/f32(grid.z));z1=mix(near,far,f32(cell.z+1)/f32(grid.z));}
  let x0=(f32(cell.x)/f32(grid.x)*2-1-clusterFrame.intensity.y)*clusterFrame.screen.z*clusterFrame.screen.w;
  let x1=(f32(cell.x+1)/f32(grid.x)*2-1-clusterFrame.intensity.y)*clusterFrame.screen.z*clusterFrame.screen.w;
  let y0=(1-f32(cell.y+1)/f32(grid.y)*2-clusterFrame.intensity.z)*clusterFrame.screen.z;
  let y1=(1-f32(cell.y)/f32(grid.y)*2-clusterFrame.intensity.z)*clusterFrame.screen.z;
  let s0=select(z0,1.0,ortho);let s1=select(z1,1.0,ortho);
  let lo=vec3f(min(x0*s0,x0*s1),min(y0*s0,y0*s1),-z1);
  let hi=vec3f(max(x1*s0,x1*s1),max(y1*s0,y1*s1),-z0);
  let center=(lo+hi)*0.5;let radius=length(hi-lo)*0.5;var count=0u;
  for(var j=0u;j<clusterFrame.grid.w;j++){
    let light=clusterLights[j];let p=(clusterFrame.view*vec4f(light.positionRange.xyz,1)).xyz;
    let delta=p-clamp(p,lo,hi);if(dot(delta,delta)>light.positionRange.w*light.positionRange.w){continue;}
    if(light.params.y>0.5){
      let direction=normalize((clusterFrame.view*vec4f(light.directionOuter.xyz,0)).xyz);
      let relative=center-p;let axial=dot(relative,direction);let radial=length(relative-direction*axial);
      let cosine=light.directionOuter.w;let sine=sqrt(max(0.0,1-cosine*cosine));
      if(axial+radius<0||radial*cosine-axial*sine>radius){continue;}
    }
    clusterIndices[id*1024u+count]=j;count++;
  }
  clusterCounts[id]=count;
}`;
// Extra directional lights (Clustered.directional): the point loop's BRDF text, so materials' Lambert and Phong (litShader)
// and the shadow catcher (catcherLit) rewrite and measure them too. `toLight` is the unit vector toward the light.
// `shadow` (LocalShadows' clusterDirectionalShadow factor) darkens each light; empty, the text is the original.
const directionalLoop = (shadow: string) => /* wgsl */ `
  for(var j=0u;j<clusterDirectional.count.x;j++){
    let light=clusterDirectional.lights[j];let l=light.toLight.xyz;let h=(v+l)/max(length(v+l),0.0001);
    let nl=clamp(dot(n,l),0.0,1.0);let nh=clamp(dot(n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);
    let d=${ggxD};
    let g=${smithG};
    let f0=mix(dielectricF0,base,metal);let fresnel=f0+(mix(dielectricF90,1.0,metal)-f0)*pow(1-vh,5.0);
    result+=${clusterBrdf}*nl*light.color.rgb${shadow};
  }`;
/** Light-loop hooks beyond shadows and area lights: `Clustered.directional`, `Clustered.ies`, `Clustered.projector` and `Clustered.shapes`. */
export interface ClusteredSamplingHooks {
  /** WGSL defining `clusterDirectional` (`count:vec4u`, `lights` of `toLight:vec4f`, `color:vec4f`), lit in the light loop. */
  directional?: { declarations(group: number): string };
  /**
   * Per-light factors: each declares a WGSL function and gives `term`, a vec3f or f32 expression in the point and spot
   * loop's `index` (the light's position in the `setLights` list), `light`, `l` (unit, to the light) and `position`.
   */
  terms?: readonly { declarations(group: number): string; readonly term: string }[];
  /** WGSL defining `clusterShapeLighting` (sphere, disc and tube lights), added to the result like the area lights. */
  shapes?: { declarations(group: number, shadow?: string): string };
  /**
   * `StochasticLights` (`@margoengine/clustered/stochastic`): shadows of sampled lights only. Used only with shadows;
   * `lighting` gets the cluster lookup, the loop body's head, the radiance, the shadow factor and the shadowed test.
   */
  stochastic?: {
    declarations(group: number): string;
    lighting(cell: string, head: string, radiance: string, visibility: string, shadowed: string): string;
  };
  /**
   * A per-light shadow factor like `terms` (`Clustered.contact`), also in the loop's `n` and `pixel`; skipped, as the
   * shadows are, on a core mesh with `receiveShadow` false.
   */
  contact?: { declarations(group: number): string; readonly term: string };
}
// BRDF: GGX D and separable Smith-GGX G (Walter et al. 2007 eq. 33-34), Schlick 1994 Fresnel, F0 0.04 and Lambert / pi
// (glTF 2.0 Appendix B). Roughness floor 0.045: the minimum perceptual roughness of the Filament design document, a
// published engine standard.
/**
 * WGSL for the clustered light loop in bind group `group`, for custom forward materials (`Clustered.pbr` and
 * `Clustered.shader` call it): the cluster bindings 4-7 and `clusterLighting(pixel, position, n, eye, base, roughness,
 * metal)`, which returns the summed radiance of the fragment's point and spot lights (times `intensityScale`).
 * @param shadow A `ClusteredShadow` hook (its `clusterShadow` darkens each light, and its `directionalShadow` and
 * `areaShadow` calls, when given, the directional and area lights), or `true` for the integrated maps.
 * @param area A `ClusteredArea` hook; its `clusterAreaLighting` is added to the result.
 * @param integratedShadows Also sample the integrated maps of `ClusteredOptions.shadows` (bindings 28-30).
 * @param decay Use the `decay`/`angle` light terms (some light set them) instead of the inverse-square ones.
 * @param receive Declare `clusterReceive`, which a core mesh with `receiveShadow` false sets to skip shadows.
 */
export function clusteredSampling(
  group: number,
  shadow?:
    | boolean
    | { declarations(group: number): string; readonly directionalShadow?: string; readonly areaShadow?: string; readonly shapeShadow?: string },
  area?: { declarations(group: number, shadow?: string): string },
  integratedShadows = false,
  decay = false,
  receive = false,
  { directional, terms = [], shapes, stochastic, contact }: ClusteredSamplingHooks = {},
): string {
  const shadows = shadow === true || integratedShadows,
    hook = typeof shadow === 'object' ? shadow : undefined,
    // A core mesh with receiveShadow false sets clusterReceive false before calling clusterLighting.
    term = (call: string) => (receive ? `*select(1.0,${call},clusterReceive)` : '*' + call),
    directionalShadow = hook?.directionalShadow,
    areaShadow = hook?.areaShadow,
    sampled = !!(hook || shadows) && stochastic,
    visibility =
      (hook ? term('clusterShadow(light,position,n)') : '') +
      (shadows ? term('clusterShadowVisibility(light,position,n)') : ''),
    head = `${terms.length || sampled || contact ? 'let index=clusterIndices[cell*1024u+j];let light=clusterLights[index];' : 'let light=clusterLights[clusterIndices[cell*1024u+j]];'}let delta=light.positionRange.xyz-position;let distance=length(delta);
    if(distance>=light.positionRange.w){continue;}let l=delta/max(distance,0.0001);let h=(v+l)/max(length(v+l),0.0001);
    let nl=clamp(dot(n,l),0.0,1.0);let nh=clamp(dot(n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);
    let d=${ggxD};
    let g=${smithG};
    let f0=mix(dielectricF0,base,metal);let fresnel=f0+(mix(dielectricF90,1.0,metal)-f0)*pow(1-vh,5.0);
    ${decay ? decayTerms : legacyTerms}`,
    start =
      '\n  let v=normalize(eye-position);let nv=clamp(dot(n,v),0.0001,1.0);let a=max(roughness,0.045)*max(roughness,0.045);let a2=a*a;',
    radiance = `${clusterBrdf}*nl*light.colorIntensity.rgb*light.colorIntensity.w*falloff*cone${terms.map((t) => '*' + t.term).join('')}${contact ? term(contact.term) : ''}`;
  const code =
    declarations(group) +
    (hook ? hook.declarations(group) : '') +
    (area ? (areaShadow ? area.declarations(group, term(areaShadow)) : area.declarations(group)) : '') +
    (directional ? directional.declarations(group) : '') +
    terms.map((t) => t.declarations(group)).join('') +
    (shapes ? shapes.declarations(group, hook?.shapeShadow ? term(hook.shapeShadow) : undefined) : '') +
    (sampled ? sampled.declarations(group) : '') +
    (contact ? contact.declarations(group) : '') +
    /* wgsl */ `
@group(${group}) @binding(6) var<storage,read> clusterCounts:array<u32>;
@group(${group}) @binding(7) var<storage,read> clusterIndices:array<u32>;${receive ? '\nvar<private> clusterReceive=true;' : ''}
fn clusterLighting(pixel:vec2f,position:vec3f,n:vec3f,eye:vec3f,base:vec3f,roughness:f32,metal:f32,dielectricF0:vec3f,dielectricF90:f32)->vec3f {
${
  sampled
    ? sampled.lighting(
        clusterCell('position') + start,
        head,
        radiance,
        visibility,
        `(${hook ? 'light.params.z>=1.0' : 'false'}||${shadows ? 'light.params.w>=1.0' : 'false'})${receive ? '&&clusterReceive' : ''}`,
      )
    : `${/* @__PURE__ */ clusterCell('position')}${start}
  for(var j=0u;j<count;j++){
    ${head}
    result+=${radiance}${visibility};
  }`
}${directional ? directionalLoop(directionalShadow ? term(directionalShadow) : '') : ''}
  return ${area || shapes ? `(result${area ? '+clusterAreaLighting(position,n,v,nv,base,roughness,metal,dielectricF0,dielectricF90)' : ''}${shapes ? '+clusterShapeLighting(position,n,v,nv,base,roughness,metal,dielectricF0,dielectricF90)' : ''})` : 'result'}*clusterFrame.intensity.x;
}`;
  return shadows ? localShadowSampling(group) + code : code;
}

// Integrated point/spot shadow maps: 3x3 PCF (Reeves, Salesin & Cook 1987) with normal offset (Holbert 2011).
/** Bindings 8/9 are already used by optional camera, sky and terrain effects. */
function localShadowSampling(group: number): string {
  return /* wgsl */ `
struct ClusterShadowFace {matrix:mat4x4f,settings:vec4f}
@group(${group}) @binding(28) var<storage,read> clusterShadowFaces:array<ClusterShadowFace>;
@group(${group}) @binding(29) var clusterShadowMap:texture_depth_2d_array;
@group(${group}) @binding(30) var clusterShadowSampler:sampler_comparison;
fn clusterShadowFace(direction:vec3f)->u32 {
  let axis=abs(direction);
  if(axis.x>=axis.y&&axis.x>=axis.z){return select(1u,0u,direction.x>=0.0);}
  if(axis.y>=axis.z){return select(3u,2u,direction.y>=0.0);}
  return select(5u,4u,direction.z>=0.0);
}
fn clusterShadowVisibility(light:ClusterLight,position:vec3f,normal:vec3f)->f32 {
  if(light.params.w<1.0){return 1.0;}
  var layer=(u32(light.params.w)-1u)*6u;
  let settings=clusterShadowFaces[layer].settings;
  let receiver=position+normal/max(length(normal),0.000001)*settings.y;
  if(light.params.y<0.5||settings.z>0.5){layer+=clusterShadowFace(receiver-light.positionRange.xyz);}
  let face=clusterShadowFaces[layer];
  let clip=face.matrix*vec4f(receiver,1);
  if(clip.w<=0.0){return 1.0;}
  let projected=clip.xyz/clip.w;
  let uv=projected.xy*vec2f(0.5,-0.5)+0.5;
  let reference=projected.z-face.settings.x;
  if(any(uv<vec2f(0))||any(uv>vec2f(1))||reference<=0.0||reference>=1.0){return 1.0;}
  let dimensions=vec2f(textureDimensions(clusterShadowMap));let texel=1.0/dimensions;
  var visibility=0.0;
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
    let sampleUV=clamp(uv+vec2f(f32(x),f32(y))*texel,texel*0.5,vec2f(1)-texel*0.5);
    visibility+=textureSampleCompareLevel(clusterShadowMap,clusterShadowSampler,sampleUV,i32(layer),reference);
  }}
  return visibility/9.0;
}
`;
}
