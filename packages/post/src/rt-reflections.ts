/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine } from '@margoengine/core/extension';
import { PostStack } from './stack.js';
import { SSR, type SSROptions, type SSRTrace } from './ssr.js';
import { checkTraced, patchTraced, TracedLight, type TracedOptions } from './rt-shade.js';
export type { TracedOptions } from './rt-shade.js';

/** RTReflections settings: SSR's, plus the scene to trace (`scene`, `shadows`, `bias`). Read every frame from
 * `rt.options`. */
export interface RTReflectionsOptions extends SSROptions, TracedOptions {}

// Hybrid reflections (C. Barre-Brisebois et al., "Hybrid Rendering for Real-Time Ray Tracing", Ray Tracing Gems ch. 25,
// 2019; T. Stachowiak, "Stochastic Screen-Space Reflections", SIGGRAPH 2015 course): SSR's Hi-Z march answers first and
// its fades (screen edges, rays toward the camera, back faces, distance) give the share of the ray the screen covers.
// The rest of the share traces the scene BVH from the same surface point along the same ray, so off-screen geometry,
// geometry behind the camera and geometry hidden behind the depth buffer still reflect. A traced hit is shaded with
// core's own lighting (rt-shade.ts). A miss keeps the environment, as SSR does.

// The mirror composite. `cover` is the screen's share of the ray (the march's fades, roughness included); the trace adds
// the rest of the roughness-faded share, `rf - cover`, faded by distance like SSR's hits. With models the IBL specular
// removed is scaled by the share the pixel can hold, as SSR does.
const mirror = (code: string, models: boolean): string =>
  patchTraced(
    code,
    [
      ['if(toward<0.5){', `var cover=0.0;${models ? 'let c0=c;' : ''}\nif(toward<0.5){`],
      ['let hc=u.matrix*vec4f(hp,1.0);', 'cover=f;let hc=u.matrix*vec4f(hp,1.0);'],
      [
        /(\(m\.rgb\*reflected-e\.rgb\)\);\n\}\}\})\}/,
        `$1
let rf=1.0-smoothstep(u.a.z*0.5,u.a.z,rough);
if(cover<rf){let ro=p+n*rt.b.x;let rh=sceneClosest(ro,r,0.0,u.b.x);if(rh.instance!=SCENE_MISS){let rad=rtShade(rh,ro+r*rh.distance,r);let g=(rf-cover)*(1.0-smoothstep(0.8*u.b.x,u.b.x,rh.distance));${
          models
            ? 'let rk=select(vec3f(1),c0/e.rgb,e.rgb>vec3f(1e-6));c=max(vec3f(0),c+g*min(1.0,min(rk.x,min(rk.y,rk.z)))*(m.rgb*rad-e.rgb));'
            : 'c=max(vec3f(0),c+g*(m.rgb*rad-e.rgb));'
        }}}
}`,
      ],
    ],
    "RTReflections: SSR's composite",
  );
// The stochastic rough trace: the sampled ray's screen share is `cover`; the trace adds the rest, so the resolved output
// still holds radiance times share (rgb) and the share (a).
const rough = (code: string): string =>
  patchTraced(
    code,
    [
      ['if(dot(r,n)>0.0&&toward<0.5){', 'var cover=0.0;\nif(dot(r,n)>0.0&&toward<0.5){'],
      ['out=vec4f(f*textureLoad(scene,hq,0).rgb,f);', 'out=vec4f(f*textureLoad(scene,hq,0).rgb,f);cover=f;'],
      [
        '\n}}}}\nreturn out;',
        `
}}}
if(dot(r,n)>0.0&&cover<1.0){let ro=p+n*rt.b.x;let rh=sceneClosest(ro,r,0.0,u.b.x);if(rh.instance!=SCENE_MISS){let g=(1.0-cover)*(1.0-smoothstep(0.8*u.b.x,u.b.x,rh.distance));out+=vec4f(g*rtShade(rh,ro+r*rh.distance,r),g);}}
}
return out;`,
      ],
    ],
    "RTReflections: SSR's rough trace",
  );

/** Ray-traced reflections in a PostStack (HDR effect): SSR's material replay and Hi-Z march, and where the screen holds
 * no hit (off screen, behind the camera, hidden behind nearer geometry, rays toward the camera) a ray through
 * `options.scene`, a `GPUSceneBVH` from @margoengine/bvh/gpu-scene. Traced hits are lit like core meshes: the engine's sun
 * with a shadow ray, its ambient, and the instance's emissive. Every SSR option and method works the same.
 * @throws TypeError when `scene` is not a GPUSceneBVH or `shadows` not a boolean; RangeError when `bias` is not a finite
 * number of at least 0; every error SSR throws. */
export class RTReflections extends SSR {
  declare readonly options: RTReflectionsOptions;
  readonly #light = new TracedLight();
  constructor(options: RTReflectionsOptions) {
    super(options);
    checkTraced(this.options, 'RTReflections');
    this.traced = this.#trace;
  }
  /** Alone, RTReflections runs in its own one-effect PostStack; to combine it, put it in your PostStack. */
  static override attach(engine: EngineKernel, options: RTReflectionsOptions): RTReflections {
    const effect = new RTReflections(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  readonly #trace: SSRTrace = {
    active: (device) => {
      checkTraced(this.options, 'RTReflections');
      return this.#light.active(this.options, device);
    },
    prepare: (c) => this.#light.prepare(c, this.engine as Engine, this.options),
    mirror,
    rough,
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
