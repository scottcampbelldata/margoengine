// The surface hook of Material meshes (KB-WEATHER-MATERIALSWET1). A Material mesh draws with gltf/pbr's shader, so the
// surface entries of `@margoengine/weather` (Puddles, Snow, PrecipitationCover), which patch core's mesh shader, left it
// dry. Each of those plugins now also offers a gltf/pbr lighting effect, `materialSurface`, that edits the surface
// (colour, roughness, metalness and normal, with the world position) before lighting; every Material mesh of the scene
// joins the effects of its scene's plugins on its next draw, in their order, and leaves them when they go.
import type { Engine, EnginePlugin, Scene } from '@margoengine/core/extension';
import type { LightingEffect, PBRModel } from '@margoengine/gltf/pbr-model';

/**
 * A gltf/pbr lighting effect that edits the surface of Material meshes before lighting. `order` sorts several of
 * them, lower first (the frame-graph order of the same plugin's pass on core meshes); default 0.
 */
export interface MaterialSurfaceEffect extends LightingEffect {
  readonly order?: number;
}

/** A scene plugin whose `materialSurface` every Material mesh of its scene joins (`@margoengine/weather`'s surface entries). */
export interface MaterialSurfaceHook extends EnginePlugin {
  readonly materialSurface?: MaterialSurfaceEffect;
}

/**
 * The scene plugin names a Material mesh looks for: `@margoengine/weather`'s `Puddles`, `Snow` and
 * `PrecipitationCover`. Any plugin under one of these names with a `materialSurface` effect joins.
 */
export const materialSurfaceHooks: readonly string[] = ['weather-puddles', 'weather-snow', 'weather-cover'];

const none: readonly MaterialSurfaceEffect[] = Object.freeze([]);
const byOrder = (a: MaterialSurfaceEffect, b: MaterialSurfaceEffect) => (a.order ?? 0) - (b.order ?? 0);

interface Found {
  frame: number;
  list: readonly MaterialSurfaceEffect[];
}
interface Joined {
  list: readonly MaterialSurfaceEffect[];
  release: (() => void)[];
}

/** One per material draw queue: the surface effects of each scene, read once a frame, and what each mesh joined. */
export class SceneSurfaces {
  private frame = 0;
  private readonly scenes = new WeakMap<Scene, Found>();
  private readonly joined = new WeakMap<PBRModel, Joined>();
  private readonly runtime: Engine;

  constructor(runtime: Engine) {
    this.runtime = runtime;
  }

  /** Starts a frame: each scene's plugins are read again on its first mesh. */
  next(): void {
    this.frame++;
  }

  /** The surface effects of `scene` this frame: the same array while they stay the same, so a mesh rejoins only on a change. */
  private effects(scene: Scene | undefined): readonly MaterialSurfaceEffect[] {
    if (!scene) return none;
    let found = this.scenes.get(scene);
    if (found?.frame === this.frame) return found.list;
    let list: MaterialSurfaceEffect[] | undefined;
    for (const name of materialSurfaceHooks) {
      const effect = (scene.plugins.get(name) as MaterialSurfaceHook | undefined)?.materialSurface;
      if (
        effect &&
        effect.owner === this.runtime &&
        typeof effect.shader === 'function' &&
        typeof effect.bindings === 'function'
      )
        (list ??= []).push(effect);
    }
    list?.sort(byOrder);
    const previous = found?.list ?? none,
      same = (list?.length ?? 0) === previous.length && (!list || list.every((e, i) => e === previous[i]));
    if (!found) this.scenes.set(scene, (found = { frame: this.frame, list: none }));
    found.frame = this.frame;
    if (!same) found.list = Object.freeze(list ?? []);
    return found.list;
  }

  /**
   * Joins `model` to the surface effects of its scene when `wanted` (and leaves them when not), before it draws. A
   * mesh adds them through `addLighting` in their order; a change of the scene's effects re-adds them all.
   */
  sync(model: PBRModel, wanted: boolean): void {
    const list = wanted ? this.effects(this.runtime.sceneOf(model)) : none,
      joined = this.joined.get(model);
    if ((joined?.list ?? none) === list) return;
    if (joined) for (const release of joined.release) release();
    if (!list.length) {
      this.joined.delete(model);
      return;
    }
    this.joined.set(model, { list, release: list.map((effect) => model.addLighting(effect)) });
  }
}
