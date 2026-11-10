/// <reference lib="esnext.disposable" preserve="true" />
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { Engine as PublicEngine, type EngineKernel, type EngineOptions } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { COMPAT_VENDOR } from '../../shared/compat.js';
import { StereoRenderer } from './renderer.js';
import { EyeViews } from './eyes.js';
import type { XREyeTarget } from './eye-target.js';
export type { XREyeTarget } from './eye-target.js';
import { XRController } from './controller.js';
export { XRController } from './controller.js';
export { HitTest, type Hit, type HitTestHost, type HitTestOptions } from './hit-test.js';
import type {
  XRBinding,
  XRFrameState,
  XRMode,
  XRNativeFrame,
  XRNativeSession,
  XRProjectionLayer,
  XRSpace,
  XRSystem,
} from './types.js';
export type {
  XRBinding,
  XRFrameState,
  XRMode,
  XRNativeFrame,
  XRNativeSession,
  XRInputSource,
  XRInputPose,
  XRPose,
  XRSpace,
  XRView,
  XRViewerPose,
  XRProjectionLayer,
  XRSubImage,
  XRSystem,
  XRAnchor,
  XRHitTestResult,
  XRHitTestSource,
  XRHitTestTrackableType,
  XRRayLike,
  XRTransientInputHitTestResult,
  XRTransientInputHitTestSource,
} from './types.js';
/** Options for {@link XR.requestSession}. */
export interface XRSessionOptions {
  /** Space of frame poses. Default 'local' (immersive) or 'viewer' (inline). */
  referenceSpace?: 'viewer' | 'local' | 'local-floor' | 'bounded-floor' | 'unbounded';
  /** Features the session must have, such as 'hand-tracking'; the request fails without them. */
  requiredFeatures?: string[];
  /** Features used when granted, such as 'hit-test'. */
  optionalFeatures?: string[];
  /**
   * More session init members from WebXR modules, passed to `navigator.xr.requestSession` as given: for example
   * `{ depthSensing: DEPTH_SENSING }` from `@margoengine/xr/ar`. The feature lists above win over any given here.
   */
  init?: Record<string, unknown>;
  /** Projection resolution relative to the runtime recommendation. Default native 1, or installXR's setting on compatibility. */
  framebufferScale?: number;
  /** Abort while the browser negotiates the session or the layer is set up: the session is ended and the request rejects with the reason. */
  signal?: AbortSignal;
  /** Called once per XR frame with reused state; copy anything you keep. Return false to own rendering with renderFrame(). */
  onFrame?: (state: XRFrameState) => unknown;
}
const platform = () =>
  globalThis as typeof globalThis & {
    /** `webgl` marks the WebGL2 layer's binding, on an XRWebGLLayer; the session then has no 'webgpu' feature. */
    XRGPUBinding?: (new (session: XRNativeSession, device: GPUDevice) => XRBinding) & { webgl?: boolean };
  };
const system = (): XRSystem | undefined => (globalThis.navigator as (Navigator & { xr?: XRSystem }) | undefined)?.xr;
/** Devices of engines made by `createXREngine`: XR-compatible, so XR draws through them. */
const xrDevices = new WeakSet<GPUDevice>();

/**
 * Creates a WebGPU engine on an XR-compatible adapter (WebXR/WebGPU binding: `requestAdapter({xrCompatible: true})`),
 * so `XR.create` shares its GPU device and draws each eye through the engine's own frame graph: lines, points,
 * terrain, shadows and post effects appear in both eyes as on the desktop. Takes the options of `Engine.create`;
 * `backend` is always 'webgpu'. After a device loss and restore the engine's new device is not XR-compatible, and a new
 * `XR.create` draws through a device of its own, as with a plain engine.
 * @throws MargoError 'unsupported' without WebGPU.
 */
export async function createXREngine(
  canvas: HTMLCanvasElement,
  options: Omit<EngineOptions, 'backend'> = {},
): Promise<EngineKernel> {
  const gpu = globalThis.navigator?.gpu;
  if (!gpu) throw new MargoError('unsupported', 'createXREngine needs WebGPU; use a browser with WebGPU and WebXR');
  // Core asks for its adapter itself, so the request gains xrCompatible for the length of the creation only.
  const own = Object.getOwnPropertyDescriptor(gpu, 'requestAdapter'),
    request = gpu.requestAdapter;
  Object.defineProperty(gpu, 'requestAdapter', {
    configurable: true,
    writable: true,
    value: (init?: GPURequestAdapterOptions) =>
      request.call(gpu, { ...init, xrCompatible: true } as GPURequestAdapterOptions),
  });
  let engine: EngineKernel;
  try {
    engine = await PublicEngine.create(canvas, { ...options, backend: 'webgpu' });
  } finally {
    if (own) Object.defineProperty(gpu, 'requestAdapter', own);
    else delete (gpu as { requestAdapter?: unknown }).requestAdapter;
  }
  const device = engineRuntime(engine).gpu;
  if (device) xrDevices.add(device);
  return engine;
}

/** WebGPU WebXR plugin: negotiates a session, tracks inputs and draws the scene in stereo. `using` or `dispose()` detaches it. */
export class XR implements EnginePlugin {
  /** Plugin name, 'xr'. */
  readonly name = 'xr';
  /** The active native session, or null. */
  session: XRNativeSession | null = null;
  /**
   * How the eyes are drawn. 'engine': through the engine's frame graph on its own device (an engine from
   * `createXREngine`), so every package pass and post effect draws. 'separate': on a device of XR's own, which draws
   * core meshes and loader PBR models only.
   */
  readonly route: 'engine' | 'separate';
  private engine!: Engine;
  private readonly renderer?: StereoRenderer;
  private eyes?: EyeViews;
  private context?: Extract<PassContext, { backend: 'webgpu' }>;
  private binding?: XRBinding;
  private layer?: XRProjectionLayer;
  private space?: XRSpace;
  private handle: number | null = null;
  private pending = false;
  private disposed = false;
  private lost = false;
  private last: number | null = null;
  private mode: XRMode = 'immersive-vr';
  private callback?: XRSessionOptions['onFrame'];
  private readonly listeners = new Set<(state: XRFrameState) => void>();
  /** One controller per current input source; updated each XR frame and kept in step with the session's inputs. */
  readonly controllers: XRController[] = [];
  private readonly state: XRFrameState = { time: 0, delta: 0, frame: null!, viewer: null, inputs: this.controllers };
  private readonly renderOptions = { culling: false, delta: 0 };
  private insideFrame = false;
  private resume = false;
  /** True while composition layers sit below the scene, so the scene keeps alpha where it draws nothing. */
  private seeThrough = false;

  /** True when the browser can start `mode`: WebXR (and for immersive modes WebGPU bindings) is present and supports it. */
  static async isSupported(mode: XRMode = 'immersive-vr'): Promise<boolean> {
    if (!system() || (mode !== 'inline' && (!platform().XRGPUBinding || !globalThis.navigator?.gpu))) return false;
    return system()!.isSessionSupported(mode);
  }
  /** Prepare before the click handler so requestSession preserves the browser's user activation. */
  static attach(engine: EngineKernel, options: { signal?: AbortSignal } = {}): Promise<XR> {
    return XR.create(engine, options);
  }
  /** Creates the XR-compatible GPU device and adds the plugin to `engine`. `signal` abandons the wait and releases the device. */
  static async create(engine: EngineKernel, { signal }: { signal?: AbortSignal } = {}): Promise<XR> {
    signal?.throwIfAborted();
    const runtime = engineRuntime(engine);
    if (runtime.backend !== 'webgpu')
      throw new MargoError(
        'unsupported',
        'XR requires WebGPU or the full WebGL2 compatibility layer; use autoEngine with loadCompat; see https://margoengine.com/errors#webgpu',
      );
    if (runtime.disposed || runtime.hasPlugin('xr'))
      throw new MargoError(
        'state',
        "XR requires a live WebGPU engine without an XR plugin; create the engine with backend 'webgpu' and call XR.create once.",
      );
    if (!system())
      throw new MargoError('unsupported', 'WebXR is unavailable; use a WebXR browser over HTTPS or localhost.');
    if (runtime.gpu && xrDevices.has(runtime.gpu)) {
      const xr = new XR(runtime.gpu, true);
      runtime.use(xr);
      return xr;
    }
    const adapter = await navigator.gpu.requestAdapter({
      xrCompatible: !!platform().XRGPUBinding,
    } as GPURequestAdapterOptions);
    if (!adapter)
      throw new MargoError(
        'unsupported',
        'XR-compatible WebGPU adapter unavailable; use a headset browser with WebGPU XR support.; see https://margoengine.com/errors#webgpu',
      );
    // WebXR on WebGL2 draws through XRWebGLLayer, which only the layer's own binding knows.
    if ((adapter as { info?: { vendor?: string } }).info?.vendor === COMPAT_VENDOR && !platform().XRGPUBinding?.webgl)
      throw new MargoError(
        'unsupported',
        "XR needs the browser's own WebGPU (XRGPUBinding) or, on the WebGL2 compatibility layer, its route: call installXR() from the layer's xr entry first; see https://margoengine.com/errors#webgpu",
      );
    signal?.throwIfAborted();
    const requiredFeatures = runtime.gpu
      ? ([...runtime.gpu.features].filter((feature) => adapter.features?.has(feature)) as GPUFeatureName[])
      : [];
    const device = await adapter.requestDevice({ requiredFeatures }),
      xr = new XR(device);
    try {
      signal?.throwIfAborted();
      runtime.use(xr);
      return xr;
    } catch (error) {
      xr.dispose();
      throw error;
    }
  }
  private constructor(
    private readonly device: GPUDevice,
    shared = false,
  ) {
    this.route = shared ? 'engine' : 'separate';
    if (!shared) this.renderer = new StereoRenderer(device);
    device.lost.then((info) => {
      if (!this.disposed) {
        this.lost = true;
        this.fail(new MargoError('failed', `XR GPU device lost: ${info.message}; create a new XR with XR.create.`));
      }
    });
    // The engine reports its own device's errors; a device of XR's own reports here.
    if (!shared) device.addEventListener('uncapturederror', this.uncaptured);
  }
  setup(engine: Engine): void {
    this.engine = engine;
    if (this.route === 'engine') this.eyes = new EyeViews(engine, this.device);
  }
  /**
   * Calls `callback` every XR frame of every session, after the poses and controllers update and before the session's
   * own `onFrame`; packages such as `XRModels` follow the inputs through it. Returns the function that stops it.
   */
  onFrame(callback: (state: XRFrameState) => void): () => void {
    if (typeof callback !== 'function') throw new TypeError('xr.onFrame needs a function; pass (state) => {...}');
    this.listeners.add(callback);
    return () => void this.listeners.delete(callback);
  }
  private readonly eyeListeners = new Set<(target: XREyeTarget) => void>();
  /** Runs for each immersive eye after its scene renders and before GPU submission. Returns an unsubscribe function. */
  onEye(callback: (target: XREyeTarget) => void): () => void {
    if (typeof callback !== 'function') throw new TypeError('xr.onEye needs a function; pass (target) => {...}');
    if (this.disposed) throw new MargoError('disposed', 'XR is disposed; create a new XR before adding an eye effect');
    this.eyeListeners.add(callback);
    return () => void this.eyeListeners.delete(callback);
  }
  private readonly drawEye = (target: XREyeTarget): boolean => {
    for (const listener of this.eyeListeners) {
      listener(target);
      if (this.disposed) return false;
    }
    return !this.disposed;
  };
  /** The session's reference space (the space of frame poses and hit results); undefined without a session. */
  get referenceSpace(): XRSpace | undefined {
    return this.space;
  }
  /**
   * Replaces the space of frame poses, controllers and hits for the rest of the session: `Locomotion` from
   * `@margoengine/xr/layers` passes an offset of the current one (WebXR `getOffsetReferenceSpace`) to teleport and turn.
   */
  useReferenceSpace(space: XRSpace): void {
    if (!this.session || !this.space)
      throw new MargoError(
        'state',
        'useReferenceSpace needs an active session; call it after xr.requestSession resolves',
      );
    if (!space || typeof space !== 'object')
      throw new TypeError(
        'useReferenceSpace needs an XRReferenceSpace; pass xr.referenceSpace.getOffsetReferenceSpace(transform)',
      );
    this.space = space;
  }
  /** The active immersive projection layer, including its baseLayer on compatibility; undefined otherwise. */
  get projectionLayer(): XRProjectionLayer | undefined { return this.layer; }
  /** The immersive session's WebGPU binding and the device its layers use; undefined otherwise. For `XRLayers`. */
  get layerBinding(): { binding: XRBinding; device: GPUDevice } | undefined {
    return this.session && this.binding && this.layer ? { binding: this.binding, device: this.device } : undefined;
  }
  /**
   * Shows `below`, then the scene, then `above` (WebXR Layers: composited in order with source-over). While any layer is
   * below, the scene keeps alpha where it draws nothing, as in AR, so the layers show through. For `XRLayers`.
   */
  setLayers(below: readonly object[], above: readonly object[]): void {
    if (!this.session || !this.layer)
      throw new MargoError('state', 'setLayers needs an immersive session; call it after xr.requestSession resolves');
    if (this.layer.baseLayer)
      throw new MargoError(
        'unsupported',
        "Composition layers need the browser's own XRGPUBinding; the WebGL2 layer's route shows a single XRWebGLLayer",
      );
    this.seeThrough = below.length > 0;
    this.session.updateRenderState({ layers: [...below, this.layer, ...above] });
  }
  private readonly uncaptured = (event: GPUUncapturedErrorEvent): void => {
    if (!this.disposed) this.fail(new MargoError('failed', `XR GPU error: ${event.error.message}`));
  };
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'xr-scene-descriptor',
      order: -1_000_000,
      execute: (context) => {
        if (context.backend === 'webgpu') this.context = context;
      },
    });
  }
  /** Starts a session (call from a user gesture). Rejects if one is active or pending; `options.signal` cancels it. */
  async requestSession(mode: XRMode = 'immersive-vr', options: XRSessionOptions = {}): Promise<XRNativeSession> {
    if (this.disposed || this.lost)
      throw new MargoError('disposed', 'XR is disposed or its device was lost; create a new XR with XR.create.');
    if (this.session || this.pending)
      throw new MargoError(
        'state',
        'An XR session is already active or pending; await xr.end() before requesting another.',
      );
    if (!['inline', 'immersive-vr', 'immersive-ar'].includes(mode))
      throw new TypeError("Unknown XR mode; use 'inline', 'immersive-vr' or 'immersive-ar'");
    if (mode !== 'inline' && !platform().XRGPUBinding)
      throw new MargoError(
        'unsupported',
        'Native WebGPU XR bindings are unavailable; desktop rendering remains active. Use a browser with XRGPUBinding or request an inline session.',
      );
    options.signal?.throwIfAborted();
    const referenceSpace = options.referenceSpace ?? (mode === 'inline' ? 'viewer' : 'local');
    if (!['viewer', 'local', 'local-floor', 'bounded-floor', 'unbounded'].includes(referenceSpace))
      throw new TypeError(
        "Unknown XR reference space; use 'viewer', 'local', 'local-floor', 'bounded-floor' or 'unbounded'",
      );
    if (options.framebufferScale !== undefined && (!Number.isFinite(Math.fround(options.framebufferScale)) || Math.fround(options.framebufferScale) <= 0))
      throw new RangeError('framebufferScale must be finite and positive; pass 1 for the runtime recommendation');
    this.pending = true;
    let session: XRNativeSession | undefined;
    try {
      if (
        mode === 'inline' &&
        [...(options.requiredFeatures ?? []), ...(options.optionalFeatures ?? [])].includes('webgpu')
      )
        throw new TypeError(
          "WebGPU XR bindings do not support inline sessions; remove 'webgpu' from the features or request an immersive mode",
        );
      session = await system()!.requestSession(mode, {
        ...options.init,
        requiredFeatures: [
          ...new Set([
            ...(mode === 'inline' || platform().XRGPUBinding?.webgl ? [] : ['webgpu']),
            ...(referenceSpace === 'viewer' ? [] : [referenceSpace]),
            ...(options.requiredFeatures ?? []),
          ]),
        ],
        optionalFeatures: options.optionalFeatures ?? [],
      });
      if (this.disposed || this.lost)
        throw new MargoError(
          'disposed',
          'XR was disposed during session negotiation; keep the XR alive until requestSession settles.',
        );
      options.signal?.throwIfAborted();
      this.session = session;
      session.addEventListener('end', this.ended, { once: true });
      this.mode = mode;
      this.callback = options.onFrame;
      session.addEventListener('inputsourceschange', this.sourcesChanged);
      this.sourcesChanged();
      // shortcut: inline sessions expose poses with a desktop canvas, upgrade if WebGPU XR permits inline layers.
      if (mode === 'inline') {
        this.space = await session.requestReferenceSpace(referenceSpace);
        if (this.disposed || this.session !== session)
          throw new MargoError('state', 'XR session ended during initialization; request a new session.');
        options.signal?.throwIfAborted();
        this.last = null;
        this.handle = session.requestAnimationFrame(this.frame);
        return session;
      }
      this.binding = new (platform().XRGPUBinding!)(session, this.device);
      const colorFormat = this.binding.getPreferredColorFormat();
      this.layer = this.binding.createProjectionLayer({ colorFormat, depthStencilFormat: 'depth24plus', ...(options.framebufferScale === undefined ? {} : { scaleFactor: options.framebufferScale }) });
      session.updateRenderState({
        ...(this.layer.baseLayer ? { baseLayer: this.layer.baseLayer } : { layers: [this.layer] }),
        depthNear: this.engine.camera.near,
        depthFar: this.engine.camera.far,
      });
      this.space = await session.requestReferenceSpace(referenceSpace);
      if (this.disposed || this.session !== session)
        throw new MargoError('state', 'XR session ended during initialization; request a new session.');
      options.signal?.throwIfAborted();
      if (this.eyes) {
        this.engine.stop();
        this.resume = true;
        this.last = null;
        this.handle = session.requestAnimationFrame(this.frame);
        return session;
      }
      this.engine.render({ culling: false });
      if (!this.context)
        throw new MargoError(
          'state',
          'WebGPU scene descriptor unavailable; add the XR plugin before the first frame renders.',
        );
      this.renderer!.configure(this.context, colorFormat);
      this.engine.stop();
      this.resume = true;
      this.last = null;
      this.handle = session.requestAnimationFrame(this.frame);
      return session;
    } catch (error) {
      if (session) {
        try {
          await session.end();
        } catch {
        } finally {
          if (this.session === session) this.ended();
        }
      }
      throw error;
    } finally {
      this.pending = false;
    }
  }
  private readonly frame = (time: number, frame: XRNativeFrame): void => {
    this.handle = null;
    if (this.disposed || frame.session !== this.session) return;
    try {
      this.insideFrame = true;
      const delta = this.last === null ? 0 : Math.max(0, Math.min((time - this.last) / 1000, 0.1));
      this.last = time;
      const viewer = frame.getViewerPose(this.space!);
      for (let i = 0; i < this.controllers.length; i++) this.controllers[i].update(frame, this.space!);
      this.state.time = time;
      this.state.delta = delta;
      this.state.frame = frame;
      this.state.viewer = viewer;
      for (const listener of this.listeners) listener(this.state);
      const automatic = this.callback?.(this.state) !== false;
      if (this.disposed || frame.session !== this.session) return;
      if (automatic) this.renderFrame();
      if (this.session === frame.session && !this.disposed)
        this.handle = frame.session.requestAnimationFrame(this.frame);
    } catch (error) {
      this.fail(error);
    } finally {
      this.insideFrame = false;
    }
  };
  /** Render the current tracked eyes (or mirror) from onFrame. Return false there to suppress the automatic draw. */
  renderFrame(): void {
    if (!this.insideFrame || this.disposed || !this.session)
      throw new MargoError('state', 'renderFrame requires an active XR frame; call it inside the session onFrame callback.');
    const { viewer, delta } = this.state;
    if (this.mode !== 'inline' && this.eyes) {
      if (viewer) this.eyes.render(this.binding!, this.layer!, viewer, delta, this.mode === 'immersive-ar' || this.seeThrough, this.drawEye);
    } else if (this.mode !== 'inline') {
      this.renderOptions.delta = delta;
      this.engine.render(this.renderOptions);
      if (viewer) this.renderer!.render(this.engine, this.binding!, this.layer!, viewer, this.mode === 'immersive-ar' || this.seeThrough, this.drawEye);
    }
  }
  private readonly sourcesChanged = (): void => {
    const sources = this.session?.inputSources ?? [];
    for (let i = this.controllers.length - 1; i >= 0; i--)
      if (!Array.prototype.includes.call(sources, this.controllers[i].source)) this.controllers.splice(i, 1);
    for (const source of sources)
      if (!this.controllers.some((controller) => controller.source === source))
        this.controllers.push(new XRController(source));
  };
  private fail(error: unknown): void {
    void this.end().catch((endError) => this.engine.onError(endError));
    this.engine.onError(error);
  }
  private readonly ended = (): void => {
    const session = this.session;
    if (session && this.handle !== null) session.cancelAnimationFrame(this.handle);
    session?.removeEventListener('end', this.ended);
    session?.removeEventListener('inputsourceschange', this.sourcesChanged);
    this.controllers.length = 0;
    this.session = null;
    this.handle = null;
    this.last = null;
    this.callback = undefined;
    this.space = undefined;
    this.binding = undefined;
    this.seeThrough = false;
    this.layer?.destroy();
    this.layer = undefined;
    this.renderer?.dispose();
    this.eyes?.dispose();
    if (this.resume) {
      this.resume = false;
      if (!this.disposed && !this.engine.disposed) this.engine.start();
    }
  };
  /** Ends the active session (no-op without one) and restarts the window render loop. */
  async end(): Promise<void> {
    const session = this.session;
    if (session) {
      try {
        await session.end();
      } finally {
        if (this.session === session) this.ended();
      }
    }
  }
  /** Ends any session, destroys the XR GPU device and removes the plugin. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.eyeListeners.clear();
    const session = this.session;
    this.ended();
    this.device.removeEventListener('uncapturederror', this.uncaptured);
    // The engine's own device stays with the engine.
    if (this.route === 'separate') this.device.destroy();
    if (session) void session.end().catch((error) => this.engine.onError(error));
    if (this.engine?.hasPlugin(this.name)) this.engine.removePlugin(this.name);
  }
  /** Same as {@link XR.dispose}, for `using`. */
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
export { XR as XRManager };
/** Request using a manager prepared before the user gesture. The caller owns manager disposal. */
export function useXRSession(
  manager: XR,
  mode: XRMode = 'immersive-vr',
  options: XRSessionOptions = {},
): Promise<XRNativeSession> {
  return manager.requestSession(mode, options);
}
