/// <reference lib="esnext.disposable" preserve="true" />
import { SRGBToLinear, hexColor } from '@margoengine/math/color';
import type { GpuArray } from '@margoengine/compute';
import { fault } from '../../shared/errors.js';
import { invalid } from './graph-gpu-data.js';
import type { GPUGraphLayout } from './graph-gpu.js';
import type { GraphBundles } from './graph-gpu-bundle.js';
import type { Figure } from './figure.js';
import type { Bounds } from './layer.js';
import { dataToClip } from './pick.js';
import { registerPublicationOverlay } from './publication-labels.js';
import { frameWGSL, requireGPU, type Drawable, type GpuContext } from './render.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** Screen-space label rectangle in CSS pixels, or an anchor before placement. */
export interface GraphLabelBox {
  readonly node: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Larger values are placed first; default 0. */ readonly priority?: number;
}
/** Greedy four-position placement with a spatial hash; every returned rectangle fits and is disjoint. */
export function placeGraphLabels(
  input: readonly GraphLabelBox[],
  width: number,
  height: number,
  padding = 2,
): GraphLabelBox[] {
  if (![width, height, padding].every((v) => Number.isFinite(v) && v >= 0))
    throw invalid('Label viewport and padding must be nonnegative');
  const cells = new Map<string, GraphLabelBox[]>(),
    result: GraphLabelBox[] = [];
  const bins = (b: GraphLabelBox) => {
    const keys: string[] = [];
    for (let y = Math.floor((b.y - padding) / 64); y <= Math.floor((b.y + b.height + padding) / 64); y++)
      for (let x = Math.floor((b.x - padding) / 64); x <= Math.floor((b.x + b.width + padding) / 64); x++)
        keys.push(`${x},${y}`);
    return keys;
  };
  for (const item of [...input].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) {
    if (
      ![item.x, item.y, item.width, item.height, item.priority ?? 0].every(Number.isFinite) ||
      item.width < 0 ||
      item.height < 0
    )
      throw invalid('Label bounds must be finite');
    for (const [dx, dy] of [
      [6, -item.height / 2],
      [-item.width - 6, -item.height / 2],
      [-item.width / 2, -item.height - 6],
      [-item.width / 2, 6],
    ]) {
      const b = { ...item, x: item.x + dx, y: item.y + dy };
      if (b.x < 0 || b.y < 0 || b.x + b.width > width || b.y + b.height > height) continue;
      const keys = bins(b);
      if (
        keys.some((key) =>
          (cells.get(key) ?? []).some(
            (a) =>
              a.x < b.x + b.width + padding &&
              a.x + a.width + padding > b.x &&
              a.y < b.y + b.height + padding &&
              a.y + a.height + padding > b.y,
          ),
        )
      )
        continue;
      result.push(b);
      for (const key of keys) {
        let values = cells.get(key);
        if (!values) cells.set(key, (values = []));
        values.push(b);
      }
      break;
    }
  }
  return result;
}

/** Device graph drawing with CSS-pixel edges, arrows and collision-avoiding node labels. */
export interface GPUGraphLayerOptions {
  /** Default fixed initial layout box. */ readonly bounds?: Bounds;
  /** Diameter in CSS pixels, or one per node. Default 5. */ readonly nodeSize?: number | ArrayLike<number>;
  /** Hex colour, or one per node. Default '#3b82c4'. */ readonly nodeColor?: string | readonly string[];
  /** CSS-pixel width, or one per edge. Default 1. */ readonly edgeWidth?: number | ArrayLike<number>;
  /** Hex colour, or one per edge. Default '#6b7f94'. */ readonly edgeColor?: string | readonly string[];
  /** Edge alpha in [0,1]. Default 0.45. */ readonly edgeOpacity?: number;
  /** Arrowhead length in CSS pixels; 0 disables. Default 7. */ readonly arrowSize?: number;
  /** Optional owned-elsewhere polylines; endpoints must match the layout positions at bundling time. */ readonly bundles?: GraphBundles;
  /** Candidates in priority order. Refresh reads only these nodes, never the whole graph. Default none. */
  readonly labels?: readonly { readonly node: number; readonly text: string; readonly priority?: number }[];
  /** Maximum displayed labels, default 200. */ readonly maxLabels?: number;
}
const drawShader = `${frameWGSL}
struct Style { model: mat4x4f, pixel: vec4f }
@group(1) @binding(0) var<uniform> style: Style;
@group(1) @binding(1) var<storage, read> nodes: array<vec4f>;
@group(1) @binding(2) var<storage, read> edges: array<vec2u>;
@group(1) @binding(3) var<storage, read> edgeStyle: array<vec4f>;
@group(1) @binding(4) var<storage, read> nodeStyle: array<vec4f>;
@group(1) @binding(5) var<storage, read> bundles: array<vec4f>;
fn clip(p: vec3f) -> vec4f { return frame.clip * style.model * vec4f(p,1.0); }
fn corner(i: u32) -> vec2f {
  let q = array<vec2f,6>(vec2f(0.0,-1.0),vec2f(1.0,-1.0),vec2f(1.0,1.0),vec2f(0.0,-1.0),vec2f(1.0,1.0),vec2f(0.0,1.0)); return q[i];
}
struct Out { @builtin(position) position: vec4f, @location(0) color: vec4f, @location(1) local: vec2f }
@vertex fn nodeVertex(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  let q = corner(v) * vec2f(2.0,1.0) - vec2f(1.0,0.0); var p = clip(nodes[i].xyz);
  p = vec4f(p.xy + q * nodeStyle[i*2u+1u].x * style.pixel.x / frame.viewport.xy * p.w,p.zw);
  var out: Out; out.position=p; out.color=nodeStyle[i*2u]; out.local=q; return out;
}
@vertex fn edgeVertex(@builtin(vertex_index) v: u32, @builtin(instance_index) instance: u32) -> Out {
  let points=u32(style.pixel.y); let segments=max(2u,points)-1u; let e=instance/segments; let segment=instance%segments;
  let ends=edges[e]; var pa=nodes[ends.x].xyz; var pb=nodes[ends.y].xyz;
  if(points>0u) { pa=bundles[e*points+segment].xyz; pb=bundles[e*points+segment+1u].xyz; }
  let a=clip(pa); let b=clip(pb); let safeA=max(a.w,1e-10); let safeB=max(b.w,1e-10);
  let delta=(b.xy/safeB-a.xy/safeA)*frame.viewport.xy; let len=length(delta); let tangent=delta/max(len,1e-10); let normal=vec2f(-tangent.y,tangent.x);
  let s=edgeStyle[e*2u+1u]; var p=a; var offset=vec2f(0.0);
  if(v<6u) { let q=corner(v); p=mix(a,b,q.x); offset=normal*q.y*s.x; }
  else {
    p=b; let q=v-6u;
    if(q>0u) { offset=-tangent*s.y*2.0+normal*select(-s.y,s.y,q==1u); }
    if(segment!=segments-1u||s.y==0.0) { p=vec4f(2.0,2.0,2.0,1.0); }
  }
  p=vec4f(p.xy+offset*style.pixel.x/frame.viewport.xy*p.w,p.zw);
  if(a.w<=0.0||b.w<=0.0||len<1e-10) { p=vec4f(2.0,2.0,2.0,1.0); }
  var out: Out; out.position=p; out.color=edgeStyle[e*2u]; out.local=vec2f(0.0); return out;
}
@fragment fn edgeFragment(in: Out) -> @location(0) vec4f { return vec4f(toOutput(in.color.rgb)*in.color.a,in.color.a); }
@fragment fn nodeFragment(in: Out) -> @location(0) vec4f { if(dot(in.local,in.local)>1.0) { discard; } return vec4f(toOutput(in.color.rgb),1.0); }
`;
const gatherShader = `@group(0) @binding(0) var<storage, read> pos: array<vec4f>;
@group(0) @binding(1) var<storage, read> ids: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(3) var<uniform> count: vec4u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) { if(id.x<count.x) { dst[id.x]=pos[ids[id.x]]; } }`;
const xml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** A figure layer drawing directly from GPUGraphLayout, without node readback. */
export class GPUGraphLayer implements Drawable {
  /** Matches the host figure, allowing planar layout with pan/zoom or an orbiting 3D view. */
  readonly dimensions: '2d' | '3d';
  visible = true;
  readonly transparent = true;
  readonly #figure: Figure;
  readonly #layout: GPUGraphLayout;
  readonly #bounds: Bounds;
  readonly #options: GPUGraphLayerOptions;
  readonly #model = new Float32Array(16);
  readonly #edges: GpuArray<'u32'>;
  readonly #edgeStyle: GpuArray<'f32'>;
  readonly #nodeStyle: GpuArray<'f32'>;
  readonly #dummy: GpuArray<'f32'>;
  readonly #uniform: GPUBuffer;
  readonly #binding: GPUBindGroupLayout;
  #groups = new Map<GPUBuffer, GPUBindGroup>();
  readonly #labels: NonNullable<GPUGraphLayerOptions['labels']>;
  #labelPositions = new Float32Array(0);
  #boxes: GraphLabelBox[] = [];
  #overlay?: HTMLCanvasElement;
  #offFrame?: () => void;
  #offExport?: () => void;
  #disposed = false;
  #lost = false;
  /** @internal Create with gpuGraphLayer(). */
  constructor(figure: Figure, layout: GPUGraphLayout, options: GPUGraphLayerOptions = {}) {
    requireGPU(figure.renderer);
    if (figure.renderer.device !== layout.gpu.device) throw invalid('Graph drawing and layout must share a device');
    if (figure.axisScales.some((s) => s.type !== 'linear')) throw invalid('Graph GPU drawing needs linear axes');
    this.#figure = figure;
    this.#layout = layout;
    this.#options = options;
    this.dimensions = figure.is2d ? '2d' : '3d';
    const side = layout.settings.side;
    this.#bounds = options.bounds ? ([...options.bounds] as Bounds) : [-side, side, -side, side, -side, side];
    if (
      this.#bounds.length !== 6 ||
      !this.#bounds.every(Number.isFinite) ||
      [0, 2, 4].some((a) => this.#bounds[a] >= this.#bounds[a + 1])
    )
      throw invalid('Bounds must be finite increasing pairs');
    const n = layout.graph.nodes,
      e = layout.graph.edges.length / 2;
    const opacity = options.edgeOpacity ?? 0.45,
      arrow = options.arrowSize ?? 7,
      maxLabels = options.maxLabels ?? 200;
    if (
      !Number.isFinite(opacity) ||
      opacity < 0 ||
      opacity > 1 ||
      !Number.isFinite(arrow) ||
      arrow < 0 ||
      !Number.isInteger(maxLabels) ||
      maxLabels < 0
    )
      throw invalid('Invalid graph opacity, arrows or label count');
    const colors = (value: string | readonly string[] | undefined, count: number, fallback: string): Float32Array => {
      if (Array.isArray(value) && value.length !== count) throw invalid('Provide one colour per graph item');
      const result = new Float32Array(Math.max(4, count * 8));
      for (let i = 0; i < count; i++) {
        const color = hexColor(typeof value === 'string' ? value : (value?.[i] ?? fallback));
        if (!color) throw invalid('Graph colours need hexadecimal RGB strings');
        result.set([SRGBToLinear(color[0]), SRGBToLinear(color[1]), SRGBToLinear(color[2]), opacity], i * 8);
      }
      return result;
    };
    const edgeStyle = colors(options.edgeColor, e, '#6b7f94'),
      nodeStyle = colors(options.nodeColor, n, '#3b82c4');
    for (const [data, value, count, fallback] of [
      [edgeStyle, options.edgeWidth, e, 1],
      [nodeStyle, options.nodeSize, n, 5],
    ] as const) {
      if (value !== undefined && typeof value !== 'number' && value.length !== count)
        throw invalid('Provide one size per graph item');
      for (let i = 0; i < count; i++) {
        const size = typeof value === 'number' ? value : (value?.[i] ?? fallback);
        if (!Number.isFinite(size) || size < 0) throw invalid('Graph sizes must be finite nonnegative CSS pixels');
        data[i * 8 + 4] = size;
        data[i * 8 + 5] = arrow;
      }
    }
    if (options.bundles && (options.bundles.edges !== e || options.bundles.points.context !== layout.gpu))
      throw invalid('Bundles must match this graph and compute context');
    this.#labels = [...(options.labels ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    for (const l of this.#labels)
      if (!Number.isInteger(l.node) || l.node < 0 || l.node >= n || !Number.isFinite(l.priority ?? 0))
        throw invalid('Labels must name valid nodes with finite priority');
    const limit = layout.gpu.device.limits.maxStorageBufferBindingSize;
    if (Math.max(edgeStyle.byteLength, nodeStyle.byteLength, e * 8) > limit)
      throw invalid('Graph drawing buffers exceed this device storage limit');
    this.#edges = layout.gpu.array(e ? Uint32Array.from(layout.graph.edges) : new Uint32Array(2), 'u32');
    this.#edgeStyle = layout.gpu.array(edgeStyle);
    this.#nodeStyle = layout.gpu.array(nodeStyle);
    this.#dummy = layout.gpu.zeros(4);
    const device = layout.gpu.device;
    this.#uniform = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#binding = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        ...[1, 2, 3, 4, 5].map((binding) => ({
          binding,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' as const },
        })),
      ],
    });
    if (this.#labels.length && maxLabels > 0) this.#setupLabels();
  }
  /** Data bounds framed by the figure. */ get bounds(): Bounds {
    return this.#bounds;
  }
  /** @internal Receives the figure's shared data-to-scene transform. */ setModel(model: Float32Array): void {
    this.#model.set(model);
  }
  /** Latest accepted label rectangles, for inspection and accessibility. */ get labelBoxes(): readonly GraphLabelBox[] {
    return this.#boxes;
  }
  /** @internal */ center(): readonly [number, number, number] {
    const b = this.#bounds;
    return [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
  }
  /** @internal Device arrays cannot restore themselves: create a new layout and layer after device replacement. */
  restore(): void {
    this.visible = false;
    this.#lost = true;
    this.#overlay?.remove();
    this.#groups.clear();
  }
  #check(): void {
    if (this.#disposed || this.#lost)
      throw fault(
        this.#lost ? 'state' : 'disposed',
        'Create a new GPU graph layout and layer on the current figure device',
        'sciviz',
      );
  }
  /** @internal Uploads only the model and CSS pixel ratio; positions stay on the device. */
  prepare(): void {
    this.#check();
    const v = new Float32Array(20);
    v.set(this.#model);
    v[16] = globalThis.devicePixelRatio || 1;
    v[17] = this.#options.bundles?.pointsPerEdge ?? 0;
    this.#layout.gpu.device.queue.writeBuffer(this.#uniform, 0, v);
  }
  /** @internal */ draw(pass: GPURenderPassEncoder, context: GpuContext): void {
    const renderer = this.#figure.renderer,
      device = renderer.device!,
      positions = this.#layout.positions.buffer;
    let group = this.#groups.get(positions);
    if (!group) {
      group = device.createBindGroup({
        layout: this.#binding,
        entries: [
          this.#uniform,
          positions,
          this.#edges.buffer,
          this.#edgeStyle.buffer,
          this.#nodeStyle.buffer,
          this.#options.bundles?.points.buffer ?? this.#dummy.buffer,
        ].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      this.#groups.set(positions, group);
    }
    const pipeline = (nodes: boolean) =>
      renderer.pipeline(`graph-gpu-${nodes ? 'nodes' : 'edges'}`, context, (target) => {
        const module = device.createShaderModule({ code: drawShader });
        return {
          layout: device.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#binding] }),
          vertex: { module, entryPoint: nodes ? 'nodeVertex' : 'edgeVertex' },
          fragment: {
            module,
            entryPoint: nodes ? 'nodeFragment' : 'edgeFragment',
            targets: [
              {
                format: target.format,
                ...(nodes
                  ? {}
                  : {
                      blend: {
                        color: {
                          srcFactor: 'one' as const,
                          dstFactor: 'one-minus-src-alpha' as const,
                          operation: 'add' as const,
                        },
                        alpha: {
                          srcFactor: 'one' as const,
                          dstFactor: 'one-minus-src-alpha' as const,
                          operation: 'add' as const,
                        },
                      },
                    }),
              },
            ],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          multisample: target.multisample,
          depthStencil: { format: target.depth, depthWriteEnabled: nodes, depthCompare: 'greater-equal' },
        };
      });
    pass.setBindGroup(1, group);
    const edges = this.#layout.graph.edges.length / 2;
    if (edges) {
      pass.setPipeline(pipeline(false));
      pass.draw(9, edges * Math.max(1, (this.#options.bundles?.pointsPerEdge ?? 2) - 1));
    }
    pass.setPipeline(pipeline(true));
    pass.draw(6, this.#layout.graph.nodes);
  }
  #setupLabels(): void {
    const canvas = (this.#figure.engine as unknown as { canvas: HTMLCanvasElement }).canvas,
      parent = canvas.parentElement ?? document.body;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    this.#overlay = document.createElement('canvas');
    this.#overlay.style.cssText = 'position:absolute;pointer-events:none;z-index:2';
    this.#overlay.setAttribute('aria-label', this.#labels.map((l) => l.text).join('; '));
    parent.append(this.#overlay);
    this.#offFrame = this.#figure.engine.onFrame(() => this.#paintLabels());
    this.#offExport = registerPublicationOverlay(this.#figure, {
      svg: () =>
        this.#boxes
          .map(
            (b) =>
              `<text x="${b.x}" y="${b.y + b.height - 3}" font-family="sans-serif" font-size="12" fill="#24374a">${xml(b.text)}</text>`,
          )
          .join(''),
      paint: (ctx) => {
        ctx.font = '12px sans-serif';
        ctx.fillStyle = '#24374a';
        for (const b of this.#boxes) ctx.fillText(b.text, b.x, b.y + b.height - 3);
      },
      dispose: () => this.dispose(),
    });
  }
  #paintLabels(): void {
    if (!this.#overlay || this.#disposed || !this.visible) {
      this.#overlay?.getContext('2d')?.clearRect(0, 0, this.#overlay.width, this.#overlay.height);
      return;
    }
    const canvas = (this.#figure.engine as unknown as { canvas: HTMLCanvasElement }).canvas,
      w = canvas.clientWidth || canvas.width,
      h = canvas.clientHeight || canvas.height;
    this.#overlay.width = w;
    this.#overlay.height = h;
    this.#overlay.style.left = `${canvas.offsetLeft}px`;
    this.#overlay.style.top = `${canvas.offsetTop}px`;
    const ctx = this.#overlay.getContext('2d')!;
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#24374a';
    const m = dataToClip(this.#figure.engine.camera.matrix, this.#figure.model),
      candidates: GraphLabelBox[] = [];
    for (let i = 0; i < this.#labels.length && i * 4 < this.#labelPositions.length; i++) {
      const l = this.#labels[i],
        p = this.#labelPositions.subarray(i * 4, i * 4 + 3),
        q = [0, 1, 2, 3].map((a) => m[a] * p[0] + m[4 + a] * p[1] + m[8 + a] * p[2] + m[12 + a]);
      if (q[3] <= 0 || q[2] < 0 || q[2] > q[3]) continue;
      candidates.push({
        ...l,
        x: ((q[0] / q[3] + 1) * w) / 2,
        y: ((1 - q[1] / q[3]) * h) / 2,
        width: ctx.measureText(l.text).width,
        height: 16,
      });
    }
    this.#boxes = placeGraphLabels(candidates, w, h).slice(0, this.#options.maxLabels ?? 200);
    for (const b of this.#boxes) ctx.fillText(b.text, b.x, b.y + b.height - 3);
  }
  /** Refreshes candidate node positions after layout changes. Camera pan/zoom reprojects this snapshot every frame. */
  async refreshLabels(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    this.#check();
    options.signal?.throwIfAborted();
    if (!this.#labels.length) return;
    const gpu = this.#layout.gpu,
      ids = gpu.array(
        Uint32Array.from(this.#labels, (l) => l.node),
        'u32',
      ),
      dst = gpu.zeros(this.#labels.length * 4),
      kernel = gpu.kernel(gatherShader);
    try {
      kernel.run(
        { pos: this.#layout.positions, ids, dst, count: new Uint32Array([this.#labels.length, 0, 0, 0]) },
        { count: this.#labels.length },
      );
      this.#labelPositions = await dst.read(options);
      this.#paintLabels();
    } finally {
      ids.dispose();
      dst.dispose();
      kernel.dispose();
    }
  }
  /** Leaves the renderer, removes labels and releases drawing buffers. Layout and bundles stay caller-owned. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#figure.renderer.remove(this);
    this.#offFrame?.();
    this.#offExport?.();
    this.#overlay?.remove();
    for (const a of [this.#edges, this.#edgeStyle, this.#nodeStyle, this.#dummy]) a.dispose();
    this.#uniform.destroy();
    this.#groups.clear();
  }
  /** Same as dispose(). */ [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Adds a direct device-buffer graph to a linear-axis figure. */
export function gpuGraphLayer(
  figure: Figure,
  layout: GPUGraphLayout,
  options: GPUGraphLayerOptions = {},
): GPUGraphLayer {
  const layer = new GPUGraphLayer(figure, layout, options);
  figure.renderer.add(layer);
  return figure.addLayer(layer);
}
