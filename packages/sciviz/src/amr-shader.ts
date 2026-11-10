// Direct AMR leaf integration. No finest-level covering texture is allocated.
import { colorLookupWGSL } from './color-lookup.js';
export const amrShader = /* wgsl */ `
struct AMR { model:mat4x4f,inverse:mat4x4f,options:vec4f,scalar:vec4f,span:vec4f,size:vec4f,planes:array<vec4f,4> }
@group(1) @binding(0) var<uniform> u:AMR;
@group(1) @binding(1) var nodes:texture_2d<f32>;
@group(1) @binding(2) var blocks:texture_2d<f32>;
@group(1) @binding(3) var samples:texture_2d<f32>;
@group(1) @binding(4) var transfer:texture_2d<f32>;
@group(1) @binding(5) var linearSampler:sampler;
${colorLookupWGSL}
fn missing(v:f32)->bool {return (bitcast<u32>(v)&0x7fffffffu)>0x7f800000u;}
fn load(t:texture_2d<f32>,i:u32)->vec4f {let w=textureDimensions(t).x;return textureLoad(t,vec2i(i32(i%w),i32(i/w)),0);}
struct Hit {low:f32,high:f32}
fn interval(origin:vec3f,d:vec3f,lo:vec3f,hi:vec3f,start:f32,limit:f32)->Hit {
 var a=start;var b=limit;
 for(var k=0u;k<3u;k++){
  if(abs(d[k])<1e-20){if(origin[k]<lo[k] || origin[k]>=hi[k]){return Hit(1.0,0.0);}}
  else {let x=(lo[k]-origin[k])/d[k];let y=(hi[k]-origin[k])/d[k];a=max(a,min(x,y));b=min(b,max(x,y));}
 }return Hit(a,b);
}
fn value(id:u32,cell:vec3i)->f32 {
 let a=load(blocks,id*3u);let dims=vec3u(load(blocks,id*3u+2u).xyz);let p=vec3u(clamp(cell,vec3i(0),vec3i(dims)-1));
 let i=u32(a.w)+(p.z*dims.y+p.y)*dims.x+p.x;return load(samples,i/4u)[i%4u];
}
fn scalar(id:u32,p:vec3f)->f32 {
 let lo=load(blocks,id*3u).xyz;let hi=load(blocks,id*3u+1u).xyz;let dims=load(blocks,id*3u+2u).xyz;
 let q=(p-lo)/(hi-lo)*dims-0.5;
 if(u.scalar.w<0.5){return value(id,vec3i(floor(q+0.5)));}
 let cell=vec3i(floor(q));let t=fract(q);var result=0.0;
 for(var c=0u;c<8u;c++) {let b=vec3u(c&1u,(c>>1u)&1u,c>>2u);let f=select(1.0-t,t,b>vec3u(0u));let w=f.x*f.y*f.z;if(w>0.0){let v=value(id,cell+vec3i(b));if(missing(v)){return v;}result+=v*w;}}
 return result;
}
struct Out {@builtin(position) position:vec4f,@location(0) ndc:vec2f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {let p=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));var o:Out;o.position=vec4f(p[i],0.0,1.0);o.ndc=p[i];return o;}
@fragment fn fragment(in:Out)->@location(0) vec4f {
 let a=frame.inverse*vec4f(in.ndc,1.0,1.0);let b=frame.inverse*vec4f(in.ndc,0.000001,1.0);
 let world=a.xyz/a.w;let worldDir=normalize(b.xyz/b.w-world);let origin=(u.inverse*vec4f(world,1.0)).xyz;
 let raw=(u.inverse*vec4f(worldDir,0.0)).xyz;let speed=length(raw);let d=raw/speed;
 var cursor=0.0;var limit=1e30;let opaque=opaquePoint(in.position.xy,in.ndc);if(opaque.w>0.0){limit=dot(opaque.xyz-world,worldDir)*speed;}
 for(var k=0u;k<u32(u.size.y);k++){let plane=u.planes[k];let f=dot(plane.xyz,origin)+plane.w;let slope=dot(plane.xyz,d);if(abs(slope)<1e-20){if(f<0.0){discard;}}else if(slope>0.0){cursor=max(cursor,-f/slope);}else{limit=min(limit,-f/slope);}}
 let physicalSpeed=length(d*u.span.xyz);var total=vec4f(0.0);var peak=0.0;var hasPeak=false;
 for(var visit=0u;visit<u32(u.size.x) && cursor<limit;visit++) {
  var best=limit;var finish=limit;var block=-1;var index=0u;
  for(var n=0u;n<u32(u.size.x) && index<u32(u.size.x);n++) {
   let lo=load(nodes,index*2u);let hi=load(nodes,index*2u+1u);let hit=interval(origin,d,lo.xyz,hi.xyz,cursor,best);
   if(hit.high<=hit.low){index=u32(lo.w);continue;}
   index++;if(hi.w<=0.0){continue;}if(hit.low<best){best=hit.low;finish=interval(origin,d,lo.xyz,hi.xyz,cursor,limit).high;block=i32(hi.w)-1;}
  }
  if(block<0){break;}let id=u32(block);let lo=load(blocks,id*3u).xyz;let hi=load(blocks,id*3u+1u).xyz;let dims=load(blocks,id*3u+2u).xyz;
  let voxel=min(min((hi.x-lo.x)*u.span.x/dims.x,(hi.y-lo.y)*u.span.y/dims.y),(hi.z-lo.z)*u.span.z/dims.z);
  let count=max(1u,min(2048u,u32(ceil((finish-best)*physicalSpeed/voxel*u.options.y))));let ds=(finish-best)/f32(count);
  for(var i=0u;i<count;i++) {
   let p=origin+d*(best+(f32(i)+0.5)*ds);let v=scalar(id,p);if(missing(v)){continue;}if(hasPeak){peak=max(peak,v);}else{peak=v;hasPeak=true;}
   if(u.options.w>0.5){continue;}let tf=colourLookup(transfer,v);let alpha=1.0-pow(1.0-clamp(tf.a*u.options.z,0.0,1.0),ds*physicalSpeed/u.scalar.z);
   var rgb=tf.rgb;
   if(u.span.w>0.5){let delta=(hi-lo)/dims;let g=vec3f(scalar(id,p+vec3f(delta.x,0.0,0.0))-scalar(id,p-vec3f(delta.x,0.0,0.0)),scalar(id,p+vec3f(0.0,delta.y,0.0))-scalar(id,p-vec3f(0.0,delta.y,0.0)),scalar(id,p+vec3f(0.0,0.0,delta.z))-scalar(id,p-vec3f(0.0,0.0,delta.z)))/delta;
    if(dot(g,g)>1e-14){let normal=vec3f(dot(u.inverse[0].xyz,g),dot(u.inverse[1].xyz,g),dot(u.inverse[2].xyz,g));rgb=shade(rgb,normalize(normal),-worldDir);}}
   total+=vec4f(rgb*alpha,alpha)*(1.0-total.a);if(total.a>0.999){break;}
  }
  cursor=finish;if(total.a>0.999){break;}
 }
 if(u.options.w>0.5){if(!hasPeak){discard;}let tf=colourLookup(transfer,peak);return vec4f(toOutput(tf.rgb),clamp(tf.a*u.options.z,0.0,1.0));}
 if(total.a<1e-8){discard;}return vec4f(toOutput(total.rgb/total.a),total.a);
}
`;
