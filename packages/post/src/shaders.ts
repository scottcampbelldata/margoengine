// The gbuffer's w is the signed view depth -z (negative behind an orthographic eye); exactly 0 marks no surface. The
// kernels read that depth from viewDepth, an r32float copy written by the extractor: the gbuffer's half float holds
// 0.004 m at 6 m, so an orthographic picture moved with the eye along its view (KB1900). A full-precision camera-space
// depth buffer is the choice of McGuire, Mara and Luebke, "Scalable Ambient Obscurance", HPG 2012.
import { displayShader } from '../../shared/display.js';
import { margoError } from '../../shared/errors.js';
export const frame = /* wgsl */ `
struct Frame {inverse:mat4x4f,view:mat4x4f,projection:mat4x4f,params:vec4f,size:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
fn viewPosition(p:vec2i,d:f32)->vec3f {
  let uv=(vec2f(p)+0.5)/f.size.xy;let w=f.inverse*vec4f(uv*vec2f(2,-2)+vec2f(-1,1),d,1);
  return (f.view*vec4f(w.xyz/w.w,1)).xyz;
}
`;
// The extractor writes each pixel's view-space normal (from depth) and its view depth. Its comments stay out of the
// WGSL text, so none ships: dx and dy use the neighbour with the smaller depth step, among neighbours that exist and
// hold a surface: at the screen edge the clamped one is the pixel itself, a zero-length difference that always read as
// the smaller step (KB1900), and a background neighbour (depth 0, reversed Z at infinity) is no surface, so a
// silhouette pixel takes the step to the covered side (KB-SSAO-SILHOUETTE1; the closer-neighbour choice of J.
// Turanszki, "Improved normal reconstruction from depth", 2019,
// https://wickedengine.net/2019/09/improved-normal-reconstruction-from-depth/). The normal is degenerate if an axis has
// no surface neighbour (a one-pixel tip of a silhouette), or dx and dy are (near) parallel or zero: |n|^2 scales with
// the pixel footprint^4, so a fixed threshold made close surfaces camera-facing. A pixel alone along an axis, both
// neighbours on the same side of it in depth and each over four pixel widths away (a slit between two blades, or a
// one-pixel wire), has no surface step there: a plane's depth is monotonic along a screen line. Either neighbour gave a
// normal along the view's side, which GTAO read as shut in, a black dot (KB-SSAO-LONEPIXEL1). The step along that axis
// is then the pixel's own at constant depth.
export const extractShader =
  frame +
  `
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(3) var viewDepth:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(output);if(any(id.xy>=size)){return;}
  let p=vec2i(id.xy);let d=textureLoad(depth,p,0);
  if(d==0){textureStore(output,p,vec4f(0));textureStore(viewDepth,p,vec4f(0));return;}
  let c=viewPosition(p,d);let limit=vec2i(size)-1;
  let right=min(p+vec2i(1,0),limit);let left=max(p-vec2i(1,0),vec2i(0));
  let down=min(p+vec2i(0,1),limit);let up=max(p-vec2i(0,1),vec2i(0));
  let dr=textureLoad(depth,right,0);let dl=textureLoad(depth,left,0);let db=textureLoad(depth,down,0);let dt=textureLoad(depth,up,0);
  let r=viewPosition(right,dr);let l=viewPosition(left,dl);let b=viewPosition(down,db);let t=viewPosition(up,dt);
  let okR=p.x<limit.x&&dr!=0;let okL=p.x>0&&dl!=0;let okD=p.y<limit.y&&db!=0;let okU=p.y>0&&dt!=0;
  let forwardX=okR&&(!okL||abs(r.z-c.z)<abs(c.z-l.z));
  let forwardY=okD&&(!okU||abs(b.z-c.z)<abs(c.z-t.z));
  let flatX=viewPosition(p+vec2i(1,0),d)-c;let flatY=viewPosition(p+vec2i(0,1),d)-c;
  let loneX=okR&&okL&&(r.z-c.z)*(l.z-c.z)>0.0&&min(abs(r.z-c.z),abs(l.z-c.z))>4.0*length(flatX);
  let loneY=okD&&okU&&(b.z-c.z)*(t.z-c.z)>0.0&&min(abs(b.z-c.z),abs(t.z-c.z))>4.0*length(flatY);
  let dx=select(select(c-l,r-c,forwardX),flatX,loneX);let dy=select(select(c-t,b-c,forwardY),flatY,loneY);
  let n=cross(dy,dx);let normal=select(vec3f(0,0,1),normalize(n),(okR||okL)&&(okD||okU)&&dot(n,n)>0.000001*dot(dx,dx)*dot(dy,dy));
  textureStore(output,p,vec4f(normal,-c.z));textureStore(viewDepth,p,vec4f(-c.z));
}
`;
// Covered blades (KB-SCATTER-AOFRINGE1): a covered blade writes depth where a hash of its coverage passes, so most of
// such a pixel's colour is the surface under it. In a frame whose covered depth was held back (packages/shared/
// ambient-veil.js) the pixel is worked out at that surface, the centre depth C: the depth under the blades U where a
// blade's depth Dc landed and nothing drew over it since (D still equals Dc), else the scene depth D. The occluders
// stay the scene's depth, so the blades still shade what is around them: one depth for the point whose occlusion is
// found and another for what occludes it, as layered depth images keep the hidden surface under a visible one (Shade,
// Gortler, He and Szeliski, "Layered Depth Images", SIGGRAPH 1998, https://doi.org/10.1145/280814.280882), and as
// screen-space occlusion over several depth layers does (Bavoil and Sainz, "Multi-Layer Dual-Resolution Screen-Space
// Ambient Occlusion", SIGGRAPH 2009 Talks, https://history.siggraph.org/?p=148934; Mara, McGuire, Nowrouzezahrai and
// Luebke, "Deep G-Buffers for Stable Global Illumination Approximation", HPG 2016,
// https://doi.org/10.2312/hpg.20161195).
export const centreShader = `@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}
@group(0) @binding(0) var under:texture_depth_2d;
@group(0) @binding(1) var cover:texture_depth_2d;
@group(0) @binding(2) var depth:texture_depth_2d;
@fragment fn fragment(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {
  let q=vec2i(p.xy);let u=textureLoad(under,q,0);let k=textureLoad(cover,q,0);let d=textureLoad(depth,q,0);
  return select(d,u,k!=u&&d==k);
}`;
// Where the centre depth is the one under the blades, the ambient light is the replay of that surface.
export const underAmbientShader = `@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}
@group(0) @binding(0) var under:texture_2d<f32>;
@group(0) @binding(1) var centre:texture_depth_2d;
@group(0) @binding(2) var depth:texture_depth_2d;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  let q=vec2i(p.xy);if(textureLoad(centre,q,0)==textureLoad(depth,q,0)){discard;}
  return textureLoad(under,q,0);
}`;
// The extractor for such a frame also writes each pixel's occluder view depth, from the scene's depth.
export const extractUnderShader = extractShader
  .replace(
    '@compute',
    '@group(0) @binding(4) var occluderDepth:texture_depth_2d;\n@group(0) @binding(5) var occluders:texture_storage_2d<r32float,write>;\n@compute',
  )
  .replace(
    'let p=vec2i(id.xy);let d=textureLoad(depth,p,0);',
    'let p=vec2i(id.xy);let d=textureLoad(depth,p,0);let od=textureLoad(occluderDepth,p,0);textureStore(occluders,p,vec4f(select(-viewPosition(p,od).z,0.0,od==0)));',
  );
if (!extractUnderShader.includes('textureStore(occluders') || !extractUnderShader.includes('var occluders'))
  throw margoError('failed', 'SSAO: the occluder extractor patch no longer matches; update extractUnderShader');
// SSAO: normal-oriented hemisphere kernel with a range check, after Mittring, "Finding Next Gen: CryEngine 2"
// (SIGGRAPH 2007 course) and J. Chapman, "SSAO Tutorial" (2013).
export const ssaoShader =
  frame +
  `
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var gbuffer:texture_2d<f32>;
@group(0) @binding(3) var noise:texture_2d<f32>;
@group(0) @binding(4) var<storage,read> kernel:array<vec4f>;
@group(0) @binding(5) var output:texture_storage_2d<r32float,write>;
@group(0) @binding(6) var viewDepth:texture_2d<f32>;
@group(0) @binding(7) var occluderDepth:texture_depth_2d;
@group(0) @binding(8) var occluders:texture_2d<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(output);if(any(id.xy>=size)){return;}
  _=textureLoad(occluderDepth,vec2i(0),0);
  let p=vec2i(id.xy);let data=textureLoad(gbuffer,p,0);let centre=textureLoad(viewDepth,p,0).r;
  if(centre==0||f.params.w<0.5){textureStore(output,p,vec4f(1));return;}
  let n=normalize(data.xyz);let position=viewPosition(p,textureLoad(depth,p,0));
  let random=textureLoad(noise,vec2i(id.xy%4u),0).xyz*2-1;
  var tangent=random-n*dot(random,n);
  if(dot(tangent,tangent)<0.001){tangent=cross(n,select(vec3f(0,1,0),vec3f(1,0,0),abs(n.y)>0.9));}
  tangent=normalize(tangent);let basis=mat3x3f(tangent,cross(n,tangent),n);
  var occlusion=0.0;let samples=u32(f.params.z);
  for(var i=0u;i<samples;i++) {
    let samplePosition=position+basis*kernel[i].xyz*f.params.x;
    let clip=f.projection*vec4f(samplePosition,1);
    if(clip.w<=0){continue;}
    let uv=clip.xy/clip.w*vec2f(0.5,-0.5)+0.5;if(any(uv<vec2f(0))||any(uv>=vec2f(1))){continue;}
    let neighbor=textureLoad(occluders,vec2i(uv*vec2f(size)),0).r;
    if(neighbor!=0){let weight=smoothstep(0.0,1.0,f.params.x/max(abs(neighbor-centre),0.0001));occlusion+=select(0.0,weight,neighbor<-samplePosition.z-f.params.y);}
  }
  textureStore(output,p,vec4f(clamp(1-occlusion/f32(samples),0.0,1.0)));
}
`;
// Separable 9-tap bilateral AO blur: Gaussian, depth and normal weights are Margo's own tuning (no external values).
export const blurShader = `
@group(0) @binding(0) var input:texture_2d<f32>;
@group(0) @binding(1) var gbuffer:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<r32float,write>;
@group(0) @binding(3) var<uniform> settings:vec4f;
@group(0) @binding(4) var viewDepth:texture_2d<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(output);if(any(id.xy>=size)){return;}
  let p=vec2i(id.xy);let center=textureLoad(gbuffer,p,0);let centre=textureLoad(viewDepth,p,0).r;
  var sum=0.0;var total=0.0;
  for(var i=-4;i<=4;i++) {
    let q=clamp(p+vec2i(settings.xy)*i,vec2i(0),vec2i(size)-1);let neighbor=textureLoad(gbuffer,q,0);
    let depthWeight=exp(-abs(centre-textureLoad(viewDepth,q,0).r)/max(settings.z*0.1,0.0001));
    let normalWeight=pow(max(dot(center.xyz,neighbor.xyz),0.0),8.0);
    let w=exp(-f32(i*i)/8)*depthWeight*select(normalWeight,1.0,centre==0);
    sum+=textureLoad(input,q,0).r*w;total+=w;
  }
  textureStore(output,p,vec4f(sum/max(total,0.000001)));
}
`;
// Composite: removes only the ambient share times (1 - AO) (Margo design), then Khronos PBR Neutral via toDisplay.
export const compositeShader = `
struct Out {@builtin(position) clip:vec4f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let positions=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.clip=vec4f(positions[i],0,1);return o;
}
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var ambient:texture_2d<f32>;
@group(0) @binding(2) var ao:texture_2d<f32>;
${displayShader}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let p=vec2i(i.clip.xy);let s=textureLoad(scene,p,0);var c=max(vec3f(0),s.rgb-textureLoad(ambient,p,0).rgb*(1-textureLoad(ao,p,0).r));
  return vec4f(toDisplay(c),s.a);
}
`;
