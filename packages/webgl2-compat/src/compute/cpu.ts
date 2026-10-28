// The run-time side of the CPU tier (roadmap "Compute plan", tier B, milestone M5): the helpers the generated
// JavaScript calls (f32 rounding, WGSL integer rules, bit and packing built-ins, memory access, textures), and the
// workgroup scheduler. Written clean room from the W3C WGSL specification.
//
// Values: f32, i32 and u32 are numbers (every f32 operation rounds through Math.fround, so +, -, *, / and sqrt give
// the same bits as an f32 GPU), bool is a boolean, and vectors, matrices (arrays of columns), arrays and structs
// (members in order) are JavaScript arrays. A variable's outermost array is changed in place; everything inside it
// is never changed (a store deeper in replaces the copies along its path), so a loaded inner value needs no copy.

const fr = Math.fround;
const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer),
  i32 = new Int32Array(f32.buffer);

/** A storage or uniform buffer binding as the kernel sees it: its bytes (a copy of the binding's range). */
export interface CPUBuffer {
  readonly dv: DataView;
  readonly bytes: Uint8Array;
}

/** One mip level of a texture on the CPU: RGBA values per texel, `d` layers (or depth slices) of `w` x `h`. */
export interface CPULevel {
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly data: Float32Array | Int32Array | Uint32Array;
  /** Texels the kernel stored (storage textures), one byte per texel. */
  written?: Uint8Array;
}

/** A texture view on the CPU, its levels read from the GPU when first used. */
export interface CPUTexture {
  readonly levels: number;
  readonly layers: number;
  readonly dimension: string;
  /** The storage texel format (stores round to it), when a storage texture. */
  readonly format?: string;
  level(l: number): CPULevel;
}

/** A sampler on the CPU. */
export interface CPUSampler {
  readonly mag: boolean;
  readonly min: boolean;
  readonly mip: boolean;
  /** Address modes u, v, w: 0 clamp-to-edge, 1 repeat, 2 mirror-repeat. */
  readonly modes: readonly number[];
  readonly lodMin: number;
  readonly lodMax: number;
}

const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function wrap(i: number, n: number, mode: number): number {
  if (mode === 1) return ((i % n) + n) % n;
  if (mode === 2) {
    const p = 2 * n,
      k = ((i % p) + p) % p;
    return k < n ? k : p - 1 - k;
  }
  return clampInt(i, 0, n - 1);
}

/** Rounds a value as a storage texture of `format` would store it. */
function quantize(format: string | undefined, v: number[]): number[] {
  if (!format) return v;
  if (format.endsWith('unorm')) {
    const k = format.includes('16') ? 65535 : format.includes('10') ? 1023 : 255;
    return v.map((x) => Math.round(Math.min(Math.max(x, 0), 1) * k) / k);
  }
  if (format.endsWith('snorm')) {
    const k = format.includes('16') ? 32767 : 127;
    return v.map((x) => Math.round(Math.min(Math.max(x, -1), 1) * k) / k);
  }
  if (format.endsWith('16float')) return v.map(toHalfValue);
  if (format.endsWith('8uint')) return v.map((x) => x & 0xff);
  if (format.endsWith('16uint')) return v.map((x) => x & 0xffff);
  if (format.endsWith('8sint')) return v.map((x) => (x << 24) >> 24);
  if (format.endsWith('16sint')) return v.map((x) => (x << 16) >> 16);
  return v;
}

function halfBits(x: number): number {
  f32[0] = x;
  const b = u32[0],
    sign = (b >>> 16) & 0x8000,
    e = (b >>> 23) & 0xff,
    m = b & 0x7fffff;
  if (e === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
  const he = e - 127 + 15;
  if (he >= 0x1f) return sign | 0x7c00;
  if (he <= 0) {
    if (he < -10) return sign;
    const mm = m | 0x800000,
      shift = 14 - he,
      r = mm >>> shift,
      rest = mm & ((1 << shift) - 1),
      half = 1 << (shift - 1);
    return sign | (r + (rest > half || (rest === half && r & 1) ? 1 : 0));
  }
  const r = (he << 10) | (m >>> 13),
    rest = m & 0x1fff;
  return sign | (r + (rest > 0x1000 || (rest === 0x1000 && r & 1) ? 1 : 0));
}
function halfValue(h: number): number {
  const s = h & 0x8000 ? -1 : 1,
    e = (h >>> 10) & 0x1f,
    m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 0x1f) return m ? Number.NaN : s * Number.POSITIVE_INFINITY;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}
const toHalfValue = (x: number) => halfValue(halfBits(x));

/** Texel (x, y, z) of a level, as 4 numbers. */
function texel(l: CPULevel, x: number, y: number, z: number): number[] {
  const i = ((z * l.h + y) * l.w + x) * 4,
    d = l.data;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}

/** Bilinear (or nearest) sample of one level and layer; `w` is the third coordinate of a 3D texture. */
function sampleLevel(
  t: CPUTexture,
  s: CPUSampler,
  level: number,
  u: number,
  v: number,
  w: number,
  layer: number,
  linear: boolean,
): number[] {
  const l = t.level(level),
    is3d = t.dimension === '3d';
  const fx = u * l.w - 0.5,
    fy = v * l.h - 0.5,
    fz = is3d ? w * l.d - 0.5 : 0;
  if (!linear) {
    const x = wrap(Math.floor(fx + 0.5), l.w, s.modes[0]),
      y = wrap(Math.floor(fy + 0.5), l.h, s.modes[1]),
      z = is3d ? wrap(Math.floor(fz + 0.5), l.d, s.modes[2]) : clampInt(layer, 0, l.d - 1);
    return texel(l, x, y, z);
  }
  const x0 = Math.floor(fx),
    y0 = Math.floor(fy),
    z0 = Math.floor(fz),
    ax = fx - x0,
    ay = fy - y0,
    az = fz - z0;
  const xs = [wrap(x0, l.w, s.modes[0]), wrap(x0 + 1, l.w, s.modes[0])],
    ys = [wrap(y0, l.h, s.modes[1]), wrap(y0 + 1, l.h, s.modes[1])];
  const zs = is3d ? [wrap(z0, l.d, s.modes[2]), wrap(z0 + 1, l.d, s.modes[2])] : [clampInt(layer, 0, l.d - 1)];
  const out = [0, 0, 0, 0];
  for (let k = 0; k < zs.length; k++) {
    const wz = is3d ? (k ? az : 1 - az) : 1;
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) {
        const wgt = wz * (j ? ay : 1 - ay) * (i ? ax : 1 - ax);
        const c = texel(l, xs[i], ys[j], zs[k]);
        for (let n = 0; n < 4; n++) out[n] += c[n] * wgt;
      }
  }
  return out.map(fr);
}

/** The helpers generated kernels call, by short name. */
export const H = {
  fr,
  /** A shallow copy of a composite value (its insides are never changed in place). */
  cp: (v: unknown) => (Array.isArray(v) ? v.slice() : v),
  /** `o` with the value at keys[i...] replaced by `v`, copying along the path. */
  wp(o: unknown[], keys: readonly (number | string)[], i: number, v: unknown): unknown[] {
    const c = o.slice();
    const k = keys[i] as number;
    c[k] = i + 1 === keys.length ? v : H.wp(o[k] as unknown[], keys, i + 1, v);
    return c;
  },
  divi: (a: number, b: number) => (b === 0 || (a === -2147483648 && b === -1) ? a : (a / b) | 0),
  modi: (a: number, b: number) => (b === 0 || (a === -2147483648 && b === -1) ? 0 : (a % b) | 0),
  divu: (a: number, b: number) => (b === 0 ? a : Math.floor(a / b) >>> 0),
  modu: (a: number, b: number) => (b === 0 ? 0 : (a % b) >>> 0),
  f2i: (x: number) => (x !== x ? 0 : x <= -2147483648 ? -2147483648 : x >= 2147483520 ? 2147483520 : Math.trunc(x)),
  f2u: (x: number) => (x !== x || x <= 0 ? 0 : x >= 4294967040 ? 4294967040 : Math.trunc(x)),
  bfu(x: number): number {
    f32[0] = x;
    return u32[0];
  },
  bfi(x: number): number {
    f32[0] = x;
    return i32[0];
  },
  buf(x: number): number {
    u32[0] = x;
    return f32[0];
  },
  bif(x: number): number {
    i32[0] = x;
    return f32[0];
  },
  halfBits,
  halfValue,
  q16: (x: number) => fr(toHalfValue(x)),
  sign: (x: number) => (x > 0 ? 1 : x < 0 ? -1 : x),
  isign: (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0),
  fclamp: (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi),
  smooth(e0: number, e1: number, x: number): number {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return fr(t * t * (3 - 2 * t));
  },
  inv: (x: number) => fr(1 / Math.sqrt(x)),
  cob(x: number): number {
    let n = 0;
    for (let v = x >>> 0; v; v &= v - 1) n++;
    return n;
  },
  rev(x: number): number {
    let r = 0;
    for (let i = 0; i < 32; i++) r = (r << 1) | ((x >>> i) & 1);
    return r >>> 0;
  },
  clz: (x: number) => Math.clz32(x),
  ctz: (x: number) => (x === 0 ? 32 : 31 - Math.clz32(x & -x)),
  flbu: (x: number) => (x === 0 ? 0xffffffff : 31 - Math.clz32(x)),
  flbi: (x: number) => {
    const v = x < 0 ? ~x : x;
    return v === 0 ? -1 : 31 - Math.clz32(v);
  },
  ftb: (x: number) => (x === 0 ? -1 : 31 - Math.clz32(x & -x)),
  extu(e: number, offset: number, count: number): number {
    const o = Math.min(offset, 32),
      c = Math.min(count, 32 - o);
    return c === 0 ? 0 : c === 32 ? e >>> 0 : (e >>> o) & ((2 ** c - 1) >>> 0);
  },
  exti(e: number, offset: number, count: number): number {
    const o = Math.min(offset, 32),
      c = Math.min(count, 32 - o);
    return c === 0 ? 0 : (((e >>> o) << (32 - c)) >> (32 - c)) | 0;
  },
  ins(e: number, n: number, offset: number, count: number): number {
    const o = Math.min(offset, 32),
      c = Math.min(count, 32 - o);
    if (c === 0) return e;
    const mask = (c === 32 ? 0xffffffff : ((1 << c) - 1) << o) >>> 0;
    return ((e & ~mask) | ((n << o) & mask)) >>> 0;
  },
  ldexp: (x: number, e: number) => fr(x * 2 ** e),
  frexp(x: number): [number, number] {
    if (x === 0 || !Number.isFinite(x)) return [x, 0];
    const e = Math.floor(Math.log2(Math.abs(x))) + 1;
    let m = x / 2 ** e;
    let k = e;
    if (Math.abs(m) >= 1) {
      m /= 2;
      k++;
    } else if (Math.abs(m) < 0.5) {
      m *= 2;
      k--;
    }
    return [fr(m), k];
  },
  p4x8u: (v: number[]) =>
    v.reduce((a, x, i) => a | (Math.floor(0.5 + 255 * Math.min(Math.max(x, 0), 1)) << (8 * i)), 0) >>> 0,
  p4x8s: (v: number[]) =>
    v.reduce((a, x, i) => a | ((Math.floor(0.5 + 127 * Math.min(Math.max(x, -1), 1)) & 0xff) << (8 * i)), 0) >>> 0,
  p2x16u: (v: number[]) =>
    v.reduce((a, x, i) => a | (Math.floor(0.5 + 65535 * Math.min(Math.max(x, 0), 1)) << (16 * i)), 0) >>> 0,
  p2x16s: (v: number[]) =>
    v.reduce((a, x, i) => a | ((Math.floor(0.5 + 32767 * Math.min(Math.max(x, -1), 1)) & 0xffff) << (16 * i)), 0) >>> 0,
  p2x16f: (v: number[]) => (halfBits(v[0]) | (halfBits(v[1]) << 16)) >>> 0,
  u4x8u: (x: number) => [0, 1, 2, 3].map((i) => fr(((x >>> (8 * i)) & 0xff) / 255)),
  u4x8s: (x: number) => [0, 1, 2, 3].map((i) => fr(Math.max(((x << (24 - 8 * i)) >> 24) / 127, -1))),
  u2x16u: (x: number) => [0, 1].map((i) => fr(((x >>> (16 * i)) & 0xffff) / 65535)),
  u2x16s: (x: number) => [0, 1].map((i) => fr(Math.max(((x << (16 - 16 * i)) >> 16) / 32767, -1))),
  u2x16f: (x: number) => [halfValue(x & 0xffff), halfValue(x >>> 16)].map(fr),
  p4i8: (v: number[]) => v.reduce((a, x, i) => a | ((x & 0xff) << (8 * i)), 0) >>> 0,
  p4u8: (v: number[]) => v.reduce((a, x, i) => a | ((x & 0xff) << (8 * i)), 0) >>> 0,
  p4i8c: (v: number[]) => v.reduce((a, x, i) => a | ((clampInt(x, -128, 127) & 0xff) << (8 * i)), 0) >>> 0,
  p4u8c: (v: number[]) => v.reduce((a, x, i) => a | (clampInt(x, 0, 255) << (8 * i)), 0) >>> 0,
  u4i8: (x: number) => [0, 1, 2, 3].map((i) => (x << (24 - 8 * i)) >> 24),
  u4u8: (x: number) => [0, 1, 2, 3].map((i) => (x >>> (8 * i)) & 0xff),
  d4u8: (a: number, b: number) => {
    let s = 0;
    for (let i = 0; i < 4; i++) s += ((a >>> (8 * i)) & 0xff) * ((b >>> (8 * i)) & 0xff);
    return s >>> 0;
  },
  d4i8: (a: number, b: number) => {
    let s = 0;
    for (let i = 0; i < 4; i++) s += ((a << (24 - 8 * i)) >> 24) * ((b << (24 - 8 * i)) >> 24);
    return s | 0;
  },
  /** A whole-array value of `n` elements made by `make`. */
  fill: (n: number, make: () => unknown) => Array.from({ length: n }, make),
  /** Clamps a dynamic index into [0, n), as WGSL's robust access allows. */
  ix: (i: number, n: number) => (i < 0 ? 0 : i >= n ? n - 1 : i),
  /** A u32 index clamped into [0, n). */
  ux: (i: number, n: number) => (i >= n ? n - 1 : i),
  /** Read-modify-write of a 32-bit integer at `ref` (an atomic): returns the old value. */
  rmw(ref: { g(): number; s(v: number): void }, f: (a: number) => number): number {
    const old = ref.g();
    ref.s(f(old));
    return old;
  },
  /** The same at a byte offset of a buffer, as u32 (`signed` false) or i32. */
  mrmw(b: CPUBuffer, o: number, signed: boolean, f: (a: number) => number): number {
    const old = signed ? b.dv.getInt32(o, true) : b.dv.getUint32(o, true);
    b.dv.setUint32(o, f(old) >>> 0, true);
    return old;
  },
  // ------------------------------------------------ textures
  /** textureLoad: the texel at (x, y, layer or z) of `level`, coordinates and level clamped into the texture. */
  tl(t: CPUTexture, c: number[] | number, layer: number, level: number): number[] {
    const lv = clampInt(level, 0, t.levels - 1),
      l = t.level(lv),
      p = typeof c === 'number' ? [c, 0, 0] : c;
    const z = t.dimension === '3d' ? clampInt(p[2], 0, l.d - 1) : clampInt(layer, 0, l.d - 1);
    return texel(l, clampInt(p[0], 0, l.w - 1), clampInt(p[1] ?? 0, 0, l.h - 1), z);
  },
  /** textureDimensions. */
  td(t: CPUTexture, level: number): number[] {
    const l = t.level(clampInt(level, 0, t.levels - 1));
    return t.dimension === '3d' ? [l.w, l.h, l.d] : [l.w, l.h];
  },
  /** textureSampleLevel of a 1D, 2D, 2D-array or 3D texture. */
  tsl(t: CPUTexture, s: CPUSampler, c: number[] | number, layer: number, level: number, offset?: number[]): number[] {
    const p = typeof c === 'number' ? [c, 0.5, 0] : c;
    const lod = Math.min(Math.max(level, s.lodMin), s.lodMax);
    const top = t.levels - 1;
    const shifted = (l: number) => {
      const lv = t.level(l);
      return offset ? [p[0] + offset[0] / lv.w, p[1] + offset[1] / lv.h, p[2] ?? 0] : p;
    };
    if (lod <= 0) {
      const q = shifted(0);
      return sampleLevel(t, s, 0, q[0], q[1], q[2], layer, s.mag);
    }
    if (!s.mip) {
      const l = clampInt(Math.floor(lod + 0.5), 0, top),
        q = shifted(l);
      return sampleLevel(t, s, l, q[0], q[1], q[2], layer, s.min);
    }
    const l0 = clampInt(Math.floor(lod), 0, top),
      l1 = Math.min(l0 + 1, top),
      f = Math.min(lod, top) - l0;
    const q0 = shifted(l0),
      a = sampleLevel(t, s, l0, q0[0], q0[1], q0[2], layer, s.min);
    if (f <= 0 || l1 === l0) return a;
    const q1 = shifted(l1),
      b = sampleLevel(t, s, l1, q1[0], q1[1], q1[2], layer, s.min);
    return a.map((x, i) => fr(x + (b[i] - x) * f));
  },
  /** textureStore: out-of-bounds stores do nothing. */
  ts(t: CPUTexture, c: number[] | number, layer: number, v: number[]): void {
    const l = t.level(0),
      p = typeof c === 'number' ? [c, 0, 0] : c;
    const z = t.dimension === '3d' ? p[2] : layer;
    if (p[0] < 0 || p[0] >= l.w || (p[1] ?? 0) < 0 || (p[1] ?? 0) >= l.h || z < 0 || z >= l.d) return;
    const n = (z * l.h + (p[1] ?? 0)) * l.w + p[0];
    l.data.set(quantize(t.format, v), n * 4);
    (l.written ??= new Uint8Array(l.w * l.h * l.d))[n] = 1;
  },
};

/** What a compiled kernel needs from the run: its bindings by "group:binding". */
export interface CPUBindings {
  readonly buffers: ReadonlyMap<string, CPUBuffer>;
  readonly textures: ReadonlyMap<string, CPUTexture>;
  readonly samplers: ReadonlyMap<string, CPUSampler>;
}

/** The functions a generated kernel module returns. */
export interface KernelModule {
  /** The entry point (a generator function when the shader has barriers). */
  main(...args: unknown[]): unknown;
  /** Fresh workgroup memory. */
  workgroup(): Record<string, unknown>;
  /** Initializes an invocation's private variables. */
  invocation(context: Record<string, unknown>): void;
  /** The order the entry's parameters take the built-ins in. */
  readonly inputs: readonly (string | readonly string[])[];
}

/**
 * Runs every workgroup of a dispatch, invocation by invocation; with barriers, every invocation of a workgroup runs
 * to its next barrier before any goes on.
 */
export function runKernel(
  k: KernelModule,
  barriers: boolean,
  size: readonly [number, number, number],
  count: readonly number[],
): void {
  const [wx, wy, wz] = size,
    [nx, ny, nz] = count,
    nwg = [nx, ny, nz];
  for (let gz = 0; gz < nz; gz++)
    for (let gy = 0; gy < ny; gy++)
      for (let gx = 0; gx < nx; gx++) {
        const w = k.workgroup(),
          wid = [gx, gy, gz];
        const runs: Iterator<unknown>[] = [];
        for (let z = 0; z < wz; z++)
          for (let y = 0; y < wy; y++)
            for (let x = 0; x < wx; x++) {
              const context: Record<string, unknown> = { w };
              k.invocation(context);
              const values: Record<string, unknown> = {
                global_invocation_id: [gx * wx + x, gy * wy + y, gz * wz + z],
                local_invocation_id: [x, y, z],
                local_invocation_index: (z * wy + y) * wx + x,
                workgroup_id: wid.slice(),
                num_workgroups: nwg.slice(),
              };
              const result = k.main(
                context,
                ...k.inputs.map((n) => (typeof n === 'string' ? values[n] : n.map((m) => values[m]))),
              );
              if (barriers) runs.push(result as Iterator<unknown>);
            }
        if (!barriers) continue;
        let live = runs.length;
        const done = new Uint8Array(runs.length);
        while (live) {
          for (let i = 0; i < runs.length; i++)
            if (!done[i] && runs[i].next().done) {
              done[i] = 1;
              live--;
            }
        }
      }
}
