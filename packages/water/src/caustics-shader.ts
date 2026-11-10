import { fullscreen } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';
import type { QueryState } from './query-state.js';

// The first 20 vectors preserve SurfaceCapture's camera/field contract.
const frame = `@group(0) @binding(0) var<uniform> u:array<vec4f,24>;
fn inverseCamera()->mat4x4f{return mat4x4f(u[4],u[5],u[6],u[7]);}
fn world(pixel:vec2f,z:f32)->vec3f{
 let q=inverseCamera()*vec4f((pixel-u[14].xy)/u[14].zw*vec2f(2,-2)+vec2f(-1,1),z,1);
 return q.xyz/q.w;
}`;

export function causticBeams(state: QueryState, shadows: string): string {
  const water = state.kind === 'water';
  return (
    state.shader +
    `
@group(1) @binding(0) var<uniform> caustic:array<vec4f,24>;
${water ? '@group(1) @binding(1) var<storage,read> coordinates:array<f32>;' : ''}
${shadows}
struct Sample {position:vec3f,normal:vec3f,base:vec2f}
fn causticSample(id:u32)->Sample {
 let cell=id/6u;let corner=array<vec2u,6>(vec2u(0,0),vec2u(0,1),vec2u(1,0),vec2u(1,0),vec2u(0,1),vec2u(1,1))[id%6u];
 let grid=vec2u(cell%${state.segments}u,cell/${state.segments}u)+corner;
 ${
   water
     ? `let index=grid.y*${state.segments + 1}u+grid.x;
 var base=vec2f(coordinates[index*3u],coordinates[index*3u+1u]);if(HORIZON){base+=frame.grid.xy;}
 let wave=surface(base,coordinates[index*3u+2u]);return Sample(wave.position,wave.normal,base);`
     : `let base=vec2f(grid)/f32(${state.segments})*frame.grid.xy-frame.grid.xy*0.5+frame.water.zw;
 let wave=oceanAt(base);return Sample(vec3f(base.x,frame.water.x,base.y)+wave.displacement,wave.normal,base);`
 }
}
fn drySample(base:vec2f)->bool {${water ? 'if(inCoast(base)){let s=coastal(base);return select(s.water.x<0.003,s.edge<=0.0,STILL);}' : ''}return false;}
fn fresnel(cosine:f32,eta:f32)->f32 {
 let t=sqrt(max(0.0,1.0-eta*eta*(1.0-cosine*cosine)));
 let s=(eta*cosine-t)/max(0.000001,eta*cosine+t);
 let p=(cosine-eta*t)/max(0.000001,cosine+eta*t);return (s*s+p*p)*0.5;
}
struct Beam {
 @builtin(position) clip:vec4f,@location(0) source:vec3f,@location(1) normal:vec3f,
 @location(2) @interpolate(flat) direction:vec3f,@location(3) @interpolate(flat) flux:f32,
 @location(4) @interpolate(flat) distance:f32,@location(5) base:vec2f
}
@group(1) @binding(2) var<storage,read> range:array<f32>;
@vertex fn beamVertex(@builtin(vertex_index) id:u32,@builtin(instance_index) layer:u32)->Beam {
 let triangle=id/6u*3u;let a=causticSample(triangle);let b=causticSample(triangle+1u);let c=causticSample(triangle+2u);
 let samples=array<Sample,3>(a,b,c);let level=mix(caustic[20].x,caustic[20].y,f32(layer)/(caustic[20].z-1.0));
 let light=caustic[12].xyz;let eta=1.0/caustic[21].x;
 var destinations:array<vec3f,3>;var direction=vec3f(0);var transmission=0.0;var distance=0.0;var valid=light.y>0.0;
 for(var i=0u;i<3u;i++){
  let n=normalize(samples[i].normal);let cosine=max(0.0,dot(n,light));
  let ray=refract(-light,n,eta);let path=(level-samples[i].position.y)/min(-0.000001,ray.y);
  valid=valid&&cosine>0.0&&ray.y<0.0&&!drySample(samples[i].base);
  // Extend the field through slices above an entry point. Receivers are still
  // wet-masked against the drawn interface; dropping these virtual samples
  // makes interpolation fade valid near-surface illumination toward zero.
  destinations[i]=samples[i].position+ray*path;
  direction+=ray/3.0;transmission+=(1.0-fresnel(cosine,eta))/3.0;distance+=max(0.0,path)/3.0;
 }
 let area=abs(cross(destinations[1]-destinations[0],destinations[2]-destinations[0]).y);
 let source=abs(dot(cross(b.position-a.position,c.position-a.position),light));
 let texel=2.0*caustic[12].w/caustic[21].y;
 let corner=array<u32,6>(0u,1u,2u,0u,2u,2u)[id%6u];
 let chosen=samples[corner];let position=destinations[corner];
 var clip=vec4f((position.xz-caustic[8].xz)/caustic[12].w*vec2f(1,-1),0,1);var denominator=area;
 if(area<texel*texel){
  // Unresolved triangles, including an exact line/point focus, carry finite
  // flux. Rasterize a pixel-aligned box and normalize by its full area; merely
  // flooring the denominator leaves a collapsed primitive with zero coverage.
  let p=(destinations[0].xz-caustic[8].xz)/texel+caustic[21].y*0.5;
  let q=(destinations[1].xz-caustic[8].xz)/texel+caustic[21].y*0.5;
  let r=(destinations[2].xz-caustic[8].xz)/texel+caustic[21].y*0.5;
  let low=floor(min(p,min(q,r)));let high=max(low+1.0,ceil(max(p,max(q,r))));
  let corners=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  clip=vec4f(mix(low,high,corners[id%6u])/caustic[21].y*vec2f(2,-2)+vec2f(-1,1),0,1);
  denominator=2.0*(high.x-low.x)*(high.y-low.y)*texel*texel;
 }
 let density=select(0.0,source*transmission/denominator,valid)/range[0];
 return Beam(clip,chosen.position,chosen.normal,direction,density,distance,chosen.base);
}

struct Flux { @location(0) red:vec4f,@location(1) green:vec4f,@location(2) blue:vec4f }
@fragment fn beamFragment(v:Beam)->Flux {
 if(drySample(v.base)){discard;}
 let visibility=${shadows ? 'shadowLit(vec3f(1),v.source+normalize(v.normal)*0.01,normalize(v.normal))' : '1.0'};
 let vector=-v.direction/max(0.000001,-v.direction.y)*v.flux*visibility;
 let attenuation=exp(-caustic[22].rgb*v.distance);
 return Flux(vec4f(vector*attenuation.r,0),vec4f(vector*attenuation.g,0),vec4f(vector*attenuation.b,0));
}`
  );
}

// A conservative total-flux bound keeps every additive half-float component
// representable. No radiance is clipped; the projector restores the same scale.
export function causticRange(state: QueryState): string {
  const count = state.segments * state.segments * 2;
  const groups = Math.ceil(count / 64);
  return (
    causticBeams(state, '').split('struct Beam')[0] +
    `
@group(1) @binding(2) var<storage,read_write> range:array<f32>;
var<workgroup> sums:array<f32,64>;
@compute @workgroup_size(64) fn measure(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) group:vec3u){
 var weight=0.0;
 if(id.x<${count}u){
  let a=causticSample(id.x*3u);let b=causticSample(id.x*3u+1u);let c=causticSample(id.x*3u+2u);
  let eta=1.0/caustic[21].x;let light=caustic[12].xyz;
  let na=normalize(a.normal);let nb=normalize(b.normal);let nc=normalize(c.normal);
  let ra=refract(-light,na,eta);let rb=refract(-light,nb,eta);let rc=refract(-light,nc,eta);
  let direction=(ra+rb+rc)/3.0;
  let texel=2.0*caustic[12].w/caustic[21].y;
  if(light.y>0.0&&min(dot(na,light),min(dot(nb,light),dot(nc,light)))>0.0&&max(ra.y,max(rb.y,rc.y))<0.0&&!drySample(a.base)&&!drySample(b.base)&&!drySample(c.base)){
   weight=abs(dot(cross(b.position-a.position,c.position-a.position),light))/(texel*texel*max(0.000001,-direction.y));
  }
 }
 sums[lane]=weight;workgroupBarrier();
 for(var stride=32u;stride>0u;stride/=2u){if(lane<stride){sums[lane]+=sums[lane+stride];}workgroupBarrier();}
 if(lane==0u){range[group.x]=sums[0];}
}
@compute @workgroup_size(64) fn reduce(@builtin(local_invocation_index) lane:u32){
 var sum=0.0;for(var i=lane;i<${groups}u;i+=64u){sum+=range[i];}
 sums[lane]=sum;workgroupBarrier();
 for(var stride=32u;stride>0u;stride/=2u){if(lane<stride){sums[lane]+=sums[lane+stride];}workgroupBarrier();}
 if(lane==0u){range[0]=max(1.0,sums[0]/32752.0);}
}`
  );
}

export const causticProject = (shadows: string) =>
  fullscreen +
  frame +
  `
@group(0) @binding(1) var opaque:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
@group(0) @binding(3) var red:texture_2d_array<f32>;
@group(0) @binding(4) var green:texture_2d_array<f32>;
@group(0) @binding(5) var blue:texture_2d_array<f32>;
@group(0) @binding(6) var field:texture_2d<f32>;
@group(0) @binding(7) var linear:sampler;
@group(0) @binding(8) var<storage,read> range:array<f32>;
${shadows}
fn flux(map:texture_2d_array<f32>,uv:vec2f,layer:f32)->vec3f {
 let lo=i32(floor(layer));let hi=min(lo+1,i32(u[20].z)-1);
 return mix(textureSampleLevel(map,linear,uv,lo,0).xyz,textureSampleLevel(map,linear,uv,hi,0).xyz,fract(layer));
}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let pixel=vec2i(at.xy);let color=textureLoad(opaque,pixel,0);let z=textureLoad(depth,pixel,0);
 if(z<=0.0||u[20].w==0.0){return vec4f(0);}
 let p=world(at.xy,z);let uv=(p.xz-u[8].xz)/(2.0*u[12].w)+0.5;
 if(any(uv<vec2f(0))||any(uv>=vec2f(1))||p.y<u[20].x||p.y>u[20].y){return vec4f(0);}
 let wet=textureLoad(field,vec2i(uv*vec2f(textureDimensions(field))),0);
 if(wet.y==0.0||p.y>=wet.w){return vec4f(0);}
 // Use the closer depth neighbour on each axis to avoid crossing a silhouette.
 let low=vec2i(u[14].xy);let high=vec2i(u[14].xy+u[14].zw)-1;
 let left=max(pixel-vec2i(1,0),low);let right=min(pixel+vec2i(1,0),high);
 let up=max(pixel-vec2i(0,1),low);let down=min(pixel+vec2i(0,1),high);
 let zl=textureLoad(depth,left,0);let zr=textureLoad(depth,right,0);let zu=textureLoad(depth,up,0);let zd=textureLoad(depth,down,0);
 let px=select(left,right,abs(zr-z)<=abs(zl-z));let py=select(up,down,abs(zd-z)<=abs(zu-z));
 let dx=(world(vec2f(px)+0.5,textureLoad(depth,px,0))-p)*f32(px.x-pixel.x);
 let dy=(world(vec2f(py)+0.5,textureLoad(depth,py,0))-p)*f32(py.y-pixel.y);
 let crossNormal=cross(dy,dx);let size=length(crossNormal);if(size==0.0){return vec4f(0);}
 let normal=crossNormal/size;let layer=(p.y-u[20].x)/(u[20].y-u[20].x)*(u[20].z-1.0);
 let illumination=max(vec3f(0),vec3f(dot(normal,flux(red,uv,layer)),dot(normal,flux(green,uv,layer)),dot(normal,flux(blue,uv,layer))));
 let visibility=${shadows ? 'shadowLit(vec3f(1),p,normal)' : '1.0'};
 return vec4f(color.rgb*illumination*range[0]*u[13].rgb*u[13].w*u[23].rgb*u[20].w*visibility,0);
}`;

export const causticCopy = (encode: boolean) =>
  fullscreen +
  (encode ? displayShader : '') +
  `
@group(0) @binding(0) var image:texture_2d<f32>;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{
 let color=textureLoad(image,vec2i(p.xy),0);return vec4f(${encode ? 'toDisplay(color.rgb)' : 'color.rgb'},color.a);
}`;
