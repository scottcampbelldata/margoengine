// WGSL of the virtual shadow map. Receivers project a world position into light space, walk the clipmap from the level
// the pixel's footprint asks for to the first level whose page is resident, and compare in the physical pool. Comments
// stay out of the WGSL: they would ship.
import type { ShadowFilter } from './shader.js';

const filters: Record<ShadowFilter, string> = {
  soft: 'return textureSampleCompareLevel(shadowMap,shadowSampler,found.xy,reference);',
  pcf: 'return textureSampleCompareLevel(shadowMap,shadowSampler,found.xy,reference);',
  hard: 'return textureSampleCompareLevel(shadowMap,shadowSampler,found.xy,reference);',
};
const frame =
  'struct ShadowFrame {view:mat4x4f,right:vec4f,up:vec4f,forward:vec4f,settings:vec4f,info:vec4f,levels:array<vec4f,16>,inverse:mat4x4f}';
const firstLevel = /* wgsl */ `fn shadowFirst(footprint:f32)->u32 {return u32(clamp(ceil(log2(max(footprint,0.0000001)*126.0/shadowFrame.levels[0].w)),0.0,shadowFrame.info.z-1.0));}`;
/** Receiver declarations and `shadowLit`, for bind group `group`. */
export function virtualSampling(group: number, filter: ShadowFilter = 'soft'): string {
  return /* wgsl */ `
${frame}
@group(${group}) @binding(1) var<uniform> shadowFrame:ShadowFrame;
@group(${group}) @binding(2) var shadowMap:texture_depth_2d;
@group(${group}) @binding(3) var shadowSampler:sampler_comparison;
@group(${group}) @binding(31) var shadowPages:texture_2d_array<u32>;
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
fn shadowVisibility(position:vec3f,normal:vec3f)->f32 {
  let n=normalize(normal);let at=position+n*shadowFrame.settings.z;
  let light=vec3f(dot(shadowFrame.right.xyz,at),dot(shadowFrame.up.xyz,at),dot(shadowFrame.forward.xyz,at));
  let range=shadowFrame.info.x;
  var reference=(light.z-shadowFrame.forward.w-shadowFrame.settings.y)/range;
  if(reference<=0||reference>=1){return 1;}
  let found=shadowPage(light.xy,shadowFirst(-(shadowFrame.view*vec4f(position,1)).z/shadowFrame.settings.w));
  if(found.x<0){return 1;}
  let facing=vec3f(dot(n,shadowFrame.right.xyz),dot(n,shadowFrame.up.xyz),dot(n,shadowFrame.forward.xyz));var slope=vec2f(0);
  if(abs(facing.z)>0.001){slope=clamp(-facing.xy/facing.z,vec2f(-2),vec2f(2));}
  reference-=(abs(slope.x)+abs(slope.y))*found.z*0.5/range;
  ${filters[filter]}
}
fn shadowLit(direct:vec3f,position:vec3f,normal:vec3f)->vec3f {if(all(direct==vec3f(0))){return direct;}return direct*shadowVisibility(position,normal);}
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
