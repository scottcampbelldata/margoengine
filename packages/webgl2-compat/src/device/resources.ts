/// <reference lib="esnext.disposable" preserve="true" />
// Buffers, textures, views, samplers, bind groups and shader modules of the compatibility device (W3C WebGPU
// specification sections 5 to 8), on WebGL2 objects. Buffers keep a CPU shadow copy where WebGPU reads them on the CPU
// (mapping, indirect arguments) or where WebGL forbids a binding (an index buffer is never also a vertex buffer in
// WebGL, so a buffer with both usages has two GL buffers kept equal).
import { checkWGSL, WGSLError } from '../wgsl.js';
import type { IRModule } from '../wgsl/ir.js';
import { type FormatInfo, FORMATS } from './formats.js';
import type { CompatDevice } from './device.js';

/** WebGPU buffer usage bits. */
const BufferUsage = {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
  QUERY_RESOLVE: 512,
} as const;
/** WebGPU texture usage bits. */
export const TextureUsage = {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
} as const;

let nextId = 1;
/** A small unique id for cache keys. */
const id = (): number => nextId++;

type Readback = { sync: WebGLSync; pack: WebGLBuffer; bytes: number; write: (data: Uint8Array) => void };

/** A GPUBuffer on WebGL2. */
export class CompatBuffer {
  readonly id = id();
  label: string;
  readonly size: number;
  readonly usage: number;
  /** GL buffer for every binding but the index binding (vertex, uniform, copies, pixel transfers). */
  readonly gl: WebGLBuffer | null;
  /** GL element buffer, for the index usage. */
  readonly element: WebGLBuffer | null;
  /** CPU copy; current when `shadowValid`. */
  readonly shadow: Uint8Array | null;
  shadowValid = true;
  mapState: 'unmapped' | 'pending' | 'mapped' = 'unmapped';
  private mapMode = 0;
  private ranges: { offset: number; data: ArrayBuffer }[] = [];
  readonly readbacks: Readback[] = [];
  destroyed = false;

  constructor(
    readonly device: CompatDevice,
    descriptor: GPUBufferDescriptor,
  ) {
    const { size, usage } = descriptor;
    if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('GPUBuffer size must be a whole number of bytes');
    this.size = size;
    this.usage = usage;
    this.label = descriptor.label ?? '';
    const gl = device.gl;
    // Uniform blocks are bound in 16-byte rows, so GL buffers are rounded up to whole rows.
    const glSize = Math.max(16, Math.ceil(size / 16) * 16);
    const gpuUses =
      BufferUsage.VERTEX |
      BufferUsage.UNIFORM |
      BufferUsage.STORAGE |
      BufferUsage.COPY_SRC |
      BufferUsage.COPY_DST |
      BufferUsage.MAP_READ |
      BufferUsage.INDIRECT;
    const staging = (usage & ~(BufferUsage.MAP_WRITE | BufferUsage.COPY_SRC)) === 0;
    this.gl =
      !staging && usage & gpuUses && usage & ~(BufferUsage.INDEX | BufferUsage.COPY_DST) ? gl.createBuffer() : null;
    if (this.gl) {
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.gl);
      gl.bufferData(gl.COPY_WRITE_BUFFER, glSize, gl.DYNAMIC_DRAW);
    }
    this.element = usage & BufferUsage.INDEX ? gl.createBuffer() : null;
    if (this.element) {
      device.state.bindVertexArray(null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.element);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, glSize, gl.DYNAMIC_DRAW);
    }
    const needsShadow =
      usage & (BufferUsage.MAP_READ | BufferUsage.MAP_WRITE | BufferUsage.INDIRECT | BufferUsage.STORAGE) ||
      (this.gl && this.element) ||
      descriptor.mappedAtCreation ||
      (!this.gl && !this.element);
    this.shadow = needsShadow ? new Uint8Array(size) : null;
    if (descriptor.mappedAtCreation) {
      if (size % 4) throw new RangeError('A buffer mapped at creation needs a size that is a multiple of 4');
      this.mapState = 'mapped';
      this.mapMode = 2;
    }
  }

  /** Writes bytes at `offset` into every copy. */
  write(offset: number, bytes: Uint8Array): void {
    const gl = this.device.gl;
    if (this.gl) {
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.gl);
      gl.bufferSubData(gl.COPY_WRITE_BUFFER, offset, bytes);
    }
    if (this.element) {
      this.device.state.bindVertexArray(null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.element);
      gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, offset, bytes);
    }
    if (this.shadow && (this.shadowValid || (offset === 0 && bytes.byteLength === this.size))) {
      this.shadow.set(bytes, offset);
      if (offset === 0 && bytes.byteLength === this.size) this.shadowValid = true;
    }
  }

  /** Brings the shadow copy up to date with the GPU (a synchronous read: callers wait on a fence first). */
  settle(): void {
    const gl = this.device.gl;
    for (const r of this.readbacks.splice(0)) {
      const data = new Uint8Array(r.bytes);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, r.pack);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(r.pack);
      gl.deleteSync(r.sync);
      r.write(data);
    }
    if (!this.shadowValid && this.shadow && this.gl) {
      gl.bindBuffer(gl.COPY_READ_BUFFER, this.gl);
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, this.shadow);
      this.shadowValid = true;
    }
  }

  /** The current bytes (settling first): for indirect arguments and copies the GPU cannot do. */
  bytes(): Uint8Array {
    if (!this.shadow) {
      // No CPU copy is kept for this usage: read the GL buffer (a stall, counted).
      const gl = this.device.gl,
        out = new Uint8Array(this.size);
      this.device.stalls++;
      gl.bindBuffer(gl.COPY_READ_BUFFER, this.gl ?? this.element);
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, out);
      return out;
    }
    if (!this.shadowValid || this.readbacks.length) {
      this.device.stalls++;
      this.settle();
    }
    return this.shadow;
  }

  mapAsync(mode: number, offset = 0, size?: number): Promise<undefined> {
    if (this.destroyed) return Promise.reject(new DOMException('The buffer is destroyed', 'OperationError'));
    if (this.mapState !== 'unmapped')
      return Promise.reject(new DOMException('The buffer is already mapped or mapping', 'OperationError'));
    if (!this.shadow)
      return Promise.reject(new DOMException('The buffer has no MAP_READ or MAP_WRITE usage', 'OperationError'));
    void offset;
    void size;
    this.mapState = 'pending';
    this.mapMode = mode;
    return this.device.idle().then(() => {
      if (this.destroyed || this.device.destroyed) {
        this.mapState = 'unmapped';
        throw new DOMException(
          'The device was lost before the buffer mapped; map it again on the restored device',
          'AbortError',
        );
      }
      if (this.mapState !== 'pending')
        throw new DOMException(
          'Unmapped before the mapping finished; call unmap() after mapAsync() resolves',
          'AbortError',
        );
      this.settle();
      this.mapState = 'mapped';
      return undefined;
    });
  }

  getMappedRange(offset = 0, size?: number): ArrayBuffer {
    if (this.mapState !== 'mapped' || !this.shadow)
      throw new DOMException('The buffer is not mapped; await mapAsync() first', 'OperationError');
    const n = size ?? this.size - offset;
    const data = this.shadow.slice(offset, offset + n).buffer;
    this.ranges.push({ offset, data });
    return data;
  }

  unmap(): void {
    if (this.mapState === 'pending') {
      this.mapState = 'unmapped';
      return;
    }
    if (this.mapState !== 'mapped') return;
    if (this.mapMode & 2) for (const r of this.ranges) this.write(r.offset, new Uint8Array(r.data));
    this.ranges = [];
    this.mapState = 'unmapped';
  }

  /** Same as destroy(): frees the buffer and its GL objects (the repository convention; WebGPU code calls destroy()). */
  dispose(): void {
    this.destroy();
  }

  /** Same as dispose(), for `using` (where the browser has Symbol.dispose). */
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const gl = this.device.gl;
    if (this.gl) gl.deleteBuffer(this.gl);
    if (this.element) gl.deleteBuffer(this.element);
    this.mapState = 'unmapped';
  }
}

/** A GPUTexture on WebGL2: a texture, or a multisample renderbuffer (plus a resolved texture when it is sampled). */
export class CompatTexture {
  readonly id = id();
  label: string;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly mipLevelCount: number;
  readonly sampleCount: number;
  readonly dimension: GPUTextureDimension;
  readonly format: GPUTextureFormat;
  readonly usage: number;
  readonly info: FormatInfo;
  /** GL texture target (TEXTURE_2D, TEXTURE_2D_ARRAY, TEXTURE_3D, TEXTURE_CUBE_MAP); 0 for a renderbuffer. */
  readonly target: number;
  readonly texture: WebGLTexture | null;
  readonly renderbuffer: WebGLRenderbuffer | null;
  /** Single-sample copy of a multisampled texture that shaders read; `stale` until the next resolve. */
  readonly resolved: WebGLTexture | null;
  stale = false;
  /** False until written: a load of an unwritten texture reads zeros, as WebGPU requires. */
  initialized = false;
  /** Base and max level last set on the GL texture. */
  levels = '';
  destroyed = false;
  /** Framebuffer keys that attach this texture, deleted with it. */
  readonly framebuffers = new Set<string>();

  constructor(
    readonly device: CompatDevice,
    descriptor: GPUTextureDescriptor,
  ) {
    const info = FORMATS.get(descriptor.format);
    if (!info) throw device.unsupported(`texture format '${descriptor.format}'`);
    this.info = info;
    const size = descriptor.size as number[] | GPUExtent3DDict;
    const [w, h, d] = Array.isArray(size)
      ? [size[0], size[1] ?? 1, size[2] ?? 1]
      : [
          (size as GPUExtent3DDict).width,
          (size as GPUExtent3DDict).height ?? 1,
          (size as GPUExtent3DDict).depthOrArrayLayers ?? 1,
        ];
    this.width = w;
    this.height = h;
    this.depthOrArrayLayers = d;
    this.mipLevelCount = descriptor.mipLevelCount ?? 1;
    this.sampleCount = descriptor.sampleCount ?? 1;
    this.dimension = descriptor.dimension ?? '2d';
    this.format = descriptor.format;
    this.usage = descriptor.usage;
    this.label = descriptor.label ?? '';
    const gl = device.gl;
    if (!w || !h || !d) throw new RangeError('GPUTexture sizes must be at least 1');
    if (this.sampleCount > 1) {
      if (this.sampleCount !== 4)
        throw new RangeError('Multisampled textures on WebGL2 take 4 samples; pass sampleCount: 4');
      this.target = 0;
      this.texture = null;
      this.renderbuffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.renderbuffer);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 4, device.enum(info.internal), w, h);
      this.resolved = descriptor.usage & TextureUsage.TEXTURE_BINDING ? this.storage(gl.TEXTURE_2D, 1, w, h, 1) : null;
      return;
    }
    this.renderbuffer = null;
    this.resolved = null;
    const hint = (descriptor as { textureBindingViewDimension?: string }).textureBindingViewDimension;
    const target =
      this.dimension === '3d'
        ? gl.TEXTURE_3D
        : hint === 'cube' || (hint === undefined && d === 6 && descriptor.viewFormats === undefined && false)
          ? gl.TEXTURE_CUBE_MAP
          : d > 1 || hint === '2d-array'
            ? gl.TEXTURE_2D_ARRAY
            : gl.TEXTURE_2D;
    this.target = target;
    this.texture = this.storage(target, this.mipLevelCount, w, h, d);
  }

  private storage(target: number, levels: number, w: number, h: number, d: number): WebGLTexture {
    const gl = this.device.gl,
      t = gl.createTexture() as WebGLTexture;
    this.device.state.scratch(target, t);
    const internal = this.device.enum(this.info.internal);
    if (target === gl.TEXTURE_3D || target === gl.TEXTURE_2D_ARRAY) gl.texStorage3D(target, levels, internal, w, h, d);
    else gl.texStorage2D(target, levels, internal, w, h);
    return t;
  }

  /** Size of a mip level. */
  levelSize(level: number): [number, number, number] {
    const d = this.dimension === '3d' ? Math.max(1, this.depthOrArrayLayers >> level) : this.depthOrArrayLayers;
    return [Math.max(1, this.width >> level), Math.max(1, this.height >> level), d];
  }

  createView(descriptor: GPUTextureViewDescriptor = {}): CompatTextureView {
    return new CompatTextureView(this, descriptor);
  }

  /** Same as destroy(): frees the texture and its GL objects (the repository convention; WebGPU code calls destroy()). */
  dispose(): void {
    this.destroy();
  }

  /** Same as dispose(), for `using` (where the browser has Symbol.dispose). */
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const gl = this.device.gl;
    this.device.dropFramebuffers(this);
    if (this.texture) {
      this.device.state.forgetTexture(this.texture);
      gl.deleteTexture(this.texture);
    }
    if (this.resolved) {
      this.device.state.forgetTexture(this.resolved);
      gl.deleteTexture(this.resolved);
    }
    if (this.renderbuffer) gl.deleteRenderbuffer(this.renderbuffer);
  }
}

/** A GPUTextureView: a mip range, a layer range and a dimension of one texture. */
export class CompatTextureView {
  readonly id = id();
  label: string;
  readonly format: GPUTextureFormat;
  readonly dimension: GPUTextureViewDimension;
  readonly baseMipLevel: number;
  readonly mipLevelCount: number;
  readonly baseArrayLayer: number;
  readonly arrayLayerCount: number;
  readonly aspect: GPUTextureAspect;

  constructor(
    readonly texture: CompatTexture,
    d: GPUTextureViewDescriptor,
  ) {
    this.label = d.label ?? '';
    this.format = d.format ?? texture.format;
    if (this.format !== texture.format)
      throw texture.device.unsupported(
        `a ${this.format} view of a ${texture.format} texture (texture views are milestone M3)`,
      );
    const layers = texture.dimension === '3d' ? 1 : texture.depthOrArrayLayers;
    this.dimension =
      d.dimension ??
      (texture.dimension === '3d'
        ? '3d'
        : texture.dimension === '1d'
          ? '1d'
          : layers > 1 && texture.target !== texture.device.gl.TEXTURE_2D
            ? texture.target === texture.device.gl.TEXTURE_CUBE_MAP
              ? 'cube'
              : '2d-array'
            : '2d');
    this.baseMipLevel = d.baseMipLevel ?? 0;
    this.mipLevelCount = d.mipLevelCount ?? texture.mipLevelCount - this.baseMipLevel;
    this.baseArrayLayer = d.baseArrayLayer ?? 0;
    this.arrayLayerCount =
      d.arrayLayerCount ??
      (this.dimension === '2d' || this.dimension === '3d' || this.dimension === '1d'
        ? 1
        : layers - this.baseArrayLayer);
    this.aspect = d.aspect ?? 'all';
  }
}

/** A GPUSampler: a WebGL2 sampler object (and a nearest-filtered twin for depth textures read without comparison). */
export class CompatSampler {
  readonly id = id();
  label: string;
  readonly sampler: WebGLSampler;
  readonly comparison: boolean;
  private nearestTwin: WebGLSampler | null = null;

  constructor(
    readonly device: CompatDevice,
    private readonly d: GPUSamplerDescriptor = {},
  ) {
    this.label = d.label ?? '';
    this.comparison = d.compare !== undefined;
    this.sampler = this.make(false);
  }

  private make(nearest: boolean): WebGLSampler {
    const gl = this.device.gl,
      d = this.d,
      s = gl.createSampler() as WebGLSampler;
    const wrap = (m?: GPUAddressMode) =>
      m === 'repeat' ? gl.REPEAT : m === 'mirror-repeat' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, wrap(d.addressModeU));
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, wrap(d.addressModeV));
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_R, wrap(d.addressModeW));
    const linear = (f?: GPUFilterMode) => !nearest && f === 'linear';
    gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, linear(d.magFilter) ? gl.LINEAR : gl.NEAREST);
    const min = linear(d.minFilter),
      mip = !nearest && d.mipmapFilter === 'linear';
    gl.samplerParameteri(
      s,
      gl.TEXTURE_MIN_FILTER,
      min
        ? mip
          ? gl.LINEAR_MIPMAP_LINEAR
          : gl.LINEAR_MIPMAP_NEAREST
        : mip
          ? gl.NEAREST_MIPMAP_LINEAR
          : gl.NEAREST_MIPMAP_NEAREST,
    );
    gl.samplerParameterf(s, gl.TEXTURE_MIN_LOD, d.lodMinClamp ?? 0);
    gl.samplerParameterf(s, gl.TEXTURE_MAX_LOD, d.lodMaxClamp ?? 32);
    if (d.compare) {
      gl.samplerParameteri(s, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.samplerParameteri(s, gl.TEXTURE_COMPARE_FUNC, this.device.compare(d.compare));
    }
    const aniso = this.device.ext.anisotropic;
    if (aniso && (d.maxAnisotropy ?? 1) > 1 && !nearest)
      gl.samplerParameterf(s, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(d.maxAnisotropy as number, 16));
    return s;
  }

  /** The nearest-filtered twin: WebGL2 depth textures are incomplete under linear filtering without comparison. */
  nearest(): WebGLSampler {
    return (this.nearestTwin ??= this.make(true));
  }
}

/** A GPUShaderModule: the checked WGSL (or the error that stopped it). */
export class CompatShaderModule {
  label: string;
  readonly ir: IRModule | null;
  readonly error: WGSLError | Error | null;

  constructor(device: CompatDevice, descriptor: GPUShaderModuleDescriptor) {
    this.label = descriptor.label ?? '';
    let ir: IRModule | null = null,
      error: Error | null = null;
    try {
      ir = checkWGSL(descriptor.code);
    } catch (e) {
      if (!(e instanceof WGSLError)) throw e;
      error = e;
      device.validationError(`createShaderModule${this.label ? ` '${this.label}'` : ''}: ${e.message}`);
    }
    this.ir = ir;
    this.error = error;
  }

  getCompilationInfo(): Promise<GPUCompilationInfo> {
    const e = this.error;
    const messages =
      e instanceof WGSLError
        ? [{ message: e.detail, type: 'error', lineNum: e.line, linePos: e.column, offset: e.offset, length: 0 }]
        : [];
    return Promise.resolve({ messages } as unknown as GPUCompilationInfo);
  }
}

/** A bind group layout entry, as the device needs it. */
export interface LayoutEntry {
  readonly binding: number;
  readonly visibility: number;
  readonly buffer?: { type: string; hasDynamicOffset: boolean; minBindingSize: number };
  readonly sampler?: { type: string };
  readonly texture?: { sampleType: string; viewDimension: string; multisampled: boolean };
  readonly storageTexture?: { format: string; access: string; viewDimension: string };
  readonly externalTexture?: object;
}

/** A GPUBindGroupLayout. */
export class CompatBindGroupLayout {
  readonly id = id();
  label: string;
  readonly entries: readonly LayoutEntry[];
  /** Bindings with dynamic offsets, in binding order: the order setBindGroup's offsets come in. */
  readonly dynamic: readonly number[];

  constructor(descriptor: { entries: Iterable<GPUBindGroupLayoutEntry>; label?: string }) {
    this.label = descriptor.label ?? '';
    this.entries = [...descriptor.entries].map((e) => ({
      binding: e.binding,
      visibility: e.visibility,
      buffer: e.buffer
        ? {
            type: e.buffer.type ?? 'uniform',
            hasDynamicOffset: !!e.buffer.hasDynamicOffset,
            minBindingSize: e.buffer.minBindingSize ?? 0,
          }
        : undefined,
      sampler: e.sampler ? { type: e.sampler.type ?? 'filtering' } : undefined,
      texture: e.texture
        ? {
            sampleType: e.texture.sampleType ?? 'float',
            viewDimension: e.texture.viewDimension ?? '2d',
            multisampled: !!e.texture.multisampled,
          }
        : undefined,
      storageTexture: e.storageTexture
        ? {
            format: e.storageTexture.format,
            access: e.storageTexture.access ?? 'write-only',
            viewDimension: e.storageTexture.viewDimension ?? '2d',
          }
        : undefined,
      externalTexture: e.externalTexture,
    }));
    this.dynamic = this.entries
      .filter((e) => e.buffer?.hasDynamicOffset)
      .map((e) => e.binding)
      .sort((a, b) => a - b);
  }
}

/** A GPUPipelineLayout. */
export class CompatPipelineLayout {
  label: string;
  readonly bindGroupLayouts: readonly (CompatBindGroupLayout | null)[];
  constructor(descriptor: GPUPipelineLayoutDescriptor) {
    this.label = descriptor.label ?? '';
    this.bindGroupLayouts = [...descriptor.bindGroupLayouts] as unknown as (CompatBindGroupLayout | null)[];
  }
}

/** One bound resource of a bind group. */
export type Bound =
  | { readonly kind: 'buffer'; readonly buffer: CompatBuffer; readonly offset: number; readonly size: number }
  | { readonly kind: 'sampler'; readonly sampler: CompatSampler }
  | { readonly kind: 'view'; readonly view: CompatTextureView };

/** A GPUBindGroup. */
export class CompatBindGroup {
  readonly id = id();
  label: string;
  readonly layout: CompatBindGroupLayout;
  readonly entries = new Map<number, Bound>();

  constructor(device: CompatDevice, descriptor: GPUBindGroupDescriptor) {
    this.label = descriptor.label ?? '';
    this.layout = descriptor.layout as unknown as CompatBindGroupLayout;
    for (const e of descriptor.entries) {
      const r = e.resource as unknown;
      if (r instanceof CompatSampler) this.entries.set(e.binding, { kind: 'sampler', sampler: r });
      else if (r instanceof CompatTextureView) this.entries.set(e.binding, { kind: 'view', view: r });
      else if (r instanceof CompatTexture) this.entries.set(e.binding, { kind: 'view', view: r.createView() });
      else if (r instanceof CompatBuffer)
        this.entries.set(e.binding, { kind: 'buffer', buffer: r, offset: 0, size: r.size });
      else if (r && typeof r === 'object' && (r as GPUBufferBinding).buffer instanceof CompatBuffer) {
        const b = r as GPUBufferBinding & { buffer: CompatBuffer };
        const offset = b.offset ?? 0;
        this.entries.set(e.binding, {
          kind: 'buffer',
          buffer: b.buffer,
          offset,
          size: b.size ?? b.buffer.size - offset,
        });
      } else
        throw device.unsupported(`bind group resource at binding ${e.binding} (external textures are milestone M3)`);
    }
  }
}
