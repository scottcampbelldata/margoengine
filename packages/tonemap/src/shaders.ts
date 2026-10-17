// Color transforms from the references in ../NOTICE.md.
import { agxShader } from '../../shared/agx.js';
import { acesShader } from '../../shared/aces.js';
const common = `
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
`;
export const tonemapShader =
  common +
  `@fragment fn fragment(@builtin(position) pos:vec4f)->@location(0) vec4f {
  let source=textureLoad(scene,vec2i(pos.xy),0);var hdr=source.rgb;
  if(p.settings.x==1.0){hdr=acescgToSRGB(hdr);}
  hdr=max(hdr,vec3f(0))*exp2(p.grade.x);
  var color=agx(hdr);if(p.grade.z==1.0){color=aces(hdr);}else if(p.grade.z==2.0){color=neutral(hdr);}
  color=clamp((color-0.18)*p.grade.y+0.18,vec3f(0),vec3f(1));
  if(p.grade.w==1.0){color=sampleLUT(color);}
  color=clamp(color,vec3f(0),vec3f(1));
  return vec4f(select(color*12.92,1.055*pow(color,vec3f(1.0/2.4))-0.055,color>=vec3f(0.0031308)),source.a);
}`;

/**
 * Used under environment's ColorOutput (settings.y = peak relative to SDR white, settings.z = 1 for a P3 canvas).
 * `fragment` writes the SDR part exactly like tonemapShader's encoding; `excess` writes what lies outside 0..1 (linear
 * Rec.709: highlights up to the peak, negative components for colours outside sRGB), which ColorOutput adds back.
 * The curve below the 0.76 knee is the SDR one; above it Khronos PBR Neutral's rolloff aims at the peak instead of 1
 * (AgX and ACES are scaled by the same rolloff ratio of the brightest channel).
 */
export const outputShader =
  common +
  `
fn rolloff(x:f32,white:f32)->f32 {if(x<0.76){return x;}return white-(white-0.76)*(white-0.76)/(x+white-1.52);}
fn linearOutput(pos:vec4f)->vec4f {
  let source=textureLoad(scene,vec2i(pos.xy),0);var hdr=source.rgb;
  if(p.settings.x==1.0){hdr=acescgToSRGB(hdr);}
  hdr*=exp2(p.grade.x);
  // P3 canvas: clip to the P3 gamut instead of sRGB; what lies outside sRGB rides along as the negative part.
  if(p.settings.z==1.0){hdr=mat3x3f(1.224940,-0.042057,-0.019638,-0.224940,1.042057,-0.078636,0.0,0.0,1.098274)*
    max(mat3x3f(0.822462,0.033194,0.017083,0.177538,0.966806,0.072397,0.0,0.0,0.910520)*hdr,vec3f(0));}
  let positive=max(hdr,vec3f(0));let white=p.settings.y;let m=max(positive.r,max(positive.g,positive.b));
  var color:vec3f;
  if(p.grade.z==2.0){
    let x=min(positive.r,min(positive.g,positive.b));let offset=select(0.04,x-6.25*x*x,x<0.08);color=positive-offset;
    let peak=max(color.r,max(color.g,color.b));
    if(peak>=0.76){let newPeak=rolloff(peak,white);color*=newPeak/peak;color=mix(color,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
  }else{
    color=agx(positive);if(p.grade.z==1.0){color=aces(positive);}
    if(m>=0.76){color*=rolloff(m,white)/rolloff(m,1.0);}
  }
  color=clamp((color-0.18)*p.grade.y+0.18,vec3f(0),vec3f(white));
  if(p.grade.w==1.0){color=sampleLUT(min(color,vec3f(1)))+max(color-1.0,vec3f(0));}
  color=clamp(color,vec3f(0),vec3f(white));
  if(m>0.0){color+=min(hdr,vec3f(0))*(max(color.r,max(color.g,color.b))/m);}
  return vec4f(color,source.a);
}
@fragment fn fragment(@builtin(position) pos:vec4f)->@location(0) vec4f {
  let o=linearOutput(pos);let color=clamp(o.rgb,vec3f(0),vec3f(1));
  return vec4f(select(color*12.92,1.055*pow(color,vec3f(1.0/2.4))-0.055,color>=vec3f(0.0031308)),o.a);
}
@fragment fn excess(@builtin(position) pos:vec4f)->@location(0) vec4f {let o=linearOutput(pos);return vec4f(o.rgb-clamp(o.rgb,vec3f(0),vec3f(1)),0);}
`;

/** Select the texture's actual cube extent while retaining the original 33³ shader bytes for legacy inputs. */
export function sizedLUTShader(code: string): string {
  return code
    .replace(
      'fn sampleLUT(color:vec3f)->vec3f {',
      'fn sampleLUT(color:vec3f)->vec3f {\n  let edge=i32(textureDimensions(lut).x)-1;',
    )
    .replace('vec3f(1))*32.0;', 'vec3f(1))*f32(edge);')
    .replace('min(lo+1,vec3i(32))', 'min(lo+1,vec3i(edge))');
}
