/// <reference lib="esnext.disposable" preserve="true" />
// Textures a ComputePass writes: one storage texture, or a ping-pong pair that swaps after every dispatch that writes it.
import { MargoError } from '@margoengine/math/errors';
import { observeDeviceLoss } from './compute.js';
import { push, statement } from './control.js';
import {
  MUTABLE,
  Node,
  cast,
  unique,
  vec2,
  uvec2,
  type Builder,
  type NodeInput,
  type Program,
  type Resource,
} from './node.js';
import type { BindableTexture } from './texture.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; STORAGE_BINDING: number; COPY_DST: number; COPY_SRC: number };

import { bytes, texel, sampled, type StorageFormat, type Texel } from './storage-format.js';
export type { StorageFormat, Texel } from './storage-format.js';
/** Options for `storageTexture` and `pingPong`. */
export interface StorageTextureOptions<F extends StorageFormat = StorageFormat> {
  /** Default `'rgba16float'`: holds values outside 0..1 and can be filtered. */
  format?: F;
  /** First contents, row by row, `width * height * bytes per texel`; also what a device loss goes back to. Default zeros. */
  data?: ArrayBufferView<ArrayBuffer>;
  /** How `texture(t, uv)` filters. Default `'linear'`. */
  filter?: 'linear' | 'nearest';
  /** How `texture(t, uv)` treats coordinates outside 0..1. Default `'clamp-to-edge'`. */
  wrap?: 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
}
type Coord = Node<'vec2u' | 'vec2i'>;
const coordinate = (c: Coord): Coord => {
  if (c?.type !== 'vec2u' && c?.type !== 'vec2i')
    throw new TypeError(`A texture coordinate must be vec2u or vec2i, got ${c?.type}`);
  return c;
};
interface Image {
  texture: GPUTexture;
  view: GPUTextureView;
}
/** One image per device, made on first use and again after a device loss. */
class Images<F extends StorageFormat> {
  private readonly images = new Map<GPUDevice, { image: Image; stop(): void }>();
  constructor(private readonly owner: ComputeTexture<F>) {}
  get(device: GPUDevice): Image {
    let held = this.images.get(device);
    if (!held) {
      const { width, height, format, data } = this.owner,
        texture = device.createTexture({
          label: 'shader:storage-texture',
          size: [width, height],
          format,
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.STORAGE_BINDING |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.COPY_DST,
        });
      if (data)
        device.queue.writeTexture({ texture }, data, { bytesPerRow: width * bytes[format], rowsPerImage: height }, [
          width,
          height,
        ]);
      held = {
        image: { texture, view: texture.createView() },
        stop: observeDeviceLoss(device, () => this.images.delete(device)),
      };
      this.images.set(device, held);
    }
    return held.image;
  }
  dispose(): void {
    for (const held of this.images.values()) {
      held.stop();
      held.image.texture.destroy();
    }
    this.images.clear();
  }
}
/** What `storageTexture` and `pingPong` share: reads, writes, and being a texture for `texture()`. */
export abstract class ComputeTexture<F extends StorageFormat = StorageFormat> implements BindableTexture {
  readonly format: F;
  readonly data?: ArrayBufferView<ArrayBuffer>;
  /** `width * height`: the count for a ComputePass with one invocation per texel. */
  readonly pixels: number;
  private readonly id = unique();
  private readonly filter: 'linear' | 'nearest';
  private readonly wrap: GPUAddressMode;
  private readonly samplers = new WeakMap<GPUDevice, GPUSampler>();
  /** @internal */ protected abstract readonly reader: Resource;
  /** @internal */ protected abstract readonly writer: Resource;
  /** @internal The image `load` and `texture()` read. */ protected abstract front(device: GPUDevice): Image;
  /** @internal Called when a node reads (1) or writes (2) this texture. */ protected use(
    _b: Builder,
    _how: number,
  ): void {}
  constructor(
    readonly width: number,
    readonly height: number,
    options: StorageTextureOptions<F> = {},
  ) {
    const { format = 'rgba16float' as F, data, filter = 'linear', wrap = 'clamp-to-edge' } = options;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
      throw new RangeError('A storage texture needs an integer width and height of at least 1');
    if (!(format in bytes))
      throw new TypeError(`${String(format)} is not a storage format; use one of ${Object.keys(bytes).join(', ')}`);
    if (data && data.byteLength !== width * height * bytes[format])
      throw new RangeError(
        `Storage texture data must be ${width * height * bytes[format]} bytes for ${width} x ${height} ${format}, got ${data.byteLength}`,
      );
    this.format = format;
    this.data = data;
    this.pixels = width * height;
    this.filter = filter;
    this.wrap = wrap;
  }
  /** The texel at `coord` as it is at the start of the dispatch (no filtering; `texture(t, uv, 0)` filters). */
  load(coord: Coord): Node<Texel<F>> {
    return new Node(
      texel(this.format) as Texel<F>,
      'x' + this.id,
      [coordinate(coord)],
      (b, n) => {
        this.use(b, 1);
        return this.loaded(b.resource(this.reader), b.expr(n.args[0]));
      },
      MUTABLE,
    );
  }
  /** @internal */ protected loaded(name: string, at: string): string {
    return `textureLoad(${name}, ${at}, 0)`;
  }
  /**
   * Writes `value` to the texel at `coord`, here in the body. A number or scalar fills all four components.
   * @throws TypeError outside a ComputePass body, or when `value` has the wrong type.
   */
  store(coord: Coord, value: NodeInput<Texel<F>> | NodeInput<'f32' | 'i32' | 'u32'>): Node {
    const type = texel(this.format);
    return push(
      statement([coordinate(coord), cast(value, type, 'stored texel')], (b, n) => {
        if (b.stage.kind !== 'compute')
          throw new TypeError(
            'Storage textures are only written in ComputePass nodes; move the store into a ComputePass body',
          );
        this.use(b, 2);
        const [at, v] = n.args.map((a) => b.expr(a));
        b.line(`textureStore(${b.resource(this.writer)}, ${at}, ${v});`);
        b.epoch++;
      }),
      'store',
    );
  }
  /** The texel that invocation `i` of a one-per-texel ComputePass owns: `(i % width, i / width)`. */
  coord(i: Node<'u32'>): Node<'vec2u'> {
    return uvec2(i.mod(this.width), i.div(this.width));
  }
  /** The 0..1 coordinate of the centre of a texel, for `texture(t, uv, 0)`. */
  uv(coord: Coord): Node<'vec2f'> {
    return vec2(coord.toFloat().add(0.5)).div(vec2(this.width, this.height)) as Node<'vec2f'>;
  }
  /** @internal `texture(t)`: what a material, NodePass or compute body samples. Formats that cannot filter have `load`. */
  bind(device: GPUDevice): [GPUTextureView, GPUSampler] {
    if (sampled(this.format) !== 'f32' || (/32float$/.test(this.format) && !device.features.has('float32-filterable')))
      throw new MargoError(
        'unsupported',
        `${this.format} cannot be sampled on this device; read it with load(), or use rgba16float`,
      );
    let sampler = this.samplers.get(device);
    if (!sampler) {
      sampler = device.createSampler({
        magFilter: this.filter,
        minFilter: this.filter,
        addressModeU: this.wrap,
        addressModeV: this.wrap,
      });
      this.samplers.set(device, sampler);
    }
    return [this.front(device).view, sampler];
  }
  /** The GPU texture holding the latest contents, to copy from or hand to other code. */
  texture(device: GPUDevice): GPUTexture {
    return this.front(device).texture;
  }
  /** Destroys the GPU copies; a later use makes them again from `data`. */
  abstract dispose(): void;
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
const binding = (
  prefix: string,
  type: string,
  view: (device: GPUDevice) => GPUTextureView,
  finish?: () => void,
): Resource => ({
  prefix,
  bindings: 1,
  declare: (name, group, b) => `@group(${group}) @binding(${b}) var ${name}:${type};`,
  entries: (device) => [view(device)],
  finish,
});
/** Options for `storageTexture`. */
export interface SingleStorageOptions<F extends StorageFormat = StorageFormat> extends StorageTextureOptions<F> {
  /**
   * Lets one pass `load` and `store` this texture in place, each invocation on its own texels. r32float, r32uint and
   * r32sint only, and the browser must have the WGSL feature `readonly_and_readwrite_storage_textures`. Default false.
   */
  readWrite?: boolean;
}
const language = 'readonly_and_readwrite_storage_textures';
/** A texture a ComputePass writes and anything else reads. A pass either reads or writes it; {@link PingPongTexture} does both. */
export class StorageTexture<F extends StorageFormat = StorageFormat> extends ComputeTexture<F> {
  /** True when one pass may both load and store it. */
  readonly readWrite: boolean;
  private readonly images = new Images<F>(this);
  private readonly passes = new WeakMap<Program, number>();
  protected readonly reader: Resource;
  protected readonly writer: Resource;
  constructor(width: number, height: number, options: SingleStorageOptions<F> = {}) {
    super(width, height, options);
    this.readWrite = !!options.readWrite;
    if (this.readWrite && !/^r32/.test(this.format))
      throw new TypeError('readWrite needs r32float, r32uint or r32sint; use pingPong() for other formats');
    const view = (device: GPUDevice) => this.images.get(device).view;
    this.writer = this.readWrite
      ? binding('ndw', `texture_storage_2d<${this.format}, read_write>`, (device) => {
          if (!navigator.gpu?.wgslLanguageFeatures?.has(language))
            throw new MargoError('unsupported', `This browser lacks the WGSL feature ${language}; use pingPong()`);
          return view(device);
        })
      : binding('ndw', `texture_storage_2d<${this.format}, write>`, view);
    this.reader = this.readWrite ? this.writer : binding('ndr', `texture_2d<${sampled(this.format)}>`, view);
  }
  protected front(device: GPUDevice): Image {
    return this.images.get(device);
  }
  protected override use(b: Builder, how: number): void {
    if (this.readWrite) return;
    const passes = (this.passes.get(b.program) ?? 0) | how;
    this.passes.set(b.program, passes);
    if (passes === 3)
      throw new TypeError(
        'One pass cannot load and store the same storage texture; use pingPong(), or readWrite for r32 formats',
      );
  }
  protected override loaded(name: string, at: string): string {
    return this.readWrite ? `textureLoad(${name}, ${at})` : super.loaded(name, at);
  }
  dispose(): void {
    this.images.dispose();
  }
}
/**
 * Two textures of one size: `load` and `texture()` read the front one, `store` writes the back one, and they swap after
 * each dispatch of a pass that stores, so a pass reads last step's result and writes the next. A pass must write every
 * texel it wants kept: the back image holds the step before last.
 */
export class PingPongTexture<F extends StorageFormat = StorageFormat> extends ComputeTexture<F> {
  private readonly images = [new Images<F>(this), new Images<F>(this)];
  private current = 0;
  protected readonly reader: Resource;
  protected readonly writer: Resource;
  constructor(width: number, height: number, options: StorageTextureOptions<F> = {}) {
    super(width, height, options);
    this.reader = binding('ndr', `texture_2d<${sampled(this.format)}>`, (device) => this.front(device).view);
    this.writer = binding(
      'ndw',
      `texture_storage_2d<${this.format}, write>`,
      (device) => this.images[1 - this.current].get(device).view,
      () => this.swap(),
    );
  }
  protected front(device: GPUDevice): Image {
    return this.images[this.current].get(device);
  }
  /** Swaps by hand. A pass that stores does this after each dispatch. */
  swap(): void {
    this.current = 1 - this.current;
  }
  dispose(): void {
    for (const images of this.images) images.dispose();
  }
}
/** A texture a ComputePass writes: `const t = storageTexture(256, 256); ComputePass.attach(engine, t.pixels, i => t.store(t.coord(i), vec4(1)));`. */
export const storageTexture = <F extends StorageFormat = 'rgba16float'>(
  width: number,
  height: number,
  options?: SingleStorageOptions<F>,
): StorageTexture<F> => new StorageTexture(width, height, options);
/** A pair a ComputePass reads and writes in steps, for simulations and repeated filters: see {@link PingPongTexture}. */
export const pingPong = <F extends StorageFormat = 'rgba16float'>(
  width: number,
  height: number,
  options?: StorageTextureOptions<F>,
): PingPongTexture<F> => new PingPongTexture(width, height, options);
