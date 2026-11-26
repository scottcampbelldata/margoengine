/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine } from '@margoengine/core/extension';
import { PostStack } from './stack.js';
import { SSGI, type SSGIOptions, type SSGITrace } from './ssgi.js';
import { checkTraced, patchTraced, TracedLight, type TracedOptions } from './rt-shade.js';
export type { TracedOptions } from './rt-shade.js';

/** RTGI settings: SSGI's, plus the scene to trace. Read every frame from `gi.options`. */
export interface RTGIOptions extends SSGIOptions, TracedOptions {}

// Hybrid diffuse bounce (C. Barre-Brisebois et al., "Hybrid Rendering for Real-Time Ray Tracing", Ray Tracing Gems ch.
// 25, 2019): each of SSGI's cosine-weighted rays marches the Hi-Z first; a ray the screen does not answer (off screen,
// behind the camera, hidden behind nearer geometry) traces the scene BVH from the same start along the same direction,
// and its hit is lit like a core mesh (rt-shade.ts), faded by distance like SSGI's screen hits. The sum over rays and
// SSGI's tile spread, bilateral blur and composite are unchanged, so traced and screen bounces average together.
const trace = (code: string): string =>
  patchTraced(
    code,
    [
      [
        'if(h.w<0.0){continue;}',
        'if(h.w<0.0){let rh=sceneClosest(start,r,0.0,u.b.x);if(rh.instance!=SCENE_MISS){let rw=1.0-smoothstep(0.8*u.b.x,u.b.x,rh.distance);sum+=vec4f(rtShade(rh,start+r*rh.distance,r)*rw,rw);}continue;}',
      ],
    ],
    'RTGI: SSGI trace',
  );

/** Ray-traced diffuse bounce light in a PostStack (HDR effect): SSGI's material replay, Hi-Z rays, blur and composite,
 * and where a ray finds no hit on screen, a ray through `options.scene`, a `GPUSceneBVH` from @margoengine/bvh/gpu-scene.
 * Traced hits are lit like core meshes: the engine's sun with a shadow ray, its ambient, and the instance's emissive.
 * Every SSGI option and method works the same.
 * @throws TypeError when `scene` is not a GPUSceneBVH or `shadows` not a boolean; RangeError when `bias` is not a finite
 * number of at least 0; every error SSGI throws. */
export class RTGI extends SSGI {
  declare readonly options: RTGIOptions;
  readonly #light = new TracedLight();
  constructor(options: RTGIOptions) {
    super(options);
    checkTraced(this.options, 'RTGI');
    this.traced = this.#trace;
  }
  /** Alone, RTGI runs in its own one-effect PostStack; to combine it, put it in your PostStack. */
  static override attach(engine: EngineKernel, options: RTGIOptions): RTGI {
    const effect = new RTGI(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  readonly #trace: SSGITrace = {
    active: (device) => {
      checkTraced(this.options, 'RTGI');
      return this.#light.active(this.options, device);
    },
    prepare: (c) => this.#light.prepare(c, this.engine as Engine, this.options),
    trace,
    group: (device, pipeline) => this.#light.group(device, pipeline, this.options.scene),
  };
  override onDeviceRestored(engine: Engine): void {
    this.#light.release();
    super.onDeviceRestored(engine);
  }
  override dispose(): void {
    super.dispose();
    this.#light.release();
  }
}
