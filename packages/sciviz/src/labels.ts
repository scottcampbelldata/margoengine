import { trackSpecLayer } from './spec-hooks.js';
// Clean room: Max (1995), Brecheisen et al. (2008), Lindholm and Bock (2013).
import { invertMatrix } from '@margoengine/math/mat4';
import { rangeError, fault } from '../../shared/errors.js';
import { f16Bits } from '../../shared/f16.js';
import type { Bounds } from './layer.js';
import type { Figure } from './figure.js';
import type { TransferRGBA } from './transfer.js';
import { frameWGSL, requireGPU, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import { volumeDepthWGSL } from './volume-depth.js';
import { fusionShader } from './labels-shader.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** A category. Unlisted integers are transparent, including zero unless explicitly listed. */
export interface VolumeLabel {
  /** Exact unsigned 32-bit category ID, never interpolated. */
  readonly id: number;
  /** Legend text. Default String(id). */
  readonly name?: string;
  /** Linear-light colour and per-voxel opacity, each in [0,1]. */
  readonly rgba: TransferRGBA;
  /** Boundary colour/opacity and thickness in framebuffer pixels (integer 1..16, default 1). Default no outline. */
  readonly outline?: { readonly rgba: TransferRGBA; readonly width?: number };
}
/** One independent scalar component, classified after interpolation. */
export interface VolumeComponent {
  /** Finite increasing physical scalar range. */
  readonly range: readonly [number, number];
  /** Physical scalar to linear RGBA. A TransferFunction is accepted directly via its evaluate method. */
  readonly transfer: ((value: number) => TransferRGBA) | { evaluate(value: number): TransferRGBA };
  /** Optical-density multiplier, default 1; zero hides the component. */
  readonly weight?: number;
}
/** Coordinates common to every source. Arrays are snapshotted at creation. */
export interface VolumeCoordinates {
  /** [nx,ny,nz], x fastest, each at least 2. */
  readonly dims: readonly [number, number, number];
  /** Bounds of first/last sample centres. Default [0,nx-1,0,ny-1,0,nz-1]. */
  readonly bounds?: Bounds;
  /** Column-major affine unit-box-to-data matrix, replacing bounds. Allows registration without resampling. */
  readonly transform?: ArrayLike<number>;
  /** Optical-density multiplier, default 1; zero hides this source. */
  readonly weight?: number;
}
/** Categorical, colour or interleaved independent-component voxels. */
export type FusionVolume = VolumeCoordinates &
  (
    | { readonly kind: 'labels'; readonly data: ArrayLike<number>; readonly labels: readonly VolumeLabel[] }
    | {
        readonly kind: 'rgb' | 'rgba';
        readonly data: ArrayLike<number>;
        /** Colour/alpha divisor, default 255 for Uint8Array/Uint8ClampedArray, otherwise 1. */
        readonly scale?: number;
        /** RGB-only per-voxel opacity, default 0.1. RGBA uses its fourth channel. */
        readonly opacity?: number;
      }
    | { readonly kind: 'components'; readonly data: ArrayLike<number>; readonly components: readonly VolumeComponent[] }
  );
/** Sample-level fusion; optical combines extinction, over gives earlier sources priority. */
export type VolumeMix = 'optical' | 'over' | 'maximum';
/** Options shared by the one ray march. */
export interface FusionOptions {
  /** Source mixing rule, default 'optical'. */
  readonly mix?: VolumeMix;
  /** Independent component mixing rule, default 'optical'. */
  readonly componentMix?: VolumeMix;
  /** Samples per smallest projected voxel, default 1.5. */
  readonly quality?: number;
  /** Overall optical-density multiplier, default 1. */
  readonly density?: number;
}
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const mixCode = (mix: VolumeMix) => ['optical', 'over', 'maximum'].indexOf(mix);
const colour = (c: TransferRGBA) => c?.length === 4 && c.every((n) => Number.isFinite(n) && n >= 0 && n <= 1);
const nonnegative = (n: number) => Number.isFinite(n) && n >= 0;
const point = (m: ArrayLike<number>, p: readonly number[]) =>
  [0, 1, 2].map((a) => m[a] * p[0] + m[4 + a] * p[1] + m[8 + a] * p[2] + m[12 + a]);
interface Source {
  input: FusionVolume;
  matrix: Float32Array;
  inverse: Float32Array;
  packed: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;
  table: Uint16Array<ArrayBuffer>;
  width: number;
  height: number;
  weights: number[];
}
function labelTable(labels: readonly VolumeLabel[]): {
  table: Uint16Array<ArrayBuffer>;
  ids: Map<number, number>;
  labels: VolumeLabel[];
} {
  const ids = new Map<number, number>(),
    copy: VolumeLabel[] = [];
  const table = new Uint16Array(Math.max(1, labels.length + 1) * 12);
  for (const [i, label] of labels.entries()) {
    if (
      !Number.isSafeInteger(label.id) ||
      label.id < 0 ||
      label.id > 0xffffffff ||
      ids.has(label.id) ||
      !colour(label.rgba) ||
      (label.outline &&
        (!colour(label.outline.rgba) ||
          !Number.isInteger(label.outline.width ?? 1) ||
          (label.outline.width ?? 1) < 1 ||
          (label.outline.width ?? 1) > 16))
    )
      throw rangeError('Labels need distinct uint32 IDs, RGBA in [0,1] and outline width 1..16', 'sciviz');
    ids.set(label.id, i + 1);
    const row = labels.length + 1;
    label.rgba.forEach((n, c) => (table[4 * (i + 1) + c] = f16Bits(n)));
    (label.outline?.rgba ?? [0, 0, 0, 0]).forEach((n, c) => (table[4 * (row + i + 1) + c] = f16Bits(n)));
    table[4 * (2 * row + i + 1)] = f16Bits(label.outline ? (label.outline.width ?? 1) : 0);
    copy.push(structuredClone(label));
  }
  return { table, ids, labels: copy };
}
function source(input: FusionVolume): Source {
  const dims = input.dims,
    count = dims?.reduce((a, b) => a * b, 1);
  if (
    dims?.length !== 3 ||
    !dims.every((n) => Number.isSafeInteger(n) && n >= 2) ||
    !Number.isSafeInteger(count) ||
    !nonnegative(input.weight ?? 1)
  )
    throw rangeError('A fusion volume needs three integer dimensions >=2 and a finite nonnegative weight', 'sciviz');
  const b = input.bounds ?? [0, dims[0] - 1, 0, dims[1] - 1, 0, dims[2] - 1];
  if (b.length !== 6 || !b.every(Number.isFinite) || [0, 1, 2].some((a) => b[2 * a + 1] <= b[2 * a]))
    throw rangeError('Fusion bounds must be finite and increasing', 'sciviz');
  const matrix = identity();
  for (let a = 0; a < 3; a++) {
    matrix[a * 5] = b[2 * a + 1] - b[2 * a];
    matrix[12 + a] = b[2 * a];
  }
  if (input.transform) {
    if (input.transform.length !== 16 || Array.from(input.transform).some((n) => !Number.isFinite(n)))
      throw rangeError('Volume transform must be a finite affine 4x4 matrix', 'sciviz');
    matrix.set(input.transform);
  }
  const inverse = new Float32Array(16);
  const determinant =
    matrix[0] * (matrix[5] * matrix[10] - matrix[9] * matrix[6]) -
    matrix[4] * (matrix[1] * matrix[10] - matrix[9] * matrix[2]) +
    matrix[8] * (matrix[1] * matrix[6] - matrix[5] * matrix[2]);
  if (
    matrix[3] !== 0 ||
    matrix[7] !== 0 ||
    matrix[11] !== 0 ||
    matrix[15] !== 1 ||
    !Number.isFinite(determinant) ||
    determinant === 0
  )
    throw rangeError('Volume transform must be invertible and affine', 'sciviz');
  invertMatrix(matrix, inverse);
  if (!Array.from(inverse).every(Number.isFinite))
    throw rangeError('Volume transform is outside the GPU float range', 'sciviz');
  let width = 256,
    height = 4,
    table = new Uint16Array(width * height * 4),
    packed: Source['packed'],
    weights = [1, 1, 1, 1];
  if (input.kind === 'labels') {
    if (input.data.length !== count) throw rangeError('Label data length must equal nx*ny*nz', 'sciviz');
    const palette = labelTable(input.labels);
    table = palette.table;
    width = input.labels.length + 1;
    height = 3;
    packed = new Uint32Array(count);
    // Preserve unknown label boundaries too: unique unknown IDs get distinct indices after the palette.
    const ids = new Map(palette.ids);
    for (let i = 0; i < count; i++) {
      const id = input.data[i];
      if (!Number.isSafeInteger(id) || id < 0 || id > 0xffffffff)
        throw rangeError('Label voxels must be exact uint32 integers', 'sciviz');
      if (!ids.has(id)) ids.set(id, width + ids.size);
      packed[i] = ids.get(id)!;
    }
    input = { ...input, dims: [...dims], data: Uint32Array.from(input.data), labels: palette.labels };
  } else {
    const channels =
      input.kind === 'components' ? input.components.length : input.kind === 'rgb' ? 3 : input.kind === 'rgba' ? 4 : 0;
    if (channels < 1 || channels > 4 || input.data.length !== count * channels)
      throw rangeError('Fusion data needs 1..4 complete interleaved components per voxel', 'sciviz');
    if (input.kind === 'components') {
      for (const [c, component] of input.components.entries()) {
        const r = component.range;
        if (r?.length !== 2 || !r.every(Number.isFinite) || r[1] <= r[0] || !nonnegative(component.weight ?? 1))
          throw rangeError('Components need finite increasing ranges and nonnegative weights', 'sciviz');
        weights[c] = component.weight ?? 1;
        for (let i = 0; i < width; i++) {
          const value = r[0] + ((r[1] - r[0]) * i) / (width - 1),
            rgba =
              typeof component.transfer === 'function' ? component.transfer(value) : component.transfer.evaluate(value);
          if (!colour(rgba)) throw rangeError('Component functions must return linear RGBA in [0,1]', 'sciviz');
          rgba.forEach((n, k) => (table[(c * width + i) * 4 + k] = f16Bits(n)));
        }
      }
    }
    const scale =
      input.kind === 'components'
        ? 1
        : (input.scale ?? (input.data instanceof Uint8Array || input.data instanceof Uint8ClampedArray ? 255 : 1));
    if (
      !(scale > 0) ||
      !Number.isFinite(scale) ||
      (input.kind !== 'components' && !colour([0, 0, 0, input.opacity ?? 0.1]))
    )
      throw rangeError('Colour volumes need positive scale and opacity in [0,1]', 'sciviz');
    packed = new Uint16Array(count * 4);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < channels; c++) {
        const v = input.data[i * channels + c];
        if (!Number.isFinite(v))
          throw rangeError('Fusion voxels must be finite; mask missing samples before drawing', 'sciviz');
        const r = input.kind === 'components' ? input.components[c].range : [0, scale];
        const normalized = (v - r[0]) / (r[1] - r[0]);
        if (input.kind !== 'components' && (normalized < 0 || normalized > 1))
          throw rangeError('RGB/RGBA channels must lie in [0,scale]', 'sciviz');
        packed[i * 4 + c] = f16Bits(Math.max(0, Math.min(1, normalized)));
      }
      if (input.kind === 'rgb') packed[i * 4 + 3] = f16Bits(input.opacity ?? 0.1);
    }
    input = { ...input, dims: [...dims], data: Float64Array.from(input.data) };
  }
  return { input, matrix, inverse, packed, table, width, height, weights };
}

/** One drawable and one ray march for up to four registered sources, with no resampling of label IDs. */
export class FusionLayer implements Drawable {
  /** Data-space union of all transformed source boxes. */
  readonly bounds: Bounds;
  /** Volume layers composite after opaque layers. */
  readonly transparent = true;
  /** @internal */
  readonly needsSceneDepth = true;
  /** Whether this volume draws. Default true. */
  visible = true;
  readonly #renderer: SciRenderer;
  readonly #sources: Source[];
  readonly #options: Required<FusionOptions>;
  #model = identity();
  #uniform: GPUBuffer | undefined;
  #textures: GPUTexture[] = [];
  #group: GPUBindGroup | undefined;
  #layout: GPUBindGroupLayout | undefined;
  #disposed = false;
  readonly #values: Float32Array;
  readonly #key: string;

  /** @internal Use fusionVolume(figure, sources, options). */
  constructor(renderer: SciRenderer, sources: readonly FusionVolume[], options: FusionOptions = {}) {
    requireGPU(renderer);
    this.#renderer = renderer;
    if (!sources.length || sources.length > 4) throw rangeError('A fusion march takes 1..4 sources', 'sciviz');
    this.#options = {
      mix: options.mix ?? 'optical',
      componentMix: options.componentMix ?? 'optical',
      quality: options.quality ?? 1.5,
      density: options.density ?? 1,
    };
    if (
      mixCode(this.#options.mix) < 0 ||
      mixCode(this.#options.componentMix) < 0 ||
      ![this.#options.quality, this.#options.density].every((n) => Number.isFinite(n) && n > 0)
    )
      throw rangeError('Fusion needs optical/over/maximum mixing and positive finite quality/density', 'sciviz');
    this.#sources = sources.map(source);
    for (const s of this.#sources) this.#checkSize(s);
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (const s of this.#sources)
      for (let k = 0; k < 8; k++) {
        const p = point(s.matrix, [k & 1, (k >> 1) & 1, (k >> 2) & 1]);
        p.forEach((n, a) => {
          lo[a] = Math.min(lo[a], n);
          hi[a] = Math.max(hi[a], n);
        });
      }
    this.bounds = [lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]];
    this.#values = new Float32Array(28 + this.#sources.length * 24);
    this.#key = this.#sources
      .map((s) => (s.input.kind === 'components' ? `components${s.input.components.length}` : s.input.kind))
      .join('|');
    this.restore();
  }
  #checkSize(s: Source): void {
    const limits = this.#renderer.device!.limits;
    if (s.input.dims.some((n) => n > limits.maxTextureDimension3D) || s.width > limits.maxTextureDimension2D)
      throw rangeError('Fusion source exceeds GPU texture dimensions; reduce the source or category count', 'sciviz');
  }
  /** Snapshot of the categorical legend for a source. */
  labels(index = 0): readonly VolumeLabel[] {
    const s = this.#sources[index];
    if (s?.input.kind !== 'labels') throw rangeError('Select a label source index', 'sciviz');
    return structuredClone(s.input.labels);
  }
  /** Atomically replace a label palette; voxels and categorical boundaries retain their original IDs. */
  setLabels(index: number, labels: readonly VolumeLabel[]): void {
    if (this.#disposed) throw fault('state', 'Fusion layer is disposed', 'sciviz');
    const s = this.#sources[index];
    if (s?.input.kind !== 'labels') throw rangeError('Select a label source index', 'sciviz');
    const replacement = source({ ...s.input, labels });
    this.#checkSize(replacement);
    this.#sources[index] = replacement;
    this.restore();
  }
  /** @internal Figure data-to-scene matrix. */
  setModel(model: Float32Array): void {
    this.#model = new Float32Array(model);
  }
  /** @internal */
  center(): readonly [number, number, number] {
    return point(
      this.#model,
      [0, 1, 2].map((a) => (this.bounds[2 * a] + this.bounds[2 * a + 1]) / 2),
    ) as [number, number, number];
  }
  /** @internal Recreate all GPU resources from owned snapshots. */
  restore(): void {
    if (this.#disposed) return;
    this.#release();
    const device = this.#renderer.device!,
      entries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ];
    this.#uniform = device.createBuffer({
      size: this.#values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const resources: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.#uniform } },
      { binding: 1, resource: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }) },
    ];
    this.#sources.forEach((s, i) => {
      this.#checkSize(s);
      const label = s.input.kind === 'labels',
        dims = [...s.input.dims];
      const data = device.createTexture({
          size: dims,
          dimension: '3d',
          format: label ? 'r32uint' : 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        }),
        table = device.createTexture({
          size: [s.width, s.height],
          format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
      this.#textures.push(data, table);
      device.queue.writeTexture(
        { texture: data },
        s.packed,
        { bytesPerRow: dims[0] * (label ? 4 : 8), rowsPerImage: dims[1] },
        dims,
      );
      device.queue.writeTexture({ texture: table }, s.table, { bytesPerRow: s.width * 8 }, [s.width, s.height]);
      entries.push(
        {
          binding: 2 + i * 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: label ? 'uint' : 'float', viewDimension: '3d' },
        },
        { binding: 3 + i * 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      );
      resources.push(
        { binding: 2 + i * 2, resource: data.createView({ dimension: '3d' }) },
        { binding: 3 + i * 2, resource: table.createView() },
      );
    });
    this.#layout = device.createBindGroupLayout({ entries });
    this.#group = device.createBindGroup({ layout: this.#layout, entries: resources });
  }
  /** @internal */
  prepare(): void {
    if (this.#disposed) return;
    const v = this.#values,
      inverse = new Float32Array(16);
    invertMatrix(this.#model, inverse);
    v.set(inverse);
    v.set(
      [this.bounds[0], this.bounds[2], this.bounds[4], this.#options.quality * (this.#renderer.samplingScale ?? 1)],
      16,
    );
    v.set([this.bounds[1], this.bounds[3], this.bounds[5], this.#options.density], 20);
    v.set([mixCode(this.#options.mix), mixCode(this.#options.componentMix), 0, 0], 24);
    this.#sources.forEach((s, i) => {
      const at = 28 + i * 24;
      v.set(s.inverse, at);
      v.set([...s.input.dims, s.input.weight ?? 1], at + 16);
      v.set(s.weights, at + 20);
    });
    this.#renderer.device!.queue.writeBuffer(this.#uniform!, 0, v);
  }
  /** @internal Fullscreen triangle handles camera-inside and arbitrary source orientation alike. */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (this.#disposed) return;
    const pipeline = renderer.pipeline(`fusion|${this.#key}`, context, (target) => {
      const module = renderer.device!.createShaderModule({
        code: frameWGSL + volumeDepthWGSL + fusionShader(this.#sources.map((s) => s.input)),
        label: 'sciviz fusion',
      });
      return {
        layout: renderer.device!.createPipelineLayout({
          bindGroupLayouts: [renderer.frameLayout!, this.#layout!, renderer.depthLayout!],
        }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: target.format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
        multisample: target.multisample,
        depthStencil: { format: target.depth, depthWriteEnabled: false, depthCompare: 'always' },
      };
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#group!);
    pass.setBindGroup(2, renderer.depthGroup!);
    pass.draw(3);
  }
  #release(): void {
    this.#uniform?.destroy();
    for (const t of this.#textures) t.destroy();
    this.#textures = [];
    this.#group = undefined;
  }
  /** Remove from the renderer and free device resources. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#renderer.remove(this);
    this.#release();
  }
  /** Same as dispose(), for using. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Attach categorical, colour and independent-component volumes in one march. Sources are snapshotted. */
export function fusionVolume(
  figure: Figure,
  sources: readonly FusionVolume[],
  options: FusionOptions = {},
): FusionLayer {
  const layer = new FusionLayer(figure.renderer, sources, options);
  try {
    figure.addLayer(layer);
    figure.renderer.add(layer);
    return trackSpecLayer(figure, 'fusion', [sources, options], layer);
  } catch (e) {
    layer.dispose();
    throw e;
  }
}
/** A categorical legend with accessible text; call update() after editing the layer's palette. */
export interface LabelLegend {
  /** Refresh using the current category names, colours, opacity and outlines. */
  update(): void;
  /** Remove only this legend's DOM. */
  dispose(): void;
  /** Same as dispose(), for using. */
  [Symbol.dispose](): void;
}
/** Append a categorical HTML legend without modifying other children of the container. */
export function labelLegend(container: HTMLElement, layer: FusionLayer, sourceIndex = 0): LabelLegend {
  const list = container.ownerDocument.createElement('ul');
  list.setAttribute('aria-label', 'Volume categories');
  container.append(list);
  const update = () => {
    list.replaceChildren();
    for (const label of layer.labels(sourceIndex)) {
      const item = list.ownerDocument.createElement('li'),
        swatch = list.ownerDocument.createElement('span');
      const c = label.rgba[3] ? label.rgba : (label.outline?.rgba ?? label.rgba);
      const srgb = (x: number) => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
      swatch.style.cssText = `display:inline-block;width:1em;height:1em;margin-right:.5em;background:rgba(${c.slice(0, 3).map(srgb).join(',')},${c[3]})`;
      item.append(swatch, `${label.name ?? label.id} (${label.id})`);
      list.append(item);
    }
  };
  update();
  const dispose = () => list.remove();
  return { update, dispose, [Symbol.dispose]: dispose };
}
