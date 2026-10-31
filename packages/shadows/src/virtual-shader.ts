// WGSL of the virtual shadow map. Receivers project a world position into light space, walk the clipmap from the level
// the pixel's footprint asks for to the first level whose page is resident, and compare in the physical pool. Comments
// stay out of the WGSL: they would ship.
import type { ShadowFilter } from './shader.js';

const filters: Record<ShadowFilter, string> = {
  soft: 'return textureSampleCompareLevel(shadowMap,shadowSampler,found.xy,reference);',
  pcf: 'return textureSampleCompareLevel(shadowMap,shadowSampler,found.xy,reference);',
  hard: 'return textureSampleCompareLevel(shadowMap,shadowSampler,found.xy,reference);',
};
/** Receiver declarations and `shadowLit`, for bind group `group`. */
export function virtualSampling(group: number, filter: ShadowFilter = 'soft'): string {
  return /* wgsl */ `
struct ShadowFrame {view:mat4x4f,right:vec4f,up:vec4f,forward:vec4f,settings:vec4f,info:vec4f,levels:array<vec4f,16>}
@group(${group}) @binding(1) var<uniform> shadowFrame:ShadowFrame;
@group(${group}) @binding(2) var shadowMap:texture_depth_2d;
@group(${group}) @binding(3) var shadowSampler:sampler_comparison;
@group(${group}) @binding(31) var shadowPages:texture_2d_array<u32>;
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
  let found=shadowPage(light.xy,0u);
  if(found.x<0){return 1;}
  let facing=vec3f(dot(n,shadowFrame.right.xyz),dot(n,shadowFrame.up.xyz),dot(n,shadowFrame.forward.xyz));var slope=vec2f(0);
  if(abs(facing.z)>0.001){slope=clamp(-facing.xy/facing.z,vec2f(-2),vec2f(2));}
  reference-=(abs(slope.x)+abs(slope.y))*found.z*0.5/range;
  ${filters[filter]}
}
fn shadowLit(direct:vec3f,position:vec3f,normal:vec3f)->vec3f {if(all(direct==vec3f(0))){return direct;}return direct*shadowVisibility(position,normal);}
`;
}
// A depth-only triangle over the viewport at the far plane: clears one page inside the frame's render pass.
export const pageClear = /* wgsl */ `@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(f32(i&1u)*4-1,f32(i&2u)*2-1,1,1);}`;
