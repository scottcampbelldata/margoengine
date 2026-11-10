/// <reference lib="esnext.disposable" preserve="true" />
import type { GeoFeature, GeoResult } from '@margoengine/loaders/geo';
import type { Label, LabelRenderer } from '@margoengine/labels';
import { invertMatrix } from '@margoengine/math/mat4';
import { SRGBToLinear } from '@margoengine/math/color';
import { fault, rangeError } from '../../shared/errors.js';
import type { Figure } from './figure.js';
import { extent, rangeOption, resolveColormap, toScene, type Bounds, type ColormapSource } from './layer.js';
import { frameWGSL, requireGPU, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import { prepareGeoVectors, type GeoVectorGeometry, type GeoVectorPrepareOptions } from './geo-vector-data.js';
export { parseTopoJSON } from './geo-topology.js';
export type { TopologyOptions } from './geo-topology.js';
export { greatCircleArc, geoBins } from './geo-vector-math.js';
export type { GeoCoordinate, GeoBin } from './geo-vector-math.js';
export { parseGeoVectors, prepareGeoVectors, joinGeoData } from './geo-vector-data.js';
export type { GeoVectorGeometry, GeoVectorParseOptions, GeoVectorPrepareOptions } from './geo-vector-data.js';

declare const GPUBufferUsage: { VERTEX: number; UNIFORM: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
type RGB = readonly [number, number, number];
/** Geographic vector styling. Colours are sRGB, evaluated once per feature. */
export interface GeoVectorOptions extends GeoVectorPrepareOptions {
  /** One choropleth observation per source feature. Missing observations use missingColor. */
  readonly values?: ArrayLike<number>;
  /** Default aurora. */
  readonly colormap?: ColormapSource;
  readonly range?: readonly [number, number];
  /** Default the choropleth colour, or [0.2,0.65,0.85] without observations. */
  readonly color?: RGB | ((feature: GeoFeature, index: number, value: number) => RGB);
  /** Default [0.45,0.45,0.45]. */
  readonly missingColor?: RGB;
  /** Default true. */
  readonly fill?: boolean;
  /** Default [0.12,0.16,0.2]. */
  readonly lineColor?: RGB;
  /** Line width in drawing-buffer pixels, default 1.5; zero hides lines. */
  readonly width?: number;
  /** Point radius in drawing-buffer pixels, default 4. */
  readonly radius?: number;
  /** Default 1. */
  readonly opacity?: number;
  /** Property name or text callback; default no labels. Text is inserted with textContent. */
  readonly labels?: string | ((feature: GeoFeature, index: number) => string | undefined);
  /** Default true. */
  readonly declutter?: boolean;
  readonly attribution?: string;
}
const shader = /* wgsl */ `${frameWGSL}
struct Style { model: mat4x4f, inverse: mat4x4f, params: vec4f }
@group(1) @binding(0) var<uniform> style: Style;
struct Out { @builtin(position) clip: vec4f, @location(0) colour: vec3f,
 @location(1) data: vec3f, @location(2) normal: vec3f, @location(3) corner: vec2f }
@vertex fn vertex(@location(0) a: vec3f, @location(1) b: vec3f, @location(2) normal: vec3f,
 @location(3) colour: vec3f, @location(4) corner: vec2f) -> Out {
  var out: Out;
  let kind = style.params.w;
  var data = a;
  if (kind == 1.0) { data = mix(a, b, corner.x); }
  let ca = frame.clip * style.model * vec4f(a, 1.0);
  let cb = frame.clip * style.model * vec4f(b, 1.0);
  var c = frame.clip * style.model * vec4f(data, 1.0);
  if (kind == 1.0) {
    let d = (cb.xy / max(cb.w, 0.000001) - ca.xy / max(ca.w, 0.000001)) * frame.viewport.xy;
    let n = vec2f(-d.y, d.x) / max(length(d), 0.000001);
    c = vec4f(c.xy + n * corner.y * style.params.z / frame.viewport.xy * c.w, c.zw);
    if (ca.w <= 0.0 || cb.w <= 0.0) { c = vec4f(0.0, 0.0, 2.0, 1.0); }
  }
  if (kind == 2.0) { c = vec4f(c.xy + corner * 2.0 * style.params.z / frame.viewport.xy * c.w, c.zw); }
  out.clip = c; out.colour = colour; out.data = data; out.normal = normal; out.corner = corner;
  return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  if (style.params.y > 0.5) {
    let eye = (style.inverse * vec4f(frame.eye.xyz, 1.0)).xyz;
    if (dot(in.normal, eye - in.data) <= 0.0) { discard; }
  }
  if (style.params.w == 2.0 && dot(in.corner, in.corner) > 1.0) { discard; }
  return vec4f(toOutput(in.colour), style.params.x);
}`;
interface Batch {
  readonly cpu: Float32Array;
  readonly kind: number;
  readonly size: number;
  buffer?: GPUBuffer;
  uniform?: GPUBuffer;
  group?: GPUBindGroup;
}
let serial = 0;
/** Retained map/globe vectors, including horizon-correct points, lines, polygon holes and decluttered labels. */
export class GeoVectorLayer implements Drawable {
  #visible = true;
  readonly transparent = true;
  readonly geometry: GeoVectorGeometry;
  readonly #figure: Figure;
  readonly #options: GeoVectorOptions;
  readonly #batches: Batch[] = [];
  readonly #model = new Float32Array(16);
  readonly #inverse = new Float32Array(16);
  #layout!: GPUBindGroupLayout;
  #labels?: LabelRenderer;
  readonly #anchors: {
    label: Label;
    position: readonly [number, number, number];
    normal: readonly [number, number, number];
  }[] = [];
  #note?: HTMLElement;
  #disposed = false;
  readonly #abort = () => this.dispose();
  /** Creates and attaches a retained vector layer to a figure. */
  static attach(figure: Figure, source: GeoResult, options: GeoVectorOptions = {}): Promise<GeoVectorLayer> {
    return geoVectorLayer(figure, source, options);
  }
  get visible(): boolean {
    return this.#visible;
  }
  set visible(value: boolean) {
    this.#visible = value;
    for (const a of this.#anchors) a.label.visible = value;
    if (this.#note) this.#note.hidden = !value;
  }
  /** @internal Use geoVectorLayer. All geometry and colours are validated before GPU allocation. */
  constructor(figure: Figure, geometry: GeoVectorGeometry, options: GeoVectorOptions = {}) {
    requireGPU(figure.renderer);
    options.signal?.throwIfAborted();
    this.#figure = figure;
    this.geometry = geometry;
    this.#options = options;
    const width = options.width ?? 1.5,
      radius = options.radius ?? 4,
      opacity = options.opacity ?? 1;
    if (
      ![width, radius, opacity].every(Number.isFinite) ||
      width < 0 ||
      radius < 0 ||
      opacity < 0 ||
      opacity > 1 ||
      (options.values && options.values.length !== geometry.source.features.length)
    )
      throw rangeError('Vector style needs nonnegative pixel sizes, opacity 0..1, one value per feature', 'sciviz');
    const map = resolveColormap(options.colormap),
      range = rangeOption(options.range, 'Choropleth range') ?? extent(options.values ?? []);
    const checked = (rgb: RGB): RGB => {
      if (rgb.length !== 3 || !rgb.every((v) => Number.isFinite(v) && v >= 0 && v <= 1))
        throw rangeError('Vector colours need three sRGB components in 0..1', 'sciviz');
      return rgb.map(SRGBToLinear) as unknown as RGB;
    };
    const line = checked(options.lineColor ?? [0.12, 0.16, 0.2]);
    const missing = checked(options.missingColor ?? [0.45, 0.45, 0.45]);
    const colours = geometry.source.features.map((f, i) => {
      const value = options.values?.[i] ?? NaN;
      if (options.color)
        return checked(typeof options.color === 'function' ? options.color(f, i, value) : options.color);
      return options.values
        ? Number.isFinite(value)
          ? checked(map.sample(range[1] === range[0] ? 0.5 : (value - range[0]) / (range[1] - range[0])))
          : missing
        : checked([0.2, 0.65, 0.85]);
    });
    const batch = (
      positions: Float64Array,
      normals: Float32Array,
      features: Uint32Array,
      kind: number,
      size: number,
    ) => {
      const out: number[] = [],
        stride = kind === 0 ? 3 : kind === 1 ? 2 : 1;
      for (let i = 0; i < features.length; i++) {
        if ((i & 1023) === 0) options.signal?.throwIfAborted();
        const v = i * stride,
          a = Array.from(positions.subarray(v * 3, v * 3 + 3)),
          b = kind === 1 ? Array.from(positions.subarray((v + 1) * 3, (v + 2) * 3)) : a;
        const corners =
          kind === 0
            ? [
                [0, 0],
                [0, 0],
                [0, 0],
              ]
            : kind === 1
              ? [
                  [0, -1],
                  [1, -1],
                  [1, 1],
                  [0, -1],
                  [1, 1],
                  [0, 1],
                ]
              : [
                  [-1, -1],
                  [1, -1],
                  [1, 1],
                  [-1, -1],
                  [1, 1],
                  [-1, 1],
                ];
        corners.forEach((corner, j) => {
          const index = kind === 0 ? v + j : kind === 1 ? v + corner[0] : v;
          const pos = kind === 0 ? Array.from(positions.subarray(index * 3, index * 3 + 3)) : a;
          out.push(
            ...pos,
            ...(kind === 0 ? pos : b),
            ...normals.subarray(index * 3, index * 3 + 3),
            ...(kind === 1 ? line : colours[features[i]]),
            ...corner,
          );
        });
      }
      if (out.length) this.#batches.push({ cpu: new Float32Array(out), kind, size });
    };
    if (options.fill !== false) batch(geometry.triangles, geometry.triangleNormals, geometry.triangleFeatures, 0, 0);
    if (width) batch(geometry.lines, geometry.lineNormals, geometry.lineFeatures, 1, width);
    if (radius) batch(geometry.points, geometry.pointNormals, geometry.pointFeatures, 2, radius);
    this.#build();
    options.signal?.addEventListener('abort', this.#abort, { once: true });
  }
  /** @internal Install optional DOM labels after the asynchronous owning entry loads. */
  async installLabels(): Promise<void> {
    const options = this.#options;
    if (options.labels) {
      const [{ LabelRenderer }, { Declutter }] = await Promise.all([
        import('@margoengine/labels'),
        import('@margoengine/labels/declutter'),
      ]);
      options.signal?.throwIfAborted();
      if (this.#disposed) throw fault('disposed', 'Vector layer disposed while loading labels', 'sciviz');
      this.#labels = LabelRenderer.attach(this.#figure.engine, {
        name: `sciviz-geo-vector:${serial++}`,
        layout: options.declutter === false ? undefined : new Declutter(),
      });
      for (const anchor of this.geometry.labels) {
        const feature = this.geometry.source.features[anchor.feature];
        const text =
          typeof options.labels === 'function'
            ? options.labels(feature, anchor.feature)
            : feature.properties?.[options.labels];
        if (text === undefined || text === null || text === '') continue;
        const element = document.createElement('span');
        element.textContent = String(text);
        element.className = 'margo-geo-label';
        element.style.cssText = 'font:11px system-ui;color:white;text-shadow:0 1px 3px #000;white-space:nowrap';
        const label = this.#labels.add(element, { position: [0, 0, 0] });
        this.#anchors.push({ label, position: anchor.position, normal: anchor.normal });
      }
    }
    if (options.attribution) {
      this.#note = document.createElement('div');
      this.#note.textContent = options.attribution;
      this.#note.style.cssText =
        'position:absolute;bottom:3px;right:6px;font:10px system-ui;color:white;background:#111b;padding:3px';
      this.#figure.engine.canvas.parentElement?.append(this.#note);
    }
  }
  get bounds(): Bounds {
    return [...this.geometry.bounds];
  }
  /** @internal */
  setModel(model: Float32Array): void {
    this.#model.set(model);
    invertMatrix(model, this.#inverse);
  }
  /** @internal */
  center(): readonly [number, number, number] {
    return toScene(this.#model, 0, 0, 0);
  }
  #drop(): void {
    for (const b of this.#batches) {
      b.buffer?.destroy();
      b.uniform?.destroy();
      b.buffer = undefined;
      b.uniform = undefined;
      b.group = undefined;
    }
  }
  #build(): void {
    const device = this.#figure.renderer.device!;
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    for (const b of this.#batches) {
      b.buffer = device.createBuffer({
        size: b.cpu.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(b.buffer, 0, b.cpu as Float32Array<ArrayBuffer>);
      b.uniform = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      b.group = device.createBindGroup({
        layout: this.#layout,
        entries: [{ binding: 0, resource: { buffer: b.uniform } }],
      });
    }
  }
  /** @internal Rebuilds from retained primitives without refetch or retessellation. */
  restore(): void {
    if (!this.#disposed) {
      this.#drop();
      this.#build();
    }
  }
  /** @internal */
  prepare(context: GpuContext): void {
    const values = new Float32Array(36);
    values.set(this.#model);
    values.set(this.#inverse, 16);
    values[32] = this.#options.opacity ?? 1;
    values[33] = this.geometry.projection === 'globe' ? 1 : 0;
    for (const b of this.#batches) {
      values[34] = b.size;
      values[35] = b.kind;
      this.#figure.renderer.device!.queue.writeBuffer(b.uniform!, 0, values);
    }
    const eye = toScene(this.#inverse, ...context.camera.position);
    for (const a of this.#anchors) {
      const world = toScene(this.#model, ...a.position);
      a.label.setPosition(world);
      a.label.visible =
        this.visible &&
        (this.geometry.projection !== 'globe' || a.normal.reduce((s, n, i) => s + n * (eye[i] - a.position[i]), 0) > 0);
    }
    if (this.#note) this.#note.hidden = !this.visible;
  }
  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    const pipeline = renderer.pipeline('geo-vector', context, (target) => {
      const device = renderer.device!,
        module = device.createShaderModule({ code: shader, label: 'geo-vector' });
      return {
        layout: device.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#layout] }),
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: 56,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x3' },
                { shaderLocation: 2, offset: 24, format: 'float32x3' },
                { shaderLocation: 3, offset: 36, format: 'float32x3' },
                { shaderLocation: 4, offset: 48, format: 'float32x2' },
              ],
            },
          ],
        },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: target.format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
        multisample: target.multisample,
        depthStencil: { format: target.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' },
      };
    });
    pass.setPipeline(pipeline);
    for (const b of this.#batches) {
      pass.setBindGroup(1, b.group!);
      pass.setVertexBuffer(0, b.buffer!);
      pass.draw(b.cpu.length / 14);
    }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#options.signal?.removeEventListener('abort', this.#abort);
    this.#drop();
    this.#labels?.dispose();
    this.#anchors.length = 0;
    this.#note?.remove();
    this.#figure.renderer.remove(this);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Adds vector geography to a figure. Both the preparation and optional label imports honour cancellation. */
export async function geoVectorLayer(
  figure: Figure,
  source: GeoResult,
  options: GeoVectorOptions = {},
): Promise<GeoVectorLayer> {
  const geometry = await prepareGeoVectors(source, options);
  const layer = new GeoVectorLayer(figure, geometry, options);
  try {
    await layer.installLabels();
    options.signal?.throwIfAborted();
    figure.renderer.add(layer);
    return figure.addLayer(layer);
  } catch (error) {
    layer.dispose();
    throw error;
  }
}
