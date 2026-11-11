// KTX 2.0 RGBA16F cubemap with lossless Margo IBL metadata. No filtering or SH projection runs on load.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { Environment } from '@margoengine/environment';
import { MargoError } from '@margoengine/math/errors';
import type { Resources, Settings } from './environment.js';

declare const GPUBufferUsage: {
  MAP_READ: number;
  COPY_DST: number;
  COPY_SRC: number;
  STORAGE: number;
  UNIFORM: number;
};
declare const GPUTextureUsage: {
  TEXTURE_BINDING: number;
  COPY_DST: number;
  COPY_SRC: number;
  RENDER_ATTACHMENT: number;
};
declare const GPUMapMode: { READ: number };

/** CPU representation of a baked environment. Mips contain six tightly packed RGBA binary16 faces in cube order. */
export interface PrefilteredIBL {
  /** Source cube edge, a power of two. All source mips down to 1x1 are required. */
  size: number;
  /** Source cube mips, largest first. */
  cube: readonly Uint16Array[];
  /** Specular cube edge, a power of two no larger than size. */
  specularSize: number;
  /** GGX specular mips, largest first; roughness is mip / (count - 1). */
  specular: readonly Uint16Array[];
  /** Square BRDF LUT, packed binary16 scale and bias pairs as in Environment.brdfLut. */
  brdf: Uint32Array;
  /** Nine RGB radiance SH coefficients. */
  radiance: Float32Array;
  /** Nine RGB diffuse-ready irradiance / PI SH coefficients. */
  irradiance: Float32Array;
  /** Rotation about +Y in radians. */
  rotation: number;
  /** Nonnegative lighting multiplier. */
  intensity: number;
  /**
   * The factor the mips and SH were divided by to fit half floats (Environment.radianceScale), a finite number above
   * 0. Default 1. A file with a scale other than 1 is written as metadata version 2, the scale after the cube mips.
   */
  radianceScale?: number;
}

/** Overrides and cancellation for loading a baked environment. */
export interface PrefilteredOptions {
  /** Cancels fetch, GPU readback or upload before an environment is returned. */
  signal?: AbortSignal;
  /** Plugin name. Default 'environment'. */
  name?: string;
  /** Override the saved rotation about +Y. Default: the file's rotation. */
  rotation?: number;
  /** Override the saved intensity. Default: the file's intensity. */
  intensity?: number;
}

const signature = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 13, 10, 26, 10];
// 20 bytes including NUL: aligned binary metadata, as required by KTX 2.0 section 3.11.2.
const key = new TextEncoder().encode('margoEnvironmentIBL\0');
const align = (n: number, a = 4) => Math.ceil(n / a) * a;
const fail = (): never => {
  throw new MargoError('failed', 'Invalid prefiltered IBL KTX2; export it again with savePrefilteredEnvironment');
};
const power = (n: number) => Number.isInteger(n) && n >= 1 && n <= 16384 && (n & (n - 1)) === 0;
// The BRDF LUT edge is any integer Environment accepts for `brdfSize` (1..4096), not only a power of two.
const lutEdge = (n: number) => Number.isInteger(n) && n >= 1 && n <= 4096;
const bytes = (data: ArrayBuffer | ArrayBufferView) =>
  data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);

function validate(data: PrefilteredIBL): number {
  if (!power(data.size) || !power(data.specularSize) || data.specularSize > data.size)
    throw new RangeError('Invalid baked cube edge; use powers of two up to 16384 with specularSize <= size');
  if (!(data.brdf instanceof Uint32Array) || !lutEdge(Math.sqrt(data.brdf.length))) fail();
  // Six RGBA16F faces, including every source mip: 48 * (4 * size^2 - 1) / 3 bytes.
  // KTX2 counts the length word and padding in its u32 kvdByteLength, not only the payload.
  const scale = data.radianceScale ?? 1;
  if (!(Number.isFinite(scale) && scale > 0)) fail();
  const payloadLength = 240 + data.brdf.byteLength + 16 * (4 * data.size ** 2 - 1) + (scale === 1 ? 0 : 4);
  if (4 + align(key.length + payloadLength) > 0xffffffff)
    throw new RangeError('KTX2 metadata exceeds the 32-bit byte length limit; use a smaller source cube');
  for (const [edge, mips, full] of [
    [data.size, data.cube, true],
    [data.specularSize, data.specular, false],
  ] as const) {
    if (!mips.length || mips.length > Math.log2(edge) + 1 || (full && mips.length !== Math.log2(edge) + 1)) fail();
    for (let m = 0; m < mips.length; m++)
      if (!(mips[m] instanceof Uint16Array) || mips[m].length !== (edge >> m) ** 2 * 24) fail();
  }
  for (const sh of [data.radiance, data.irradiance])
    if (!(sh instanceof Float32Array) || sh.length !== 27 || !sh.every(Number.isFinite)) fail();
  if (!Number.isFinite(data.rotation) || !Number.isFinite(data.intensity) || data.intensity < 0) fail();
  return payloadLength;
}

// Khronos basic DFD: RGBSDA, BT.709 primaries, linear transfer, one 8-byte texel, four signed float samples.
function dfd(): Uint8Array {
  const out = new Uint8Array(92),
    d = view(out);
  d.setUint32(0, 92, true);
  d.setUint16(8, 2, true);
  d.setUint16(10, 88, true);
  out.set([1, 1, 1, 0], 12);
  out[20] = 8;
  for (let c = 0; c < 4; c++) {
    const p = 28 + c * 16;
    d.setUint16(p, c * 16, true);
    out[p + 2] = 15;
    out[p + 3] = 0xc0 | (c === 3 ? 15 : c);
    d.setFloat32(p + 8, -1, true);
    d.setFloat32(p + 12, 1, true);
  }
  return out;
}

/** Encode a baked environment as uncompressed, linear RGBA16F KTX2. Every saved GPU bit is retained. */
export function encodePrefilteredIBL(data: PrefilteredIBL): Uint8Array {
  const payloadLength = validate(data);
  const count = data.specular.length,
    dfdOffset = 80 + 24 * count,
    kvOffset = dfdOffset + 92;
  const kvLength = 4 + align(key.length + payloadLength);
  let end = align(kvOffset + kvLength, 8);
  const offsets = new Array<number>(count);
  for (let m = count - 1; m >= 0; m--) {
    offsets[m] = end;
    end += data.specular[m].byteLength;
  }
  const out = new Uint8Array(end),
    d = view(out);
  out.set(signature);
  [97, 2, data.specularSize, data.specularSize, 0, 0, 6, count, 0, dfdOffset, 92, kvOffset, kvLength].forEach(
    (value, i) => d.setUint32(12 + i * 4, value, true),
  );
  out.set(dfd(), dfdOffset);
  d.setUint32(kvOffset, key.length + payloadLength, true);
  out.set(key, kvOffset + 4);
  let p = kvOffset + 4 + key.length;
  const scale = data.radianceScale ?? 1;
  [scale === 1 ? 1 : 2, data.size, data.cube.length, Math.sqrt(data.brdf.length)].forEach((v, i) =>
    d.setUint32(p + i * 4, v, true),
  );
  d.setFloat32(p + 16, data.rotation, true);
  d.setFloat32(p + 20, data.intensity, true);
  p += 24;
  for (const sh of [data.radiance, data.irradiance])
    for (const v of sh) {
      d.setFloat32(p, v, true);
      p += 4;
    }
  for (const part of [data.brdf, ...data.cube]) {
    out.set(bytes(part), p);
    p += part.byteLength;
  }
  if (scale !== 1) d.setFloat32(p, scale, true);
  for (let m = 0; m < count; m++) {
    const length = data.specular[m].byteLength;
    d.setBigUint64(80 + 24 * m, BigInt(offsets[m]), true);
    d.setBigUint64(88 + 24 * m, BigInt(length), true);
    d.setBigUint64(96 + 24 * m, BigInt(length), true);
    out.set(bytes(data.specular[m]), offsets[m]);
  }
  return out;
}

/** Parse a Margo baked IBL KTX2, validating dimensions, metadata, mip sizes and nonoverlapping ranges before upload. */
export function parsePrefilteredIBL(input: ArrayBuffer | ArrayBufferView): PrefilteredIBL {
  const b = bytes(input),
    d = view(b);
  if (b.length < 80 || signature.some((v, i) => b[i] !== v)) fail();
  const u = (p: number) => d.getUint32(p, true);
  const size = u(20),
    count = u(40),
    df = u(48),
    dl = u(52),
    kv = u(56),
    kl = u(60);
  if (
    u(12) !== 97 ||
    u(16) !== 2 ||
    !power(size) ||
    u(24) !== size ||
    u(28) ||
    u(32) ||
    u(36) !== 6 ||
    !count ||
    count > Math.log2(size) + 1 ||
    u(44) ||
    d.getBigUint64(64, true) ||
    d.getBigUint64(72, true)
  )
    fail();
  if (df < 80 + 24 * count || df % 4 || dl !== 92 || kv !== df + dl || kv + kl > b.length || kl % 4) fail();
  if (dfd().some((v, i) => b[df + i] !== v)) fail();
  let meta: Uint8Array | undefined;
  const keys = new Set<string>();
  for (let p = kv; p < kv + kl; ) {
    if (p + 4 > kv + kl) fail();
    const n = u(p);
    p += 4;
    if (n < 2 || p + align(n) > kv + kl) fail();
    const end = b.indexOf(0, p);
    if (end <= p || end >= p + n) fail();
    const name = new TextDecoder().decode(b.subarray(p, end));
    if (keys.has(name)) fail();
    keys.add(name);
    const value = b.subarray(end + 1, p + n);
    if (name === 'margoEnvironmentIBL') meta = value;
    if (name === 'KTXorientation' && new TextDecoder().decode(value).replace(/\0$/, '') !== 'rd') fail();
    p += align(n);
  }
  if (!meta || meta.length < 240) fail();
  const md = view(meta!),
    mu = (p: number) => md.getUint32(p, true);
  const edge = mu(4),
    cubeCount = mu(8),
    brdfSize = mu(12);
  const version = mu(0);
  if ((version !== 1 && version !== 2) || !power(edge) || edge < size || cubeCount !== Math.log2(edge) + 1 || !lutEdge(brdfSize)) fail();
  const take = (offset: number, length: number): ArrayBuffer => {
    if (offset + length > meta!.length) fail();
    return meta!.slice(offset, offset + length).buffer;
  };
  const radiance = new Float32Array(take(24, 108)),
    irradiance = new Float32Array(take(132, 108));
  let p = 240;
  const brdf = new Uint32Array(take(p, brdfSize ** 2 * 4));
  p += brdf.byteLength;
  const cube: Uint16Array[] = [];
  for (let m = 0; m < cubeCount; m++) {
    const length = (edge >> m) ** 2 * 48;
    cube.push(new Uint16Array(take(p, length)));
    p += length;
  }
  if (p + (version === 2 ? 4 : 0) !== meta!.length) fail();
  const radianceScale = version === 2 ? md.getFloat32(p, true) : 1;
  if (version === 2 && radianceScale === 1) fail();
  const specular: Uint16Array[] = [];
  const ranges: [number, number][] = [[0, kv + kl]];
  for (let m = 0; m < count; m++) {
    const offset = Number(d.getBigUint64(80 + 24 * m, true)),
      length = Number(d.getBigUint64(88 + 24 * m, true));
    if (
      !Number.isSafeInteger(offset) ||
      offset % 8 ||
      length !== (size >> m) ** 2 * 48 ||
      d.getBigUint64(96 + 24 * m, true) !== BigInt(length) ||
      offset + length > b.length ||
      ranges.some(([a, z]) => offset < z && offset + length > a)
    )
      fail();
    ranges.push([offset, offset + length]);
    specular.push(new Uint16Array(b.slice(offset, offset + length).buffer));
  }
  const result = {
    size: edge,
    cube,
    specularSize: size,
    specular,
    brdf,
    radiance,
    irradiance,
    rotation: md.getFloat32(16, true),
    intensity: md.getFloat32(20, true),
    ...(version === 2 ? { radianceScale } : {}),
  };
  validate(result);
  return result;
}

function deviceOf(target: GPUDevice | EngineKernel): GPUDevice {
  const device = 'createTexture' in target ? target : engineRuntime(target).gpu;
  if (!device)
    throw new MargoError('unsupported', 'Baked IBL needs WebGPU; use WebGPU or its full WebGL2 compatibility layer');
  return device;
}

function upload(device: GPUDevice, data: PrefilteredIBL): Resources {
  const owned: { destroy(): void }[] = [];
  const track = <T extends { destroy(): void }>(value: T): T => {
    owned.push(value);
    return value;
  };
  try {
    const texture = (edge: number, mips: readonly Uint16Array[]) => {
      if (edge > device.limits.maxTextureDimension2D)
        throw new RangeError('Baked cube exceeds the device limit; bake a smaller cube');
      const t = track(
        device.createTexture({
          size: [edge, edge, 6],
          mipLevelCount: mips.length,
          format: 'rgba16float',
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.RENDER_ATTACHMENT,
        }),
      );
      mips.forEach((mip, m) => {
        const n = edge >> m;
        device.queue.writeTexture({ texture: t, mipLevel: m }, mip, { bytesPerRow: n * 8, rowsPerImage: n }, [n, n, 6]);
      });
      return t;
    };
    const buffer = (input: Float32Array | Uint32Array, usage: number) => {
      const b = track(
        device.createBuffer({
          size: input.byteLength,
          usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        }),
      );
      device.queue.writeBuffer(b, 0, input);
      return b;
    };
    const cube = texture(data.size, data.cube),
      specular = texture(data.specularSize, data.specular);
    const shData = new Float32Array(128);
    for (let i = 0; i < 9; i++) {
      shData.set(data.irradiance.subarray(i * 3, i * 3 + 3), i * 4);
      shData.set(data.radiance.subarray(i * 3, i * 3 + 3), 64 + i * 4);
    }
    const brdf = buffer(data.brdf, GPUBufferUsage.STORAGE);
    return {
      device,
      cube,
      specular,
      cubeView: cube.createView({ dimension: 'cube' }),
      specularView: specular.createView({ dimension: 'cube' }),
      brdf,
      lut: { buffer: brdf, users: 1, key: 'baked' },
      sh: buffer(shData, GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE),
      params: buffer(
        new Float32Array([
          Math.cos(data.rotation),
          Math.sin(data.rotation),
          data.specular.length - 1,
          data.intensity * (data.radianceScale ?? 1),
        ]),
        GPUBufferUsage.UNIFORM,
      ),
      sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' }),
      radiance: data.radiance.slice(),
      irradiance: data.irradiance.slice(),
      radianceScale: data.radianceScale ?? 1,
    };
  } catch (error) {
    for (const r of owned) r.destroy();
    throw error;
  }
}

class BakedEnvironment extends Environment {
  private baked?: PrefilteredIBL;
  constructor(baked: PrefilteredIBL, device: GPUDevice, name?: string) {
    const settings: Settings = {
      size: baked.size,
      specularSize: baked.specularSize,
      specularMips: baked.specular.length,
      brdfSize: Math.sqrt(baked.brdf.length),
      samples: 0,
      brdfSamples: 0,
      shSize: 0,
      float32: false,
      keepEquirect: false,
    };
    super(upload(device, baked), settings, undefined, { rotation: baked.rotation, intensity: baked.intensity, name });
    this.baked = baked;
  }
  override restore(target: GPUDevice | EngineKernel): Promise<void> {
    try {
      if (this.disposed) throw new MargoError('disposed', 'Environment is disposed; load the baked file again');
      const device = deviceOf(target);
      if (this.device === device) return Promise.resolve();
      const r = upload(device, { ...this.baked!, rotation: this.rotation, intensity: this.intensity });
      const old = this.resources;
      this.resources = r;
      if (old) for (const v of [old.cube, old.specular, old.brdf, old.sh, old.params]) v.destroy();
      this.version++;
      for (const listener of this.listeners) listener(this);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  override dispose(): void {
    super.dispose();
    this.baked = undefined;
  }
}

/** Load baked KTX2 bytes or a URL directly into Environment resources. Retains CPU bytes for device restoration. */
export async function loadPrefilteredEnvironment(
  target: GPUDevice | EngineKernel,
  source: ArrayBuffer | ArrayBufferView | string | URL,
  options: PrefilteredOptions = {},
): Promise<Environment> {
  options.signal?.throwIfAborted();
  const input =
    typeof source === 'string' || source instanceof URL
      ? await (async () => {
          const response = await fetch(source, { signal: options.signal });
          if (!response.ok)
            throw new MargoError('failed', `Baked IBL fetch returned ${response.status}; check the file URL`);
          return response.arrayBuffer();
        })()
      : source;
  options.signal?.throwIfAborted();
  const data = parsePrefilteredIBL(input);
  data.rotation = options.rotation ?? data.rotation;
  data.intensity = options.intensity ?? data.intensity;
  validate(data);
  return new BakedEnvironment(data, deviceOf(target), options.name);
}

/** Read back source/specular mips, SH and BRDF LUT and save one lossless KTX2 file. No GPU prefiltering is repeated. */
export async function savePrefilteredEnvironment(
  environment: Environment,
  options: Pick<PrefilteredOptions, 'signal'> = {},
): Promise<Uint8Array> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const device = environment.device;
  if (!device) throw new MargoError('state', 'Environment is not ready; finish restoration before saving');
  const read = async (size: number, record: (encoder: GPUCommandEncoder, buffer: GPUBuffer) => void) => {
    signal?.throwIfAborted();
    const buffer = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const abort = () => buffer.destroy();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const encoder = device.createCommandEncoder();
      record(encoder, buffer);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      signal?.throwIfAborted();
      return buffer.getMappedRange().slice(0);
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      buffer.destroy();
    }
  };
  const readMips = async (texture: GPUTexture) => {
    const mips: Uint16Array[] = [];
    for (let m = 0; m < texture.mipLevelCount; m++) {
      const edge = texture.width >> m,
        row = align(edge * 8, 256);
      const raw = new Uint8Array(
        await read(row * edge * 6, (encoder, buffer) =>
          encoder.copyTextureToBuffer({ texture, mipLevel: m }, { buffer, bytesPerRow: row, rowsPerImage: edge }, [
            edge,
            edge,
            6,
          ]),
        ),
      );
      const mip = new Uint16Array(edge * edge * 24),
        dest = bytes(mip);
      for (let y = 0; y < edge * 6; y++) dest.set(raw.subarray(y * row, y * row + edge * 8), y * edge * 8);
      mips.push(mip);
    }
    return mips;
  };
  // Snapshot scalars before asynchronous readbacks; no frame or loader work mutates this file's metadata later.
  const rotation = environment.rotation,
    intensity = environment.intensity,
    radianceScale = environment.radianceScale;
  const version = environment.version;
  const radiance = environment.sh.radiance.slice(),
    irradiance = environment.sh.irradiance.slice();
  const cube = await readMips(environment.cubeTexture),
    specular = await readMips(environment.specularTexture);
  const lut = environment.brdfLut;
  const brdf = new Uint32Array(
    await read(lut.size, (encoder, buffer) => encoder.copyBufferToBuffer(lut, 0, buffer, 0, lut.size)),
  );
  signal?.throwIfAborted();
  if (environment.disposed || environment.version !== version)
    throw new MargoError('state', 'Environment changed during save; stop captures and save again after restoration');
  return encodePrefilteredIBL({
    size: environment.size,
    specularSize: environment.specularSize,
    cube,
    specular,
    brdf,
    radiance,
    irradiance,
    rotation,
    intensity,
    radianceScale,
  });
}
