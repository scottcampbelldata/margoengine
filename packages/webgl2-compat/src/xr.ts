// @margoengine/webgl2-compat/xr: WebXR on the compatibility layer. Written from the W3C WebXR Device API (XRWebGLLayer,
// opaque framebuffers) and the WebXR/WebGPU binding draft. `XR` from @margoengine/xr draws through `XRGPUBinding`, which
// a WebGL2 session cannot have, so this entry puts a binding of the same shape in its place: each eye renders into an
// ordinary texture of the layer's device, and `present` draws those textures into the XRWebGLLayer's framebuffer at the
// end of the frame. Nothing runs at import time: globals change only in installXR().
import { fault } from '../../shared/errors.js';
import { CompatDevice, CompatGPU } from './device/device.js';
import { type CompatTexture, TextureUsage } from './device/resources.js';

/** Options of {@link installXR}. */
export interface CompatXROptions {
  /**
   * The `framebufferScaleFactor` of each session's XRWebGLLayer: the layer's size against the headset's default, the
   * first setting to lower on a weak GPU. Default: the browser's own default.
   */
  readonly framebufferScale?: number;
}

/** Undoes {@link installXR}. */
export interface CompatXR {
  /** Puts back what `XRGPUBinding` was. Sessions already running keep their binding. */
  dispose(): void;
  [Symbol.dispose](): void;
}

type Viewport = { x: number; y: number; width: number; height: number };
/** The part of the browser's XRWebGLLayer the binding uses. */
interface WebGLLayer {
  readonly framebuffer: WebGLFramebuffer | null;
  getViewport(view: unknown): Viewport | null;
}
type WebGLLayerClass = new (session: unknown, context: WebGL2RenderingContext, init: object) => WebGLLayer;
/** The part of an XRView the binding uses. */
interface View {
  readonly projectionMatrix: ArrayLike<number>;
}
interface Eye {
  color?: CompatTexture;
  /** Where the eye goes in the XR framebuffer, in its bottom-left coordinates. */
  target?: Viewport;
}

/** The layer {@link CompatXRBinding.createProjectionLayer} makes; `baseLayer` goes in the session's render state. */
export class CompatXRProjectionLayer {
  /** Each eye's texture, by where the browser puts it, so a frame's new XRView objects find theirs. */
  readonly eyes = new Map<string, Eye>();
  /** The eyes handed out since the last present. */
  readonly drawn = new Set<Eye>();
  constructor(
    /** The browser's XRWebGLLayer. */
    readonly baseLayer: WebGLLayer,
  ) {}
  /** Frees the eyes' textures. The XRWebGLLayer has no destroy: the session drops it. */
  destroy(): void {
    for (const eye of this.eyes.values()) eye.color?.destroy();
    this.eyes.clear();
    this.drawn.clear();
  }
  /** Same as {@link CompatXRProjectionLayer.destroy}. */
  dispose(): void {
    this.destroy();
  }
  /** Same as {@link CompatXRProjectionLayer.destroy}, for `using`. */
  [Symbol.dispose](): void {
    this.destroy();
  }
}

let scale: number | undefined;

/**
 * `XRGPUBinding`'s shape on an XRWebGLLayer. {@link installXR} makes it the global `XRGPUBinding`; `webgl` tells
 * `@margoengine/xr` which kind it has, because a WebGL2 session must not ask for the 'webgpu' feature.
 */
export class CompatXRBinding {
  /** Marks a binding that draws through an XRWebGLLayer. */
  static readonly webgl = true;
  constructor(
    private readonly session: unknown,
    private readonly device: CompatDevice,
  ) {
    if (!(device instanceof CompatDevice))
      throw new TypeError(
        'CompatXRBinding needs a device of the WebGL2 compatibility layer; use navigator.gpu after install()',
      );
  }

  /** WebGL2 stores rgba, and an XRWebGLLayer's framebuffer takes the same bytes a canvas does. */
  getPreferredColorFormat(): GPUTextureFormat {
    return 'rgba8unorm';
  }

  /**
   * Makes the session's XRWebGLLayer. No multisampling there, because the eyes are multisampled and resolved before
   * they arrive, and no depth, because the framebuffer's depth cannot be filled from another texture.
   */
  createProjectionLayer(init: { colorFormat: GPUTextureFormat }): CompatXRProjectionLayer {
    if (init.colorFormat !== 'rgba8unorm')
      throw new TypeError(`An XRWebGLLayer takes rgba8unorm, not '${init.colorFormat}'; use getPreferredColorFormat()`);
    const Layer = (globalThis as unknown as { XRWebGLLayer?: WebGLLayerClass }).XRWebGLLayer;
    if (!Layer) throw fault('unsupported', 'This browser has no XRWebGLLayer', 'compatibility-layer');
    return new CompatXRProjectionLayer(
      new Layer(this.session, this.device.gl, {
        antialias: false,
        depth: false,
        stencil: false,
        alpha: true,
        ignoreDepthValues: true,
        ...(scale === undefined ? {} : { framebufferScaleFactor: scale }),
      }),
    );
  }

  /** The texture one eye draws into this frame, as big as the eye's part of the XR framebuffer. */
  getViewSubImage(layer: CompatXRProjectionLayer, view: View) {
    const target = layer.baseLayer.getViewport(view);
    if (!target)
      throw fault('state', 'The XR view has no viewport in this layer; pass a view of this session', 'compatibility-layer');
    const key = `${target.x},${target.y}`;
    let eye = layer.eyes.get(key);
    if (!eye) layer.eyes.set(key, (eye = {}));
    if (eye.color?.width !== target.width || eye.color.height !== target.height) {
      eye.color?.destroy();
      eye.color = this.device.createTexture({
        size: [target.width, target.height],
        format: 'rgba8unorm',
        usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
        label: 'XR eye',
      });
    }
    eye.target = target;
    layer.drawn.add(eye);
    return {
      colorTexture: eye.color,
      depthStencilTexture: null,
      viewport: { x: 0, y: 0, width: target.width, height: target.height },
      getViewDescriptor: () => ({}),
    };
  }

  /**
   * The view's projection for clip space as WebGPU has it. A WebGL session's XRView gives z in [-1, 1], and the layer's
   * clip space, like a WebGPU session's, is [0, 1]: z' = (z + w) / 2.
   */
  projection(view: View): Float32Array {
    const p = Float32Array.from(view.projectionMatrix);
    for (let column = 0; column < 16; column += 4) p[column + 2] = (p[column + 2] + p[column + 3]) / 2;
    return p;
  }

  /**
   * Draws the eyes into the XR framebuffer; the frame's commands must be submitted. A draw, because the browser may
   * multisample the framebuffer whatever `antialias` asked, and a blit into a multisampled target is an error. Each
   * eye goes in at its viewport, flipped: textures on the layer keep WebGPU's top-left origin.
   */
  present(layer: CompatXRProjectionLayer): void {
    const device = this.device;
    // Commands waiting for the compute runtime have not drawn yet, and the framebuffer only takes this frame's pixels.
    if (device.destroyed || device.queue.waiting) return layer.drawn.clear();
    const gl = device.gl,
      s = device.state,
      replayer = device.replayer,
      helper = replayer.helper(
        'xr',
        'uniform highp sampler2D t;\nuniform ivec4 o;\nout highp vec4 c;\nvoid main() { ivec2 p = ivec2(gl_FragCoord.xy) - o.xy; c = texelFetch(t, ivec2(p.x, o.w - 1 - p.y), 0); }',
      );
    s.bindDrawFramebuffer(layer.baseLayer.framebuffer);
    for (const eye of layer.drawn) {
      const { x, y, width, height } = eye.target as Viewport;
      replayer.helperState(helper, width, height);
      s.set('viewport', `${x},${y},${width},${height}`, () => gl.viewport(x, y, width, height));
      s.unit(0, gl.TEXTURE_2D, (eye.color as CompatTexture).texture, null);
      gl.uniform4i(helper.offset, x, y, width, height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    s.bindDrawFramebuffer(null);
    layer.drawn.clear();
  }
}

let active: CompatXR | undefined;

/**
 * Gives `@margoengine/xr` a route on the layer: `XRGPUBinding` becomes {@link CompatXRBinding}, so `XR.create` and
 * `requestSession` run as on WebGPU, on an XRWebGLLayer. Call it after the root entry's `install()` installed the
 * layer. Throws `unsupported` where the browser has no WebXR or XRWebGLLayer, `state` before `install()` and on a
 * second call until the first is disposed.
 */
export function installXR({ framebufferScale }: CompatXROptions = {}): CompatXR {
  const g = globalThis as unknown as Record<string, unknown> & { navigator?: { xr?: unknown; gpu?: unknown } };
  if (!g.navigator?.xr || !g.XRWebGLLayer)
    throw fault(
      'unsupported',
      'installXR needs WebXR with XRWebGLLayer; use a WebXR browser over HTTPS or localhost',
      'compatibility-layer',
    );
  if (!(g.navigator.gpu instanceof CompatGPU))
    throw fault(
      'state',
      'installXR comes after install(); where install() left WebGPU in place XR needs no route',
      'compatibility-layer',
    );
  if (active) throw fault('state', 'installXR is already in place; dispose the first call', 'compatibility-layer');
  const own = Object.getOwnPropertyDescriptor(globalThis, 'XRGPUBinding');
  Object.defineProperty(globalThis, 'XRGPUBinding', { value: CompatXRBinding, configurable: true, writable: true });
  scale = framebufferScale;
  const dispose = () => {
    if (active !== handle) return;
    active = undefined;
    if (own) Object.defineProperty(globalThis, 'XRGPUBinding', own);
    else delete g.XRGPUBinding;
  };
  const handle: CompatXR = { dispose, [Symbol.dispose]: dispose };
  active = handle;
  return handle;
}
