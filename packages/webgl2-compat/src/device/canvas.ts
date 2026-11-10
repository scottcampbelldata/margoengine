// GPUCanvasContext of the compatibility layer (W3C WebGPU specification section 21). A device renders into its own
// offscreen WebGL2 context; the canvas texture is an ordinary texture of that device, and presenting copies it,
// flipped into WebGL's bottom-up order, to the context's drawing buffer and from there to the page canvas (as an
// ImageBitmap, or with drawImage where OffscreenCanvas is missing). The copy is exact: same size, no filtering.
import { CompatDevice } from './device.js';
import { type CompatTexture, TextureUsage } from './resources.js';

type GetContext = (this: unknown, type: string, options?: unknown) => unknown;
type Canvas = HTMLCanvasElement | OffscreenCanvas;

/** The 'webgpu' context of a canvas under the compatibility layer. */
export class CompatCanvasContext {
  private config: (Omit<GPUCanvasConfiguration, 'device'> & { device: CompatDevice }) | null = null;
  private texture: CompatTexture | null = null;
  private frameOpen = false;
  private output: ImageBitmapRenderingContext | CanvasRenderingContext2D | null = null;
  /** A page-backed XR source copied into an already selected bitmaprenderer. */
  private copy?: OffscreenCanvas;
  /** The device whose context backs the image the page canvas shows now, while it is an ImageBitmap of that context. */
  private shownBy: CompatDevice | null = null;

  constructor(
    readonly canvas: Canvas,
    private readonly getContext: GetContext,
  ) {}

  configure(configuration: GPUCanvasConfiguration): void {
    if (!(configuration?.device instanceof CompatDevice))
      throw new TypeError(
        'configure() needs a device of the WebGL2 compatibility layer (from navigator.gpu after install())',
      );
    if (!['rgba8unorm', 'bgra8unorm', 'rgba16float'].includes(configuration.format))
      throw new TypeError(
        `'${configuration.format}' is not a canvas format: use rgba8unorm, bgra8unorm or rgba16float`,
      );
    this.texture?.destroy();
    this.texture = null;
    this.config = configuration as unknown as Omit<GPUCanvasConfiguration, 'device'> & { device: CompatDevice };
  }

  unconfigure(): void {
    this.texture?.destroy();
    this.texture = null;
    this.config = null;
  }

  getConfiguration(): GPUCanvasConfiguration | null {
    return this.config as unknown as GPUCanvasConfiguration | null;
  }

  getCurrentTexture(): CompatTexture {
    const c = this.config;
    if (!c) throw new DOMException('Configure the canvas context before getCurrentTexture()', 'InvalidStateError');
    const { width, height } = this.canvas;
    let t: CompatTexture | null = this.texture;
    if (!t || t.width !== width || t.height !== height || t.device !== c.device || t.destroyed) {
      t?.destroy();
      t = c.device.createTexture({
        size: [Math.max(1, width), Math.max(1, height)],
        format: c.format,
        usage: (c.usage ?? TextureUsage.RENDER_ATTACHMENT) | TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
        label: 'canvas texture',
      });
      (t as { canvasContext?: CompatCanvasContext }).canvasContext = this;
      this.texture = t;
    }
    if (!this.frameOpen) {
      // A new frame: WebGPU hands out a cleared texture, and keeps handing out the same one until it is shown.
      this.frameOpen = true;
      t.initialized = false;
      setTimeout(() => (this.frameOpen = false), 0);
    }
    return t;
  }

  /**
   * A 2D copy of the page canvas for toDataURL and toBlob while it shows an ImageBitmap of the layer's WebGL2 context,
   * or null when it does not. Chrome on macOS shows and draws such an image upright but encodes it upside down; a 2D
   * copy made with drawImage encodes upright.
   */
  uprightCopy(): HTMLCanvasElement | null {
    const { canvas, output } = this;
    if (!output || !('transferFromImageBitmap' in output) || typeof document === 'undefined') return null;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d')?.drawImage(canvas, 0, 0);
    return copy;
  }

  /** Shows the canvas texture on the page (the device calls this at the end of a task that rendered into it). */
  present(): void {
    const t = this.texture,
      c = this.config;
    if (!t || !c || t.destroyed || c.device.destroyed) return;
    const device = c.device,
      gl = device.gl,
      s = device.state;
    const source = gl.canvas as Canvas;
    if (source.width !== t.width || source.height !== t.height) {
      source.width = t.width;
      source.height = t.height;
    }
    const read = device.replayer.framebufferOf(t);
    s.bindReadFramebuffer(read);
    s.bindDrawFramebuffer(null);
    s.enable(gl.SCISSOR_TEST, false);
    s.set('colorMask', '1111', () => gl.colorMask(true, true, true, true));
    gl.blitFramebuffer(0, 0, t.width, t.height, 0, t.height, t.width, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    if ((c.alphaMode ?? 'opaque') === 'opaque') {
      s.set('colorMask', '0001', () => gl.colorMask(false, false, false, true));
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    const transferable = typeof (source as OffscreenCanvas).transferToImageBitmap === 'function';
    // A canvas's mode cannot change on reconfiguration. XR devices use page-backed
    // sources; desktop devices use OffscreenCanvas. Either source must reach the
    // output selected by the first device, in either transition direction.
    this.output ??= (this.getContext.call(this.canvas, transferable ? 'bitmaprenderer' : '2d') ??
      this.getContext.call(this.canvas, transferable ? '2d' : 'bitmaprenderer')) as typeof this.output;
    if (!this.output) {
      device.validationError('The canvas already has another kind of context; the frame cannot be shown');
      return;
    }
    if ('transferFromImageBitmap' in this.output) {
      let image = source as OffscreenCanvas;
      if (!transferable) {
        image = this.copy ??= new OffscreenCanvas(t.width, t.height);
        if (image.width !== t.width) image.width = t.width;
        if (image.height !== t.height) image.height = t.height;
        const copy = image.getContext('2d') as OffscreenCanvasRenderingContext2D;
        copy.globalCompositeOperation = 'copy';
        copy.drawImage(source, 0, 0);
      }
      this.output.transferFromImageBitmap(image.transferToImageBitmap());
      this.shownBy?.shown.delete(this);
      this.shownBy = transferable ? device : null;
      this.shownBy?.shown.add(this);
    } else {
      this.output.clearRect(0, 0, t.width, t.height);
      this.output.drawImage(source, 0, 0);
    }
  }

  /**
   * Moves the frame on the page off the device's context, which is about to be lost. As in WebGPU the page keeps showing
   * it; and the image from transferToImageBitmap is only valid while that context lives. Chrome 157 on macOS kills the
   * tab when such an image reaches its next commit after the loss, so a copy from a context of the page's own replaces it.
   */
  keepFrame(): void {
    const { canvas, output } = this,
      { width, height } = canvas;
    this.shownBy = null;
    if (!output || !('transferFromImageBitmap' in output) || !width || !height) return;
    const copy = new OffscreenCanvas(width, height),
      context = copy.getContext('2d') as OffscreenCanvasRenderingContext2D;
    context.globalCompositeOperation = 'copy';
    context.drawImage(canvas, 0, 0);
    output.transferFromImageBitmap(copy.transferToImageBitmap());
  }
}
