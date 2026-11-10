// Clean-room dual-phase advection. Local phase noise hides pulsing; phase offsets decorrelate the layers.
export function flowShader(binding: number): string {
  return `
struct FlowFrame { region:vec4f, motion:vec4f, settings:vec4f }
@group(0) @binding(${binding}) var<uniform> flowFrame:FlowFrame;
@group(0) @binding(${binding + 1}) var flowMap:texture_2d<f32>;
@group(0) @binding(${binding + 2}) var flowNormal0:texture_2d<f32>;
@group(0) @binding(${binding + 3}) var flowNormal1:texture_2d<f32>;
fn flowLookup(image:texture_2d<f32>,uv:vec2f,repeat:bool)->vec4f {
 let size=vec2i(textureDimensions(image));var p=uv*vec2f(size)-0.5;
 if(repeat){p=fract(uv)*vec2f(size)-0.5;}else{p=clamp(p,vec2f(0),vec2f(size-1));}
 let lo=vec2i(floor(p));let t=fract(p);var a=lo;var b=lo+1;
 if(repeat){a=((a%size)+size)%size;b=((b%size)+size)%size;}else{a=clamp(a,vec2i(0),size-1);b=clamp(b,vec2i(0),size-1);}
 return mix(mix(textureLoad(image,a,0),textureLoad(image,vec2i(b.x,a.y),0),t.x),mix(textureLoad(image,vec2i(a.x,b.y),0),textureLoad(image,b,0),t.x),t.y);
}
fn flowVector(xz:vec2f)->vec2f {
 let uv=(xz-flowFrame.region.xy)/flowFrame.region.zw;
 if(any(uv<vec2f(0))||any(uv>vec2f(1))){return vec2f(0);}
 let encoded=flowLookup(flowMap,uv,false).xy;
 return select(encoded*2.0-1.0,encoded,flowFrame.settings.x>0.5)*flowFrame.motion.y;
}
fn flowLayer(p:vec2f,phase:f32,vector:vec2f,second:bool)->vec2f {
 let uv=(p-vector*phase*flowFrame.motion.w)/flowFrame.motion.z;
 if(flowFrame.settings.y>0.5){
  var normal=flowLookup(flowNormal0,uv,true).xyz*2.0-1.0;
  if(second){normal=flowLookup(flowNormal1,uv+vec2f(0.371,0.613),true).xyz*2.0-1.0;}
  return -normal.xy/max(0.05,normal.z);
 }
 let offset=select(vec2f(0),vec2f(5.17,9.23),second);
 return noise(uv+offset).yz/flowFrame.motion.z;
}
fn flowingSlope(xz:vec2f)->vec2f {
 let vector=flowVector(xz);let phase=fract(flowFrame.motion.x/flowFrame.motion.w+noise(xz*0.037).x*0.25);
 let other=fract(phase+0.5);let blend=1.0-abs(phase*2.0-1.0);
 return (flowLayer(xz,phase,vector,false)*blend+flowLayer(xz,other,vector,true)*(1.0-blend))*flowFrame.settings.z*min(1.0,length(vector));
}
fn flowingNormal(xz:vec2f,footprint:f32)->vec3f {
 let slope=flowingSlope(xz)*(1.0-smoothstep(0.25,1.0,footprint/flowFrame.motion.z));
 return vec3f(-slope.x,0,-slope.y);
}
`;
}
