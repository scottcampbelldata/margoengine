// The gbuffer's w is the signed view depth -z (negative behind an orthographic eye); exactly 0 marks no surface.
const frame = /* wgsl */ `
struct Frame {inverse:mat4x4f,view:mat4x4f,projection:mat4x4f,params:vec4f,size:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
fn viewPosition(p:vec2i,d:f32)->vec3f {
  let uv=(vec2f(p)+0.5)/f.size.xy;let w=f.inverse*vec4f(uv*vec2f(2,-2)+vec2f(-1,1),d,1);
  return (f.view*vec4f(w.xyz/w.w,1)).xyz;
}
`;
export const extractShader =
  frame +
  `
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(output);if(any(id.xy>=size)){return;}
  let p=vec2i(id.xy);let d=textureLoad(depth,p,0);
  if(d==0){textureStore(output,p,vec4f(0));return;}
  let c=viewPosition(p,d);let limit=vec2i(size)-1;
  let right=min(p+vec2i(1,0),limit);let left=max(p-vec2i(1,0),vec2i(0));
  let down=min(p+vec2i(0,1),limit);let up=max(p-vec2i(0,1),vec2i(0));
  let r=viewPosition(right,textureLoad(depth,right,0));let l=viewPosition(left,textureLoad(depth,left,0));
  let b=viewPosition(down,textureLoad(depth,down,0));let t=viewPosition(up,textureLoad(depth,up,0));
  let dx=select(c-l,r-c,abs(r.z-c.z)<abs(c.z-l.z));let dy=select(c-t,b-c,abs(b.z-c.z)<abs(c.z-t.z));
  // Degenerate only if dx and dy are (near) parallel or zero: |n|^2 scales with the pixel footprint^4, so a fixed threshold made close surfaces camera-facing.
  let n=cross(dy,dx);let normal=select(vec3f(0,0,1),normalize(n),dot(n,n)>0.000001*dot(dx,dx)*dot(dy,dy));
  textureStore(output,p,vec4f(normal,-c.z));
}
`;
export const ssaoShader =
  frame +
  `
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var gbuffer:texture_2d<f32>;
@group(0) @binding(3) var noise:texture_2d<f32>;
@group(0) @binding(4) var<storage,read> kernel:array<vec4f>;
@group(0) @binding(5) var output:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(output);if(any(id.xy>=size)){return;}
  let p=vec2i(id.xy);let data=textureLoad(gbuffer,p,0);
  if(data.w==0||f.params.w<0.5){textureStore(output,p,vec4f(1));return;}
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
    let neighbor=textureLoad(gbuffer,vec2i(uv*vec2f(size)),0).w;
    if(neighbor!=0){let weight=smoothstep(0.0,1.0,f.params.x/max(abs(neighbor-data.w),0.0001));occlusion+=select(0.0,weight,neighbor<-samplePosition.z-f.params.y);}
  }
  textureStore(output,p,vec4f(clamp(1-occlusion/f32(samples),0.0,1.0)));
}
`;
export const blurShader = `
@group(0) @binding(0) var input:texture_2d<f32>;
@group(0) @binding(1) var gbuffer:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<r32float,write>;
@group(0) @binding(3) var<uniform> settings:vec4f;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(output);if(any(id.xy>=size)){return;}
  let p=vec2i(id.xy);let center=textureLoad(gbuffer,p,0);var sum=0.0;var total=0.0;
  for(var i=-4;i<=4;i++) {
    let q=clamp(p+vec2i(settings.xy)*i,vec2i(0),vec2i(size)-1);let neighbor=textureLoad(gbuffer,q,0);
    let depthWeight=exp(-abs(center.w-neighbor.w)/max(settings.z*0.1,0.0001));
    let normalWeight=pow(max(dot(center.xyz,neighbor.xyz),0.0),8.0);
    let w=exp(-f32(i*i)/8)*depthWeight*select(normalWeight,1.0,center.w==0);
    sum+=textureLoad(input,q,0).r*w;total+=w;
  }
  textureStore(output,p,vec4f(sum/max(total,0.000001)));
}
`;
export const compositeShader = `
struct Out {@builtin(position) clip:vec4f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let positions=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.clip=vec4f(positions[i],0,1);return o;
}
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var ambient:texture_2d<f32>;
@group(0) @binding(2) var ao:texture_2d<f32>;
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let p=vec2i(i.clip.xy);let s=textureLoad(scene,p,0);var c=max(vec3f(0),s.rgb-textureLoad(ambient,p,0).rgb*(1-textureLoad(ao,p,0).r));
  c=c/(1+c);c=select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308));return vec4f(c,s.a);
}
`;
