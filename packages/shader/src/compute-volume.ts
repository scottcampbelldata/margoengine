/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import { observeDeviceLoss } from './compute.js';
import { push, statement } from './control.js';
import {
  MUTABLE,
  Node,
  cast,
  unique,
  uvec3,
  vec3,
  type Builder,
  type NodeInput,
  type Program,
  type Resource,
} from './node.js';
import { bytes, sampled, texel, type StorageFormat, type Texel } from './storage-format.js';
import type { StorageTextureOptions } from './compute-texture.js';
import type { BindableTexture } from './texture.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; STORAGE_BINDING: number; COPY_SRC: number; COPY_DST: number };

/** Options for a writable volume or layered image. */
export interface ComputeVolumeOptions<F extends StorageFormat = StorageFormat> extends StorageTextureOptions<F> {
  /** Default '3d'. '2d-array' keeps each layer separate when sampling. */
  dimension?: '3d' | '2d-array';
  /** Keep two images and swap after each writing dispatch. Default false. */
  pingPong?: boolean;
  /** In-place r32 access, requiring readonly_and_readwrite_storage_textures. Default false. */
  readWrite?: boolean;
}
type Coord = Node<'vec3u' | 'vec3i'>;
const coordinate = (at: Coord): Coord => {
  if (at?.type !== 'vec3u' && at?.type !== 'vec3i')
    throw new TypeError('Volume coordinates must be vec3u or vec3i; use volume.coord(index)');
  return at;
};
interface Image {
  texture: GPUTexture;
  view: GPUTextureView;
}
interface DeviceImages {
  images: Image[];
  current: number;
  sampler?: GPUSampler;
  stop(): void;
}

/** A storage texture with depth or array layers, usable by ComputePass, NodePass and NodeMaterial. */
export class ComputeVolume<F extends StorageFormat = StorageFormat> implements BindableTexture {
  readonly dimension: '3d' | '2d-array';
  readonly format: F;
  readonly data?: ArrayBufferView<ArrayBuffer>;
  /** Width times height times depth; one invocation per voxel with coord(i). */
  readonly pixels: number;
  readonly pingPong: boolean;
  readonly readWrite: boolean;
  private readonly id = unique();
  private readonly devices = new Map<GPUDevice, DeviceImages>();
  private readonly uses = new WeakMap<Program, number>();
  private readonly reader: Resource;
  private readonly writer: Resource;
  private readonly filter: GPUFilterMode;
  private readonly wrap: GPUAddressMode;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly depth: number,
    options: ComputeVolumeOptions<F> = {},
  ) {
    const {
      dimension = '3d',
      format = 'rgba16float' as F,
      data,
      filter = 'linear',
      wrap = 'clamp-to-edge',
      pingPong = false,
      readWrite = false,
    } = options;
    if (
      ![width, height, depth].every((n) => Number.isSafeInteger(n) && n > 0) ||
      !Number.isSafeInteger(width * height * depth) ||
      width * height * depth > 0xffffffff
    )
      throw new RangeError('Use positive integer volume dimensions with at most 4294967295 voxels');
    if (dimension !== '3d' && dimension !== '2d-array') throw new TypeError("Use dimension '3d' or '2d-array'");
    if (!Object.hasOwn(bytes, format)) throw new TypeError('Use a supported storage texture format');
    if (data && data.byteLength !== width * height * depth * bytes[format])
      throw new RangeError(`Use volume data containing ${width * height * depth * bytes[format]} bytes in x, y, z order`);
    if (filter !== 'linear' && filter !== 'nearest') throw new TypeError("Use filter 'linear' or 'nearest'");
    if (!['clamp-to-edge', 'repeat', 'mirror-repeat'].includes(wrap))
      throw new TypeError('Use a supported texture wrap mode');
    if (readWrite && (pingPong || !/^r32/.test(format)))
      throw new TypeError('Use readWrite with an r32 format and without pingPong');
    this.dimension = dimension;
    this.format = format;
    this.data = data;
    this.filter = filter;
    this.wrap = wrap;
    this.pixels = width * height * depth;
    this.pingPong = pingPong;
    this.readWrite = readWrite;
    const dim = dimension.replace('-', '_');
    let writing: DeviceImages | undefined;
    const binding = (prefix: string, type: string, write: boolean): Resource => ({
      prefix,
      bindings: 1,
      declare: (name, group, slot) => `@group(${group}) @binding(${slot}) var ${name}:${type};`,
      entries: (device) => {
        const held = this.images(device);
        if (write) writing = held;
        return [held.images[write && pingPong ? 1 - held.current : held.current].view];
      },
      ...(write && pingPong
        ? {
            finish: () => {
              if (writing) writing.current = 1 - writing.current;
            },
          }
        : {}),
    });
    this.writer = binding('ndw', `texture_storage_${dim}<${format}, ${readWrite ? 'read_write' : 'write'}>`, true);
    this.reader = readWrite ? this.writer : binding('ndr', `texture_${dim}<${sampled(format)}>`, false);
  }
  private images(device: GPUDevice): DeviceImages {
    let held = this.devices.get(device);
    if (held) return held;
    const limit = this.dimension === '3d' ? device.limits.maxTextureDimension3D : device.limits.maxTextureDimension2D;
    const layers = this.dimension === '3d' ? limit : device.limits.maxTextureArrayLayers;
    if (this.width > limit || this.height > limit || this.depth > layers)
      throw new MargoError(
        'unsupported',
        `Volume exceeds this device's ${limit} x ${limit} x ${layers} limit; reduce its dimensions`,
      );
    if (
      this.readWrite &&
      !globalThis.navigator?.gpu?.wgslLanguageFeatures?.has('readonly_and_readwrite_storage_textures')
    )
      throw new MargoError('unsupported', 'This browser lacks read-write storage textures; use pingPong instead');
    const images = Array.from({ length: this.pingPong ? 2 : 1 }, () => {
      const texture = device.createTexture({
        label: 'shader:compute-volume',
        dimension: this.dimension === '3d' ? '3d' : '2d',
        size: [this.width, this.height, this.depth],
        format: this.format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });
      if (this.data)
        device.queue.writeTexture(
          { texture },
          this.data,
          { bytesPerRow: this.width * bytes[this.format], rowsPerImage: this.height },
          [this.width, this.height, this.depth],
        );
      return { texture, view: texture.createView({ dimension: this.dimension }) };
    });
    held = { images, current: 0, stop: observeDeviceLoss(device, () => this.devices.delete(device)) };
    this.devices.set(device, held);
    return held;
  }
  private use(b: Builder, how: number): void {
    if (this.pingPong || this.readWrite) return;
    const flags = (this.uses.get(b.program) ?? 0) | how;
    this.uses.set(b.program, flags);
    if (flags === 3)
      throw new TypeError('One pass cannot read and write the same image; use pingPong or r32 readWrite');
  }
  private at(b: Builder, at: Node): string {
    const value = b.expr(at);
    return this.dimension === '3d' ? value : `${value}.xy, i32(${value}.z)`;
  }
  /** Unfiltered voxel or layer texel, with integer x, y, z coordinates. */
  load(at: Coord): Node<Texel<F>> {
    return new Node(
      texel(this.format) as Texel<F>,
      'volume' + this.id,
      [coordinate(at)],
      (b, n) => {
        this.use(b, 1);
        return `textureLoad(${b.resource(this.reader)}, ${this.at(b, n.args[0])}${this.readWrite ? '' : ', 0'})`;
      },
      MUTABLE,
    );
  }
  /** Writes a voxel in a ComputePass body; z selects the layer for 2d-array. */
  store(at: Coord, value: NodeInput<Texel<F>>): Node {
    return push(
      statement([coordinate(at), cast(value, texel(this.format), 'stored voxel')], (b, n) => {
        if (b.stage.kind !== 'compute') throw new TypeError('Use volume.store inside a ComputePass body');
        this.use(b, 2);
        b.line(`textureStore(${b.resource(this.writer)}, ${this.at(b, n.args[0])}, ${b.expr(n.args[1])});`);
        b.epoch++;
      }),
      'store',
    );
  }
  /** Maps a linear invocation index to integer x, y, z, with x contiguous. */
  coord(i: Node<'u32'>): Node<'vec3u'> {
    return uvec3(i.mod(this.width), i.div(this.width).mod(this.height), i.div(this.width * this.height));
  }
  /** Normalized voxel centre; for arrays use xy as UV and integer coord.z as the layer. */
  uv(at: Coord): Node<'vec3f'> {
    return vec3(coordinate(at).toFloat().add(0.5)).div(vec3(this.width, this.height, this.depth)) as Node<'vec3f'>;
  }
  /** Sampling view and sampler of the latest image. Integer formats use load(). */
  bind(device: GPUDevice): [GPUTextureView, GPUSampler] {
    if (sampled(this.format) !== 'f32' || (/32float$/.test(this.format) && !device.features.has('float32-filterable')))
      throw new MargoError('unsupported', 'Use load() for integer or unfilterable float32 volumes, or use rgba16float');
    const held = this.images(device);
    held.sampler ??= device.createSampler({
      magFilter: this.filter,
      minFilter: this.filter,
      addressModeU: this.wrap,
      addressModeV: this.wrap,
      addressModeW: this.wrap,
    });
    return [held.images[held.current].view, held.sampler];
  }
  /** Latest GPU image for copies or other passes. */
  texture(device: GPUDevice): GPUTexture {
    const held = this.images(device);
    return held.images[held.current].texture;
  }
  /** Release all device copies; later use starts again from data. */
  dispose(): void {
    for (const held of this.devices.values()) {
      held.stop();
      for (const image of held.images) image.texture.destroy();
    }
    this.devices.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
/** Creates a writable 3D texture, or a 2D array with dimension: '2d-array'. */
export const storageVolume = <F extends StorageFormat = 'rgba16float'>(
  width: number,
  height: number,
  depth: number,
  options?: ComputeVolumeOptions<F>,
): ComputeVolume<F> => new ComputeVolume(width, height, depth, options);
