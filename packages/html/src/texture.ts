/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  type Engine,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { margoError } from '../../shared/errors.js';
import { overlayDepthPass } from '../../shared/pass.js';
import { applyView } from '../../shared/view-rect.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };

/** Options of one HTML surface: its size in world units, its texture density and the transform it follows. */
export interface HTMLSurfaceOptions {
  /** Width in world units. Default: the element's CSS width / 100 (100 CSS pixels a metre). */
  width?: number;
  /** Height in world units. Default: the element's CSS height / 100. */
  height?: number;
  /** Texture pixels per CSS pixel, 0.25 to 4. Default `devicePixelRatio` (1 without one). */
  pixelRatio?: number;
  /** Follow this mesh's world transform. The surface lies in its local XY plane, centred, facing +Z. */
  mesh?: Mesh;
  /** Column-major 4 x 4 world matrix, used without `mesh`. Default identity. */
  matrix?: ArrayLike<number>;
  /** Route the page's pointer to the element where it hits the surface. Default true. */
  interactive?: boolean;
}
/** Which rasterizer draws the element: the browser's HTML-in-canvas `drawElementImage`, or an SVG `foreignObject`. */
export type HTMLSurfaceRasterizer = 'element-image' | 'foreign-object';
type Context = Extract<PassContext, { backend: 'webgpu' }>;
const shader = `
struct Surface {camera:mat4x4f,model:mat4x4f,size:vec4f}
@group(0) @binding(0) var<uniform> surface:Surface;
@group(0) @binding(1) var image:texture_2d<f32>;
@group(0) @binding(2) var linearSampler:sampler;
struct Varyings {@builtin(position) position:vec4f,@location(0) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) index:u32)->Varyings {
 let c=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[index];
 let local=vec4f((c.x-0.5)*surface.size.x,(0.5-c.y)*surface.size.y,0,1);
 return Varyings(surface.camera*(surface.model*local),c);
}
@fragment fn fragment(v:Varyings)->@location(0) vec4f {
 let color=textureSample(image,linearSampler,v.uv);
 if(color.a<0.004){discard;}
 return color;
}`;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Column-major `m` times the column (x, y, z, w). */
const apply = (m: ArrayLike<number>, x: number, y: number, z: number, w: number) =>
  [0, 1, 2, 3].map((row) => m[row] * x + m[row + 4] * y + m[row + 8] * z + m[row + 12] * w);
/**
 * Where the pointer at clip-space point (x, y) meets a surface of `width` x `height` in the XY plane of `model`: its UV
 * (0,0 top left) and its clip depth, or null. The plane's points (px, py) project by the 3 x 3 homography of columns x,
 * y and w of viewProjection x model, so (px, py) solves two linear equations; no matrix is inverted, and it holds on
 * both depth conventions.
 */
export function surfaceHit(
  viewProjection: ArrayLike<number>,
  model: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
): { u: number; v: number; t: number } | null {
  const column = (c: number) => apply(viewProjection, model[c], model[c + 1], model[c + 2], model[c + 3]),
    a = column(0),
    b = column(4),
    o = column(12);
  // Rows: clip x - x * clip w = 0 and clip y - y * clip w = 0, in (px, py).
  const a1 = a[0] - x * a[3],
    b1 = b[0] - x * b[3],
    c1 = x * o[3] - o[0],
    a2 = a[1] - y * a[3],
    b2 = b[1] - y * b[3],
    c2 = y * o[3] - o[1],
    det = a1 * b2 - b1 * a2;
  // Seen edge on, or a degenerate pose: a miss.
  if (!(Math.abs(det) > 1e-12)) return null;
  const px = (c1 * b2 - b1 * c2) / det,
    py = (a1 * c2 - c1 * a2) / det,
    u = px / width + 0.5,
    v = 0.5 - py / height,
    w = a[3] * px + b[3] * py + o[3];
  // Off the quad, or behind the eye (w at or below 0): a miss.
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1) || !(w > 0)) return null;
  return { u, v, t: (a[2] * px + b[2] * py + o[2]) / w };
}
/** An inline copy of an element tree for an SVG image: every computed style written out, form state as attributes. */
function inlineCopy(source: Element): Element {
  const copy = source.cloneNode(false) as Element,
    view = source.ownerDocument.defaultView!;
  if (source instanceof view.HTMLElement || source instanceof view.SVGElement) {
    const style = view.getComputedStyle(source);
    let text = '';
    for (let i = 0; i < style.length; i++) {
      const name = style[i];
      text += `${name}:${style.getPropertyValue(name)};`;
    }
    copy.setAttribute('style', text);
  }
  if (source instanceof view.HTMLInputElement) {
    copy.setAttribute('value', source.value);
    if (source.checked) copy.setAttribute('checked', '');
    else copy.removeAttribute('checked');
  } else if (source instanceof view.HTMLTextAreaElement) copy.textContent = source.value;
  for (const child of source.childNodes)
    copy.appendChild(child.nodeType === 1 ? inlineCopy(child as Element) : child.cloneNode(false));
  return copy;
}
/** One element drawn on a quad in the scene. */
export class HTMLSurface {
  readonly element: HTMLElement;
  width: number;
  height: number;
  mesh: Mesh | null;
  readonly matrix = new Float32Array(identity);
  interactive: boolean;
  /** Raster drawn so far; the texture is redrawn after the element changes. */
  draws = 0;
  /** @internal */ readonly holder: HTMLElement;
  /** @internal The 2D canvas a foreignObject image is drawn into before its upload. */
  scratch?: HTMLCanvasElement;
  /** @internal */ texture?: GPUTexture;
  /** @internal */ group?: GPUBindGroup;
  /** @internal */ uniform?: GPUBuffer;
  /** @internal */ dirty = true;
  /** @internal */ busy = false;
  /** @internal */ readonly pixelRatio: number;
  /** @internal */ readonly world = new Float32Array(16);
  private readonly observer?: MutationObserver;
  /** @internal A raster waiting for the holder canvas's next paint event (HTML-in-canvas draws only there). */
  painting?: () => void;
  private readonly mark = () => this.invalidate();
  // The holder's paint event: it runs a waiting raster, else it says the element's rendering changed.
  private readonly paint = () => {
    const painting = this.painting;
    this.painting = undefined;
    if (painting) painting();
    else this.invalidate();
  };
  constructor(
    private readonly owner: HTMLTexture,
    element: HTMLElement,
    options: HTMLSurfaceOptions,
  ) {
    this.element = element;
    const doc = element.ownerDocument,
      view = doc.defaultView!;
    const pixelRatio = options.pixelRatio ?? view.devicePixelRatio ?? 1;
    if (!(pixelRatio >= 0.25 && pixelRatio <= 4))
      throw new RangeError('Invalid HTML surface pixelRatio; pass 0.25 to 4 texture pixels per CSS pixel');
    this.pixelRatio = pixelRatio;
    // The holder keeps the element laid out at its CSS size, invisible (opacity 0) and out of the way of the page's
    // pointer until the pointer is over the surface. It stays at the viewport's top left, not off screen: the browser
    // takes no HTML-in-canvas snapshot of a canvas outside the viewport.
    const holder = owner.rasterizer === 'element-image' ? doc.createElement('canvas') : doc.createElement('div');
    // HTML-in-canvas opts in twice: the canvas draws its content (content="drawable"), the element is drawable.
    if (owner.rasterizer === 'element-image') {
      holder.setAttribute('content', 'drawable');
      element.setAttribute('drawable', '');
    }
    holder.setAttribute('data-margoengine-html-surface', '');
    const s = holder.style;
    s.position = 'fixed';
    s.left = s.top = '0';
    s.opacity = '0';
    s.pointerEvents = 'none';
    s.zIndex = '2147483647';
    s.transformOrigin = '0 0';
    s.transform = 'none';
    holder.appendChild(element);
    doc.body.appendChild(holder);
    const rect = element.getBoundingClientRect(),
      cssWidth = element.offsetWidth || rect.width,
      cssHeight = element.offsetHeight || rect.height;
    if (holder instanceof view.HTMLCanvasElement) {
      holder.width = Math.max(1, Math.round(cssWidth * pixelRatio));
      holder.height = Math.max(1, Math.round(cssHeight * pixelRatio));
      holder.style.width = `${cssWidth}px`;
      holder.style.height = `${cssHeight}px`;
      holder.addEventListener('paint', this.paint);
    }
    this.width = options.width ?? cssWidth / 100;
    this.height = options.height ?? cssHeight / 100;
    if (!(this.width > 0 && this.height > 0 && Number.isFinite(this.width) && Number.isFinite(this.height)))
      throw new RangeError('Invalid HTML surface size; give the element a CSS size, or pass width and height above 0');
    this.mesh = options.mesh ?? null;
    if (options.matrix) this.setMatrix(options.matrix);
    this.interactive = options.interactive ?? true;
    this.holder = holder;
    if (typeof view.MutationObserver === 'function') {
      this.observer = new view.MutationObserver(this.mark);
      this.observer.observe(element, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    for (const type of [
      'input',
      'change',
      'focusin',
      'focusout',
      'pointerover',
      'pointerout',
      'pointerdown',
      'pointerup',
    ])
      element.addEventListener(type, this.mark);
  }
  /** Sets the world matrix (column-major) used without `mesh`. */
  setMatrix(matrix: ArrayLike<number>): this {
    if (matrix.length !== 16 || !Array.from(matrix).every(Number.isFinite))
      throw new RangeError('Invalid HTML surface matrix; pass 16 finite numbers, column-major');
    this.matrix.set(matrix);
    return this;
  }
  /** Redraws the texture on the next frame, for changes no mutation shows (a style sheet, a loaded font). */
  invalidate(): void {
    this.dirty = true;
  }
  /** The element's size in CSS pixels, as drawn on the surface. */
  get cssSize(): [number, number] {
    return [this.element.offsetWidth, this.element.offsetHeight];
  }
  remove(): void {
    this.owner.remove(this);
  }
  /** @internal */ detach(): void {
    this.observer?.disconnect();
    for (const type of [
      'input',
      'change',
      'focusin',
      'focusout',
      'pointerover',
      'pointerout',
      'pointerdown',
      'pointerup',
    ])
      this.element.removeEventListener(type, this.mark);
    this.holder.removeEventListener('paint', this.paint);
    if (this.owner.rasterizer === 'element-image') this.element.removeAttribute('drawable');
    this.painting = undefined;
    this.holder.remove();
    this.texture?.destroy();
    this.uniform?.destroy();
    this.texture = this.uniform = this.group = undefined;
  }
}
/**
 * HTML elements drawn as textures on quads in the scene, depth-tested with it, with the page's pointer routed to the
 * element where it hits a quad. WebGPU only.
 */
export class HTMLTexture {
  readonly name: string;
  /** How elements are drawn: the HTML-in-canvas API where the browser has it, else an SVG `foreignObject` image. */
  readonly rasterizer: HTMLSurfaceRasterizer;
  private runtime?: Engine;
  private readonly surfaces = new Set<HTMLSurface>();
  private pipelines = new Map<string, GPURenderPipeline>();
  private sampler?: GPUSampler;
  private disposed = false;
  private hovered: HTMLSurface | null = null;
  /** Depth convention of the last frame: reversed depth is nearer when larger. */
  private reversed = false;
  /** Colour and depth loaded and stored, so later passes see the quads' depth too. */
  private readonly descriptor = overlayDepthPass();
  private readonly values = new Float32Array(36);
  private readonly pointer = (event: PointerEvent) => this.route(event);
  constructor(options: { name?: string; rasterizer?: HTMLSurfaceRasterizer } = {}) {
    this.name = options.name ?? 'html-texture';
    const native =
      typeof CanvasRenderingContext2D !== 'undefined' && 'drawElementImage' in CanvasRenderingContext2D.prototype;
    this.rasterizer = options.rasterizer ?? (native ? 'element-image' : 'foreign-object');
    if (this.rasterizer !== 'element-image' && this.rasterizer !== 'foreign-object')
      throw new RangeError("Invalid HTMLTexture rasterizer; pass 'element-image' or 'foreign-object'");
    if (this.rasterizer === 'element-image' && !native)
      throw margoError(
        'unsupported',
        "This browser has no HTML-in-canvas drawElementImage; use rasterizer: 'foreign-object'",
      );
  }
  static attach(engine: EngineKernel, options?: { name?: string; rasterizer?: HTMLSurfaceRasterizer }): HTMLTexture {
    const textures = new HTMLTexture(options);
    engineRuntime(engine).use(textures);
    return textures;
  }
  /** Draws `element` on a quad in the scene. The element moves into an invisible holder in `document.body`. */
  add(element: HTMLElement, options: HTMLSurfaceOptions = {}): HTMLSurface {
    if (this.disposed) throw margoError('disposed', 'HTMLTexture is disposed; create a new one');
    const surface = new HTMLSurface(this, element, options);
    this.surfaces.add(surface);
    return surface;
  }
  remove(surface: HTMLSurface): void {
    if (!this.surfaces.delete(surface)) return;
    if (this.hovered === surface) this.hovered = null;
    surface.detach();
  }
  get size(): number {
    return this.surfaces.size;
  }
  setup(instance: EngineKernel): void {
    if (this.disposed) throw margoError('disposed', 'HTMLTexture is disposed; create a new one');
    const engine = engineRuntime(instance);
    if (!engine.gpu)
      throw margoError(
        'unsupported',
        'HTMLTexture requires WebGPU, not the WebGL2 fallback; create the engine where WebGPU is available; see https://margoengine.com/errors#webgpu',
      );
    this.runtime = engine;
    engine.canvas.ownerDocument.addEventListener('pointermove', this.pointer, true);
    engine.canvas.ownerDocument.addEventListener('pointerdown', this.pointer, true);
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: 0.75,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  /** World matrix of a surface this frame: its mesh's, or its own. */
  worldMatrix(surface: HTMLSurface): Float32Array {
    const mesh = surface.mesh,
      out = surface.world;
    if (mesh && this.runtime) {
      const id = meshRuntime(mesh).id;
      out.set(this.runtime.store.matrices.subarray(id * 16, id * 16 + 16));
    } else out.set(surface.matrix);
    return out;
  }
  /** Moves the hit surface's element under the pointer so the browser's own hit test, focus and hover reach it. */
  private route(event: PointerEvent): void {
    const engine = this.runtime;
    if (!engine) return;
    const canvas = engine.canvas,
      rect = canvas.getBoundingClientRect(),
      x = ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y = 1 - ((event.clientY - rect.top) / rect.height) * 2;
    let best: { surface: HTMLSurface; u: number; v: number; t: number } | null = null;
    if (x >= -1 && x <= 1 && y >= -1 && y <= 1)
      for (const surface of this.surfaces) {
        if (!surface.interactive) continue;
        const hit = surfaceHit(engine.camera.matrix, this.worldMatrix(surface), surface.width, surface.height, x, y);
        // Nearest first on either depth convention: reversed depth is nearer when larger.
        if (hit && (!best || (this.reversed ? hit.t > best.t : hit.t < best.t))) best = { surface, ...hit };
      }
    if (this.hovered && this.hovered !== best?.surface) {
      this.hovered.holder.style.pointerEvents = 'none';
      this.hovered.holder.style.transform = 'none';
    }
    this.hovered = best?.surface ?? null;
    if (!best) return;
    const [w, h] = best.surface.cssSize,
      s = best.surface.holder.style;
    s.transform = `translate(${event.clientX - best.u * w}px,${event.clientY - best.v * h}px)`;
    s.pointerEvents = 'auto';
  }
  private pipeline(c: Context): GPURenderPipeline {
    const d = c.descriptor,
      key = `${d.multisample?.count} ${c.format} ${d.depthStencil?.format} ${d.depthStencil?.depthCompare}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = c.device.createShaderModule({ code: shader });
      pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: c.format,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: d.depthStencil && {
          format: d.depthStencil.format,
          depthWriteEnabled: true,
          depthCompare: d.depthStencil.depthCompare ?? 'less',
        },
        multisample: d.multisample,
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
  private refresh(device: GPUDevice, surface: HTMLSurface): void {
    if (!surface.dirty || surface.busy) return;
    surface.dirty = false;
    surface.busy = true;
    const [cssWidth, cssHeight] = surface.cssSize,
      width = Math.max(1, Math.round(cssWidth * surface.pixelRatio)),
      height = Math.max(1, Math.round(cssHeight * surface.pixelRatio));
    this.rasterize(surface, cssWidth, cssHeight, width, height)
      .then((source) => {
        if (this.disposed || !this.surfaces.has(surface)) return;
        if (!surface.texture || surface.texture.width !== width || surface.texture.height !== height) {
          surface.texture?.destroy();
          surface.texture = device.createTexture({
            size: [width, height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
          });
          surface.group = undefined;
        }
        device.queue.copyExternalImageToTexture({ source }, { texture: surface.texture, premultipliedAlpha: true }, [
          width,
          height,
        ]);
        surface.draws++;
      })
      .catch((error: unknown) => {
        // A failed raster is an error of the page (a tainting image, say): reported, never hidden.
        queueMicrotask(() => {
          throw error;
        });
      })
      .finally(() => {
        surface.busy = false;
      });
  }
  private async rasterize(
    surface: HTMLSurface,
    cssWidth: number,
    cssHeight: number,
    width: number,
    height: number,
  ): Promise<HTMLCanvasElement> {
    const holder = surface.holder;
    // The holder's own window's classes, not this one's: the element may live in another frame.
    if (holder instanceof holder.ownerDocument.defaultView!.HTMLCanvasElement) {
      if (holder.width !== width) holder.width = width;
      if (holder.height !== height) holder.height = height;
      const context = holder.getContext('2d')! as CanvasRenderingContext2D & {
        drawElementImage(element: Element, x: number, y: number, w: number, h: number): void;
      };
      // drawElementImage draws the element's snapshot of the current rendering update, so only in the paint event;
      // requestPaint asks for one even when nothing changed.
      await new Promise<void>((resolve, reject) => {
        surface.painting = () => {
          try {
            context.reset();
            context.drawElementImage(surface.element, 0, 0, width, height);
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        (holder as HTMLCanvasElement & { requestPaint?(): void }).requestPaint?.();
      });
      return holder;
    }
    const markup = new XMLSerializer().serializeToString(inlineCopy(surface.element));
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${cssWidth} ${cssHeight}">` +
      `<foreignObject x="0" y="0" width="${cssWidth}" height="${cssHeight}">${markup}</foreignObject></svg>`;
    const image = new Image(width, height);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    // WebGPU counts an SVG image with a foreignObject as cross-origin, a 2D canvas it was drawn into as clean.
    const canvas = (surface.scratch ??= holder.ownerDocument.createElement('canvas'));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext('2d')!;
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return canvas;
  }
  private draw(c: Context): void {
    if (!this.surfaces.size) return;
    const pipeline = this.pipeline(c);
    this.reversed = (c.descriptor.depthStencil?.depthCompare ?? 'less').startsWith('greater');
    this.sampler ??= c.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    let pass: GPURenderPassEncoder | undefined;
    for (const surface of this.surfaces) {
      this.refresh(c.device, surface);
      if (!surface.texture) continue;
      surface.uniform ??= c.device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      surface.group ??= c.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: surface.uniform } },
          { binding: 1, resource: surface.texture.createView() },
          { binding: 2, resource: this.sampler },
        ],
      });
      const values = this.values;
      values.set(c.camera.matrix);
      values.set(this.worldMatrix(surface), 16);
      values[32] = surface.width;
      values[33] = surface.height;
      c.device.queue.writeBuffer(surface.uniform, 0, values as Float32Array<ArrayBuffer>);
      if (!pass) {
        const descriptor = this.descriptor;
        descriptor.colorAttachments[0].view = c.color;
        descriptor.depthStencilAttachment.view = c.depth;
        pass = c.encoder.beginRenderPass(descriptor);
        applyView(pass, c);
        pass.setPipeline(pipeline);
      }
      pass.setBindGroup(0, surface.group);
      pass.draw(6);
    }
    pass?.end();
  }
  onDeviceRestored(): void {
    this.pipelines.clear();
    this.sampler = undefined;
    for (const surface of this.surfaces) {
      surface.texture = surface.uniform = surface.group = undefined;
      surface.dirty = true;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.runtime;
    engine?.canvas.ownerDocument.removeEventListener('pointermove', this.pointer, true);
    engine?.canvas.ownerDocument.removeEventListener('pointerdown', this.pointer, true);
    for (const surface of this.surfaces) surface.detach();
    this.surfaces.clear();
    engine?.removePlugin(this.name);
    this.runtime = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
