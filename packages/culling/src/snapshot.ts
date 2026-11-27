/// <reference lib="esnext.disposable" preserve="true" />
// Snapshot rendering: core's main draw is recorded once into a WebGPU render bundle and replayed every frame after
// that, so the CPU no longer encodes one setPipeline / setVertexBuffer / drawIndexed run per batch. WebGPU
// "Bundles" (GPURenderBundleEncoder, GPURenderPassEncoder.executeBundles) is the mechanism; core owns the recording
// and replays it while the draw's pipeline and bind group match (DrawOptions.snapshot). This entry is the other half:
// it sees, before every main draw, whether what core would encode has changed, and asks for a new recording when it has.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext, Snapshot } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';

type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Options for {@link SnapshotRendering}. */
export interface SnapshotRenderingOptions {
  /**
   * Draw core's batches with drawIndexedIndirect, so a mesh shown or hidden in a batch that stays drawn changes only
   * the instance count core writes into its indirect arguments, and the recording stays valid. False bakes each
   * count into the recording, which then records again whenever a count changes. It sets `indirect` for every core
   * draw of the frame. Default true.
   */
  indirect?: boolean;
}

/** Snapshot rendering's counts since it was attached. */
export interface SnapshotRenderingStats {
  /** Main draws that were handed a snapshot (one per view and frame while `enabled`). */
  frames: number;
  /** Of those, the draws that recorded a new bundle; the rest replayed one. */
  recorded: number;
}

interface ViewState {
  readonly snapshot: Snapshot;
  /** What the last recording drew, batch by batch: the values a recording bakes in. */
  readonly key: unknown[];
  /** The bundle last counted as recorded. */
  seen?: GPURenderBundle;
}

let serial = 0;

/**
 * Snapshot rendering for core meshes: the main pass's draws are recorded once into a render bundle and replayed while
 * the scene's draws stay the same. Moving, recolouring or re-materialling meshes keeps the recording, since those only
 * change instance rows, which are uploaded as always. Adding or removing a mesh of a new geometry, a batch that starts
 * or stops drawing, a geometry whose buffers are rebuilt, a mirrored or
 * double-sided mesh appearing in a batch, a culling package redirecting a batch, a new shader variant or new bindings
 * from another package: each is seen before the draw and records again. Each view (by `RenderView.id`) keeps its own
 * recording. Runs on WebGPU and on the WebGL2 compatibility layer, which replays its recorded command list.
 *
 * @example
 * ```ts
 * import { SnapshotRendering } from '@margoengine/culling/snapshot';
 * const snapshots = SnapshotRendering.attach(engine);
 * engine.render(); // records
 * engine.render(); // replays
 * console.log(snapshots.stats); // { frames: 2, recorded: 1 }
 * ```
 */
export class SnapshotRendering implements EnginePlugin {
  readonly name = 'snapshot-rendering:' + ++serial;
  /** See {@link SnapshotRenderingOptions.indirect}. */
  readonly indirect: boolean;
  /** False draws as if the plugin were not attached (nothing recorded or replayed); true again checks the recording first, as every frame. */
  enabled = true;
  disposed = false;
  private engine?: Engine;
  private readonly views = new Map<string, ViewState>();
  private frames = 0;
  private recorded = 0;

  /** Same as `engine.use(new SnapshotRendering(options))`; returns the plugin. */
  static attach(engine: EngineKernel, options?: SnapshotRenderingOptions): SnapshotRendering {
    const value = new SnapshotRendering(options);
    engine.use(value);
    return value;
  }
  constructor({ indirect = true }: SnapshotRenderingOptions = {}) {
    if (typeof indirect !== 'boolean') throw new TypeError('Invalid snapshot options; set indirect to true or false');
    this.indirect = indirect;
  }
  setup(engine: Engine): void {
    if (this.disposed)
      throw new MargoError('disposed', 'SnapshotRendering is disposed; attach a new SnapshotRendering');
    if (!engine.gpu)
      throw new MargoError(
        'unsupported',
        'SnapshotRendering requires WebGPU or the WebGL2 compatibility layer; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    // Just before the main pass, after every package that claims or redirects batches for the frame.
    graph.add({
      name: this.name,
      order: -1e-6,
      execute: (c) => {
        if (c.backend === 'webgpu' && c.batches && this.enabled) this.hand(c);
      },
    });
  }
  /** Counts so far; read after a frame. */
  get stats(): SnapshotRenderingStats {
    for (const state of this.views.values()) this.observe(state);
    return { frames: this.frames, recorded: this.recorded };
  }
  /** Records every view again on its next frame. */
  reset(): void {
    for (const state of this.views.values()) {
      // A recording made since the last look is counted before it goes.
      this.observe(state);
      state.snapshot.bundle = undefined;
    }
  }
  private observe(state: ViewState): void {
    const bundle = state.snapshot.bundle;
    if (bundle && bundle !== state.seen) {
      state.seen = bundle;
      this.recorded++;
    }
  }
  /** Compares what core is about to encode with the recording, and hands core the view's snapshot. */
  private hand(c: Context): void {
    const engine = this.engine!,
      id = c.view?.id ?? '';
    let state = this.views.get(id);
    if (!state) this.views.set(id, (state = { snapshot: {}, key: [] }));
    this.observe(state);
    if (this.indirect) c.indirect = true;
    const key = state.key,
      batches = c.batches!;
    let n = 0,
      same = true;
    // By index, writing in place: nothing allocated a frame.
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if ((batch.count || batch.redirect) && !batch.claimed) {
        const buffers = engine.geometryBuffers(batch.geometry),
          redirect = batch.redirect;
        same = same && key[n] === batch;
        key[n++] = batch;
        same = same && key[n] === buffers?.vertex;
        key[n++] = buffers?.vertex;
        same = same && key[n] === buffers?.index;
        key[n++] = buffers?.index;
        same = same && key[n] === buffers?.instance;
        key[n++] = buffers?.instance;
        same = same && key[n] === batch.geometry.indices.length;
        key[n++] = batch.geometry.indices.length;
        // Core's back-culled pipeline draws a batch with no mask.
        same = same && key[n] === !batch.mask;
        key[n++] = !batch.mask;
        same = same && key[n] === redirect?.instances;
        key[n++] = redirect?.instances;
        same = same && key[n] === redirect?.args;
        key[n++] = redirect?.args;
        // Ranges of one geometry (MultiDraw): how many argument sets, and whether in one call.
        same = same && key[n] === batch.draws;
        key[n++] = batch.draws;
        same = same && key[n] === batch.multi;
        key[n++] = batch.multi;
        // An indirect draw reads its count from core's arguments, written every frame; a direct one bakes it in.
        const count = c.indirect || redirect ? -1 : batch.count;
        same = same && key[n] === count;
        key[n++] = count;
      }
    }
    same = same && key[n] === c.indirect && key.length === n + 1;
    key[n++] = c.indirect;
    key.length = n;
    if (!same) state.snapshot.bundle = undefined;
    c.snapshot = state.snapshot;
    this.frames++;
  }
  onDeviceRestored(engine: Engine): void {
    this.reset();
    this.views.clear();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.reset();
    this.views.clear();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
