/// <reference lib="esnext.disposable" preserve="true" />
import { applyView } from '../../shared/view-rect.js';
// Solid or vertical-gradient background color.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import {
  type ColorInput,
  LinearToSRGB as linearToSrgb,
  hexColor,
  parseColor,
  SRGBToLinear as srgbToLinear,
} from '@margoengine/math/color';
import { MargoError } from '@margoengine/math/errors';
import { linearHdr } from '../../shared/hdr-format.js';

export type { ColorInput } from '@margoengine/math/color';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

type GPUContext = Extract<PassContext, { backend: 'webgpu' }>;
type RGB = [number, number, number];

// A ColorInput as sRGB components and linear RGB, each exact for its own kind of input: hex strings and numbers are
// sRGB bytes, `[r, g, b]` arrays linear (docs/conventions.md).
function colorPair(value: ColorInput): { srgb: RGB; linear: RGB } {
  const hex = typeof value === 'number' ? value : undefined;
  // CSS color(display-p3 r g b) and friends: linear sRGB, negative outside sRGB (math's parseColor).
  if (typeof value === 'string' && /^\s*color\(/i.test(value)) {
    const linear = parseColor(value, [0, 0, 0]) as RGB;
    return { srgb: [linearToSrgb(linear[0]), linearToSrgb(linear[1]), linearToSrgb(linear[2])], linear };
  }
  if (typeof value === 'string') {
    const srgb = hexColor(value[0] === '#' ? value : '#' + value)?.slice(0, 3) as RGB | undefined;
    if (!srgb) throw new TypeError(`Color '${value}' is not '#rgb' or '#rrggbb'; pass a hex color or linear [r, g, b]`);
    return { srgb, linear: srgb.map(srgbToLinear) as RGB };
  }
  if (hex !== undefined) {
    if (!Number.isInteger(hex) || hex < 0 || hex > 0xffffff)
      throw new RangeError(`Color ${hex} is outside 0x000000..0xffffff; use a value from 0x000000 to 0xffffff`);
    const srgb: RGB = [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
    return { srgb, linear: [srgbToLinear(srgb[0]), srgbToLinear(srgb[1]), srgbToLinear(srgb[2])] };
  }
  const linear = parseColor(value, [0, 0, 0]) as RGB;
  return { srgb: [linearToSrgb(linear[0]), linearToSrgb(linear[1]), linearToSrgb(linear[2])], linear };
}

/**
 * sRGB components (display values, 0..1 for displayable colors) of a ColorInput: hex strings and numbers as given,
 * linear `[r, g, b]` arrays encoded with the sRGB transfer function.
 * @throws TypeError for a string that is not `#rgb`/`#rrggbb` or any other value; RangeError for a number outside
 * 0x000000..0xffffff or a negative or non-finite array component.
 */
export function srgbColor(value: ColorInput): RGB {
  return colorPair(value).srgb;
}

/** @internal Linear RGB of a ColorInput (hex decoded from sRGB, arrays as given); throws as {@link srgbColor}. */
export function linearColor(value: ColorInput): RGB {
  return colorPair(value).linear;
}

const shader = /* wgsl */ `
struct Colors {top:vec4f, bottom:vec4f}
@group(0) @binding(0) var<uniform> colors:Colors;
struct Out {@builtin(position) position:vec4f, @location(0) y:f32}
@vertex fn vertexMain(@builtin(vertex_index) index:u32)->Out {
  let p=vec2f(f32((index<<1u)&2u),f32(index&2u))*2.0-1.0;var o:Out;o.position=vec4f(p,0.0,1.0);o.y=p.y*0.5+0.5;return o;
}
@fragment fn fragmentMain(i:Out)->@location(0) vec4f {return mix(colors.bottom,colors.top,clamp(i.y,0.0,1.0));}`;

/** `ColorBackground` settings; colours are any ColorInput (hex strings and numbers sRGB, `[r, g, b]` arrays linear). */
export interface ColorBackgroundOptions {
  /** Background color (top of the viewport when `bottom` is set). Default '#000000'. */
  color?: ColorInput;
  /** Optional color at the bottom of the viewport for a vertical gradient. */
  bottom?: ColorInput;
  /** Frame graph order; must run after core's main pass (order 0). Default 0.5, before glTF-pro models (1). */
  order?: number;
  /** Plugin and pass name. Default 'background'. */
  name?: string;
}

/**
 * Fills every pixel the scene left empty (depth still at the cleared reversed-Z 0) with a color or a vertical
 * gradient. On the canvas the color is shown exactly (no tone mapping);
 * on an rgba16float pass target (tonemap, creative PostProcessing) it writes the linear value so the post chain
 * treats it like scene radiance. The canvas stays opaque; `TransparentCanvas` (below) clears to alpha 0 instead.
 */
export class ColorBackground {
  readonly name: string;
  readonly order: number;
  private top!: { srgb: RGB; linear: RGB };
  private under?: { srgb: RGB; linear: RGB };
  private state?: {
    device: GPUDevice;
    uniform: GPUBuffer;
    module: GPUShaderModule;
    pipelines: Map<string, { pipeline: GPURenderPipeline; group: GPUBindGroup }>;
  };
  protected disposed = false;
  protected engine?: EngineKernel;
  /** Written premultiplied: colour times alpha, alpha. */
  protected alpha = 1;
  private readonly values = new Float32Array(8);
  private readonly colorAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'load',
    storeOp: 'store',
  };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = { view: undefined!, depthReadOnly: true };
  private readonly passDescriptor: GPURenderPassDescriptor = {
    label: 'color background',
    colorAttachments: [this.colorAttachment],
    depthStencilAttachment: this.depthAttachment,
  };

  /** Same as `engine.use(new ColorBackground(...))`; returns the ColorBackground. */
  static attach(engine: EngineKernel, options?: ColorBackgroundOptions): ColorBackground {
    const value = new ColorBackground(options);
    engine.use(value);
    return value;
  }
  constructor(options: ColorBackgroundOptions = {}) {
    this.name = options.name ?? 'background';
    this.order = options.order ?? 0.5;
    if (!(this.order > 0) || !Number.isFinite(this.order))
      throw new RangeError('Background order must be greater than 0 (after the main pass)');
    this.color = options.color ?? 0;
    this.bottom = options.bottom;
  }
  /**
   * The (top) color. Set any ColorInput (hex is sRGB, `[r, g, b]` linear); reads linear `[r, g, b]`, so assigning it
   * back keeps the color.
   */
  get color(): RGB {
    return [...this.top.linear];
  }
  set color(value: ColorInput) {
    this.top = colorPair(value);
  }
  /** The bottom gradient color as `color`, or undefined for a solid color. */
  get bottom(): RGB | undefined {
    return this.under && [...this.under.linear];
  }
  set bottom(value: ColorInput | undefined) {
    this.under = value === undefined ? undefined : colorPair(value);
  }

  setup(engine: EngineKernel): void {
    if (this.disposed) throw new MargoError('disposed', 'ColorBackground is disposed; create a new ColorBackground');
    if (engine.backend === 'webgl2')
      throw new MargoError(
        'unsupported',
        'ColorBackground requires the WebGPU backend; use an engine on the WebGPU backend; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu') this.record(c);
      },
    });
  }
  onDeviceRestored(): void {
    this.release();
  }
  /** Frees the GPU state and detaches from the engine. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  /** Records the background into `context.encoder` over `context.color`, testing against `context.depth`. */
  record(context: GPUContext): void {
    if (this.disposed) return;
    const { device } = context,
      depthFormat = context.descriptor.depthStencil?.format ?? 'depth32float',
      count = context.descriptor.multisample?.count ?? 1;
    if (this.state?.device !== device) {
      this.release();
      const uniform = device.createBuffer({
        label: 'color background',
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      try {
        this.state = { device, uniform, module: device.createShaderModule({ code: shader }), pipelines: new Map() };
      } catch (error) {
        uniform.destroy();
        throw error;
      }
    }
    const state = this.state,
      key = `${context.format}|${depthFormat}|${count}`;
    let entry = state.pipelines.get(key);
    if (!entry) {
      const pipeline = device.createRenderPipeline({
        label: 'color background',
        layout: 'auto',
        vertex: { module: state.module, entryPoint: 'vertexMain' },
        fragment: { module: state.module, entryPoint: 'fragmentMain', targets: [{ format: context.format }] },
        primitive: { topology: 'triangle-list' },
        multisample: { count },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
      });
      state.pipelines.set(
        key,
        (entry = {
          pipeline,
          group: device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: state.uniform } }],
          }),
        }),
      );
    }
    const hdr = linearHdr(context.format),
      v = this.values,
      bottom = this.under ?? this.top;
    for (let i = 0; i < 3; i++) {
      v[i] = (hdr ? this.top.linear[i] : this.top.srgb[i]) * this.alpha;
      v[4 + i] = (hdr ? bottom.linear[i] : bottom.srgb[i]) * this.alpha;
    }
    v[3] = v[7] = this.alpha;
    device.queue.writeBuffer(state.uniform, 0, v);
    this.colorAttachment.view = context.color;
    this.depthAttachment.view = context.depth;
    if (depthFormat.includes('stencil')) this.depthAttachment.stencilReadOnly = true;
    else delete this.depthAttachment.stencilReadOnly;
    const pass = context.encoder.beginRenderPass(this.passDescriptor);
    applyView(pass, context);
    pass.setPipeline(entry.pipeline);
    pass.setBindGroup(0, entry.group);
    pass.draw(3);
    pass.end();
  }
  private release(): void {
    this.state?.uniform.destroy();
    this.state = undefined;
  }
}

/**
 * Transparent canvas over HTML/CSS (cleared to alpha 0) without a core change: switches the
 * canvas context to `alphaMode: 'premultiplied'` and overwrites every pixel the scene left empty with alpha 0 (the
 * `ColorBackground` pass, so multisampled silhouettes resolve to valid premultiplied edges). Reapplied after
 * `engine.rebootDevice()`; `dispose()` restores the opaque canvas. On the WebGL2 fallback it does nothing: create that
 * renderer transparent instead, `fallback: canvas => webglRenderer(canvas, {transparent: true})`.
 */
export class TransparentCanvas extends ColorBackground {
  /** Same as `engine.use(new TransparentCanvas(...))`; returns the TransparentCanvas. */
  static override attach(
    engine: EngineKernel,
    options?: Pick<ColorBackgroundOptions, 'order' | 'name'>,
  ): TransparentCanvas {
    const value = new TransparentCanvas(options);
    engine.use(value);
    return value;
  }
  constructor(options: Pick<ColorBackgroundOptions, 'order' | 'name'> = {}) {
    super({ name: 'transparent-canvas', ...options });
    this.alpha = 0;
  }
  override setup(engine: EngineKernel): void {
    if (this.disposed)
      throw new MargoError('disposed', 'TransparentCanvas is disposed; create a new TransparentCanvas');
    this.engine = engine;
    this.configure('premultiplied');
  }
  override onDeviceRestored(): void {
    super.onDeviceRestored();
    this.configure('premultiplied');
  }
  /** Restores the opaque canvas and detaches from the engine. */
  override dispose(): void {
    if (this.disposed) return;
    this.configure('opaque');
    super.dispose();
  }
  // Core configured this context with the same device and preferred format; only alphaMode changes (the rest of the
  // current configuration, e.g. ColorOutput's P3/HDR, is kept where the browser can report it).
  private configure(alphaMode: GPUCanvasAlphaMode): void {
    const engine = this.engine,
      device = engine && engineRuntime(engine).gpu;
    if (!engine || !device || engine.disposed) return;
    const context = engine.canvas.getContext('webgpu') as
        | (GPUCanvasContext & { getConfiguration?(): GPUCanvasConfiguration | null })
        | null,
      current = context?.getConfiguration?.();
    context?.configure({
      ...current,
      device,
      format: current?.format ?? navigator.gpu.getPreferredCanvasFormat(),
      alphaMode,
    });
  }
}
