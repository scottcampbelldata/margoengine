/// <reference lib="esnext.disposable" preserve="true" />
// Clean room: Jacob et al. (2018), Krishnamoorthi (2018), ONNX linear quantization.
import { rangeError, typeError } from '../../shared/errors.js';
import type { ComputeContext } from './context.js';
import type { GpuArray } from './array.js';

/** Affine signed int8 parameters: real = scale * (q - zeroPoint). */
export interface Quantization {
  /** Positive finite f32 scale, or one scale per axis coordinate. */
  readonly scale: number | readonly number[];
  /** Signed int8 zero point(s), same cardinality as scale. Default zero. */
  readonly zeroPoint?: number | readonly number[];
  /** Axis for vector parameters, negative axes allowed. Omit for per-tensor. */
  readonly axis?: number;
}
/** Inference output quantization, accumulator bias and cancellation. */
export interface QuantOptions {
  /** Per-tensor output scale and zero point; choose to avoid clipping. */
  readonly output: Quantization;
  /** Int32 bias per output channel, in input-scale times weight-scale units. Default none. */
  readonly bias?: Int32Array;
  /** Cancels CPU reads or submission before GPU dispatch. */
  readonly signal?: AbortSignal;
}
/** NCHW convolution with [outChannels, inChannels/groups, kh, kw] weights. */
export interface QuantConvOptions extends QuantOptions {
  /** Spatial stride. Default 1. */ readonly stride?: number | readonly [number, number];
  /** Tap dilation. Default 1. */ readonly dilation?: number | readonly [number, number];
  /** 0, symmetric [h,w], [top,left,bottom,right], valid, same or same-lower. Default 0. */
  readonly padding?: number | readonly number[] | 'valid' | 'same' | 'same-lower';
  /** Independent channel groups, including depthwise. Default 1. */ readonly groups?: number;
}
const fail = (s: string): never => {
  throw rangeError(`${s}; supply valid int8 quantization or dimensions`, 'compute');
};
const product = (s: readonly number[]) => s.reduce((a, b) => a * b, 1);
const vector = (x: number | readonly number[]) => (typeof x === 'number' ? [x] : [...x]);
const even = (x: number) => {
  const n = Math.floor(x),
    r = x - n;
  return r < 0.5 ? n : r > 0.5 ? n + 1 : n + (n % 2 === 0 ? 0 : 1);
};
const clamp = (x: number) => Math.max(-128, Math.min(127, x));
const f = Math.fround;
function parameters(q: Quantization, shape: readonly number[]) {
  const scale = vector(q.scale).map(f),
    zero = q.zeroPoint === undefined ? scale.map(() => 0) : vector(q.zeroPoint);
  const axis = q.axis === undefined ? undefined : q.axis < 0 ? q.axis + shape.length : q.axis;
  if (axis !== undefined && (!Number.isInteger(axis) || axis < 0 || axis >= shape.length))
    fail('Quantization axis is out of range');
  if (
    scale.length !== (axis === undefined ? 1 : shape[axis]) ||
    zero.length !== scale.length ||
    scale.some((v) => !(v > 0 && Number.isFinite(v))) ||
    zero.some((v) => !Number.isInteger(v) || v < -128 || v > 127)
  )
    fail('Scales and zero points must match the quantization axis');
  return { scale: Object.freeze(scale), zero: Object.freeze(zero), axis };
}
function pack(data: Int8Array): Uint32Array {
  const out = new Uint32Array(Math.ceil(data.length / 4));
  for (let i = 0; i < data.length; i++) out[i >>> 2] |= (data[i] & 255) << ((i & 3) * 8);
  return out;
}
function unpack(data: Uint32Array, size: number): Int8Array {
  return Int8Array.from({ length: size }, (_, i) => (data[i >>> 2] >>> ((i & 3) * 8)) & 255);
}
/** Owned packed int8 tensor. Four signed bytes per u32 on either backend, with no float mirror. */
export class QuantizedTensor {
  /** Logical C-order dimensions. */ readonly shape: readonly number[];
  /** Canonical f32 scales. */ readonly scales: readonly number[];
  /** Canonical int8 zero points. */ readonly zeroPoints: readonly number[];
  /** Per-channel axis, or undefined for per-tensor. */ readonly axis: number | undefined;
  /** Logical element count. */ readonly size: number;
  /** @internal Packed storage, not an expanded i32 tensor. */ readonly packed: GpuArray<'u32'>;
  /** @internal Use quantize or quantizedTensor. */
  constructor(packed: GpuArray<'u32'>, shape: readonly number[], q: Quantization) {
    this.shape = Object.freeze([...shape]);
    this.size = product(shape);
    const p = parameters(q, shape);
    this.scales = p.scale;
    this.zeroPoints = p.zero;
    this.axis = p.axis;
    this.packed = packed;
  }
  /** Context owning this tensor. */ get context(): ComputeContext {
    return this.packed.context;
  }
  /** Read signed bytes, with optional cancellation. */
  async read(options: { readonly signal?: AbortSignal } = {}): Promise<Int8Array> {
    return unpack(await this.packed.read(options), this.size);
  }
  /** Read reconstructed real values. */
  async dequantize(options: { readonly signal?: AbortSignal } = {}): Promise<Float32Array> {
    const data = await this.read(options),
      inner = this.axis === undefined ? 1 : product(this.shape.slice(this.axis + 1));
    return Float32Array.from(data, (v, i) => {
      const c = this.axis === undefined ? 0 : Math.floor(i / inner) % this.shape[this.axis];
      return (v - this.zeroPoints[c]) * this.scales[c];
    });
  }
  /** Release packed storage; safe to repeat. */ dispose(): void {
    this.packed.dispose();
  }
  /** Explicit resource management. */ [Symbol.dispose](): void {
    this.dispose();
  }
}
function dims(shape: readonly number[], length: number) {
  if (
    !Array.isArray(shape) ||
    shape.some((v) => !Number.isSafeInteger(v) || v < 0) ||
    !Number.isSafeInteger(product(shape)) ||
    product(shape) !== length ||
    length > 0x7fffffff
  )
    fail('Shape must hold the input and fit signed 32-bit indexing');
}
/** Upload already quantized signed bytes. Inputs and parameter arrays are copied. */
export function quantizedTensor(
  c: ComputeContext,
  data: Int8Array,
  shape: readonly number[],
  q: Quantization,
): QuantizedTensor {
  c.check();
  if (!(data instanceof Int8Array)) throw typeError('Use Int8Array for signed quantized input', 'compute');
  dims(shape, data.length);
  parameters(q, shape);
  return new QuantizedTensor(c.array(pack(data)), shape, q);
}
/** Quantize finite real values with nearest-even rounding and int8 saturation. */
export function quantize(
  c: ComputeContext,
  data: ArrayLike<number>,
  shape: readonly number[],
  q: Quantization,
): QuantizedTensor {
  dims(shape, data.length);
  const p = parameters(q, shape),
    inner = p.axis === undefined ? 1 : product(shape.slice(p.axis + 1));
  const bytes = Int8Array.from(data, (v, i) => {
    if (!Number.isFinite(v)) fail('Quantization input must be finite');
    const channel = p.axis === undefined ? 0 : Math.floor(i / inner) % shape[p.axis];
    return clamp(even(v / p.scale[channel]) + p.zero[channel]);
  });
  return quantizedTensor(c, bytes, shape, q);
}
const byteShader = `fn av(i:u32)->i32 { let v=(a[i/4u] >> ((i%4u)*8u)) & 255u; return (i32(v)^128)-128; }
fn bv(i:u32)->i32 { let v=(b[i/4u] >> ((i%4u)*8u)) & 255u; return (i32(v)^128)-128; }
fn nearest(v:f32)->f32 { let n=floor(v); let r=v-n; if(r<0.5){return n;} if(r>0.5){return n+1.0;} return n+f32(i32(n)%2!=0); }`;
type Plan = {
  shape: number[];
  taps: number;
  channels: number;
  aAxis?: number;
  bAxis?: number;
  channel: (i: number) => [number, number, number];
  indices: (i: number, k: number) => [number, number];
  code: string;
};
async function execute(a: QuantizedTensor, b: QuantizedTensor, o: QuantOptions, p: Plan): Promise<QuantizedTensor> {
  o.signal?.throwIfAborted();
  a.packed.check(a.context);
  b.packed.check(a.context);
  if ((a.axis !== undefined && a.axis !== p.aAxis) || (b.axis !== undefined && b.axis !== p.bAxis))
    fail('Quantized axes must be output rows or weight output channels');
  const q = parameters(o.output, p.shape);
  if (q.axis !== undefined) fail('Output quantization must be per tensor');
  if (o.bias !== undefined && (!(o.bias instanceof Int32Array) || o.bias.length !== p.channels))
    fail('Bias must have one int32 per output channel');
  const bias = o.bias ? new Int32Array(o.bias) : new Int32Array(p.channels);
  const output = { scale: q.scale[0], zeroPoint: q.zero[0] };
  const ma = a.zeroPoints.reduce((m, z) => Math.max(m, 128 + z, 127 - z), 0),
    mb = b.zeroPoints.reduce((m, z) => Math.max(m, 128 + z, 127 - z), 0);
  if (p.taps * ma * mb + bias.reduce((v, x) => Math.max(v, Math.abs(x)), 0) > 0x7fffffff)
    fail('Int32 accumulator could overflow');
  dims(p.shape, product(p.shape));
  // Validate f32 rescale, including underflow, before allocating or dispatching.
  for (const x of a.scales)
    for (const y of b.scales) {
      const m = f(f(x * y) / q.scale[0]);
      if (!(m > 0 && Number.isFinite(m))) fail('Rescale multiplier must be representable in f32');
    }
  if (a.context.backend === 'cpu') {
    const [aa, bb] = await Promise.all([a.read({ signal: o.signal }), b.read({ signal: o.signal })]);
    const bytes = new Int8Array(product(p.shape));
    for (let i = 0; i < bytes.length; i++) {
      const [ac0, bc0, channel] = p.channel(i),
        ac = a.axis === undefined ? 0 : ac0,
        bc = b.axis === undefined ? 0 : bc0;
      let acc = bias[channel];
      for (let k = 0; k < p.taps; k++) {
        const [ai, bi] = p.indices(i, k);
        if (ai >= 0) acc += (aa[ai] - a.zeroPoints[ac]) * (bb[bi] - b.zeroPoints[bc]);
      }
      const multiplier = f(f(a.scales[ac] * b.scales[bc]) / q.scale[0]);
      bytes[i] = clamp(even(f(f(acc) * multiplier)) + q.zero[0]);
    }
    o.signal?.throwIfAborted();
    return quantizedTensor(a.context, bytes, p.shape, output);
  }
  const size = product(p.shape),
    words = Math.ceil(size / 4),
    c = a.context;
  const groups = Math.ceil(words / 64),
    limit = c.device.limits.maxComputeWorkgroupsPerDimension;
  if (groups > limit * limit) fail('Output exceeds two-dimensional dispatch capacity');
  const out = c.empty([words], 'u32');
  try {
    if (size) {
      const meta = (t: QuantizedTensor) => Float32Array.from(t.scales.flatMap((s, i) => [s, t.zeroPoints[i]]));
      const [setup, index] = p.code.split('//INDICES');
      const shader = `@group(0) @binding(0) var<storage,read> a:array<u32>;
@group(0) @binding(1) var<storage,read> b:array<u32>;
@group(0) @binding(2) var<storage,read_write> out:array<u32>;
@group(0) @binding(3) var<storage,read> qa:array<vec2<f32>>;
@group(0) @binding(4) var<storage,read> qb:array<vec2<f32>>;
@group(0) @binding(5) var<storage,read> bias:array<i32>;
${byteShader}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3<u32>) {
let word=gid.x+gid.y*${Math.min(groups, limit) * 64}u; if(word>=${words}u){return;}
var packed=0u;
for(var lane=0u;lane<4u;lane++){ let i=word*4u+lane; if(i>=${size}u){break;}
${setup}
let ac=${a.axis === undefined ? '0u' : 'row'}; let bc=${b.axis === undefined ? '0u' : 'channel'};
var acc=bias[channel];
for(var k=0u;k<${p.taps}u;k++){ ${index}
if(ai>=0){acc+=(av(u32(ai))-i32(qa[ac].y))*(bv(bi)-i32(qb[bc].y));}}
let multiplier=(qa[ac].x*qb[bc].x)/${q.scale[0]}f;
let value=i32(clamp(nearest(clamp(f32(acc)*multiplier,-512.0,512.0))+${q.zero[0]}.0,-128.0,127.0));
packed=packed|((u32(value)&255u)<<(lane*8u)); }
out[word]=packed; }`;
      c.submit([
        {
          program: c.program(shader, undefined, 'quant-int8'),
          resources: { a: a.packed, b: b.packed, out, qa: meta(a), qb: meta(b), bias },
          workgroups: [Math.min(groups, limit), Math.ceil(groups / limit), 1],
        },
      ]);
    }
    return new QuantizedTensor(out, p.shape, output);
  } catch (error) {
    out.dispose();
    throw error;
  }
}

/** Batched broadcast matmul, including vector promotion. Integer MACs, f32 nearest-even requantization. */
export async function quantizedMatmul(
  a: QuantizedTensor,
  b: QuantizedTensor,
  o: QuantOptions,
): Promise<QuantizedTensor> {
  if (!a.shape.length || !b.shape.length) fail('Matmul requires rank at least one');
  const av = a.shape.length === 1,
    bv = b.shape.length === 1,
    as = av ? [1, ...a.shape] : [...a.shape],
    bs = bv ? [...b.shape, 1] : [...b.shape],
    m = as.at(-2)!,
    k = as.at(-1)!,
    n = bs.at(-1)!;
  if (k !== bs.at(-2)) fail('Matmul inner dimensions must match');
  const rank = Math.max(as.length, bs.length) - 2,
    batch = Array(rank).fill(1) as number[];
  while (as.length < rank + 2) as.unshift(1);
  while (bs.length < rank + 2) bs.unshift(1);
  for (let d = 0; d < rank; d++) {
    if (as[d] !== bs[d] && as[d] !== 1 && bs[d] !== 1) fail('Matmul batch dimensions must broadcast');
    batch[d] = as[d] === 1 ? bs[d] : as[d];
  }
  const offset = (s: number[], i: number) => {
    let out = 0;
    for (let d = 0; d < rank; d++)
      out += (s[d] === 1 ? 0 : Math.floor(i / product(batch.slice(d + 1))) % batch[d]) * product(s.slice(d + 1));
    return out;
  };
  const wgOffset = (s: number[]) =>
    s
      .slice(0, rank)
      .map((v, d) =>
        v === 1 ? '0u' : `((batch/${product(batch.slice(d + 1))}u)%${batch[d]}u)*${product(s.slice(d + 1))}u`,
      )
      .join('+') || '0u';
  return execute(a, b, o, {
    shape: [...batch, ...(av ? [] : [m]), ...(bv ? [] : [n])],
    taps: k,
    channels: n,
    aAxis: av ? undefined : a.shape.length - 2,
    bAxis: bv ? undefined : b.shape.length - 1,
    channel: (i) => [Math.floor(i / n) % m, i % n, i % n],
    indices: (i, j) => {
      const batch = Math.floor(i / (m * n));
      return [offset(as, batch) + (Math.floor(i / n) % m) * k + j, offset(bs, batch) + j * n + (i % n)];
    },
    code: `let row=(i/${n || 1}u)%${m || 1}u; let channel=i%${n || 1}u; let batch=i/${m * n || 1}u;
//INDICES
let ai=i32(${wgOffset(as)}+row*${k}u+k); let bi=${wgOffset(bs)}+k*${n}u+channel;`,
  });
}
const pair = (v: number | readonly number[], min: number) => {
  const p = typeof v === 'number' ? [v, v] : [...v];
  if (p.length !== 2 || p.some((v) => !Number.isSafeInteger(v) || v < min || v > 0x7fffffff))
    fail('Spatial options need two bounded integers');
  return p;
};
/** Grouped/depthwise dilated 2D convolution. Padding contributes real zero, including asymmetric zero points. */
export async function quantizedConv2d(
  a: QuantizedTensor,
  b: QuantizedTensor,
  o: QuantConvOptions,
): Promise<QuantizedTensor> {
  if (a.shape.length !== 4 || b.shape.length !== 4) fail('Conv2d requires NCHW and OIHW ranks');
  const [batch, ci, h, w] = a.shape,
    [co, cg, kh, kw] = b.shape,
    g = o.groups ?? 1,
    [sh, sw] = pair(o.stride ?? 1, 1),
    [dh, dw] = pair(o.dilation ?? 1, 1);
  if (!Number.isSafeInteger(g) || g < 1 || ci !== cg * g || co % g || !ci || !co || !kh || !kw || !h || !w)
    fail('Convolution channels, groups and kernels must agree');
  let pad: number[];
  if (typeof o.padding === 'string') {
    if (!['valid', 'same', 'same-lower'].includes(o.padding)) fail('Choose valid, same or same-lower padding');
    const ph = o.padding === 'valid' ? 0 : Math.max(0, (Math.ceil(h / sh) - 1) * sh + dh * (kh - 1) + 1 - h),
      pw = o.padding === 'valid' ? 0 : Math.max(0, (Math.ceil(w / sw) - 1) * sw + dw * (kw - 1) + 1 - w),
      rounding = o.padding === 'same-lower' ? Math.ceil : Math.floor;
    pad = [rounding(ph / 2), rounding(pw / 2), ph - rounding(ph / 2), pw - rounding(pw / 2)];
  } else {
    const p = o.padding ?? 0;
    pad = typeof p !== 'number' && p.length === 4 ? [...p] : [...pair(p, 0), ...pair(p, 0)];
    if (pad.some((v) => !Number.isSafeInteger(v) || v < 0 || v > 0x7fffffff))
      fail('Padding must be nonnegative bounded integers');
  }
  const [pt, pl, pb, pr] = pad,
    oh = Math.floor((h + pt + pb - dh * (kh - 1) - 1) / sh) + 1,
    ow = Math.floor((w + pl + pr - dw * (kw - 1) - 1) / sw) + 1;
  if (oh < 0 || ow < 0 || [h + pt + pb, w + pl + pr, dh * kh, dw * kw].some((v) => v > 0x7fffffff))
    fail('Convolution geometry exceeds indexing range');
  const spatial = oh * ow,
    taps = cg * kh * kw;
  return execute(a, b, o, {
    shape: [batch, co, oh, ow],
    taps,
    channels: co,
    bAxis: 0,
    channel: (i) => [0, Math.floor(i / spatial) % co, Math.floor(i / spatial) % co],
    indices: (i, k) => {
      const ch = Math.floor(i / spatial) % co,
        y = Math.floor((i % spatial) / ow) * sh - pt + Math.floor((k % (kh * kw)) / kw) * dh,
        x = (i % ow) * sw - pl + (k % kw) * dw,
        c = Math.floor(ch / (co / g)) * cg + Math.floor(k / (kh * kw));
      return [
        y < 0 || x < 0 || y >= h || x >= w ? -1 : ((Math.floor(i / (co * spatial)) * ci + c) * h + y) * w + x,
        ch * taps + k,
      ];
    },
    code: `let channel=(i/${spatial || 1}u)%${co}u; let batch=i/${co * spatial || 1}u;
let oy=(i%${spatial || 1}u)/${ow || 1}u; let ox=i%${ow || 1}u;
//INDICES
let y=i32(oy*${sh}u+(k%${kh * kw}u)/${kw}u*${dh}u)-${pt};
let x=i32(ox*${sw}u+(k%${kw}u)*${dw}u)-${pl};
let c=(channel/${co / g}u)*${cg}u+k/${kh * kw}u;
var ai=-1; if(y>=0 && x>=0 && y<${h} && x<${w}){ai=i32((batch*${ci}u+c)*${h * w}u)+y*${w}+x;}
let bi=channel*${taps}u+k;`,
  });
}
