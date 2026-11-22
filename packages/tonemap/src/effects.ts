import { MargoError } from '@margoengine/math/errors';
import { blackbodyChromaticity } from '@margoengine/math/color';
// Optional grading extras, compiled in only when an option asks for them so the default shaders stay byte-identical.
// White balance: Kim et al. (2002) cubic-spline fit of the Planckian locus in CIE xy, then a von Kries adaptation in
// the linearised Bradford cone space (Lam 1985; Suesstrunk, Holm and Finlayson 2001) as one 3x3 matrix. Vignette: radial smoothstep, multiplied by or blended toward a colour. Dither: triangular (TPDF) noise of
// up to one code value either way on the encoded value, the last step before the target quantises it (Gjoel 2016, after
// Lipshitz, Wannamaker and Vanderkooy 1992), narrowed near 0 and 1 so black and white stay exact. Grain: PCG integer hash (Jarzynski and Olano, 2020), animated per frame.
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
  /**
   * Weight texture of `'mask'` metering (any size, filterable float or unorm; red channel 0 to 1), or
   * `(device) => texture`, called once per device. A plain texture is the caller's and belongs to the device it was
   * first used on: after a device restore it is dropped and reported once through `engine.onError`
   * (margoengine.com/errors#borrowed-lost), the meter keeps its last exposure, and assigning a new one brings it back.
   */
  mask?: GPUTexture | ((device: GPUDevice) => GPUTexture);
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
    (a.metering !== 'mask' ||
      typeof a.mask === 'function' ||
      typeof (a.mask as { createView?: unknown } | undefined)?.createView === 'function')
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

// The Planckian white at `kelvin` in linear Rec.709: CIE xy by Kim et al. (2002, `blackbodyChromaticity` of
// @margoengine/math/color), as XYZ with Y = 1, then XYZ to RGB.
function planckian(kelvin: number): number[] {
  const [x, y] = blackbodyChromaticity(kelvin),
    X = x / y,
    Z = (1 - x - y) / y;
  return [
    3.2404542 * X - 1.5371385 - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 + 0.041556 * Z,
    0.0556434 * X - 0.2040259 + 1.0572252 * Z,
  ];
}

// Linear Rec.709 to the linearised Bradford cone responses (Lam 1985, as printed by Suesstrunk, Holm and Finlayson
// 2001) and back: Bradford times the inverse of the XYZ to Rec.709 matrix above, and that matrix times the inverse of
// Bradford, multiplied out to 8 digits.
const LMS = [
    [0.42272531, 0.49134529, 0.027357931],
    [0.055699661, 0.96153401, 0.023183824],
    [0.021382653, 0.087641898, 0.9805081],
  ],
  RGB = [
    [2.538044, -1.2932767, -0.040236827],
    [-0.14600373, 1.1166482, -0.02232905],
    [-0.04229855, -0.07160724, 1.0227527],
  ];
const apply = (m: number[][], v: number[]) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]),
  luma = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2],
  REFERENCE = apply(LMS, planckian(NEUTRAL_TEMPERATURE));

/**
 * White balance as a 3x3 matrix on linear Rec.709 RGB, column-major (the WGSL `mat3x3f` order), that makes a scene lit
 * at `temperature` Kelvin (and `tint`, -1 green to 1 magenta) look neutral, like a camera's white-balance setting: a
 * low temperature cools the picture, a high one warms it. It is a von Kries chromatic adaptation in the Bradford cone
 * space from the Planckian white at `temperature` to the one at 6500 K, so it stays well defined over the whole range
 * (an RGB gain cannot: below 1903.4 K the Planckian white lies outside Rec.709 and its blue is negative). A grey card
 * lit by the light keeps its luminance as it turns neutral, and the matrix is exactly the identity at 6500 K with no
 * tint. Strong corrections can push colours outside Rec.709; the shader clips them at 0.
 * @throws RangeError for a temperature outside 1667-25000 K or a tint outside -1..1.
 */
export function whiteBalanceMatrix(temperature = NEUTRAL_TEMPERATURE, tint = 0): number[] {
  if (
    !Number.isFinite(temperature) ||
    temperature < 1667 ||
    temperature > 25000 ||
    !Number.isFinite(tint) ||
    tint < -1 ||
    tint > 1
  )
    throw new RangeError('Tonemap white balance needs a temperature of 1667-25000 K and a tint of -1 to 1');
  if (temperature === NEUTRAL_TEMPERATURE && tint === 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // m = RGB * diag(reference / source) * LMS in the cone space; the tint scales its green row.
  const card = planckian(temperature),
    source = apply(LMS, card),
    m = RGB.map((r, i) =>
      [0, 1, 2].map(
        (j) =>
          (i === 1 ? 1 - 0.25 * tint : 1) *
          r.reduce((sum, v, k) => sum + (v * REFERENCE[k] * LMS[k][j]) / source[k], 0),
      ),
    ),
    // Rescale so a grey card lit by the light keeps its luminance while it turns neutral.
    k = luma(card) / luma(apply(m, card));
  return [0, 1, 2].flatMap((col) => [m[0][col] * k, m[1][col] * k, m[2][col] * k]);
}

/** True when any extra needs the effects shader variant. */
export function usesEffects(o: {
  temperature?: number;
  tint?: number;
  vignette?: number;
  grain?: number;
  dither?: boolean | number;
  chromaticAberration?: number;
  autoExposure?: unknown;
}): boolean {
  return !!(
    (o.temperature !== undefined && o.temperature !== NEUTRAL_TEMPERATURE) ||
    o.tint ||
    o.vignette ||
    o.grain ||
    o.dither ||
    o.chromaticAberration ||
    o.autoExposure
  );
}

const FX = `
struct Fx {wb0:vec4f,wb1:vec4f,wb2:vec4f,vig:vec4f,rect:vec4f,time:vec4f,vc:vec4f,vp:vec4f}
@group(0) @binding(3) var<uniform> fx:Fx;
fn fxPcg(v:u32)->u32 {let s=v*747796405u+2891336375u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn fxBalance(c:vec3f)->vec3f {return mat3x3f(fx.wb0.xyz,fx.wb1.xyz,fx.wb2.xyz)*c;}
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
fn fxDither(c:vec3f,pos:vec4f)->vec3f {
  if(fx.vp.w==0.0){return c;}
  let s=vec3u(u32(pos.x),u32(pos.y),fxPcg(u32(fx.time.x)+0x9e3779b9u));
  let a=vec3u(fxPcg(s.x+fxPcg(s.y+s.z)),fxPcg(s.x+fxPcg(s.y+s.z+1u)),fxPcg(s.x+fxPcg(s.y+s.z+2u)));
  let b=vec3u(fxPcg(a.x),fxPcg(a.y),fxPcg(a.z));
  let n=(vec3f(a)+vec3f(b))/4294967295.0-1.0;
  return c+n*min(vec3f(fx.vp.w),min(c,1.0-c));
}
fn fxFinish(c:vec3f,pos:vec4f,white:f32)->vec3f {
  var color=c;
  if(fx.wb0.w>0.0){
    let d=((pos.xy-fx.rect.xy)/fx.rect.zw-fx.vp.xy)*2.0*mix(vec2f(1),fx.rect.zw*1.41421356/length(fx.rect.zw),fx.vp.z);
    let v=fx.wb0.w*smoothstep(fx.vig.x,fx.vig.x+fx.vig.y,length(d)*0.70710678);
    color=select(color*mix(vec3f(1),fx.vc.rgb,v),mix(color,fx.vc.rgb,v),fx.vc.w==1.0);
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
    out = swap(
      out,
      'hdr=max(hdr,vec3f(0))*exp2(p.grade.x);',
      `hdr=max(fxBalance(max(hdr,vec3f(0))),vec3f(0))*exp2(${stops});`,
    );
  if (out.includes('hdr*=exp2(p.grade.x);'))
    out = swap(out, 'hdr*=exp2(p.grade.x);', `hdr=fxBalance(hdr)*exp2(${stops});`);
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
  // Dither the encoded value, the last step before the target quantises it.
  const encode = 'return vec4f(select(color*12.92,1.055*pow(color,vec3f(1.0/2.4))-0.055,color>=vec3f(0.0031308)),';
  out = swap(
    out,
    encode,
    'return vec4f(fxDither(select(color*12.92,1.055*pow(color,vec3f(1.0/2.4))-0.055,color>=vec3f(0.0031308)),pos),',
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
