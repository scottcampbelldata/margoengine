import { MargoError } from '@margoengine/math/errors';
// Optional grading extras, compiled in only when an option asks for them so the default shaders stay byte-identical.
// White balance: Kim et al. (2002) cubic-spline fit of the Planckian locus in CIE xy, then the CIE XYZ to linear
// Rec.709 matrix. Vignette: radial smoothstep. Grain: PCG integer hash (Jarzynski and Olano, 2020), animated per frame.
// Chromatic aberration: radial red/blue channel offset. Auto-exposure: log-average luminance metering with
// exponential adaptation (the "18% grey" key value of Reinhard et al. 2002), weighted evenly, by a centre Gaussian, a
// spot disc or a mask, optionally through a percentile-trimmed histogram of log luminance.

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
  /**
   * How the samples become one level: `'mean'` (default) is the weighted log-average luminance; `'histogram'` sorts
   * the weighted samples into 64 bins of log2 luminance (-12 to 12) and averages only those between `percentiles`, so
   * a small light or a dark corner does not swing the exposure.
   */
  method?: 'mean' | 'histogram';
  /** The share of the weighted samples the histogram keeps, darkest first, 0 to 1 with low below high. Default [0.1, 0.9]. */
  percentiles?: readonly [number, number];
  /**
   * Where the meter looks: `'average'` (default) weighs the whole view evenly; `'center'` weighs by a Gaussian of the
   * distance from the view centre (sigma a quarter of the view height); `'spot'` meters only the disc `spot`; `'mask'`
   * weighs each sample by the red channel of `mask`, stretched over the view.
   */
  metering?: 'average' | 'center' | 'spot' | 'mask';
  /** The spot of `'spot'` metering: centre `x`, `y` as fractions of the view (default 0.5) and `radius` as a fraction of its shorter side (default 0.05). */
  spot?: { x?: number; y?: number; radius?: number };
  /** Weight texture of `'mask'` metering (any size, filterable float or unorm; red channel 0 to 1). */
  mask?: GPUTexture;
}

const METHODS = ['mean', 'histogram'],
  METERING = ['average', 'center', 'spot', 'mask'];
const inside = (v: number | undefined, lo: number, hi: number) =>
  v === undefined || (Number.isFinite(v) && v >= lo && v <= hi);
/** True when the metering options of `a` are valid (the ranges of min, max, speed and compensation are checked by Tonemap). */
export function validMetering(a: AutoExposure): boolean {
  const p = a.percentiles,
    s = a.spot;
  return (
    (a.method === undefined || METHODS.includes(a.method)) &&
    (a.metering === undefined || METERING.includes(a.metering)) &&
    (p === undefined ||
      (Array.isArray(p) && p.length === 2 && inside(p[0], 0, 1) && inside(p[1], 0, 1) && p[0] < p[1])) &&
    (s === undefined ||
      (typeof s === 'object' && inside(s.x, 0, 1) && inside(s.y, 0, 1) && inside(s.radius, 1e-3, 1))) &&
    (a.metering !== 'mask' || typeof (a.mask as { createView?: unknown } | undefined)?.createView === 'function')
  );
}

/**
 * Writes the meter uniform (16 floats): view rect; min, max, adaptation factor, compensation; method, weighting, low
 * and high percentile; the sampled domain in pixels (the view, or the spot's square).
 */
export function meterValues(out: Float32Array, rect: readonly number[], a: AutoExposure, adapt: number): Float32Array {
  out.set(rect, 0);
  out[4] = a.min ?? -4;
  out[5] = a.max ?? 4;
  out[6] = adapt;
  out[7] = a.compensation ?? 0;
  out[8] = +(a.method === 'histogram');
  out[9] = METERING.indexOf(a.metering ?? 'average');
  out[10] = a.percentiles?.[0] ?? 0.1;
  out[11] = a.percentiles?.[1] ?? 0.9;
  if (a.metering === 'spot') {
    const r = (a.spot?.radius ?? 0.05) * Math.min(rect[2], rect[3]);
    out[12] = rect[0] + (a.spot?.x ?? 0.5) * rect[2] - r;
    out[13] = rect[1] + (a.spot?.y ?? 0.5) * rect[3] - r;
    out[14] = out[15] = 2 * r;
  } else out.set(rect, 12);
  return out;
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

/**
 * WGSL compute shader that meters the view into the adapted-exposure buffer: 4,096 samples on a 64 by 64 grid over the
 * domain (the view, or the spot's square), each weighted (even, centre Gaussian, spot disc or mask), then either the
 * weighted mean of log2 luminance or the weighted mean of the histogram bins between the two percentiles. Zero total
 * weight (an empty mask) keeps the previous exposure.
 */
export const meterShader = `
struct Meter {rect:vec4f,params:vec4f,mode:vec4f,domain:vec4f}
@group(0) @binding(0) var<uniform> m:Meter;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var<storage,read_write> st:array<f32,2>;
@group(0) @binding(3) var mask:texture_2d<f32>;
var<workgroup> sums:array<vec2f,256>;
var<workgroup> bins:array<atomic<u32>,64>;
@compute @workgroup_size(256) fn main(@builtin(local_invocation_index) i:u32) {
  if(i<64u){atomicStore(&bins[i],0u);}
  workgroupBarrier();
  let tx=i%16u;let ty=i/16u;var acc=vec2f(0);
  for(var k=0u;k<16u;k++){
    let uv=vec2f((f32(tx*4u+(k%4u))+0.5)/64.0,(f32(ty*4u+(k/4u))+0.5)/64.0);
    let pix=clamp(m.domain.xy+uv*m.domain.zw,m.rect.xy,m.rect.xy+m.rect.zw-1.0);
    let c=textureLoad(scene,vec2i(pix),0).rgb;
    var l=dot(max(c,vec3f(0)),vec3f(0.2126,0.7152,0.0722));
    l=select(65000.0,l,l<65000.0);
    let v=clamp(log2(max(l,0.0001)),-12.0,12.0);
    var w=1.0;
    if(m.mode.y==1.0){let d=(pix-m.rect.xy-0.5*m.rect.zw)/m.rect.w;w=exp(-8.0*dot(d,d));}
    else if(m.mode.y==2.0){w=select(0.0,1.0,length(uv-0.5)<=0.5);}
    else if(m.mode.y==3.0){
      let size=vec2f(textureDimensions(mask));
      w=clamp(textureLoad(mask,vec2i(min((pix-m.rect.xy)/m.rect.zw*size,size-1.0)),0).r,0.0,1.0);
    }
    acc+=vec2f(w*v,w);
    if(m.mode.x==1.0){atomicAdd(&bins[min(u32((v+12.0)/24.0*64.0),63u)],u32(w*256.0+0.5));}
  }
  sums[i]=acc;workgroupBarrier();
  for(var s=128u;s>0u;s>>=1u){if(i<s){sums[i]+=sums[i+s];}workgroupBarrier();}
  if(i==0u){
    var total=sums[0].y;var level=sums[0].x/max(total,1e-12);
    if(m.mode.x==1.0){
      var count=0u;for(var b=0u;b<64u;b++){count+=atomicLoad(&bins[b]);}
      let lo=f32(count)*m.mode.z;let hi=f32(count)*m.mode.w;var below=0.0;var kept=0.0;var sum=0.0;
      for(var b=0u;b<64u;b++){
        let n=f32(atomicLoad(&bins[b]));let part=min(hi,below+n)-max(lo,below);
        if(part>0.0){kept+=part;sum+=part*(-12.0+(f32(b)+0.5)*0.375);}
        below+=n;
      }
      total=kept;level=sum/max(kept,1e-12);
    }
    if(total>0.0){
      let want=clamp(log2(0.18)-level+m.params.w,m.params.x,m.params.y);
      if(st[1]==0.0){st[0]=want;st[1]=1.0;}else{st[0]+=(want-st[0])*m.params.z;}
    }
  }
}`;
