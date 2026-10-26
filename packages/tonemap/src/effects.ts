import { MargoError } from '@margoengine/math/errors';
// Optional grading extras, compiled in only when an option asks for them so the default shaders stay byte-identical.
// White balance: Kim et al. (2002) cubic-spline fit of the Planckian locus in CIE xy, then the CIE XYZ to linear
// Rec.709 matrix. Vignette: radial smoothstep. Grain: PCG integer hash (Jarzynski and Olano, 2020), animated per frame.
// Chromatic aberration: radial red/blue channel offset. Auto-exposure: log-average luminance metering with
// exponential adaptation (the usual "18% grey" key-value method).

/** Auto-exposure (eye adaptation) settings; setting `TonemapOptions.autoExposure` to an object or `true` enables it. */
export interface AutoExposure {
  /** Lowest exposure the metering may apply, in stops. Default -4. */
  min?: number;
  /** Highest exposure the metering may apply, in stops. Default 4. */
  max?: number;
  /** Adaptation speed in 1/seconds; higher is quicker. Default 1.5 (about 0.5 s to settle most of the way). */
  speed?: number;
  /** Extra stops added to the metered exposure, e.g. 0.5 for a brighter look. Default 0. */
  compensation?: number;
}

/** Kelvin value that leaves the image unchanged. */
export const NEUTRAL_TEMPERATURE = 6500;

function planckian(kelvin: number): [number, number, number] {
  const t = Math.min(25000, Math.max(1667, kelvin)),
    x =
      t <= 4000
        ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991
        : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039,
    y =
      t <= 2222
        ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
        : t <= 4000
          ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
          : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483,
    X = x / y,
    Z = (1 - x - y) / y;
  return [
    3.2404542 * X - 1.5371385 - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 + 0.041556 * Z,
    0.0556434 * X - 0.2040259 + 1.0572252 * Z,
  ];
}

/**
 * Linear RGB gain that makes a scene lit at `temperature` Kelvin (and `tint`, -1 green to 1 magenta) look neutral, like
 * a camera's white-balance setting: a low temperature cools the picture, a high one warms it. The gain keeps luminance
 * and is exactly (1, 1, 1) at 6500 K with no tint.
 * @throws RangeError for a temperature outside 1667-25000 K or a tint outside -1..1.
 */
export function whiteBalanceGain(temperature = NEUTRAL_TEMPERATURE, tint = 0): [number, number, number] {
  if (
    !Number.isFinite(temperature) ||
    temperature < 1667 ||
    temperature > 25000 ||
    !Number.isFinite(tint) ||
    tint < -1 ||
    tint > 1
  )
    throw new RangeError('Tonemap white balance needs a temperature of 1667-25000 K and a tint of -1 to 1');
  const ref = planckian(NEUTRAL_TEMPERATURE),
    now = planckian(temperature),
    gain: [number, number, number] = [ref[0] / now[0], ref[1] / now[1], ref[2] / now[2]];
  gain[1] *= 1 - 0.25 * tint;
  const norm = (0.2126 * ref[0] + 0.7152 * ref[1] + 0.0722 * ref[2]) / ref[1];
  // Rescale so the white point keeps its luminance (identity stays exactly 1).
  const lum = (0.2126 * gain[0] + 0.7152 * gain[1] + 0.0722 * gain[2]) / norm;
  return temperature === NEUTRAL_TEMPERATURE && tint === 0 ? [1, 1, 1] : [gain[0] / lum, gain[1] / lum, gain[2] / lum];
}

/** True when any extra needs the effects shader variant. */
export function usesEffects(o: {
  temperature?: number;
  tint?: number;
  vignette?: number;
  grain?: number;
  chromaticAberration?: number;
  autoExposure?: unknown;
}): boolean {
  return !!(
    (o.temperature !== undefined && o.temperature !== NEUTRAL_TEMPERATURE) ||
    o.tint ||
    o.vignette ||
    o.grain ||
    o.chromaticAberration ||
    o.autoExposure
  );
}

const FX = `
struct Fx {wb:vec4f,vig:vec4f,rect:vec4f,time:vec4f}
@group(0) @binding(3) var<uniform> fx:Fx;
fn fxPcg(v:u32)->u32 {let s=v*747796405u+2891336375u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn fxNoise(pos:vec2f)->f32 {
  let h=fxPcg(u32(pos.x)+fxPcg(u32(pos.y)+fxPcg(u32(fx.time.x))));return f32(h)/4294967295.0-0.5;
}
fn fxFetch(pos:vec4f)->vec4f {
  let size=vec2i(textureDimensions(scene))-1;
  if(fx.vig.w==0.0){return textureLoad(scene,vec2i(pos.xy),0);}
  let d=(pos.xy-fx.rect.xy)/fx.rect.zw-0.5;let o=d*fx.vig.w*fx.rect.zw;
  let g=textureLoad(scene,vec2i(pos.xy),0);
  let r=textureLoad(scene,clamp(vec2i(pos.xy+o),vec2i(0),size),0).r;
  let b=textureLoad(scene,clamp(vec2i(pos.xy-o),vec2i(0),size),0).b;
  return vec4f(r,g.g,b,g.a);
}
fn fxFinish(c:vec3f,pos:vec4f,white:f32)->vec3f {
  var color=c;
  if(fx.wb.w>0.0){
    let d=(pos.xy-fx.rect.xy)/fx.rect.zw*2.0-1.0;let r=length(d)*0.70710678;
    color*=1.0-fx.wb.w*smoothstep(fx.vig.x,fx.vig.x+fx.vig.y,r);
  }
  if(fx.vig.z>0.0){
    let l=clamp(dot(color,vec3f(0.2126,0.7152,0.0722))/white,0.0,1.0);
    color+=fxNoise(pos.xy)*fx.vig.z*0.2*white*(1.0-0.6*abs(2.0*l-1.0));
  }
  return color;
}
`;

function swap(code: string, from: string, to: string): string {
  if (!code.includes(from))
    throw new MargoError('failed', 'Tonemap effects patch target missing; update effects.ts to match the shader');
  return code.replace(from, to);
}

/**
 * The effects variant of a tonemap shader (`tonemapShader`, `outputShader` or their sized-LUT forms): adds binding 3
 * (the {@link Fx} uniform), white balance before exposure, chromatic aberration when sampling, and vignette and grain
 * last. With `auto`, exposure also adds the metered stops from binding 4 (read-only storage).
 */
export function effectsShader(code: string, auto: boolean): string {
  let out = swap(code, 'struct Params', FX + 'struct Params');
  if (auto)
    out = swap(
      out,
      '@group(0) @binding(3) var<uniform> fx:Fx;',
      '@group(0) @binding(3) var<uniform> fx:Fx;\n@group(0) @binding(4) var<storage,read> ae:array<f32,2>;',
    );
  const stops = auto ? 'p.grade.x+ae[0]' : 'p.grade.x';
  out = out.split('let source=textureLoad(scene,vec2i(pos.xy),0);').join('let source=fxFetch(pos);');
  if (out.includes('hdr=max(hdr,vec3f(0))*exp2(p.grade.x);'))
    out = swap(out, 'hdr=max(hdr,vec3f(0))*exp2(p.grade.x);', `hdr=max(hdr,vec3f(0))*fx.wb.xyz*exp2(${stops});`);
  if (out.includes('hdr*=exp2(p.grade.x);')) out = swap(out, 'hdr*=exp2(p.grade.x);', `hdr*=fx.wb.xyz*exp2(${stops});`);
  if (out.includes('  color=clamp(color,vec3f(0),vec3f(1));\n  return vec4f(select'))
    out = swap(
      out,
      '  color=clamp(color,vec3f(0),vec3f(1));\n  return vec4f(select',
      '  color=clamp(fxFinish(color,pos,1.0),vec3f(0),vec3f(1));\n  return vec4f(select',
    );
  if (out.includes('  color=clamp(color,vec3f(0),vec3f(white));\n  if(m>0.0)'))
    out = swap(
      out,
      '  color=clamp(color,vec3f(0),vec3f(white));\n  if(m>0.0)',
      '  color=clamp(fxFinish(color,pos,white),vec3f(0),vec3f(white));\n  if(m>0.0)',
    );
  if (!out.includes('fxFinish(color'))
    throw new MargoError(
      'failed',
      'Tonemap effects patch found no output stage; update effects.ts to match the shader',
    );
  return out;
}

/** WGSL compute shader that meters log-average luminance over the view rectangle and adapts the stored exposure. */
export const meterShader = `
struct Meter {rect:vec4f,params:vec4f}
@group(0) @binding(0) var<uniform> m:Meter;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var<storage,read_write> st:array<f32,2>;
var<workgroup> sums:array<f32,256>;
@compute @workgroup_size(256) fn main(@builtin(local_invocation_index) i:u32) {
  let tx=i%16u;let ty=i/16u;var acc=0.0;
  for(var k=0u;k<16u;k++){
    let sx=(f32(tx*4u+(k%4u))+0.5)/64.0;let sy=(f32(ty*4u+(k/4u))+0.5)/64.0;
    let c=textureLoad(scene,vec2i(m.rect.xy+vec2f(sx,sy)*m.rect.zw),0).rgb;
    var l=dot(max(c,vec3f(0)),vec3f(0.2126,0.7152,0.0722));
    l=select(65000.0,l,l<65000.0);
    acc+=clamp(log2(max(l,0.0001)),-12.0,12.0);
  }
  sums[i]=acc;workgroupBarrier();
  for(var s=128u;s>0u;s>>=1u){if(i<s){sums[i]+=sums[i+s];}workgroupBarrier();}
  if(i==0u){
    let want=clamp(log2(0.18)-sums[0]/4096.0+m.params.w,m.params.x,m.params.y);
    if(st[1]==0.0){st[0]=want;st[1]=1.0;}else{st[0]+=(want-st[0])*m.params.z;}
  }
}`;
