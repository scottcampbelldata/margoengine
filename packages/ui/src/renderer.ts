/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { rangeError, typeError } from '../../shared/errors.js';
import { overlayPass } from '../../shared/pass.js';
import { UiPainter } from './painter.js';
import { attachInput, type AttachOptions, type Detach } from './dom.js';
import { attachMirror, type MirrorOptions } from './mirror.js';
import type { Ui } from './ui.js';

type GpuContext = Extract<PassContext, { backend: 'webgpu' }>;
type GlContext = Extract<PassContext, { backend: 'webgl2' }>;
type GlModule = typeof import('./gl.js');

/** Options for {@link UiRenderer}. */
export interface UiRendererOptions {
  /** Plugin name, unique per engine. Default `'ui'`. */
  name?: string;
  /** Frame graph order. Default 1000: after the scene and post-processing, so the UI is never tone mapped or blurred. */
  order?: number;
  /** SDF atlas page size in texels. Default 1024. */
  atlasSize?: number;
  /** Colour (emoji) atlas page size in texels. Default 512. */
  colorAtlasSize?: number;
  /** Page limit per atlas. Default 16. */
  maxPages?: number;
  /**
   * Connect the engine's canvas to the UI (pointer, touch, wheel and keyboard; see {@link attachInput}). Pass false to
   * do it yourself, or options for `attachInput`. Default true.
   */
  input?: boolean | AttachOptions;
  /**
   * Mirror the UI into the DOM for screen readers (see {@link attachMirror}). Pass false to leave it out, or options. Default
   * true: the interface is accessible with no setup.
   */
  mirror?: boolean | MirrorOptions;
}

/**
 * Engine plugin that draws a {@link Ui} over the finished frame, in the engine's own render pass: rounded rectangles
 * and signed distance field text from the text package, in device pixels, so it works in fullscreen and in exported
 * games with no DOM involved. It also steps the UI each frame (`ui.update`) and keeps its size in step with the canvas.
 * On core's WebGL2 preview backend it draws the same rectangles and text with WebGL2 (its code loads on first use, so
 * the UI shows from the first frame after that load).
 *
 * @example
 * const ui = new Ui();
 * UiRenderer.attach(engine, ui);
 */
export class UiRenderer implements EnginePlugin {
  readonly name: string;
  readonly order: number;
  /** Counts for the latest frame. */
  readonly stats = { rects: 0, glyphs: 0, drawCalls: 0, uploads: 0 };
  private engine?: Engine;
  private device?: GPUDevice;
  private readonly painter: UiPainter;
  private readonly descriptor = overlayPass();
  private readonly options: Required<Omit<UiRendererOptions, 'name' | 'order' | 'input' | 'mirror'>>;
  private readonly inputOptions: AttachOptions | false;
  private readonly mirrorOptions: MirrorOptions | false;
  private gl?: GlModule;
  private glPainter?: InstanceType<GlModule['GlUiPainter']>;
  private detach?: Detach;
  private detachMirror?: Detach;
  private disposed = false;

  /** Same as `engine.use(new UiRenderer(ui, options))`; returns the renderer. */
  static attach(engine: EngineKernel, ui: Ui, options?: UiRendererOptions): UiRenderer {
    const value = new UiRenderer(ui, options);
    engine.use(value);
    return value;
  }

  /**
   * @throws TypeError for a missing `ui`, an empty name or a non-finite order.
   * @throws RangeError for an atlas size under 64 texels or a page limit that is not a positive integer.
   */
  constructor(
    readonly ui: Ui,
    options: UiRendererOptions = {},
  ) {
    if (!ui || typeof ui.draw !== 'function') throw typeError('UiRenderer needs a Ui: new UiRenderer(new Ui())', 'ui');
    this.name = options.name ?? 'ui';
    this.order = options.order ?? 1000;
    if (!this.name || typeof this.name !== 'string' || !Number.isFinite(this.order))
      throw typeError('Invalid UiRenderer options', 'ui');
    this.inputOptions = options.input === false ? false : options.input === true || !options.input ? {} : options.input;
    this.mirrorOptions =
      options.mirror === false ? false : options.mirror === true || !options.mirror ? {} : options.mirror;
    this.options = {
      atlasSize: options.atlasSize ?? 1024,
      colorAtlasSize: options.colorAtlasSize ?? 512,
      maxPages: options.maxPages ?? 16,
    };
    for (const value of Object.values(this.options))
      if (!Number.isInteger(value) || value < 1)
        throw rangeError('Atlas sizes and page limits must be positive integers', 'ui');
    if (this.options.atlasSize < 64 || this.options.colorAtlasSize < 64)
      throw rangeError('Atlas pages must be at least 64 texels', 'ui');
    this.painter = new UiPainter(this.options, this.stats);
  }

  setup(engine: Engine): void {
    this.engine = engine;
    const canvas = (engine as unknown as { canvas?: HTMLElement }).canvas;
    if (this.inputOptions && canvas && !this.detach) this.detach = attachInput(this.ui, canvas, this.inputOptions);
    if (this.mirrorOptions && canvas && !this.detachMirror)
      this.detachMirror = attachMirror(this.ui, canvas, this.mirrorOptions);
    if (engine.backend !== 'webgpu' || !engine.gpu) {
      if (!this.gl)
        void import('./gl.js').then((module) => {
          if (!this.disposed) this.gl = module;
        });
      return;
    }
    this.painter.setup((this.device = engine.gpu));
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:draw`, order: this.order, execute: this.execute });
  }

  onPreUpdate(delta: number): void {
    if (!this.disposed) this.ui.update(delta);
  }

  private readonly execute = (context: PassContext): void => {
    this.stats.rects = this.stats.glyphs = this.stats.drawCalls = this.stats.uploads = 0;
    const view = context.view;
    if (view && view.index !== view.count - 1) return;
    if (context.backend === 'webgl2') return this.drawGl(context);
    if (!this.device || !this.engine || context.device !== this.device) return;
    this.draw(context);
  };

  private draw(context: GpuContext): void {
    const ui = this.ui,
      ratio = this.pixelRatio(context.width);
    // The drawing buffer is the canvas in device pixels; the UI works in CSS pixels times the pixel ratio.
    ui.resize(context.width / ratio, context.height / ratio, ratio);
    if (!this.painter.prepare(ui.draw())) return;
    this.descriptor.colorAttachments[0].view = context.color;
    this.descriptor.depthStencilAttachment.view = context.depth;
    const pass = context.encoder.beginRenderPass(this.descriptor);
    this.painter.encode(pass, {
      width: context.width,
      height: context.height,
      format: context.format,
      depthFormat: context.descriptor.depthStencil!.format,
      samples: context.descriptor.multisample?.count ?? 1,
    });
    pass.end();
  }

  /** The WebGL2 path: the same draw list over the finished frame in the default framebuffer. */
  private drawGl(context: GlContext): void {
    if (!this.gl || !this.engine || context.gl.isContextLost()) return;
    if (this.glPainter?.gl !== context.gl) {
      this.glPainter?.dispose();
      this.glPainter = new this.gl.GlUiPainter(context.gl, this.options, this.stats);
    }
    const ratio = this.pixelRatio(context.width);
    this.ui.resize(context.width / ratio, context.height / ratio, ratio);
    this.glPainter.draw(this.ui.draw(), context.width, context.height);
  }

  /** Device pixels per CSS pixel: the drawing buffer's width over the canvas's CSS width. */
  private pixelRatio(width: number): number {
    const canvas = (this.engine as unknown as { canvas?: HTMLCanvasElement }).canvas,
      cssWidth = canvas?.clientWidth || 0;
    return cssWidth > 0 ? width / cssWidth : (globalThis.devicePixelRatio ?? 1);
  }

  onDeviceRestored(engine: Engine): void {
    // A restored WebGL2 context is a new set of objects: the painter is made again on the next frame.
    this.glPainter = undefined;
    this.painter.release(false);
    this.device = undefined;
    this.setup(engine);
  }

  /** Release every GPU resource, atlases included. The `Ui` is not disposed. */
  dispose(): void {
    this.disposed = true;
    this.detach?.();
    this.detach = undefined;
    this.detachMirror?.();
    this.detachMirror = undefined;
    this.painter.release(true);
    if (this.glPainter && !this.glPainter.gl.isContextLost()) this.glPainter.dispose();
    this.glPainter = this.gl = undefined;
    this.device = undefined;
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol.for('Symbol.dispose')) as symbol](): void {
    this.dispose();
  }
}
