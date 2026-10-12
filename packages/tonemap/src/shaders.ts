// Color transforms adapted from the references and licenses in ../NOTICE.md.
import {agxShader} from '../../shared/agx.js';
import {acesShader} from '../../shared/aces.js';
export const tonemapShader = `
struct Params {grade:vec4f,domainMin:vec4f,domainMax:vec4f,settings:vec4f}
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var lut:texture_3d<f32>;
fn acescgToSRGB(v:vec3f)->vec3f {
  return mat3x3f(vec3f(1.705051,-0.130257,-0.024003),vec3f(-0.621792,1.140805,-0.128969),vec3f(-0.083259,-0.010548,1.152972))*v;
}
${acesShader}
${agxShader}
fn neutral(input:vec3f)->vec3f {
  let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var color=input-offset;
  let peak=max(color.r,max(color.g,color.b));if(peak<0.76){return color;}
  let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);color*=newPeak/peak;
  let desaturation=1.0-1.0/(0.15*(peak-newPeak)+1.0);return mix(color,vec3f(newPeak),desaturation);
}
fn sampleLUT(color:vec3f)->vec3f {
  let uv=clamp((color-p.domainMin.xyz)/(p.domainMax.xyz-p.domainMin.xyz),vec3f(0),vec3f(1))*32.0;
  let lo=vec3i(floor(uv));let hi=min(lo+1,vec3i(32));let t=fract(uv);
  let z0=mix(mix(textureLoad(lut,lo,0).rgb,textureLoad(lut,vec3i(hi.x,lo.y,lo.z),0).rgb,t.x),
    mix(textureLoad(lut,vec3i(lo.x,hi.y,lo.z),0).rgb,textureLoad(lut,vec3i(hi.x,hi.y,lo.z),0).rgb,t.x),t.y);
  let z1=mix(mix(textureLoad(lut,vec3i(lo.x,lo.y,hi.z),0).rgb,textureLoad(lut,vec3i(hi.x,lo.y,hi.z),0).rgb,t.x),
    mix(textureLoad(lut,vec3i(lo.x,hi.y,hi.z),0).rgb,textureLoad(lut,hi,0).rgb,t.x),t.y);
  return mix(z0,z1,t.z);
}
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let xy=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(xy[i],0,1);
}
@fragment fn fragment(@builtin(position) pos:vec4f)->@location(0) vec4f {
  let source=textureLoad(scene,vec2i(pos.xy),0);var hdr=source.rgb;
  if(p.settings.x==1.0){hdr=acescgToSRGB(hdr);}
  hdr=max(hdr,vec3f(0))*exp2(p.grade.x);
  var color=agx(hdr);if(p.grade.z==1.0){color=aces(hdr);}else if(p.grade.z==2.0){color=neutral(hdr);}
  color=clamp((color-0.18)*p.grade.y+0.18,vec3f(0),vec3f(1));
  if(p.grade.w==1.0){color=sampleLUT(color);}
  color=clamp(color,vec3f(0),vec3f(1));
  return vec4f(select(color*12.92,1.055*pow(color,vec3f(1.0/2.4))-0.055,color>=vec3f(0.0031308)),source.a);
}`;
