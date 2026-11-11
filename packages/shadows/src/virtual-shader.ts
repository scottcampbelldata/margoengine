// WGSL of the virtual shadow map. Receivers project a world position into light space, walk the clipmap from the level
// the pixel's footprint asks for to the first level whose page is resident, and compare in the physical pool. Comments
// stay out of the WGSL: they would ship.
import { effectDeclarations, effectLight, type ShadowEffect, type ShadowFilter } from './shader.js';

// Each filter's last step, after the level walk (found: pool uv, texel size, level) and the receiver-plane bias, as in the
// root's shader.ts: the same taps, in world units of light space, each tap reading the page table for its own position,
// so a tap across a page edge reads the neighbouring page. PCSS: Fernando 2005; PCF: Reeves, Salesin & Cook 1987; noise:
// Jimenez 2014. The search and the penumbra stop at one page.
const filters: Record<ShadowFilter, string> = {
  soft: /* wgsl */ `
  let noise=shadowNoise(position);let angle=noise*6.2831853;let turn=vec2f(cos(angle),sin(angle));
  let size=shadowFrame.levels[level].w;let lightSize=shadowFrame.settings.x;
  let search=clamp(lightSize*max(reference-shadowFrame.nearest[level/4u][level%4u],0.0)*range,found.z,size);
  let dimensions=vec2f(textureDimensions(shadowMap));
  var blockers=0.0;var sum=0.0;var direction=turn;
  for(var j=0u;j<16u;j++){
    let offset=direction*sqrt(f32(j)/16.0)*search;direction=shadowGolden*direction;
    let page=shadowPage(light.xy+offset,level);
    if(page.x<0){continue;}
    let d=textureLoad(shadowMap,vec2i(page.xy*dimensions),0);
    let plane=min(dot(offset,slope),0.0)/range;
    if(d<reference+plane){sum+=d-plane;blockers+=1;}
  }
  if(blockers==0){return 1;}
  let radius=clamp(lightSize*(reference-sum/blockers)*range,found.z,size);var visibility=0.0;direction=turn;
  for(var j=0u;j<32u;j++){
    let offset=direction*sqrt((f32(j)+0.5)/32.0)*radius;direction=shadowGolden*direction;
    visibility+=shadowTap(light.xy+offset,level,reference+min(dot(offset,slope),0.0)/range);
  }
  return visibility/32.0;`,
  pcf: /* wgsl */ `
  let h=vec2f(found.z*0.5);let a=vec2f(h.x,-h.y);
  return (shadowTap(light.xy-h,level,reference-dot(h,slope)/range)+shadowTap(light.xy+h,level,reference+dot(h,slope)/range)+shadowTap(light.xy-a,level,reference-dot(a,slope)/range)+shadowTap(light.xy+a,level,reference+dot(a,slope)/range))*0.25;`,
  hard: /* wgsl */ `
  return textureSampleCompareLevel(shadowMap,shadowSampler,found.xy,reference);`,
};
// The receiver's own offsets follow the texel of the page it reads, so every model scale gets the same shadow (fixed
// world lengths, 0.02 along the normal and 0.002 along the light, hid a model a few centimetres across): it moves
// NORMAL_TEXELS texels along its normal (Holbert 2011, "Normal Offset Shadows": the offset scales with the world size
// of a texel), as the root's shader.ts does with its cascades, and compares DEPTH_STEP of the depth range nearer the
// light: 16 float32 steps at 1, a fixed share of a range that scales with the scene. The slope's part of the bias is the
// receiver-plane term below (Isidoro 2006), which already reads the page's texel; a whole texel of constant depth bias
// (Dou, Yan, Kerzner, Dai & Wyman 2014) would lift deep shade off the coarsest level's texels, half a metre wide, on
// the frames before feedback names finer pages. The level is found from the receiver itself, then the offset receiver
// walks again from that level. `normalBias` and `bias` add to them.
const NORMAL_TEXELS = 0.25,
  DEPTH_STEP = '0.00000095367431640625';
const frame =
  'struct ShadowFrame {view:mat4x4f,right:vec4f,up:vec4f,forward:vec4f,settings:vec4f,info:vec4f,levels:array<vec4f,16>,inverse:mat4x4f,nearest:array<vec4f,4>}\nfn shadowReach()->f32 {return shadowFrame.info.w;}';
const soft = /* wgsl */ `const shadowGolden=mat2x2f(-0.737368878,0.675490294,-0.675490294,-0.737368878);
fn shadowNoise(position:vec3f)->f32 {
  let eye=shadowFrame.view*vec4f(position,1);let pixel=eye.xy/max(-eye.z,0.000001)*shadowFrame.settings.w;
  return fract(52.9829189*fract(dot(pixel,vec2f(0.06711056,0.00583715))));
}
`;
const firstLevel = /* wgsl */ `fn shadowFirst(footprint:f32)->u32 {return u32(clamp(ceil(log2(max(footprint,0.0000001)*126.0/shadowFrame.levels[0].w)),0.0,shadowFrame.info.z-1.0));}`;
/** Receiver declarations and `shadowLit`, for bind group `group`. */
export function virtualSampling(
  group: number,
  filter: ShadowFilter = 'soft',
  effects: readonly ShadowEffect[] = [],
  level = false,
): string {
  // The compatibility level forbids textureLoad of a depth texture: the search reads the pool bound again as float.
  const search = level && filter === 'soft';
  return /* wgsl */ `
${frame}
@group(${group}) @binding(1) var<uniform> shadowFrame:ShadowFrame;
@group(${group}) @binding(2) var shadowMap:texture_depth_2d;
@group(${group}) @binding(3) var shadowSampler:sampler_comparison;
${search ? `@group(${group}) @binding(30) var shadowDepth:texture_2d<f32>;
` : ''}@group(${group}) @binding(31) var shadowPages:texture_2d_array<u32>;
${firstLevel}
fn shadowPage(light:vec2f,first:u32)->vec4f {
  for(var level=first;level<u32(shadowFrame.info.z);level++){
    let e=shadowFrame.levels[level];let c=light/e.w;let p=floor(c);let d=p-e.xy;
    if(any(d<vec2f(-8))||any(d>=vec2f(8))){continue;}
    let t=textureLoad(shadowPages,vec2i(p)&vec2i(15),i32(level),0).r;
    if((t&0x10000u)==0u){continue;}
    return vec4f((vec2f(f32(t&255u),f32((t>>8u)&255u))+((c-p)*126.0+1.0)/128.0)*shadowFrame.info.y,e.w/126.0,f32(level));
  }
  return vec4f(-1);
}
fn shadowTap(at:vec2f,level:u32,reference:f32)->f32 {
  let page=shadowPage(at,level);
  if(page.x<0){return 1;}
  return textureSampleCompareLevel(shadowMap,shadowSampler,page.xy,reference);
}
${filter === 'soft' ? soft : ''}fn shadowVisibility(position:vec3f,normal:vec3f)->f32 {
  let n=normalize(normal);
  let first=shadowPage(vec2f(dot(shadowFrame.right.xyz,position),dot(shadowFrame.up.xyz,position)),shadowFirst(-(shadowFrame.view*vec4f(position,1)).z/shadowFrame.settings.w));
  if(first.x<0){return 1;}
  let at=position+n*(shadowFrame.settings.z+${NORMAL_TEXELS}*first.z);
  let light=vec3f(dot(shadowFrame.right.xyz,at),dot(shadowFrame.up.xyz,at),dot(shadowFrame.forward.xyz,at));
  let found=shadowPage(light.xy,u32(first.w));
  if(found.x<0){return 1;}
  let range=shadowFrame.info.x;
  var reference=(light.z-shadowFrame.forward.w-shadowFrame.settings.y)/range-${DEPTH_STEP};
  if(reference<=0||reference>=1){return 1;}
  let facing=vec3f(dot(n,shadowFrame.right.xyz),dot(n,shadowFrame.up.xyz),dot(n,shadowFrame.forward.xyz));var slope=vec2f(0);
  if(abs(facing.z)>0.001){slope=clamp(-facing.xy/facing.z,vec2f(-2),vec2f(2));}
  reference-=(abs(slope.x)+abs(slope.y))*found.z*0.5/range;let level=u32(found.w);
  ${search ? filters.soft.replace('textureLoad(shadowMap,vec2i(page.xy*dimensions),0)', 'textureLoad(shadowDepth,vec2i(page.xy*dimensions),0).x') : filters[filter]}
}
${effectDeclarations(group, effects)}fn shadowLit(direct:vec3f,position:vec3f,normal:vec3f)->vec3f {if(all(direct==vec3f(0))){return direct;}return ${effectLight(effects, 'shadowVisibility(position,normal)')};}
`;
}
// A page copy inside a render pass: a partial copy of a depth texture is not allowed in WebGPU (depth copies take the
// whole subresource), so the same pixel of the still pool is written as depth. Both pools address a page alike.
export const pageCopy = /* wgsl */ `@group(0) @binding(0) var still:texture_depth_2d;
@fragment fn fragment(@builtin(position) at:vec4f)->@builtin(frag_depth) f32 {return textureLoad(still,vec2i(at.xy),0);}`;
// A depth-only triangle over the viewport at the far plane: clears one page inside the frame's render pass.
export const pageClear = /* wgsl */ `@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(f32(i&1u)*4-1,f32(i&2u)*2-1,1,1);}`;
// Marks the pages this view needs from a half-size (a quarter of the pixels) depth of the receivers. A pixel's level has
// texels no larger than its footprint: the larger of its distance footprint (what receivers start from, shadowFirst) and
// its light-space derivative (one-sided differences, the smaller on each axis, so a silhouette does not count), so a
// receiver walking up from its own start always meets the marked page. One bit per table slot.
export const pageFeedback = /* wgsl */ `${frame}
@group(0) @binding(0) var<uniform> shadowFrame:ShadowFrame;
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var<storage,read_write> requests:array<atomic<u32>>;
${firstLevel}
fn lightAt(c:vec2i,size:vec2i)->vec2f {
  if(any(c<vec2i(0))||any(c>=size)){return vec2f(1e18);}
  let d=textureLoad(depth,c,0);if(d>=1){return vec2f(1e18);}
  let s=vec2f(size);let w=shadowFrame.inverse*vec4f((f32(c.x)+0.5)/s.x*2-1,1-(f32(c.y)+0.5)/s.y*2,d,1);let p=w.xyz/w.w;
  return vec2f(dot(shadowFrame.right.xyz,p),dot(shadowFrame.up.xyz,p));
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
  let size=vec2i(textureDimensions(depth));let c=vec2i(id.xy);if(any(c>=size)){return;}
  let d=textureLoad(depth,c,0);if(d>=1){return;}
  let s=vec2f(size);let w=shadowFrame.inverse*vec4f((f32(c.x)+0.5)/s.x*2-1,1-(f32(c.y)+0.5)/s.y*2,d,1);let p=vec4f(w.xyz/w.w,1);
  let light=vec2f(dot(shadowFrame.right.xyz,p.xyz),dot(shadowFrame.up.xyz,p.xyz));
  let dx=min(length(lightAt(c+vec2i(1,0),size)-light),length(lightAt(c-vec2i(1,0),size)-light));
  let dy=min(length(lightAt(c+vec2i(0,1),size)-light),length(lightAt(c-vec2i(0,1),size)-light));
  var derivative=max(dx,dy);if(derivative>1e17){derivative=0;}
  let footprint=max(-(shadowFrame.view*p).z/shadowFrame.settings.w,derivative*0.5);
  for(var level=shadowFirst(footprint);level<u32(shadowFrame.info.z);level++){
    let e=shadowFrame.levels[level];let page=floor(light/e.w);let q=page-e.xy;
    if(any(q<vec2f(-8))||any(q>=vec2f(8))){continue;}
    let m=vec2u(vec2i(page)&vec2i(15));let slot=(level*16u+m.y)*16u+m.x;let bit=1u<<(slot&31u);
    if((atomicLoad(&requests[slot>>5u])&bit)==0u){atomicOr(&requests[slot>>5u],bit);}
    return;
  }
}`;
// Each level's nearest depth for the PCSS search: one workgroup per table entry, its 8 x 8 invocations reading 16 x 16 texels
// each, so a whole page of 128 texels, and the page's minimum reduced into the level's slot. Depths lie in 0..1, where f32
// bit patterns order as the values do. The frame seeds the slots with 1.0, the cleared depth.
export const pageNearest = /* wgsl */ `@group(0) @binding(0) var map:texture_depth_2d;
@group(0) @binding(1) var pages:texture_2d_array<u32>;
@group(0) @binding(2) var<storage,read_write> nearest:array<atomic<u32>,16>;
var<workgroup> block:atomic<u32>;
@compute @workgroup_size(8,8) fn main(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_id) at:vec3u,@builtin(local_invocation_index) index:u32){
  if(index==0u){atomicStore(&block,0x3f800000u);}
  workgroupBarrier();
  let t=textureLoad(pages,group.xy,group.z,0).r;
  if((t&0x10000u)!=0u){
    let origin=vec2u(t&255u,(t>>8u)&255u)*128u+at.xy*16u;var m=1.0;
    for(var y=0u;y<16u;y++){for(var x=0u;x<16u;x++){m=min(m,textureLoad(map,origin+vec2u(x,y),0));}}
    atomicMin(&block,bitcast<u32>(m));
  }
  workgroupBarrier();
  if(index==0u){atomicMin(&nearest[group.z],atomicLoad(&block));}
}`;
