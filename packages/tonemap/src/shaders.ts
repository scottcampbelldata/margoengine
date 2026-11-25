// Color transforms from the references in ../NOTICE.md.
// ACEScg (AP1, D60) to linear sRGB: derived from the ACES S-2014-004 AP1 and BT.709 primaries with Bradford D60 to
// D65 adaptation. sRGB <-> Display P3: derived from the SMPTE EG 432-1 (D65) and BT.709 primaries. 3D LUT: Adobe Cube
// LUT Specification 1.0, trilinear lookup. Exposure exp2(stops). Contrast is a power about 18% grey,
// 0.18 (x / 0.18)^k: a slope of k in log2 exposure about the pivot, as contrast works in the log grading space ACEScc
// (Academy S-2014-003), so it never clips black. Until 2026-11-14 it was linear, (x - 0.18) k + 0.18, which sent every
// channel below 0.18 (1 - 1/k) to 0 (sRGB code 30 and under at k = 1.08): crushed, banded flat runs at night. Contrast
// 0 is flat 0.18, black included, as 0.18 * (x / 0.18) ** 0 is in JavaScript and IEEE 754 pow (x^0 = 1 for every x):
// pow(0, 0) itself is undefined in WGSL and GLSL ES 3.00, so it is never evaluated. sRGB:
// IEC 61966-2-1. HDR rolloff: Khronos PBR Neutral's compression aimed at the display peak (Margo derivation).
import { agxShader } from '../../shared/agx.js';
import { acesShader } from '../../shared/aces.js';
import { neutralShader } from '../../shared/display.js';
import { cleanShader } from '../../shared/finite.js';
const common = `
struct Params {grade:vec4f,domainMin:vec4f,domainMax:vec4f,settings:vec4f}
@group(0) @binding(0) var<uniform> p:Params;
fn margoContrast(c:vec3f,k:f32)->vec3f {if(k==1.0){return c;}if(k==0.0){return vec3f(0.18);}return 0.18*pow(max(c,vec3f(0))/0.18,vec3f(k));}
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var lut:texture_3d<f32>;
fn acescgToSRGB(v:vec3f)->vec3f {
  return mat3x3f(vec3f(1.705051,-0.130257,-0.024003),vec3f(-0.621792,1.140805,-0.128969),vec3f(-0.083259,-0.010548,1.152972))*v;
}
${acesShader}
${agxShader}
${neutralShader}${cleanShader}fn sampleLUT(color:vec3f)->vec3f {
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
  let source=textureLoad(scene,vec2i(pos.xy),0);var hdr=clean(source.rgb);
  if(p.settings.x==1.0){hdr=acescgToSRGB(hdr);}
  hdr=max(hdr,vec3f(0))*exp2(p.grade.x);
  var color:vec3f;if(p.grade.z==1.0){color=aces(hdr);}else if(p.grade.z==2.0){color=pbrNeutral(hdr);}else{color=agx(hdr);}
  color=clamp(margoContrast(color,p.grade.y),vec3f(0),vec3f(1));
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
  let source=textureLoad(scene,vec2i(pos.xy),0);var hdr=clean(source.rgb);
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
    if(p.grade.z==1.0){color=aces(positive);}else{color=agx(positive);}
    if(m>=0.76){color*=rolloff(m,white)/rolloff(m,1.0);}
  }
  color=clamp(margoContrast(color,p.grade.y),vec3f(0),vec3f(white));
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

/**
 * The classic curves, compiled in only when one is selected so the other shaders stay byte-identical: Reinhard
 * x / (1 + x) (Reinhard et al., "Photographic Tone Reproduction for Digital Images", 2002, the global operator per
 * channel); Cineon, the filmic fit of J. Hejl and R. Burgess-Dawson (GDC 2010), whose output includes a 2.2 display
 * gamma, so it is raised to 2.2 back to linear; linear, a clamp to 0..1. Codes 3, 4 and 5 of `p.grade.z`.
 */
export function classicShader(code: string): string {
  const classic = (x: string) =>
    `}else if(p.grade.z==3.0){color=${x}/(1.0+${x});}else if(p.grade.z==4.0){let f=max(${x}-0.004,vec3f(0));` +
    `color=pow(f*(6.2*f+0.5)/(f*(6.2*f+1.7)+0.06),vec3f(2.2));}else if(p.grade.z==5.0){color=min(${x},vec3f(1));}else{color=agx(${x});}`;
  return code
    .replace('}else{color=agx(hdr);}', classic('hdr'))
    .replace('}else{color=agx(positive);}', classic('positive'));
}

/**
 * White point, toe and shoulder, compiled in only when one is set (the shaders above stay byte-identical without them).
 * After the display curve and before contrast: the curve output is divided by the curve's own value at the white point
 * `W` (`p.domainMin.w`, 0 = off), so scene-linear `W` lands on exactly 1 and brighter values clip, as in Hable's
 * filmic curve (J. Hable, "Filmic Tonemapping Operators", filmicworlds.com, 2010: the page scales the curve by
 * 1 / curve(W)). The Reinhard curve takes the paper's own white point instead (Reinhard et al. 2002, Eq. 4,
 * Ld = L (1 + L / Lwhite^2) / (1 + L), written on the curve output c = L / (1 + L) as c (1 + c / ((1 - c) W^2))),
 * which is not the same curve as dividing x / (1 + x) by its value at W; then the cubic Hermite spline through (0, 0)
 * and (1, 1) whose slope at black is `toe` and whose slope at white is `shoulder` (`p.domainMax.w` and `p.settings.w`
 * hold each minus 1, so unset is 0). Monotone for both slopes in 0..3 (the slopes over the secant 1 are the alpha and beta of Fritsch and Carlson,
 * "Monotone Piecewise Cubic Interpolation", SIAM J. Numer. Anal. 17(2), 1980, https://doi.org/10.1137/0717021, whose
 * square 0..3 by 0..3 keeps a cubic monotone; tests/shape.test.js checks the derivative over the whole square).
 * `shapeCurve` is its CPU twin.
 */
export function shapeShader(code: string): string {
  const call = 'color=clamp(margoContrast(color,p.grade.y),';
  if (!code.includes(call) || !code.includes('fn margoContrast'))
    throw new RangeError('Tonemap shader has no contrast step to shape before; pass tonemapShader or outputShader.');
  return code
    .replace('fn margoContrast', shape + 'fn margoContrast')
    .split(call)
    .join('color=margoShape(color);\n  ' + call);
}
const shape = `fn margoCurveAt(x:vec3f)->vec3f {
  if(p.grade.z==1.0){return aces(x);}
  if(p.grade.z==2.0){return pbrNeutral(x);}
  if(p.grade.z==3.0){return x/(1.0+x);}
  if(p.grade.z==4.0){let f=max(x-0.004,vec3f(0));return pow(f*(6.2*f+0.5)/(f*(6.2*f+1.7)+0.06),vec3f(2.2));}
  if(p.grade.z==5.0){return min(x,vec3f(1));}
  return agx(x);
}
fn margoShape(c:vec3f)->vec3f {
  var x=c;
  let white=p.domainMin.w;
  if(white>0.0){
    if(p.grade.z==3.0){let w=max(white,0.01);x=x*(1.0+x/(max(vec3f(1)-x,vec3f(0.000001))*w*w));}
    else{x=x/max(margoCurveAt(vec3f(max(white,0.01))),vec3f(0.000001));}
  }
  x=clamp(x,vec3f(0),vec3f(1));
  let a=1.0+p.domainMax.w;let b=1.0+p.settings.w;
  if(a!=1.0||b!=1.0){let x2=x*x;let x3=x2*x;x=(x3-2.0*x2+x)*a+(3.0*x2-2.0*x3)+(x3-x2)*b;}
  return x;
}
`;
/**
 * The toe and shoulder spline of the display for one channel in 0..1: the cubic Hermite through (0, 0) and (1, 1) with
 * slope `toe` at 0 and `shoulder` at 1, each 0 to 3 (1 and 1 is the identity), as the shader evaluates it. Monotone for
 * every slope in that range (Fritsch and Carlson 1980).
 */
export function shapeCurve(x: number, toe = 1, shoulder = 1): number {
  const x2 = x * x,
    x3 = x2 * x;
  return (x3 - 2 * x2 + x) * toe + (3 * x2 - 2 * x3) + (x3 - x2) * shoulder;
}
