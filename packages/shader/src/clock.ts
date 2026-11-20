// GAP-FILM-TIME: the clock that shader `time` reads. A node material's `time` member, a NodePass or ComputePass `time`
// frame value and the raw camera block's `time` (and `margoBefore.time` for TAA) once read `performance.now()`, so a
// frame drawn twice, or a film scene started at film time T in a fresh process, drew a different picture. They read
// this clock instead: seconds of frame deltas since it started, one per engine, moved in the frame update by
// `advanceTime`, so `seek` from `@margoengine/cutscene/seek` replays it with every other clock (Fiedler 2004, "Fix Your
// Timestep!": a sum of fixed steps repeats exactly; Goldberg 1991 for why it is a replayed sum and not n x delta).
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin } from '@margoengine/core/extension';

type Kernel = EngineKernel | Engine;
const clocks = new WeakMap<object, ShaderClock>();

/**
 * The frame clock that shader `time` reads, one per engine, attached as the plugin `shader:clock`. RawShaders,
 * ComputePass and NodePass attach it with themselves and take it away with the last of them; a NodeMaterial on an
 * engine without one attaches it after the frame that first draws it (its `time` reads 0 in that frame) and keeps it.
 * Attach it yourself with `ShaderClock.attach(engine)` before a `seek` when only node materials read `time`.
 */
export class ShaderClock implements EnginePlugin {
  readonly name = 'shader:clock';
  private seconds = 0;
  private step = 0;
  private engine?: Engine;
  /** What draws with the clock; `ShaderClock` itself when something keeps it for good. */
  private readonly hosts = new Set<object>();
  /**
   * The engine's clock, attached to its current scene when it has none, or the one it has: one per engine, so a second
   * call returns the same clock. It stays until you dispose it.
   */
  static attach(engine: EngineKernel): ShaderClock {
    return ShaderClock.hold(engine, ShaderClock);
  }
  /** @internal `host` draws with the engine's clock: attaches it, and keeps it until {@link release}. */
  static hold(engine: Kernel, host: object): ShaderClock {
    let clock = clocks.get(engine);
    if (!clock) (engine as EngineKernel).use((clock = new ShaderClock()));
    clock.hosts.add(host);
    return clock;
  }
  /** @internal `host` is gone: the clock goes with the last host. */
  static release(engine: Kernel | undefined, host: object): void {
    const clock = engine && clocks.get(engine);
    if (clock?.hosts.delete(host) && !clock.hosts.size) clock.dispose();
  }
  /** @internal The engine's clock; without one, it attaches after this frame (a plugin cannot attach while a frame draws). */
  static find(engine: Kernel | undefined): ShaderClock | undefined {
    const clock = engine && clocks.get(engine);
    if (engine && !clock) queueMicrotask(() => (engine as EngineKernel).disposed || ShaderClock.attach(engine as EngineKernel));
    return clock;
  }
  /** Seconds of frame deltas since the clock started: shader `time`. */
  get time(): number {
    return this.seconds;
  }
  /** The latest step in seconds: shader `deltaTime` where the pass has no delta of its own. */
  get delta(): number {
    return this.step;
  }
  /** One frame of the clock without drawing; each frame update runs it, so a `seek` replays it exactly. */
  advanceTime(delta: number): void {
    this.step = delta;
    this.seconds += delta;
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  setup(engine: Engine): void {
    if (clocks.has(engine)) throw new TypeError('The engine has a ShaderClock: use ShaderClock.attach(engine)');
    clocks.set((this.engine = engine), this);
  }
  /** Detaches the clock; the next host or `ShaderClock.attach` starts a new one at 0. */
  dispose(): void {
    const engine = this.engine;
    if (engine && clocks.get(engine) === this) {
      clocks.delete(engine);
      engine.sceneOf(this)?.removePlugin(this.name);
    }
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
