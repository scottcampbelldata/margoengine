import type { Figure, ScatterLayer, LineLayer, PointSelection } from './figure.js';
// Shared with figure.ts through the global registry, so this optional entry does not pull in the figure module.
const LINKED_DRAW: unique symbol = Symbol.for('@margoengine/sciviz/linked-draw') as never;
import type { RectsLayer } from './rects.js';
import type { SelectionStore, RowKey, SelectionOperation } from './link.js';
import { frameWGSL, type Drawable, type GpuContext } from './render.js';
import { fault, rangeError } from '../../shared/errors.js';
import { trackSpecLayer } from './spec-hooks.js';
import type { MaskStyle } from '../../shared/selection-mask.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number; COPY_SRC: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

type LinkedLayer = ScatterLayer | LineLayer | RectsLayer;
type NativeTarget = ScatterLayer['cloud'] | LineLayer['line'];
const views = new WeakMap<Figure, Map<SelectionStore, Set<SelectionBinding>>>();
/** Row mapping, aggregate membership and display policy for a linked layer. */
export interface SelectionBindingOptions {
  /** A key per point/vertex/rectangle. Subsets and reordered rows are supported. */
  readonly rowIds?: ArrayLike<RowKey>;
  /** For aggregate marks, the member keys per rectangle, instead of rowIds. */
  readonly groups?: readonly (readonly RowKey[])[];
  /** Default fade. Filter removes unselected marks; histogram filter also scales each bin to its selected count. */
  readonly mode?: 'highlight' | 'fade' | 'filter';
  /** Independent brush identity. Default a unique identity shared by this figure's bindings to the store. */
  readonly source?: string;
  /** Unselected brightness, default 0.12. */
  readonly fade?: number;
  readonly signal?: AbortSignal;
}

const shader = /* wgsl */ `${frameWGSL}
struct Params { model: mat4x4f, style: vec4f }
@group(1) @binding(0) var<uniform> p: Params;
@group(1) @binding(1) var<storage, read> geometry: array<f32>;
@group(1) @binding(2) var<storage, read> colours: array<u32>;
@group(1) @binding(3) var<storage, read> mask: array<f32>;
struct Out { @builtin(position) clip: vec4f,
 @location(0) @interpolate(flat) weight: f32, @location(1) @interpolate(flat) rgb: vec3f }
// One quad a rectangle (x0, y0, x1, y1 in geometry); a filtered histogram bin rises to its selected share.
@vertex fn vertex(@builtin(vertex_index) v: u32, @builtin(instance_index) k: u32) -> Out {
 let corner = v % 6u;
 let uv = vec2f(select(-1.0, 1.0, corner == 1u || corner == 2u || corner == 4u), select(-1.0, 1.0, corner == 2u || corner == 4u || corner == 5u));
 var out: Out;
 out.weight = mask[k];
 out.rgb = unpack4x8unorm(colours[k]).rgb;
 let r = k*4u;
 let x = select(geometry[r], geometry[r+2u], uv.x > 0.0);
 let top = select(geometry[r+3u], mix(geometry[r+1u], geometry[r+3u], out.weight), p.style.z > 2.5);
 let y = select(geometry[r+1u], top, uv.y > 0.0);
 out.clip = frame.clip * p.model * vec4f(x, y, -0.5, 1.0);
 return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
 if (p.style.z > 1.5 && in.weight == 0.0) { discard; }
 var c = in.rgb;
 if (in.weight == 0.0) { c *= p.style.w; }
 else if (p.style.z < 0.5) { c = mix(c,vec3f(1.0,0.7,0.15),0.7); }
 let linear = select(pow((c+0.055)/1.055,vec3f(2.4)), c/12.92, c<=vec3f(0.04045));
 return vec4f(toOutput(linear),1.0);
}`;

/**
 * Links a layer to a store. Scatter and line layers take the selection as the native per-point mask of
 * @margoengine/points and @margoengine/lines, so every point and line style (EDL, sphere shading, per-point sizes,
 * shapes, dashes, widths) and the vector exports keep working; histogram and bar rectangles draw through a mask
 * drawable of their own. Changing any number of rows writes the mask exactly once.
 */
export class SelectionBinding implements Drawable {
  readonly transparent = false;
  #visible = true;
  readonly #figure: Figure;
  readonly #layer: LinkedLayer;
  readonly #store: SelectionStore;
  readonly #options: SelectionBindingOptions;
  readonly #keys: RowKey[];
  readonly #groups: readonly (readonly RowKey[])[] | undefined;
  readonly #controller = new AbortController();
  readonly #weights: Float32Array;
  readonly #uniform = new Float32Array(20);
  readonly #geometry: Float32Array;
  readonly #colours: Uint32Array;
  /** The scatter's cloud or the line's Line, which hold the mask natively; undefined for rectangles. */
  readonly #native: NativeTarget | undefined;
  #buffers: GPUBuffer[] = [];
  #layout!: GPUBindGroupLayout;
  #group!: GPUBindGroup;
  #disposed = false;
  #operation: SelectionOperation = 'replace';
  readonly source: string;
  /** Deterministic upload count, excluding restoration and setup. */
  maskWrites = 0;

  constructor(figure: Figure, layer: LinkedLayer, store: SelectionStore, options: SelectionBindingOptions = {}) {
    if (!figure.layers.includes(layer)) throw rangeError('Bind a layer belonging to this figure', 'sciviz');
    if (!figure.renderer.device)
      throw fault('unsupported', 'Selection masks require WebGPU or webgl2-compat', 'sciviz');
    options.signal?.throwIfAborted();
    this.#figure = figure;
    this.#layer = layer;
    this.#store = store;
    this.#options = options;
    const siblings = views.get(figure)?.get(store);
    this.source = options.source ?? siblings?.values().next().value?.source ?? `view-${crypto.randomUUID()}`;
    const count =
      layer.kind === 'scatter' ? layer.count : layer.kind === 'line' ? layer.positions.length / 3 : layer.values.length;
    this.#groups = options.groups?.map((group) => [...group]);
    if (options.groups && options.rowIds) throw rangeError('Pass rowIds or groups, not both', 'sciviz');
    this.#keys = options.rowIds ? Array.from(options.rowIds) : Array.from({ length: count }, (_, i) => i);
    if ((this.#groups?.length ?? this.#keys.length) !== count)
      throw rangeError('One row key or group is required per mark', 'sciviz');
    for (const key of this.#groups ? this.#groups.flat() : this.#keys)
      if (!store.contains(key)) throw rangeError(`Unknown bound row key ${key}`, 'sciviz');
    if (!['highlight', 'fade', 'filter'].includes(options.mode ?? 'fade'))
      throw rangeError('Unknown selection display mode', 'sciviz');
    if (!Number.isFinite(options.fade ?? 0.12) || (options.fade ?? 0.12) < 0 || (options.fade ?? 0.12) > 1)
      throw rangeError('Selection fade must be in [0,1]', 'sciviz');
    this.#weights = new Float32Array(count);
    if (layer.kind === 'scatter' || layer.kind === 'line') {
      const native = (this.#native = layer.kind === 'scatter' ? layer.cloud : layer.line);
      if (native.count !== count) throw rangeError('The layer and its drawn marks differ in count', 'sciviz');
      if (native.mask) throw fault('state', 'The layer is already bound; dispose that binding first', 'sciviz');
      this.#geometry = new Float32Array(0);
      this.#colours = new Uint32Array(0);
      this.#upload();
    } else {
      this.#native = undefined;
      this.#geometry = layer.rects;
      this.#colours = new Uint32Array(count).fill(0xffd0d0d0);
      this.#colours.set(layer.colours);
      // The binding draws the rectangles in the source's place: it starts with the source's visibility and hands it
      // back on dispose.
      this.#visible = layer.visible;
      this.#rebuild();
      layer.visible = false;
      (layer as { [LINKED_DRAW]?: SelectionBinding })[LINKED_DRAW] = this;
      figure.renderer.add(this);
    }
    const stores = views.get(figure) ?? new Map<SelectionStore, Set<SelectionBinding>>();
    const bound = stores.get(store) ?? new Set<SelectionBinding>();
    bound.add(this);
    stores.set(store, bound);
    views.set(figure, stores);
    store.subscribe(() => this.#upload(), { signal: this.#controller.signal });
    const signal = this.#controller.signal;
    figure.addEventListener(
      'selection',
      ((event: CustomEvent<PointSelection>) => {
        if ([...bound].find((binding) => binding.source === this.source) !== this) return;
        const keys = new Set<RowKey>();
        let found = false;
        for (const binding of bound)
          if (binding.source === this.source)
            for (const selected of event.detail.points)
              if (selected.layer === binding.#layer) {
                found = true;
                for (const index of selected.indices)
                  for (const key of binding.#groups?.[index] ?? [binding.#keys[index]]) keys.add(key);
              }
        if (found) store.select(keys, { source: this.source, operation: this.#operation });
      }) as EventListener,
      { signal },
    );
    const canvas = (figure.engine as unknown as { canvas: HTMLCanvasElement }).canvas;
    canvas?.addEventListener(
      'pointerdown',
      (e) => {
        this.#operation = e.shiftKey ? 'toggle' : e.altKey ? 'intersect' : e.ctrlKey || e.metaKey ? 'union' : 'replace';
      },
      { signal },
    );
    canvas?.addEventListener(
      'click',
      (e) => {
        if (!this.#groups) return;
        const r = canvas.getBoundingClientRect(),
          hit = figure.pick(e.clientX - r.left, e.clientY - r.top);
        if (hit?.layer === layer)
          store.select(this.#groups[hit.index], { source: this.source, operation: this.#operation });
      },
      { signal },
    );
    options.signal?.addEventListener('abort', () => this.dispose(), { once: true, signal });
  }
  /** Whether the bound marks are drawn: the scatter's cloud or line itself, or the rectangles' mask drawable. */
  get visible(): boolean {
    return this.#native ? this.#native.visible : this.#visible;
  }
  set visible(value: boolean) {
    if (this.#native) this.#native.visible = value;
    else this.#visible = value;
  }
  /** Snapshot in layer order, including fractional membership for aggregates. */
  get weights(): Float32Array {
    return this.#weights.slice();
  }
  /**
   * The mask drawable's per-rectangle weights (one f32 each) for histogram and bar layers; undefined for scatter and
   * line layers, whose mask is `layer.cloud.mask` or `layer.line.mask` (uploaded by their plugins).
   */
  get buffer(): GPUBuffer | undefined {
    return this.#buffers[3];
  }
  /** The mask style the store's state asks for now. */
  #style(): MaskStyle {
    const mode = this.#options.mode ?? 'fade';
    return { mode: mode === 'highlight' && !this.#store.active ? 'fade' : mode, fade: this.#options.fade ?? 0.12 };
  }
  #upload(): void {
    for (let i = 0; i < this.#weights.length; i++) {
      const group = this.#groups?.[i];
      this.#weights[i] = group
        ? group.length
          ? group.reduce<number>((n, key) => n + Number(this.#store.has(key)), 0) / group.length
          : 0
        : Number(this.#store.has(this.#keys[i]));
    }
    if (this.#native) {
      const native = this.#native,
        style = this.#style();
      if (!native.mask) native.setMask(this.#weights, style);
      else {
        if (native.maskStyle.mode !== style.mode) native.setMaskStyle(style);
        native.updateMask(0, this.#weights);
      }
      this.maskWrites++;
    } else if (this.#weights.length) {
      this.#figure.renderer.device!.queue.writeBuffer(this.#buffers[3], 0, this.#weights);
      this.maskWrites++;
    }
  }
  #rebuild(): void {
    const device = this.#figure.renderer.device!;
    this.#buffers = [this.#uniform, this.#geometry, this.#colours, this.#weights].map((data, i) => {
      const buffer = device.createBuffer({
        size: Math.max(16, Math.ceil(data.byteLength / 16) * 16),
        usage:
          GPUBufferUsage.COPY_DST | (i ? GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC : GPUBufferUsage.UNIFORM),
      });
      device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
      return buffer;
    });
    this.#layout = device.createBindGroupLayout({
      entries: this.#buffers.map((_, binding) => ({
        binding,
        visibility: GPUShaderStage.VERTEX | (binding === 0 ? GPUShaderStage.FRAGMENT : 0),
        buffer: { type: binding ? ('read-only-storage' as const) : ('uniform' as const) },
      })),
    });
    this.#group = device.createBindGroup({
      layout: this.#layout,
      entries: this.#buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    this.#upload();
  }
  restore(): void {
    if (this.#native) return this.#upload();
    for (const buffer of this.#buffers) buffer.destroy();
    this.#rebuild();
  }
  /** @internal The SVG exporters' view of rectangle `index`: its height fraction and displayed sRGB colour, or null. */
  vectorRect(index: number, rgb: readonly number[]): { top: number; rgb: number[] } | null {
    const weight = this.#weights[index],
      mode = this.#options.mode ?? 'fade',
      fade = this.#options.fade ?? 0.12;
    if (mode === 'filter' && !weight) return null;
    if (!weight) return { top: 1, rgb: rgb.map((c) => c * fade) };
    if (mode === 'highlight' && this.#store.active)
      return { top: 1, rgb: rgb.map((c, k) => c + ([1, 0.7, 0.15][k] - c) * 0.7) };
    return { top: mode === 'filter' && this.#layer.kind === 'histogram' ? weight : 1, rgb: [...rgb] };
  }
  center(): readonly [number, number, number] {
    const m = this.#figure.model;
    return [m[12], m[13], m[14]];
  }
  prepare(): void {
    const layer = this.#layer;
    this.#uniform.set(this.#figure.model);
    this.#uniform.set(
      [
        1,
        2,
        this.#options.mode === 'filter'
          ? layer.kind === 'histogram'
            ? 3
            : 2
          : this.#options.mode === 'highlight' && this.#store.active
            ? 0
            : 1,
        this.#options.fade ?? 0.12,
      ],
      16,
    );
    this.#figure.renderer.device!.queue.writeBuffer(this.#buffers[0], 0, this.#uniform);
  }
  draw(pass: GPURenderPassEncoder, context: GpuContext): void {
    const renderer = this.#figure.renderer;
    const pipeline = renderer.pipeline('linked-selection', context, (target) => {
      const device = renderer.device!,
        module = device.createShaderModule({ code: shader, label: 'sciviz linked mask' });
      return {
        layout: device.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#layout] }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: target.format }] },
        primitive: { topology: 'triangle-list' },
        multisample: target.multisample,
        depthStencil: { format: target.depth, depthWriteEnabled: true, depthCompare: 'greater-equal' },
      };
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#group);
    pass.draw(6, this.#weights.length);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const stores = views.get(this.#figure),
      bound = stores?.get(this.#store);
    bound?.delete(this);
    if (!bound?.size) stores?.delete(this.#store);
    this.#controller.abort();
    if (this.#native) {
      this.#native.setMask(null);
      return;
    }
    this.#figure.renderer.remove(this);
    for (const buffer of this.#buffers) buffer.destroy();
    const target = this.#layer as RectsLayer & { [LINKED_DRAW]?: SelectionBinding };
    if (target[LINKED_DRAW] === this) delete target[LINKED_DRAW];
    target.visible = this.#visible;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Bind a layer to a shared store. Dispose the binding before replacing its layer. */
export const bindSelection = (
  figure: Figure,
  layer: LinkedLayer,
  store: SelectionStore,
  options?: SelectionBindingOptions,
): SelectionBinding => {
  const binding = new SelectionBinding(figure, layer, store, options);
  trackSpecLayer(figure, 'selection-store', [store], store);
  return trackSpecLayer(figure, 'selection-binding', [layer, store, { ...options, source: binding.source }], binding);
};
