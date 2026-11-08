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

/**
 * A write to a buffer that waits for the GPU: a texture readback (a pixel buffer behind a fence, which may be forced
 * at the cost of a stall), occlusion query results (never forced: WebGL2 makes them available only in a later task),
 * or a write queued behind one of those so that writes land in submission order.
 */
type Readback = {
  ready(): boolean;
  /** True when apply() may run before ready() (a stall, counted). */
  readonly forcible: boolean;
  apply(): void;
};

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
  /** Bumped by every change of the contents, so the data texture knows when to refresh. */
  version = 0;
  /**
   * The RGBA32UI texture shaders read the buffer through as a storage buffer (WebGL2 has none): one 16-byte row per
   * texel, `1 << shift` texels wide; refreshed from the GL buffer on the GPU when the contents changed.
   */
  private data: { texture: WebGLTexture; shift: number; version: number } | null = null;
  /** @internal GPU objects the compute runtime keeps for this buffer (its word texture), freed with it. */
  computeState: { destroy(): void } | null = null;
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
      usage &
        (BufferUsage.MAP_READ |
          BufferUsage.MAP_WRITE |
          BufferUsage.INDIRECT |
          BufferUsage.STORAGE |
          BufferUsage.UNIFORM |
          BufferUsage.QUERY_RESOLVE) ||
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

  /** Writes bytes at `offset` into every copy (after the writes still waiting for the GPU, in order). */
  write(offset: number, bytes: Uint8Array): void {
    if (this.readbacks.length && !this.settle()) {
      const copy = bytes.slice();
      this.readbacks.push({ ready: () => true, forcible: true, apply: () => this.land(offset, copy) });
      return;
    }
    const gl = this.device.gl;
    this.version++;
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

  /**
   * Applies the waiting writes in order, forcing readbacks that may be forced, and brings the shadow copy up to date
   * with the GPU. False when a write cannot land yet (query results not available): it and the writes after it wait.
   */
  settle(): boolean {
    const gl = this.device.gl;
    while (this.readbacks.length) {
      const r = this.readbacks[0];
      if (!r.ready()) {
        if (!r.forcible) return false;
        this.device.stalls++;
      }
      this.readbacks.shift();
      r.apply();
    }
    if (!this.shadowValid && this.shadow && this.gl) {
      gl.bindBuffer(gl.COPY_READ_BUFFER, this.gl);
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, this.shadow);
      this.shadowValid = true;
    }
    return true;
  }

  /** Writes bytes into the GL buffers and the shadow copy at once (a waiting write's last step). */
  land(offset: number, bytes: Uint8Array): void {
    const gl = this.device.gl;
    this.version++;
    if (this.shadow) this.shadow.set(bytes.subarray(0, Math.max(0, this.size - offset)), offset);
    for (const [target, b] of [
      [gl.COPY_WRITE_BUFFER, this.gl],
      [gl.ELEMENT_ARRAY_BUFFER, this.element],
    ] as const)
      if (b) {
        if (target === gl.ELEMENT_ARRAY_BUFFER) this.device.state.bindVertexArray(null);
        gl.bindBuffer(target, b);
        gl.bufferSubData(target, offset, bytes.subarray(0, Math.max(0, this.size - offset)));
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
      if (!this.settle())
        this.device.validationError('A buffer was read on the CPU before its occlusion query results were available');
    }
    return this.shadow;
  }

  /**
   * The data texture shaders read this buffer through as a storage buffer, brought up to date first (a GPU-side copy
   * from the GL buffer through PIXEL_UNPACK_BUFFER); null for a buffer without a GL buffer.
   */
  dataTexture(): { texture: WebGLTexture; shift: number } | null {
    if (!this.gl) return null;
    const gl = this.device.gl,
      texels = Math.max(1, Math.ceil(this.size / 16));
    if (!this.data) {
      const shift = Math.min(11, Math.ceil(Math.log2(texels))),
        w = 1 << shift,
        h = Math.ceil(texels / w);
      const texture = gl.createTexture() as WebGLTexture;
      this.device.state.scratch(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, w, h);
      this.data = { texture, shift, version: -1 };
    }
    const d = this.data;
    if (d.version !== this.version) {
      if (this.readbacks.length) this.settle();
      this.device.state.scratch(gl.TEXTURE_2D, d.texture);
      uploadRows(gl, this.gl, 1 << d.shift, 0, texels, 0);
      d.version = this.version;
    }
    return d;
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
    return this.device.idle().then(async () => {
      // Occlusion results arrive a task after the GPU finishes: wait for every write this buffer still expects.
      while (!this.destroyed && !this.device.destroyed && this.mapState === 'pending' && !this.settle())
        await new Promise((resolve) => setTimeout(resolve, 1));
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
    if (this.destroyed || this.device.queue.afterWaiting(() => this.destroy())) return;
    this.destroyed = true;
    const gl = this.device.gl;
    if (this.gl) gl.deleteBuffer(this.gl);
    if (this.element) gl.deleteBuffer(this.element);
    if (this.data) {
      this.device.state.forgetTexture(this.data.texture);
      gl.deleteTexture(this.data.texture);
    }
    this.computeState?.destroy();
    this.mapState = 'unmapped';
  }
}

/**
 * One GL texture holding a texture's subresources. WebGL2 has no texture views, so a view of another format (an sRGB
 * view of a unorm texture), of one layer as 2D, of six layers as a cube, or of a cube or 2D texture as an array reads
 * a copy of its own, made when first needed and brought up to date before each use (see {@link CompatTexture.read}).
 */
export interface TextureStorage {
  readonly id: number;
  readonly texture: CompatTexture;
  readonly gl: WebGLTexture;
  /** TEXTURE_2D, TEXTURE_2D_ARRAY, TEXTURE_3D or TEXTURE_CUBE_MAP. */
  readonly target: number;
  readonly format: GPUTextureFormat;
  readonly info: FormatInfo;
  /** The first texture layer it holds and how many (all of them, except for 2D and cube copies). */
  readonly layer: number;
  readonly layers: number;
  /** The data version it holds per subresource (level * layers of the texture + layer); null until copies exist. */
  have: Uint32Array | null;
  /** Base and max level last set on the GL texture. */
  levels: string;
}

/**
 * Copies `count` 16-byte rows of a GL buffer, from byte `from`, into the RGBA32UI texture bound at TEXTURE_2D on the
 * active unit, from texel `start` on (row-major, `w` texels wide): on the GPU, through PIXEL_UNPACK_BUFFER.
 */
function uploadRows(
  gl: WebGL2RenderingContext,
  buffer: WebGLBuffer,
  w: number,
  start: number,
  count: number,
  from: number,
): void {
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, buffer);
  for (let t = start, left = count, src = from; left > 0; ) {
    const x = t % w,
      y = Math.floor(t / w);
    const rows = x === 0 ? Math.floor(left / w) : 0;
    const n = rows ? rows * w : Math.min(left, w - x);
    if (rows) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, w, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, src);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, n, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, src);
    t += n;
    left -= n;
    src += n * 16;
  }
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
}

/** Deletes the shared data textures of bind groups the program dropped (WebGPU bind groups have no destroy()). */
const dropped =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<{ gl: WebGL2RenderingContext; texture: WebGLTexture }>(({ gl, texture }) => {
        if (!gl.isContextLost()) gl.deleteTexture(texture);
      })
    : null;

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
  /** GL texture target of the primary storage; 0 for a renderbuffer. */
  readonly target: number;
  /** The primary storage's GL texture (uploads, copies and render attachments of the texture's own format). */
  readonly texture: WebGLTexture | null;
  readonly primary: TextureStorage | null;
  readonly renderbuffer: WebGLRenderbuffer | null;
  /** Single-sample copy of a multisampled texture that shaders read; `stale` until the next resolve. */
  readonly resolved: WebGLTexture | null;
  stale = false;
  /** False until written: a load of an unwritten texture reads zeros, as WebGPU requires. */
  initialized = false;
  destroyed = false;
  /** Framebuffer keys that attach this texture, deleted with it. */
  readonly framebuffers = new Set<string>();
  /** Layers as subresources count them (a 3D texture is one layer per level). */
  readonly layers: number;
  /** Copies for views GL cannot make, by format, target and first layer; null while there are none. */
  private copies: Map<string, TextureStorage> | null = null;
  /** Current data version per subresource and the storage holding it; null while the primary is the only storage. */
  private ver: Uint32Array | null = null;
  private owner: TextureStorage[] | null = null;

  constructor(
    readonly device: CompatDevice,
    descriptor: GPUTextureDescriptor,
  ) {
    const info = FORMATS.get(descriptor.format);
    if (!info) throw device.unsupported(`texture format '${descriptor.format}'`);
    if (info.block && !device.features.has(info.block.feature))
      throw new TypeError(
        `A ${descriptor.format} texture needs the '${info.block.feature}' feature; request it in requestDevice({ requiredFeatures })`,
      );
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
    this.layers = this.dimension === '3d' ? 1 : d;
    const gl = device.gl;
    if (!w || !h || !d) throw new RangeError('GPUTexture sizes must be at least 1');
    if (info.block && (w % info.block.w || h % info.block.h || this.dimension !== '2d'))
      throw new TypeError(
        `A ${this.format} texture is 2D with a size in whole ${info.block.w} x ${info.block.h} blocks; pass such a size`,
      );
    for (const f of descriptor.viewFormats ?? [])
      if (f !== this.format && !twins(info, FORMATS.get(f)))
        throw new TypeError(`'${f}' is not a view format of a '${this.format}' texture; WebGPU allows its sRGB twin`);
    if (this.sampleCount > 1) {
      if (this.sampleCount !== 4)
        throw new RangeError('Multisampled textures on WebGL2 take 4 samples; pass sampleCount: 4');
      const counts = gl.getInternalformatParameter(
        gl.RENDERBUFFER,
        device.enum(info.internal),
        gl.SAMPLES,
      ) as Int32Array | null;
      if (!counts?.includes(4))
        throw device.unsupported(
          `4x multisampled ${this.format} textures (this WebGL2 has no multisample ${info.internal} renderbuffers)`,
        );
      this.target = 0;
      this.texture = null;
      this.primary = null;
      this.renderbuffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.renderbuffer);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 4, device.enum(info.internal), w, h);
      this.resolved =
        descriptor.usage & TextureUsage.TEXTURE_BINDING ? this.allocate(gl.TEXTURE_2D, info, 1, w, h, 1) : null;
      return;
    }
    this.renderbuffer = null;
    this.resolved = null;
    // A square 6-layer 2D texture is a cube map unless told otherwise (WebGPU's compatibility-mode default): sampling
    // it as a cube is the common case, and a 2D-array or 2D view of it reads a copy.
    const hint = (descriptor as { textureBindingViewDimension?: string }).textureBindingViewDimension;
    const target =
      this.dimension === '3d'
        ? gl.TEXTURE_3D
        : hint === 'cube' || (hint === undefined && d === 6 && w === h)
          ? gl.TEXTURE_CUBE_MAP
          : d > 1 || hint === '2d-array'
            ? gl.TEXTURE_2D_ARRAY
            : gl.TEXTURE_2D;
    this.target = target;
    this.primary = this.storageOf(target, this.format, info, 0, this.layers);
    this.texture = this.primary.gl;
  }

  private allocate(target: number, info: FormatInfo, levels: number, w: number, h: number, d: number): WebGLTexture {
    const gl = this.device.gl,
      t = gl.createTexture() as WebGLTexture;
    this.device.state.scratch(target, t);
    const internal = this.device.enum(info.internal);
    if (target === gl.TEXTURE_3D || target === gl.TEXTURE_2D_ARRAY) gl.texStorage3D(target, levels, internal, w, h, d);
    else gl.texStorage2D(target, levels, internal, w, h);
    return t;
  }

  private storageOf(
    target: number,
    format: GPUTextureFormat,
    info: FormatInfo,
    layer: number,
    layers: number,
  ): TextureStorage {
    const gl = this.device.gl;
    const depth = target === gl.TEXTURE_3D ? this.depthOrArrayLayers : target === gl.TEXTURE_2D_ARRAY ? layers : 1;
    return {
      id: id(),
      texture: this,
      gl: this.allocate(target, info, this.mipLevelCount, this.width, this.height, depth),
      target,
      format,
      info,
      layer,
      layers,
      have: null,
      levels: '',
    };
  }

  /**
   * The storage a view reads when sampled: the primary, or a copy when GL cannot sample the primary as the view asks
   * (another format, a 2D view of a layer, a cube view of an array, an array view of a cube or 2D texture). `alias` 1
   * and up name further copies of the same kind: GL keeps one base and max level per texture object, so a draw that
   * samples two mip ranges of one texture reads the second through a copy of its own.
   */
  sampled(v: CompatTextureView, alias = 0): TextureStorage {
    const gl = this.device.gl,
      p = this.primary as TextureStorage;
    let target = p.target,
      layer = 0,
      layers = this.layers;
    if (v.dimension === '2d' && target !== gl.TEXTURE_2D) {
      target = gl.TEXTURE_2D;
      layer = v.baseArrayLayer;
      layers = 1;
    } else if (v.dimension === 'cube' && target !== gl.TEXTURE_CUBE_MAP) {
      target = gl.TEXTURE_CUBE_MAP;
      layer = v.baseArrayLayer;
      layers = 6;
    } else if (v.dimension === '2d-array' && target !== gl.TEXTURE_2D_ARRAY) target = gl.TEXTURE_2D_ARRAY;
    return this.copy(v.format, target, layer, layers, alias);
  }

  /** The storage a render pass writes through a view: the primary, or the copy of the view's format. */
  attached(v: CompatTextureView): TextureStorage {
    const p = this.primary as TextureStorage;
    return v.format === this.format ? p : this.copy(v.format, p.target, 0, this.layers);
  }

  private copy(format: GPUTextureFormat, target: number, layer: number, layers: number, alias = 0): TextureStorage {
    const p = this.primary as TextureStorage;
    if (!alias && format === this.format && target === p.target) return p;
    const key = `${format}:${target}:${layer}:${alias}`;
    let s = this.copies?.get(key);
    if (s) return s;
    const info = FORMATS.get(format) as FormatInfo;
    if (!info.renderable || !this.info.renderable || this.info.kind === 'stencil')
      throw this.device.unsupported(
        `a ${format} ${target === p.target ? '' : 'layer or cube '}view of a ${this.format} texture, which WebGL2 would copy (${this.format} is not renderable there)`,
      );
    s = this.storageOf(target, format, info, layer, layers);
    if (!this.copies) {
      // Tracking starts with the first copy: every subresource is current in the primary.
      const n = this.mipLevelCount * this.layers;
      this.copies = new Map();
      this.ver = new Uint32Array(n).fill(1);
      this.owner = new Array<TextureStorage>(n).fill(p);
      p.have = new Uint32Array(n).fill(1);
    }
    s.have = new Uint32Array(this.mipLevelCount * this.layers);
    this.copies.set(key, s);
    return s;
  }

  /**
   * Brings a storage's levels and layers up to date before a read (or a partial write): each subresource another
   * storage changed since is copied over with `sync`. Free while the texture has no copies.
   */
  read(
    s: TextureStorage,
    level: number,
    levels: number,
    layer: number,
    layers: number,
    sync: (from: TextureStorage, to: TextureStorage, level: number, layer: number) => void,
  ): void {
    const ver = this.ver,
      owner = this.owner,
      have = s.have;
    if (!ver || !owner || !have) return;
    for (let l = level; l < level + levels; l++)
      for (let a = layer; a < layer + layers; a++) {
        const i = l * this.layers + a;
        if (have[i] === ver[i]) continue;
        sync(owner[i], s, l, a);
        have[i] = ver[i];
      }
  }

  /** Records that `s` now holds the newest data of these levels and layers (after a write through it). */
  wrote(s: TextureStorage, level: number, levels: number, layer: number, layers: number): void {
    const ver = this.ver,
      owner = this.owner,
      have = s.have;
    if (!ver || !owner || !have) return;
    for (let l = level; l < level + levels; l++)
      for (let a = layer; a < layer + layers; a++) {
        const i = l * this.layers + a;
        have[i] = ++ver[i];
        owner[i] = s;
      }
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
    if (this.destroyed || this.device.queue.afterWaiting(() => this.destroy())) return;
    this.destroyed = true;
    const gl = this.device.gl;
    this.device.dropFramebuffers(this);
    for (const t of [this.texture, this.resolved, ...[...(this.copies?.values() ?? [])].map((c) => c.gl)])
      if (t) {
        this.device.state.forgetTexture(t);
        gl.deleteTexture(t);
      }
    if (this.renderbuffer) gl.deleteRenderbuffer(this.renderbuffer);
  }
}

/** True when `b` is the sRGB twin of `a` (or `a` of `b`): the one format reinterpretation WebGPU views allow. */
const twins = (a: FormatInfo, b: FormatInfo | undefined): boolean =>
  !!b && a.name !== b.name && a.name.replace('-srgb', '') === b.name.replace('-srgb', '');

/** A GPUTextureView: a format, a mip range, a layer range and a dimension of one texture. */
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
    if (this.format !== texture.format && !twins(texture.info, FORMATS.get(this.format)))
      throw new TypeError(`A '${texture.format}' texture has no '${this.format}' view; WebGPU allows its sRGB twin`);
    const gl = texture.device.gl,
      layers = texture.layers;
    this.dimension =
      d.dimension ??
      (texture.dimension === '3d'
        ? '3d'
        : texture.dimension === '1d'
          ? '1d'
          : layers > 1 || texture.target === gl.TEXTURE_2D_ARRAY
            ? '2d-array'
            : '2d');
    this.baseMipLevel = d.baseMipLevel ?? 0;
    this.mipLevelCount = d.mipLevelCount ?? texture.mipLevelCount - this.baseMipLevel;
    this.baseArrayLayer = d.baseArrayLayer ?? 0;
    this.arrayLayerCount =
      d.arrayLayerCount ??
      (this.dimension === '2d' || this.dimension === '3d' || this.dimension === '1d'
        ? 1
        : this.dimension === 'cube'
          ? 6
          : layers - this.baseArrayLayer);
    this.aspect = d.aspect ?? 'all';
    if (
      this.mipLevelCount < 1 ||
      this.arrayLayerCount < 1 ||
      this.baseMipLevel + this.mipLevelCount > texture.mipLevelCount ||
      this.baseArrayLayer + this.arrayLayerCount > layers
    )
      throw new RangeError(
        `The view's levels or layers lie outside the texture (${texture.mipLevelCount} levels, ${layers} layers); pass a range inside it`,
      );
  }
}

/** WebGPU compare functions in the order {@link CompatSampler.modes} numbers them (from 1). */
const COMPARE_FUNCTIONS: readonly GPUCompareFunction[] = [
  'never',
  'less',
  'equal',
  'less-equal',
  'greater',
  'not-equal',
  'greater-equal',
  'always',
];

/** A GPUSampler: a WebGL2 sampler object (and a nearest-filtered twin for depth textures read without comparison). */
export class CompatSampler {
  readonly id = id();
  label: string;
  readonly sampler: WebGLSampler;
  readonly comparison: boolean;
  /**
   * What textureGather reads by hand: address modes u, v, w (0 clamp-to-edge, 1 repeat, 2 mirror-repeat) and the
   * comparison (0 none, then never, less, equal, less-equal, greater, not-equal, greater-equal, always).
   */
  readonly modes: Int32Array;
  private nearestTwin: WebGLSampler | null = null;

  constructor(
    readonly device: CompatDevice,
    /** The descriptor it was made with (the compute runtime's CPU sampling reads its filters). */
    readonly d: GPUSamplerDescriptor = {},
  ) {
    this.label = d.label ?? '';
    this.comparison = d.compare !== undefined;
    const mode = (m?: GPUAddressMode) => (m === 'repeat' ? 1 : m === 'mirror-repeat' ? 2 : 0);
    this.modes = Int32Array.of(
      mode(d.addressModeU),
      mode(d.addressModeV),
      mode(d.addressModeW),
      d.compare ? COMPARE_FUNCTIONS.indexOf(d.compare) + 1 : 0,
    );
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

/**
 * A GPUExternalTexture: the video frame, copied into an rgba8unorm texture of the device when it is imported (WebGL2
 * has no zero-copy video; the roadmap accepts the copy). Sampled values are the frame's sRGB-encoded values, as for
 * WebGPU's `colorSpace: 'srgb'`.
 */
export class CompatExternalTexture {
  label: string;
  /** Always false: the copy stays valid, though WebGPU code imports a new one each frame. */
  readonly expired = false;
  constructor(
    readonly view: CompatTextureView,
    label = '',
  ) {
    this.label = label;
  }
}

/** A GPUBindGroup. */
export class CompatBindGroup {
  readonly id = id();
  label: string;
  readonly layout: CompatBindGroupLayout;
  readonly entries = new Map<number, Bound>();
  /** Why the group is invalid (reported when it was created), else null; a pass treats an invalid group as unset. */
  readonly invalid: string | null = null;
  /** The shared data texture of the group's storage bindings without a dynamic offset (see storageTexture()). */
  private shared: {
    texture: WebGLTexture;
    shift: number;
    rows: Map<number, number>;
    versions: Map<number, number>;
  } | null = null;

  constructor(
    private readonly device: CompatDevice,
    descriptor: GPUBindGroupDescriptor,
  ) {
    this.label = descriptor.label ?? '';
    this.layout = descriptor.layout as unknown as CompatBindGroupLayout;
    for (const e of descriptor.entries) {
      const r = e.resource as unknown;
      if (r instanceof CompatSampler) this.entries.set(e.binding, { kind: 'sampler', sampler: r });
      else if (r instanceof CompatTextureView) this.entries.set(e.binding, { kind: 'view', view: r });
      else if (r instanceof CompatTexture) this.entries.set(e.binding, { kind: 'view', view: r.createView() });
      else if (r instanceof CompatExternalTexture) this.entries.set(e.binding, { kind: 'view', view: r.view });
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
        throw new TypeError(
          `Bind group entry ${e.binding} is not a resource of this device; pass a buffer binding, sampler, texture view or external texture made by it`,
        );
    }
    // WebGPU's createBindGroup rules for buffers: the range lies inside the buffer and covers the layout's minimum
    // binding size. Without them a too-small buffer reached the CPU tier, which read past its end (a RangeError).
    for (const l of this.layout.entries) {
      const bound = this.entries.get(l.binding);
      if (!l.buffer || bound?.kind !== 'buffer') continue;
      const where = `createBindGroup${this.label ? ` '${this.label}'` : ''} @binding(${l.binding})`;
      if (bound.offset < 0 || bound.offset + bound.size > bound.buffer.size)
        this.invalid = `${where}: bytes ${bound.offset} to ${bound.offset + bound.size} are outside the ${bound.buffer.size}-byte buffer`;
      else if (bound.size < l.buffer.minBindingSize)
        this.invalid = `${where}: the binding is ${bound.size} bytes, below the layout's minimum binding size of ${l.buffer.minBindingSize}`;
      if (this.invalid) break;
    }
    if (this.invalid) device.validationError(this.invalid);
  }

  /**
   * One RGBA32UI texture holding the rows of every storage binding of the group without a dynamic offset, one after
   * another (`rows` gives each binding's first texel), so a pipeline spends one texture unit on them. A binding is
   * copied in again, on the GPU, whenever its buffer changed; null when the group has no such binding.
   */
  storageTexture(): { texture: WebGLTexture; shift: number; rows: ReadonlyMap<number, number> } | null {
    const gl = this.device.gl;
    if (!this.shared) {
      const rows = new Map<number, number>();
      let total = 0;
      for (const e of this.layout.entries) {
        const bound = this.entries.get(e.binding);
        if (!e.buffer || e.buffer.type === 'uniform' || e.buffer.hasDynamicOffset || bound?.kind !== 'buffer') continue;
        rows.set(e.binding, total);
        total += Math.max(1, Math.ceil(bound.size / 16));
      }
      if (!total) return null;
      const shift = Math.min(11, Math.ceil(Math.log2(total))),
        texture = gl.createTexture() as WebGLTexture;
      this.device.state.scratch(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, 1 << shift, Math.ceil(total / (1 << shift)));
      this.shared = { texture, shift, rows, versions: new Map() };
      dropped?.register(this, { gl, texture });
    }
    const d = this.shared;
    for (const [binding, row] of d.rows) {
      const bound = this.entries.get(binding) as Extract<Bound, { kind: 'buffer' }>,
        buffer = bound.buffer;
      if (d.versions.get(binding) === buffer.version || buffer.destroyed || !buffer.gl) continue;
      if (buffer.readbacks.length) buffer.settle();
      this.device.state.scratch(gl.TEXTURE_2D, d.texture);
      uploadRows(gl, buffer.gl, 1 << d.shift, row, Math.max(1, Math.ceil(bound.size / 16)), bound.offset);
      d.versions.set(binding, buffer.version);
    }
    return d;
  }
}
