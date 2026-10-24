/// <reference lib="esnext.disposable" preserve="true" />
// A scene depth any pass or material can sample, owned by itself rather than borrowed from an effect: one depth-only
// SceneTargets pass (core meshes, plus the models added) with a camera-distance colour target beside it.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph } from '@margoengine/core/extension';
import { SceneTargets } from './mrt.js';
import type { SSRModel } from './ssr.js';

/** Options for {@link DepthTexture}. */
export interface DepthTextureOptions {
  /** Frame-graph order of its pass. Default -5: before the main pass, so this frame's materials can sample it. */
  order?: number;
}

/**
 * The scene's depth as textures of its own, for passes and materials to sample: `texture` (depth32float, reversed Z:
 * 1 at the near plane, 0 far or empty; bind as `texture_depth_2d`) and `distance` (r32float, world distance from the
 * camera, 0 where empty; any material can read it, e.g. `new Texture(depth.distance)` in a WgslMaterial, with
 * `textureLoad`). Both follow the drawing size and are replaced on resize (`onResize`). Core meshes always draw into it;
 * add gltf-pro models and materials meshes with `add(model)`. Do not add a model whose material samples it. WebGPU only.
 */
export class DepthTexture implements EnginePlugin {
  private readonly targets: SceneTargets;
  constructor(options: DepthTextureOptions = {}) {
    this.targets = new SceneTargets({ outputs: { distance: 'distance' }, order: options.order });
  }
  /** Same as `engine.use(new DepthTexture(options))`; returns it. */
  static attach(engine: EngineKernel, options: DepthTextureOptions = {}): DepthTexture {
    const depth = new DepthTexture(options);
    engine.use(depth);
    return depth;
  }
  get name(): string {
    return this.targets.name;
  }
  /** The depth (depth32float, 1 sample, reversed Z); undefined before the first frame. */
  get texture(): GPUTexture | undefined {
    return this.targets.depth;
  }
  /** World distance from the camera in red (r32float, 0 where empty); undefined before the first frame. */
  get distance(): GPUTexture | undefined {
    return this.targets.texture('distance');
  }
  /** Calls `listener` after the textures are (re)created. Returns a remover. */
  onResize(listener: () => void): () => void {
    return this.targets.onResize(listener);
  }
  /** Writes `model`'s own geometry (alpha mask, skinning, instances) into the depth; returns a remover. */
  add(model: SSRModel): () => void {
    return this.targets.add(model);
  }
  setup(engine: Engine): void {
    this.targets.setup(engine);
  }
  registerPasses(graph: FrameGraph): void {
    this.targets.registerPasses(graph);
  }
  onDeviceRestored(engine: Engine): void {
    this.targets.onDeviceRestored(engine);
  }
  /** Releases the textures. */
  dispose(): void {
    this.targets.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
