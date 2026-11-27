// Clean-room synchronous CPU spectral ocean evaluator matching fft-shaders.ts (Tessendorf 1999-2004,
// Hasselmann et al. 1973 JONSWAP, Cooley & Tukey 1965 radix-2 2D IFFT). Allocated lazily on first sample() call.

const TAU = 6.283185307179586;

/** Synchronous CPU evaluation of an FFTOcean surface at world (x, z) and time t. */
export interface OceanSample {
  /** World-space Y height of the ocean surface in metres. */
  height: number;
  /** Three-axis Gerstner/choppy displacement [dx, dy, dz] in metres. */
  displacement: [number, number, number];
  /** Unit surface normal pointing up. */
  normal: [number, number, number];
  /** Surface-particle velocity [vx, vy, vz] in m/s. */
  velocity: [number, number, number];
  /** Minimum cascade Jacobian folding determinant (< 1 compressed, < 0 folded). */
  jacobian: number;
  /** Instantaneous whitecap foam mask in 0..1 from Jacobian compression. */
  foam: number;
  /** Evaluation time in seconds. */
  time: number;
}

function hash(value: number): number {
  value = Math.imul(value ^ (value >>> 16), 2246822519);
  value = Math.imul(value ^ (value >>> 13), 3266489917);
  return (value ^ (value >>> 16)) >>> 0;
}

function random(value: number): number {
  return ((hash(value) >>> 8) + 0.5) / 16777216;
}

function density(si: number, sj: number, c: number, config: Float32Array): number {
  const b = 12 + c * 4;
  const length = config[b]!;
  const kMin = config[b + 1]!;
  const kMax = config[b + 2]!;
  const kx = (si * TAU) / length,
    kz = (sj * TAU) / length,
    k = Math.hypot(kx, kz);
  // The band edges are tested as the shader tests them, on its binary32 wave number (vec2f(signed) * TAU / length): a mode
  // on an edge, such as the patch's longest wave at k = 2 pi / length, falls on the same side on both, or the CPU drops
  // the largest wave the GPU draws.
  const f = Math.fround,
    x32 = f(f(si * f(TAU)) / length),
    z32 = f(f(sj * f(TAU)) / length),
    k32 = f(Math.sqrt(f(f(x32 * x32) + f(z32 * z32))));
  if (k32 < kMin || k32 >= kMax || k === 0) return 0;
  const alignment = (kx * config[4]! + kz * config[5]!) / k;
  const spread = alignment * alignment;
  const speed = config[6]!;
  const longest = (speed * speed) / 9.81;
  let power = 0;
  if (config[8]! === 0) {
    power = ((config[9]! * Math.exp(-1 / (k * k * longest * longest))) / (k * k * k * k)) * spread * Math.exp(-k * k * 0.01);
  } else {
    const omega = Math.sqrt(9.81 * k);
    const fetch = config[10]!;
    const peak = 22 * ((9.81 * 9.81) / (speed * fetch)) ** (1 / 3);
    const alpha = 0.076 * ((speed * speed) / (fetch * 9.81)) ** 0.22;
    const sigma = omega <= peak ? 0.07 : 0.09;
    const r = Math.exp(-0.5 * ((omega - peak) / (sigma * peak)) ** 2);
    const spectrum =
      ((alpha * 9.81 * 9.81) / omega ** 5) * Math.exp(-1.25 * (peak / omega) ** 4) * config[11]! ** r;
    power = (((spectrum * (spread / Math.PI) * Math.sqrt(9.81 / k) * 0.5) / k) * config[9]!);
  }
  const dk = TAU / length;
  return power * dk * dk;
}

/** Retained CPU spectral cache and radix-2 Cooley-Tukey 2D IFFT evaluator for one FFTOcean. */
export class CpuOceanEvaluator {
  private readonly n: number;
  private readonly cascades: number;
  private readonly bitRev: Uint32Array;
  private readonly twCos: Float64Array;
  private readonly twSin: Float64Array;
  private readonly h0: Float32Array;
  private readonly field: Float32Array;
  private readonly re0: Float64Array;
  private readonly im0: Float64Array;
  private readonly re1: Float64Array;
  private readonly im1: Float64Array;
  private readonly re2: Float64Array;
  private readonly im2: Float64Array;
  private readonly colRe: Float64Array;
  private readonly colIm: Float64Array;
  private spectrumVersion = -1;
  private evaluatedVersion = -1;
  private evaluatedTime = NaN;
  private evaluatedChop = NaN;
  private evaluatedFoam = NaN;

  constructor(resolution: number, cascades: number) {
    this.n = resolution;
    this.cascades = cascades;
    const cells = resolution * resolution;
    const bits = Math.log2(resolution);
    this.bitRev = new Uint32Array(resolution);
    for (let i = 0; i < resolution; i++) {
      let x = i,
        r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>>= 1;
      }
      this.bitRev[i] = r;
    }
    this.twCos = new Float64Array(resolution);
    this.twSin = new Float64Array(resolution);
    for (let i = 0; i < resolution; i++) {
      const angle = (TAU * i) / resolution;
      this.twCos[i] = Math.cos(angle);
      this.twSin[i] = Math.sin(angle);
    }
    this.h0 = new Float32Array(cells * cascades * 2);
    this.field = new Float32Array(cells * cascades * 12);
    this.re0 = new Float64Array(cells);
    this.im0 = new Float64Array(cells);
    this.re1 = new Float64Array(cells);
    this.im1 = new Float64Array(cells);
    this.re2 = new Float64Array(cells);
    this.im2 = new Float64Array(cells);
    this.colRe = new Float64Array(resolution);
    this.colIm = new Float64Array(resolution);
  }

  private buildInitial(config: Float32Array, version: number): void {
    const n = this.n,
      half = n >> 1,
      cells = n * n,
      seedBase = Math.imul(config[7]! >>> 0, 747796405);
    for (let c = 0; c < this.cascades; c++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const idx = c * cells + j * n + i;
          if (i === half || j === half) {
            this.h0[idx * 2] = 0;
            this.h0[idx * 2 + 1] = 0;
            continue;
          }
          const d = density(i < half ? i : i - n, j < half ? j : j - n, c, config);
          if (d <= 0) {
            this.h0[idx * 2] = 0;
            this.h0[idx * 2 + 1] = 0;
            continue;
          }
          const seed = (idx + seedBase) >>> 0;
          const angle = TAU * random(seed + 1);
          const amp = Math.sqrt(-2 * Math.log(random(seed)) * d * 0.5);
          this.h0[idx * 2] = amp * Math.cos(angle);
          this.h0[idx * 2 + 1] = amp * Math.sin(angle);
        }
      }
    }
    this.spectrumVersion = version;
    this.evaluatedVersion = -1;
  }

  private ifft1d(re: Float64Array, im: Float64Array, offset: number): void {
    const n = this.n,
      rev = this.bitRev,
      twCos = this.twCos,
      twSin = this.twSin;
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        const a = offset + i,
          b = offset + j;
        const tr = re[a]!,
          ti = im[a]!;
        re[a] = re[b]!;
        im[a] = im[b]!;
        re[b] = tr;
        im[b] = ti;
      }
    }
    for (let half = 1; half < n; half <<= 1) {
      const width = half << 1;
      const stride = n / width;
      for (let start = 0; start < n; start += width) {
        for (let j = 0; j < half; j++) {
          const tw = j * stride;
          const wr = twCos[tw]!,
            wi = twSin[tw]!;
          const a = offset + start + j;
          const b = a + half;
          const br = re[b]!,
            bi = im[b]!;
          const tr = br * wr - bi * wi;
          const ti = br * wi + bi * wr;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
  }

  private ifft2d(re: Float64Array, im: Float64Array): void {
    const n = this.n,
      colRe = this.colRe,
      colIm = this.colIm;
    for (let row = 0; row < n; row++) this.ifft1d(re, im, row * n);
    for (let col = 0; col < n; col++) {
      for (let row = 0; row < n; row++) {
        colRe[row] = re[row * n + col]!;
        colIm[row] = im[row * n + col]!;
      }
      this.ifft1d(colRe, colIm, 0);
      for (let row = 0; row < n; row++) {
        re[row * n + col] = colRe[row]!;
        im[row * n + col] = colIm[row]!;
      }
    }
  }

  /** Ensure the CPU grid matches the current spectrum, choppiness, foam threshold and time. */
  ensure(config: Float32Array, spectrumVersion: number, time: number): Float32Array {
    if (this.spectrumVersion !== spectrumVersion) this.buildInitial(config, spectrumVersion);
    const chop = config[2]!,
      foamThreshold = config[15]!;
    if (
      this.evaluatedVersion === spectrumVersion &&
      this.evaluatedTime === time &&
      this.evaluatedChop === chop &&
      this.evaluatedFoam === foamThreshold
    )
      return this.field;

    const n = this.n,
      half = n >> 1,
      cells = n * n,
      h0 = this.h0,
      re0 = this.re0,
      im0 = this.im0,
      re1 = this.re1,
      im1 = this.im1,
      re2 = this.re2,
      im2 = this.im2,
      field = this.field;

    for (let c = 0; c < this.cascades; c++) {
      const length = config[12 + c * 4]!,
        scale = TAU / length,
        base = c * cells;
      for (let j = 0; j < n; j++) {
        const kz = (j < half ? j : j - n) * scale;
        const oppJ = (n - j) % n;
        for (let i = 0; i < n; i++) {
          const kx = (i < half ? i : i - n) * scale;
          const k = Math.hypot(kx, kz);
          const p = j * n + i;
          if (k === 0) {
            re0[p] = im0[p] = re1[p] = im1[p] = re2[p] = im2[p] = 0;
            continue;
          }
          const omega = Math.sqrt(9.81 * k);
          const angle = omega * time;
          const co = Math.cos(angle),
            si = Math.sin(angle);
          const aIdx = (base + p) * 2;
          const bIdx = (base + oppJ * n + ((n - i) % n)) * 2;
          const h0ar = h0[aIdx]!,
            h0ai = h0[aIdx + 1]!;
          const h0br = h0[bIdx]!,
            h0bi = h0[bIdx + 1]!;
          const ar = h0ar * co - h0ai * si;
          const ai = h0ar * si + h0ai * co;
          // conj(h0(-k)) * conj(phase)
          const br = h0br * co - h0bi * si;
          const bi = -h0br * si - h0bi * co;
          const hr = ar + br,
            hi = ai + bi;
          const vr = -(ai - bi) * omega,
            vi = (ar - br) * omega;
          const invK = chop / Math.max(k, 1e-6);
          const dirX = kx * invK,
            dirZ = kz * invK;
          // horizontal = vec2f(height.y, -height.x) = (hi, -hr)
          const dxr = hi * dirX,
            dxi = -hr * dirX;
          const dzr = hi * dirZ,
            dzi = -hr * dirZ;
          const vxr = vi * dirX,
            vxi = -vr * dirX;
          const vzr = vi * dirZ,
            vzi = -vr * dirZ;
          // Pack pairs of Hermitian spectra (A + i B) into 3 complex 2D IFFTs.
          re0[p] = hr - dxi;
          im0[p] = hi + dxr;
          re1[p] = dzr - vi;
          im1[p] = dzi + vr;
          re2[p] = vxr - vzi;
          im2[p] = vxi + vzr;
        }
      }
      this.ifft2d(re0, im0);
      this.ifft2d(re1, im1);
      this.ifft2d(re2, im2);

      const spacing = length / n;
      const inv2Spacing = 0.5 / spacing;
      const threshold = config[15 + c * 4]!;
      for (let j = 0; j < n; j++) {
        const jPrev = (j + n - 1) % n;
        const jNext = (j + 1) % n;
        for (let i = 0; i < n; i++) {
          const iPrev = (i + n - 1) % n;
          const iNext = (i + 1) % n;
          const p = j * n + i;
          const pE = j * n + iNext,
            pW = j * n + iPrev;
          const pN = jNext * n + i,
            pS = jPrev * n + i;
          const txX = 1 + (im0[pE]! - im0[pW]!) * inv2Spacing;
          const txY = (re0[pE]! - re0[pW]!) * inv2Spacing;
          const txZ = (re1[pE]! - re1[pW]!) * inv2Spacing;
          const tzX = (im0[pN]! - im0[pS]!) * inv2Spacing;
          const tzY = (re0[pN]! - re0[pS]!) * inv2Spacing;
          const tzZ = 1 + (re1[pN]! - re1[pS]!) * inv2Spacing;
          const jacobian = txX * tzZ - txZ * tzX;
          const foam = Math.max(0, Math.min(1, (threshold - jacobian) * 2));
          // cross(tangentZ, tangentX)
          const nx = tzY * txZ - tzZ * txY;
          const ny = tzZ * txX - tzX * txZ;
          const nz = tzX * txY - tzY * txX;
          const nLen = Math.hypot(nx, ny, nz) || 1;
          const out = (base + p) * 12;
          field[out] = im0[p]!;
          field[out + 1] = re0[p]!;
          field[out + 2] = re1[p]!;
          field[out + 3] = foam;
          field[out + 4] = re2[p]!;
          field[out + 5] = im1[p]!;
          field[out + 6] = im2[p]!;
          field[out + 7] = jacobian;
          field[out + 8] = nx / nLen;
          field[out + 9] = ny / nLen;
          field[out + 10] = nz / nLen;
          field[out + 11] = 0;
        }
      }
    }

    this.evaluatedVersion = spectrumVersion;
    this.evaluatedTime = time;
    this.evaluatedChop = chop;
    this.evaluatedFoam = foamThreshold;
    return field;
  }

  private bilinear(
    bx: number,
    bz: number,
    lengths: readonly number[],
    outDisp: Float64Array,
  ): void {
    const n = this.n,
      cells = n * n,
      field = this.field;
    let dx = 0,
      dy = 0,
      dz = 0;
    for (let c = 0; c < this.cascades; c++) {
      const px = (bx / lengths[c]!) * n;
      const pz = (bz / lengths[c]!) * n;
      const ix = Math.floor(px),
        iz = Math.floor(pz);
      const tx = px - ix,
        tz = pz - iz;
      const x0 = ((ix % n) + n) % n,
        x1 = (x0 + 1) % n;
      const z0 = ((iz % n) + n) % n,
        z1 = (z0 + 1) % n;
      const base = c * cells;
      const o00 = (base + z0 * n + x0) * 12;
      const o10 = (base + z0 * n + x1) * 12;
      const o01 = (base + z1 * n + x0) * 12;
      const o11 = (base + z1 * n + x1) * 12;
      const w00 = (1 - tx) * (1 - tz),
        w10 = tx * (1 - tz),
        w01 = (1 - tx) * tz,
        w11 = tx * tz;
      dx += field[o00]! * w00 + field[o10]! * w10 + field[o01]! * w01 + field[o11]! * w11;
      dy += field[o00 + 1]! * w00 + field[o10 + 1]! * w10 + field[o01 + 1]! * w01 + field[o11 + 1]! * w11;
      dz += field[o00 + 2]! * w00 + field[o10 + 2]! * w10 + field[o01 + 2]! * w01 + field[o11 + 2]! * w11;
    }
    outDisp[0] = dx;
    outDisp[1] = dy;
    outDisp[2] = dz;
  }

  /** Sample the cached spectral grid at world (x, z), inverting horizontal choppy displacement. */
  sample(
    config: Float32Array,
    spectrumVersion: number,
    lengths: readonly number[],
    height: number,
    x: number,
    z: number,
    time: number,
  ): OceanSample {
    const field = this.ensure(config, spectrumVersion, time);
    const chop = config[2]!;
    let bx = x,
      bz = z;
    if (chop > 0) {
      const disp = new Float64Array(3);
      const dispX = new Float64Array(3);
      const dispZ = new Float64Array(3);
      const eps = Math.min(0.05, lengths[lengths.length - 1]! / (this.n * 4));
      for (let iter = 0; iter < 6; iter++) {
        this.bilinear(bx, bz, lengths, disp);
        const rx = bx + disp[0]! - x;
        const rz = bz + disp[2]! - z;
        if (rx * rx + rz * rz <= 1e-10) break;
        this.bilinear(bx + eps, bz, lengths, dispX);
        this.bilinear(bx, bz + eps, lengths, dispZ);
        const jxx = 1 + (dispX[0]! - disp[0]!) / eps;
        const jxz = (dispZ[0]! - disp[0]!) / eps;
        const jzx = (dispX[2]! - disp[2]!) / eps;
        const jzz = 1 + (dispZ[2]! - disp[2]!) / eps;
        const det = jxx * jzz - jxz * jzx;
        if (det > 0.25) {
          bx -= (jzz * rx - jxz * rz) / det;
          bz -= (-jzx * rx + jxx * rz) / det;
        } else {
          bx -= 0.5 * rx;
          bz -= 0.5 * rz;
        }
      }
    }
    const n = this.n,
      cells = n * n;
    let dx = 0,
      dy = 0,
      dz = 0,
      vx = 0,
      vy = 0,
      vz = 0,
      nx = 0,
      ny = 1,
      nz = 0,
      foam = 0,
      jacobian = Infinity;
    for (let c = 0; c < this.cascades; c++) {
      const px = (bx / lengths[c]!) * n;
      const pz = (bz / lengths[c]!) * n;
      const ix = Math.floor(px),
        iz = Math.floor(pz);
      const tx = px - ix,
        tz = pz - iz;
      const x0 = ((ix % n) + n) % n,
        x1 = (x0 + 1) % n;
      const z0 = ((iz % n) + n) % n,
        z1 = (z0 + 1) % n;
      const base = c * cells;
      const o00 = (base + z0 * n + x0) * 12;
      const o10 = (base + z0 * n + x1) * 12;
      const o01 = (base + z1 * n + x0) * 12;
      const o11 = (base + z1 * n + x1) * 12;
      const w00 = (1 - tx) * (1 - tz),
        w10 = tx * (1 - tz),
        w01 = (1 - tx) * tz,
        w11 = tx * tz;
      const read = (ch: number) =>
        field[o00 + ch]! * w00 + field[o10 + ch]! * w10 + field[o01 + ch]! * w01 + field[o11 + ch]! * w11;
      dx += read(0);
      dy += read(1);
      dz += read(2);
      foam = Math.max(foam, read(3));
      vx += read(4);
      vy += read(5);
      vz += read(6);
      jacobian = Math.min(jacobian, read(7));
      nx += read(8);
      ny += read(9) - 1;
      nz += read(10);
    }
    const nLen = Math.hypot(nx, ny, nz) || 1;
    return {
      height: height + dy,
      displacement: [dx, dy, dz],
      normal: [nx / nLen, ny / nLen, nz / nLen],
      velocity: [vx, vy, vz],
      jacobian: Number.isFinite(jacobian) ? jacobian : 1,
      foam,
      time,
    };
  }
}
