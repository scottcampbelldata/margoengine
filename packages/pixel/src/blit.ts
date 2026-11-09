// The plumbing the scale and CRT passes share: one low-res source drawn over a rectangle of the canvas (each canvas
// view, the picture as large as fits) or of a target texture, by a full-screen triangle and a fragment shader of the
// pass's own. Each view keeps its own uniform buffer, since a frame's writes all land before its passes run.
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { checkLayers, ViewStates } from '../../shared/view-rect.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** A texture, or a function returning one each frame such as a pixel layer's `target`. */
export type TextureSource = GPUTexture | (() => GPUTexture);

/** How the picture fills its view: as large as fits keeping its shape (`'contain'`), or all of it (`'stretch'`). */
export type PixelFit = 'contain' | 'stretch';

/** Settings the scale and CRT passes share. */
export interface ScreenPassOptions {
  /** The low-res picture, colours premultiplied by alpha as in a pixel layer. Required. */
  source: TextureSource;
  /** Where to draw; it is cleared first. Default each canvas view, drawn over what is there. */
  target?: TextureSource;
  /** Read each frame. Default `'contain'`. */
  fit?: PixelFit;
  /** Render-layer bits; a canvas view whose `layers` shares none is left alone. Default 1. */
  layers?: number;
  /** Frame-graph order. Default 35, after a compositor (30). */
  order?: number;
  /** Plugin name, unique per scene. */
  name?: string;
}

/** The whole output pixels a picture of `width` x `height` covers in a view of `viewWidth` x `viewHeight`. */
export function fitRect(
  width: number,
  height: number,
  viewWidth: number,
  viewHeight: number,
  fit: PixelFit = 'contain',
): [number, number, number, number] {
  if (fit === 'stretch') return [0, 0, viewWidth, viewHeight];
  // Whole numbers throughout: the side that limits takes the view's length, the other its share rounded down.
  const wide = viewWidth * height <= viewHeight * width,
    w = wide ? viewWidth : Math.floor((width * viewHeight) / height),
    h = wide ? Math.floor((height * viewWidth) / width) : viewHeight;
  return [Math.floor((viewWidth - w) / 2), Math.floor((viewHeight - h) / 2), w, h];
}

type Context = Extract<PassContext, { backend: 'webgpu' }>;
interface State {
  buffer?: GPUBuffer;
  group?: GPUBindGroup;
  groupFor?: GPUTexture;
  groupPipeline?: GPURenderPipeline;
}
const BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};

/** The base of `PixelScale` and `CRT`. */
export abstract class ScreenPass implements EnginePlugin {
  readonly name: string;
  /** Read each frame. */
  fit: PixelFit;
  readonly #source: TextureSource;
  readonly #target?: TextureSource;
  readonly #order: number;
  readonly #layers: number;
  readonly #label: string;
  readonly #code: string;
  readonly #bytes: number;
  readonly #values: ArrayBuffer;
  #engine?: Engine;
  #device?: GPUDevice;
  #module?: GPUShaderModule;
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  readonly #states = new ViewStates<State>(
    () => ({}),
    (state) => state.buffer?.destroy(),
  );
  #disposed = false;

  protected constructor(options: ScreenPassOptions, label: string, code: string, bytes: number, name: string) {
    if (!options?.source) throw typeError(`${label} needs a source texture`, 'pixel-options');
    const order = options.order ?? 35;
    if (!Number.isFinite(order)) throw rangeError(`${label} order must be a finite number`, 'pixel-options');
    this.#source = options.source;
    this.#target = options.target;
    this.#order = order;
    this.#layers = checkLayers(options.layers ?? 1, `${label} layers`);
    this.fit = options.fit ?? 'contain';
    this.#label = label;
    this.#code = code;
    this.#bytes = bytes;
    this.#values = new ArrayBuffer(bytes);
    this.name = options.name ?? name;
  }
  /** Writes the pass's uniforms: the drawn rectangle in output pixels, and the source's size. */
  protected abstract fill(values: ArrayBuffer, rect: readonly number[], source: GPUTexture): void;

  setup(engine: Engine): void {
    if (this.#disposed) throw fault('disposed', `${this.#label} disposed; create a new one`, 'disposed');
    if (engine.backend !== 'webgpu') throw fault('unsupported', `${this.#label} needs WebGPU`, 'webgpu');
    this.#engine = engine;
    engine.frameGraph.add({
      name: this.name,
      order: this.#order,
      execute: (c) => {
        if (c.backend === 'webgpu') this.#run(c);
      },
    });
  }
  onPreUpdate(delta: number): void {
    if (delta > 0) this.#states.prune();
  }
  onDeviceRestored(): void {
    this.#release();
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#engine?.sceneOf(this)?.removePlugin(this.name);
    this.#engine = undefined;
    this.#release();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  #release(): void {
    this.#states.clear();
    this.#pipelines.clear();
    this.#module = this.#device = undefined;
  }
  #run(c: Context): void {
    const view = c.view,
      pick = (t: TextureSource) => (typeof t === 'function' ? t() : t);
    if (this.#target ? view?.index : view?.target || (view?.layers !== undefined && !(view.layers & this.#layers)))
      return;
    if (this.fit !== 'contain' && this.fit !== 'stretch')
      throw rangeError(`${this.#label} fit must be contain or stretch`, 'pixel-options');
    const device = c.device;
    if (this.#device !== device) {
      this.#release();
      this.#device = device;
    }
    this.#module ??= device.createShaderModule({ label: this.#label, code: this.#code });
    const source = pick(this.#source),
      target = this.#target ? pick(this.#target) : undefined;
    if (source === target) throw fault('state', `${this.#label} source and target must differ`, 'pixel-options');
    const format = target ? target.format : c.format,
      samples = target ? 1 : (c.descriptor.multisample?.count ?? 1),
      key = `${format}/${samples}`;
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        label: this.#label,
        layout: 'auto',
        vertex: { module: this.#module, entryPoint: 'vs' },
        fragment: { module: this.#module, entryPoint: 'fs', targets: [{ format, blend: BLEND }] },
        multisample: { count: samples },
      });
      this.#pipelines.set(key, pipeline);
    }
    const x0 = target ? 0 : view ? view.viewport[0] : 0,
      y0 = target ? 0 : view ? view.viewport[1] : 0,
      vw = target ? target.width : view ? view.viewport[2] : c.width,
      vh = target ? target.height : view ? view.viewport[3] : c.height,
      fit = fitRect(source.width, source.height, vw, vh, this.fit),
      rect = [x0 + fit[0], y0 + fit[1], fit[2], fit[3]],
      state = this.#states.get(c);
    state.buffer ??= device.createBuffer({
      label: this.#label,
      size: this.#bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    if (!state.group || state.groupFor !== source || state.groupPipeline !== pipeline) {
      state.group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: state.buffer } },
          { binding: 1, resource: source.createView() },
        ],
      });
      state.groupFor = source;
      state.groupPipeline = pipeline;
    }
    this.fill(this.#values, rect, source);
    device.queue.writeBuffer(state.buffer, 0, this.#values);
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [
        target
          ? { view: target.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }
          : { view: c.color, loadOp: 'load', storeOp: 'store' },
      ],
    });
    const width = target ? target.width : c.width,
      height = target ? target.height : c.height,
      clip = target ? [0, 0, width, height] : (view?.scissor ?? [0, 0, width, height]),
      sx = Math.max(0, rect[0], clip[0]),
      sy = Math.max(0, rect[1], clip[1]),
      ex = Math.min(width, rect[0] + rect[2], clip[0] + clip[2]),
      ey = Math.min(height, rect[1] + rect[3], clip[1] + clip[3]);
    if (ex > sx && ey > sy) {
      pass.setScissorRect(sx, sy, ex - sx, ey - sy);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, state.group);
      pass.draw(3);
    }
    pass.end();
  }
}

/** The full-screen triangle every screen pass draws. */
export const VERTEX = /* wgsl */ `@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);
}`;
