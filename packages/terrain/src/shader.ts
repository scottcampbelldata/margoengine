import { neutralShader } from '../../shared/display.js';
import { ggxD, smithG } from '../../shared/light-terms.js';
// Vertex morph between grid levels: Strugar 2009, "Continuous Distance-Dependent Level of Detail" (CDLOD), JGT.
export const terrainVertex = /* wgsl */ `
struct Frame {camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f,grid:vec4f,offset:vec4f,map:vec4f,heights:vec4f}
struct Layer {heightSlope:vec4f,params:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var heightMap:texture_2d<f32>;
@group(0) @binding(2) var normalMap:texture_2d<f32>;
@group(0) @binding(3) var terrainLayers:texture_2d_array<f32>;
@group(0) @binding(4) var terrainSampler:sampler;
@group(0) @binding(5) var<storage,read> layerRules:array<Layer>;
fn height(position:vec2f)->f32 {
  let dimensions=vec2i(textureDimensions(heightMap));let uv=clamp((position-frame.map.xy)/frame.map.zw,vec2f(0),vec2f(1));let pixel=uv*vec2f(dimensions-vec2i(1));let lo=vec2i(floor(pixel));let hi=min(lo+vec2i(1),dimensions-vec2i(1));let t=fract(pixel);
  let a=mix(textureLoad(heightMap,lo,0).r,textureLoad(heightMap,vec2i(hi.x,lo.y),0).r,t.x);let b=mix(textureLoad(heightMap,vec2i(lo.x,hi.y),0).r,textureLoad(heightMap,hi,0).r,t.x);
  return mix(a,b,t.y)*frame.heights.x+frame.heights.y;
}
struct Output {@builtin(position) clip:vec4f,@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) color:vec3f,@location(3) material:vec4f}
@vertex fn vertex(@location(0) grid:vec2f)->Output {
  let edge=max(abs(grid.x),abs(grid.y));let morph=clamp((edge-frame.grid.w*0.5+2)/2,0.0,1.0);
  let aligned=mix(grid,round(grid*0.5)*2,morph);let inner=clamp((frame.grid.w*0.5-edge)/(frame.grid.w*0.25),0.0,1.0);
  let xz=frame.grid.xy+aligned*frame.grid.z+frame.offset.xy*inner;let position=vec3f(xz.x,height(xz),xz.y);
  let step=frame.map.zw/max(vec2f(textureDimensions(heightMap))-1,vec2f(1));
  var normal=normalize(vec3f((height(xz-vec2f(step.x,0))-height(xz+vec2f(step.x,0)))/(2*step.x),1,(height(xz-vec2f(0,step.y))-height(xz+vec2f(0,step.y)))/(2*step.y)));
  if(frame.offset.w>0.5){let dimensions=vec2i(textureDimensions(normalMap));let uv=clamp((xz-frame.map.xy)/frame.map.zw,vec2f(0),vec2f(1));let sampled=textureLoad(normalMap,min(vec2i(uv*vec2f(dimensions)),dimensions-vec2i(1)),0).xyz*2-1;if(dot(sampled,sampled)>0.00001){normal=normalize(sampled);}}
  var o:Output;o.position=position;o.clip=frame.camera*vec4f(position,1);o.normal=normal;o.color=vec3f(1);o.material=vec4f(0.9,0,1,1);return o;
}
`;
/**
 * The heightmap covers `frame.map` (origin, size); the outer clipmap rings reach past it, where heights and weights are
 * only the clamped edge texels (a flat shelf with stretched walls). Fragments there are dropped, so the sky shows past
 * the terrain's edge (main drew that shelf to the horizon).
 */
export const terrainOutside = /* wgsl */ `if(any(i.position.xz<frame.map.xy)||any(i.position.xz>frame.map.xy+frame.map.zw)){discard;}`;
/**
 * `TerrainLayer.bump` and `macro`, compiled in only when some layer sets one (otherwise every shader is the text it was).
 * Rules grow to 12 floats: `surface` is (bump height in metres per unit of luma, macro amount, macro texture scale, 0).
 * `terrainSurface` takes a layer's triplanar colour and returns it scaled by the macro sample (the same layer at 1/24 of
 * its scale; its luma over the layer's mean from the top mip, so the average colour stays) with the bump height in w.
 * `terrainBump` is Mikkelsen 2010, "Bump Mapping Unparametrized Surfaces on the GPU" (JGT 15(1)), listing 1: the
 * surface gradient of that height from its screen-space derivatives and the position's, no extra texture samples. Each
 * screen axis is first divided by its position derivative's length (the formula is homogeneous in each axis), so det
 * is the sine-like measure of how far the two axes are from parallel in 3D: 1 on any surface seen squarely or at a
 * grazing angle along a screen axis, near 0 only on slivers seen edge-on. There both axes sample nearly one direction
 * on the surface, so the solve divides the height derivatives by det, and those carry errors (the 2x2 quad's helper
 * lanes lie past the crest edge, where the vertex normal, the triplanar blend and the layer weights are extrapolated).
 * The slope the gradient may give is therefore capped at min(1, 4 det), what the pixel can resolve. Uncapped, alpine
 * crests under the noon sun got slopes of 1.5 to over 8 and drew dotted lines of near-black pixels
 * (test/crest.browser.mjs: 21 specks against 0 without bump; capped, 0).
 */
export const surfaceStruct = (code: string): string =>
  code.replace(
    'struct Layer {heightSlope:vec4f,params:vec4f}',
    'struct Layer {heightSlope:vec4f,params:vec4f,surface:vec4f}',
  );
const surfaceFunctions = /* wgsl */ `
var<private> terrainRelief:f32;
fn terrainSurface(sample:vec3f,position:vec3f,projection:vec3f,dx:vec3f,dy:vec3f,layer:u32)->vec4f {
  let s=layerRules[layer].surface;let luma=vec3f(0.2126,0.7152,0.0722);var color=sample;
  if(s.y>0.0){
    let m=s.z;let p=position*m;
    let x=textureSampleGrad(terrainLayers,terrainSampler,p.zy,i32(layer),dx.zy*m,dy.zy*m).rgb;
    let y=textureSampleGrad(terrainLayers,terrainSampler,p.xz,i32(layer),dx.xz*m,dy.xz*m).rgb;
    let z=textureSampleGrad(terrainLayers,terrainSampler,p.xy,i32(layer),dx.xy*m,dy.xy*m).rgb;
    let mean=textureSampleLevel(terrainLayers,terrainSampler,vec2f(0.5),i32(layer),f32(textureNumLevels(terrainLayers)-1u)).rgb;
    color*=max(1.0-s.y+s.y*dot(x*projection.x+y*projection.y+z*projection.z,luma)/max(dot(mean,luma),0.0001),0.0);
  }
  return vec4f(color,dot(sample,luma)*s.x);
}
fn terrainBump(position:vec3f,normal:vec3f)->vec3f {
  let px=dpdxFine(position);let py=dpdyFine(position);let ax=1.0/max(length(px),1e-20);let ay=1.0/max(length(py),1e-20);
  let dx=px*ax;let dy=py*ay;let r1=cross(dy,normal);let r2=cross(normal,dx);let det=dot(dx,r1);
  let g=sign(det)*(dpdxFine(terrainRelief)*ax*r1+dpdyFine(terrainRelief)*ay*r2);
  let bumped=abs(det)*normal-g*min(1.0,min(1.0,4.0*abs(det))*abs(det)/max(length(g),1e-20));
  return select(normal,normalize(bumped),dot(bumped,bumped)>0.0);
}`;
/** The fragment's shading normal `n` and layer colour `base` (the SSR capture entry starts the same way). */
export const terrainShading = (surface: boolean): string =>
  surface
    ? 'let terrainN=normalize(i.normal);let base=terrainColor(i.position,terrainN);let n=terrainBump(i.position,terrainN);'
    : 'let n=normalize(i.normal);let base=terrainColor(i.position,n);';
// Triplanar weights abs(n)^8 (Geiss 2007, GPU Gems 3 ch. 1; exponent 8 is Margo's); GGX + Schlick (F0 0.04) + Lambert
// sun per glTF 2.0 Appendix B (Walter et al. 2007; Schlick 1994); Khronos PBR Neutral, then sRGB (IEC 61966-2-1).
/** The rule-weighted fragment shader; `surface` adds `TerrainLayer.bump` and `macro`. A function, so a bundle that
 * never draws a terrain keeps no shader text. */
export const terrainFragment = (
  surface = false,
): string => /* wgsl */ `${neutralShader}${surface ? surfaceFunctions : ''}
fn terrainColor(position:vec3f,normal:vec3f)->vec3f {
  let slope=1-clamp(normal.y,0.0,1.0);let axes=pow(abs(normal),vec3f(8));let projection=axes/max(axes.x+axes.y+axes.z,0.00001);let dx=dpdx(position);let dy=dpdy(position);var color=vec3f(0);var total=0.0;var fallback=vec3f(0);${surface ? 'var relief=0.0;var fallbackRelief=0.0;' : ''}
  for(var layer=0u;layer<u32(frame.heights.z);layer++){
    let rule=layerRules[layer];let hs=rule.heightSlope;let scale=rule.params.x;let p=position*scale;
    let x=textureSampleGrad(terrainLayers,terrainSampler,p.zy,i32(layer),dx.zy*scale,dy.zy*scale).rgb;
    let y=textureSampleGrad(terrainLayers,terrainSampler,p.xz,i32(layer),dx.xz*scale,dy.xz*scale).rgb;
    let z=textureSampleGrad(terrainLayers,terrainSampler,p.xy,i32(layer),dx.xy*scale,dy.xy*scale).rgb;
    ${surface ? 'let surface=terrainSurface(x*projection.x+y*projection.y+z*projection.z,position,projection,dx,dy,layer);let sample=surface.rgb;if(layer==0){fallback=sample;fallbackRelief=surface.w;}' : 'let sample=x*projection.x+y*projection.y+z*projection.z;if(layer==0){fallback=sample;}'}
    let h=rule.params.y;let s=rule.params.z;
    let weight=smoothstep(hs.x-h,hs.x+h,position.y)*(1-smoothstep(hs.y-h,hs.y+h,position.y))*smoothstep(hs.z-s,hs.z+s,slope)*(1-smoothstep(hs.w-s,hs.w+s,slope));
    color+=sample*weight;total+=weight;${surface ? 'relief+=surface.w*weight;' : ''}
  }
  ${surface ? 'terrainRelief=select(fallbackRelief,relief/max(total,0.00001),total>0.00001);' : ''}return select(fallback,color/max(total,0.00001),total>0.00001);
}
@fragment fn fragment(i:Output)->@location(0) vec4f {
  ${terrainOutside}
  ${terrainShading(surface)}let v=normalize(frame.eye.xyz-i.position);let l=normalize(frame.light.xyz);let h=(v+l)/max(length(v+l),0.0001);
  let nl=clamp(dot(n,l),0.0,1.0);let nv=clamp(dot(n,v),0.0001,1.0);let nh=clamp(dot(n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);let a=i.material.x*i.material.x;let a2=a*a;
  let d=${ggxD};let g=${smithG};let fresnel=vec3f(0.04)+vec3f(0.96)*pow(1-vh,5.0);
  let direct=((1-fresnel)*base/3.14159265+d*g*fresnel/max(4*nl*nv,0.0001))*nl;
  let linear=direct*frame.radiance.xyz*frame.light.w+base*frame.radiance.w;
  if(frame.heights.w>0.5){return vec4f(linear,1);}
  let mapped=pbrNeutral(max(linear,vec3f(0)));return vec4f(select(mapped*12.92,1.055*pow(mapped,vec3f(1.0/2.4))-0.055,mapped>=vec3f(0.0031308)),1);
}`;

/** One layer's triplanar colour: its three projections blended by the normal (`terrainColor` and the weighted one). */
const layerSample = /* wgsl */ `
fn terrainLayerSample(position:vec3f,projection:vec3f,dx:vec3f,dy:vec3f,layer:u32)->vec3f {
  let scale=layerRules[layer].params.x;let p=position*scale;
  let x=textureSampleGrad(terrainLayers,terrainSampler,p.zy,i32(layer),dx.zy*scale,dy.zy*scale).rgb;
  let y=textureSampleGrad(terrainLayers,terrainSampler,p.xz,i32(layer),dx.xz*scale,dy.xz*scale).rgb;
  let z=textureSampleGrad(terrainLayers,terrainSampler,p.xy,i32(layer),dx.xy*scale,dy.xy*scale).rgb;
  return x*projection.x+y*projection.y+z*projection.z;
}`;

/**
 * The fragment shader with `TerrainTextures.weights` (`count` textures, 2 to 4): layer i's weight is channel i % 4 of
 * weight texture i / 4, sampled bilinearly once per fragment over the heightmap's bounds, in place of the height and
 * slope rules (which still set each layer's texture scale). A layer whose weight is 0 skips its three triplanar
 * samples, so 16 layers cost what the ones that show do; the colour is the same as sampling every layer. A function,
 * so importing anything else from this package keeps no shader text.
 */
export const weightedFragment = (count: number, surface = false): string => {
  const rules = terrainFragment(surface),
    ruleColor = rules.slice(rules.indexOf('fn terrainColor('), rules.indexOf('@fragment fn fragment(')),
    n = Math.min(4, Math.max(1, Math.floor(count))),
    ids = Array.from({ length: n }, (_, i) => i);
  return /* wgsl */ `
${ids.map((i) => `@group(0) @binding(${6 + i}) var terrainWeights${i}:texture_2d<f32>;`).join('\n')}
${layerSample}
fn terrainColor(position:vec3f,normal:vec3f)->vec3f {
  let axes=pow(abs(normal),vec3f(8));let projection=axes/max(axes.x+axes.y+axes.z,0.00001);let dx=dpdx(position);let dy=dpdy(position);
  let d=vec2f(textureDimensions(terrainWeights0));let uv=clamp((position.xz-frame.map.xy)/frame.map.zw,vec2f(0.5)/d,vec2f(1)-vec2f(0.5)/d);
  var packed=array<vec4f,4>(${[0, 1, 2, 3].map((i) => (i < n ? `textureSampleLevel(terrainWeights${i},terrainSampler,uv,0)` : 'vec4f(0)')).join(',')});
  var color=vec3f(0);var total=0.0;${surface ? 'var relief=0.0;' : ''}
  for(var layer=0u;layer<u32(frame.heights.z);layer++){
    let weight=packed[layer/4u][layer%4u];if(weight<=0.0){continue;}
    ${surface ? 'let surface=terrainSurface(terrainLayerSample(position,projection,dx,dy,layer),position,projection,dx,dy,layer);color+=surface.rgb*weight;relief+=surface.w*weight;total+=weight;' : 'color+=terrainLayerSample(position,projection,dx,dy,layer)*weight;total+=weight;'}
  }
  ${surface ? 'if(total>0.00001){terrainRelief=relief/total;return color/total;}' : 'if(total>0.00001){return color/total;}'}
  ${surface ? 'let surface=terrainSurface(terrainLayerSample(position,projection,dx,dy,0u),position,projection,dx,dy,0u);terrainRelief=surface.w;return surface.rgb;' : 'return terrainLayerSample(position,projection,dx,dy,0u);'}
}
${rules.replace(ruleColor, '')}`;
};
