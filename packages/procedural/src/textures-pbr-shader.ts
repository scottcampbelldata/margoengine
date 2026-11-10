import { textureShader } from './texture-shader.js';

// Reuse our existing periodic hash/interpolant, not an external shader library.
const noise = textureShader.slice(textureShader.indexOf('fn hash'), textureShader.indexOf('@compute'));
export const pbrShader = /* wgsl */ `
struct Params {
 size: vec2u, kind: u32, seed: u32,
 repeat: vec2f, detail: f32, grout: f32,
 color: vec4f, secondary: vec4f,
 offset: vec2f, stagger: f32, time: f32,
 normalStrength: f32, heightScale: f32, roughness: f32, roughnessVariation: f32,
}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var albedo: texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(2) var normals: texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(3) var roughness: texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(4) var height: texture_storage_2d<rgba8unorm,write>;
${noise}
fn encodeRGBA8(value:vec4f)->vec4f {return floor(clamp(value,vec4f(0),vec4f(1))*255.0+0.5)/255.0;}
fn field(inputUV: vec2f)->f32 {
 var uv=fract(inputUV);
 if p.kind==6u || p.kind==8u {uv=fract(uv+vec2f(p.time*0.03,p.time*0.09));}
 let n=(noise(uv,4u)*8.0+noise(uv,8u)*4.0+noise(uv,16u)*2.0+noise(uv,32u))/15.0;
 var value=n;
 if p.kind==1u || p.kind==2u {
  let row=u32(floor(uv.y*p.repeat.y));
  let shift=select(0.0,f32(row%2u)*p.stagger,p.kind==1u);
  let local=fract(uv*p.repeat+vec2f(shift,0));let edge=min(local,1.0-local);
  value=select(0.0,1.0,all(edge>=vec2f(p.grout)))*(1.0-p.detail*(1.0-n));
 }else if p.kind==3u {value=0.2+0.8*(0.5+0.5*cos(6.28318530718*(uv.x*p.repeat.x+p.detail*n)));
 }else if p.kind==4u {value=smoothstep(0.35-p.detail*0.2,0.65+p.detail*0.2,n);
 }else if p.kind==5u {value=pow(0.5+0.5*cos(6.28318530718*(uv.x*p.repeat.x+4.0*p.detail*n)),4.0);
 }else if p.kind==6u {value=smoothstep(0.25,0.75,n);
 }else if p.kind==7u {value=clamp(0.3*n+0.7*(0.5+0.5*sin(6.28318530718*(uv.x*p.repeat.x*3.0+p.detail*n*4.0))),0.0,1.0);
 }else if p.kind==8u {value=clamp((n-0.25)*2.0,0.0,1.0)*pow(0.5+0.5*cos(6.28318530718*inputUV.y),2.0);
 }else if p.kind==9u {
  let q=uv*p.repeat;let cell=vec2i(floor(q));let local=fract(q);var star=0.0;
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
   let delta=vec2i(x,y);let period=vec2i(p.repeat);let wrapped=vec2u(((cell+delta)%period+period)%period);
   let h=hash(wrapped);let center=vec2f(hash(wrapped+vec2u(71u,13u)),hash(wrapped+vec2u(19u,97u)));
   let distance=length(local-vec2f(delta)-center);
   let radius=0.035+0.08*h;
   let light=(1.0-smoothstep(0.0,radius,distance))*(0.75+0.25*cos(p.time+h*6.28318530718));
   star=max(star,select(0.0,light,h>0.65));
  }}value=star;
 }else if p.kind==10u {
  let lane=abs(fract(uv.x*p.repeat.x)-0.5);
  let dash=select(0.0,1.0,fract(uv.y*p.repeat.y)<0.5);
  value=select(n*0.12,1.0,lane<0.035 && dash>0.0);
 }
 return clamp(value,0.0,1.0);
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
 if any(id.xy>=p.size){return;}
 let uv=(vec2f(id.xy)+0.5)/vec2f(p.size)+p.offset;
 let h=field(uv);let step=1.0/vec2f(p.size);
 let dx=(field(uv+vec2f(step.x,0))-field(uv-vec2f(step.x,0)))*f32(p.size.x)*0.5*p.heightScale*p.normalStrength;
 let dy=(field(uv+vec2f(0,step.y))-field(uv-vec2f(0,step.y)))*f32(p.size.y)*0.5*p.heightScale*p.normalStrength;
 let normal=normalize(vec3f(-dx,-dy,1));
 let rough=clamp(p.roughness+(h-0.5)*p.roughnessVariation,0.0,1.0);
 textureStore(albedo,vec2i(id.xy),encodeRGBA8(vec4f(mix(p.secondary.rgb,p.color.rgb,h),1)));
 textureStore(normals,vec2i(id.xy),encodeRGBA8(vec4f(normal*0.5+0.5,1)));
 textureStore(roughness,vec2i(id.xy),encodeRGBA8(vec4f(vec3f(rough),1)));
 textureStore(height,vec2i(id.xy),encodeRGBA8(vec4f(vec3f(h*p.heightScale),1)));
}`;

// Exact area weights cover every NPOT source texel, including the last row/column.
export const pbrMipShader = /* wgsl */ `
struct Params { size:vec2u, sourceSize:vec2u, normal:u32, pad:u32, pad2:vec2u }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var source:texture_2d<f32>;
@group(0) @binding(2) var mipOutput:texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
 if any(id.xy>=p.size){return;}
 let lo=vec2f(id.xy)*vec2f(p.sourceSize)/vec2f(p.size);
 let hi=vec2f(id.xy+1u)*vec2f(p.sourceSize)/vec2f(p.size);
 let first=vec2u(floor(lo));var sum=vec4f(0);var weight=0.0;
 for(var y=0u;y<3u;y++){for(var x=0u;x<3u;x++){
  let at=first+vec2u(x,y);if any(at>=p.sourceSize){continue;}
  let area=max(vec2f(0),min(hi,vec2f(at+1u))-max(lo,vec2f(at)));
  let w=area.x*area.y;var color=textureLoad(source,vec2i(at),0);
  if p.normal==1u {color=vec4f(color.xyz*2.0-1.0,1);}
  sum+=color*w;weight+=w;
 }}
 var result=sum/weight;
 if p.normal==1u {result=vec4f(normalize(result.xyz)*0.5+0.5,1);}
 textureStore(mipOutput,vec2i(id.xy),floor(clamp(result,vec4f(0),vec4f(1))*255.0+0.5)/255.0);
}`;
