import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { glRenderer, type GLRenderer } from './preview.js';

/** `timeout`: milliseconds to wait for the browser to give a lost context back before reporting it. Default 30000. */
export interface WebGLRestoreOptions {
  timeout?: number;
}

class WebGLRestore implements EnginePlugin {
  readonly name = 'webgl-restore';
  private engine?: Engine;
  private renderer?: GLRenderer;
  private recovery?: Promise<void>;
  private finish?: (error?: unknown) => void;
  constructor(private readonly timeout: number) {}

  setup(engine: Engine): void {
    // WebGPU and the compatibility layer have core's restore: one `use` serves every backend.
    if (engine.backend !== 'webgl2') return;
    const renderer = glRenderer(engine.canvas);
    if (!renderer)
      throw new MargoError('unsupported', 'webglRestore needs webglRenderer from @margoengine/webgl2-compat/preview as the fallback');
    this.engine = engine;
    this.renderer = renderer;
    engine.canvas.addEventListener('webglcontextlost', this.lost);
    engine.canvas.addEventListener('webglcontextrestored', this.restored);
    // Core's rebootDevice refuses every renderer but WebGPU's, so this engine's method is covered until the plugin goes.
    engine.rebootDevice = () => this.reboot();
  }

  // Without preventDefault the browser never gives the context back.
  private readonly lost = (event: Event): void => {
    event.preventDefault();
    this.renderer!.recovering = true;
    void this.reboot().catch((error) => this.engine?.onError(error));
  };

  private readonly restored = (): void => {
    const { finish } = this;
    try {
      this.rebuild();
      finish?.();
    } catch (error) {
      if (finish) finish(error);
      else this.engine?.onError(error);
    }
  };

  private reboot(): Promise<void> {
    if (this.recovery) return this.recovery;
    const { gl } = this.renderer!;
    const running = gl.isContextLost()
      ? new Promise<void>((resolve, reject) => {
          const limit = setTimeout(
            () =>
              this.finish?.(
                new MargoError(
                  'timeout',
                  `The browser did not restore the WebGL context within ${this.timeout} ms; reload the page or create a new engine`,
                ),
              ),
            this.timeout,
          );
          this.finish = (error) => {
            clearTimeout(limit);
            this.finish = undefined;
            if (error === undefined) resolve();
            else reject(error);
          };
        })
      : // Out of any frame in progress: the rebuild runs a frame of its own.
        Promise.resolve().then(() => this.rebuild());
    const recovery: Promise<void> = running.finally(() => {
      if (this.recovery === recovery) this.recovery = undefined;
    });
    this.recovery = recovery;
    return recovery;
  }

  /** Makes the GL objects again, then tells each scene's plugins as core does: from inside that scene. */
  private rebuild(): void {
    const { engine, renderer } = this;
    if (!engine || !renderer) return;
    renderer.restore();
    for (const scene of engine.scenes) {
      renderer.intercept = () => {
        for (const plugin of scene.plugins.values()) plugin.onDeviceRestored?.(engine);
      };
      try {
        engine.render({ views: [{ camera: engine.camera, viewport: [0, 0, 1, 1], scene }] });
      } finally {
        renderer.intercept = undefined;
      }
    }
  }

  dispose(): void {
    const { engine, renderer } = this;
    if (!engine || !renderer) return;
    engine.canvas.removeEventListener('webglcontextlost', this.lost);
    engine.canvas.removeEventListener('webglcontextrestored', this.restored);
    this.finish?.();
    renderer.recovering = false;
    // Back to the class's method: core's own answers (`disposed`, `unsupported`) apply again.
    delete (engine as Partial<Engine>).rebootDevice;
    this.engine = this.renderer = undefined;
  }
}

/**
 * Lost-context recovery on the WebGL2 preview: `engine.use(webglRestore())`. When the browser loses the context, frames
 * pass without drawing and new geometry waits; when it gives the context back, every program and buffer is made again
 * from the geometry the renderer holds and each scene's plugins hear `onDeviceRestored`. `engine.rebootDevice()` works
 * too: on a live context it rebuilds at once, on a lost one it resolves when the context is back. On WebGPU and the
 * compatibility layer the plugin does nothing, because core's restore already runs there.
 * @throws MargoError `'unsupported'` on attach when the engine's fallback is not `webglRenderer`. A context not given
 * back in `timeout` ms rejects `rebootDevice`, and reaches `engine.onError` for a loss nobody called it for, with code
 * `'timeout'`; a restore after that still recovers.
 */
export const webglRestore = ({ timeout = 30_000 }: WebGLRestoreOptions = {}): EnginePlugin => new WebGLRestore(timeout);
