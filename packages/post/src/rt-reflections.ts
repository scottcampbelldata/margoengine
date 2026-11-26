/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine } from '@margoengine/core/extension';
import { sceneBvhWGSL, type GPUSceneBVH } from '@margoengine/bvh/gpu-scene';
import { margoError } from '../../shared/errors.js';
import { retire, uniformGroups, writeUniform } from '../../shared/frame-resources.js';
import { PostStack } from './stack.js';
import { SSR, type SSROptions, type SSRTrace } from './ssr.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** RTReflections settings: SSR's, plus the scene to trace. Read every frame from `rt.options`. */
export interface RTReflectionsOptions extends SSROptions {
  /** What reflections trace where the screen holds no hit: a `GPUSceneBVH` (@margoengine/bvh/gpu-scene) on the
   * engine's device. Set `rt.options.scene` to swap it; a disposed scene, or one from a lost device, runs as SSR. */
  scene: GPUSceneBVH;
  /** A shadow ray toward the sun from every traced hit. Default true. */
  shadows?: boolean;
  /** Scene units a traced ray starts off its surface, along the normal, so it does not hit that surface. Default 0.01. */
  bias?: number;
}

// Hybrid reflections (C. Barre-Brisebois et al., "Hybrid Rendering for Real-Time Ray Tracing", Ray Tracing Gems ch. 25,
// 2019; T. Stachowiak, "Stochastic Screen-Space Reflections", SIGGRAPH 2015 course): SSR's Hi-Z march answers first and
// its fades (screen edges, rays toward the camera, back faces, distance) give the share of the ray the screen covers.
// The rest of the share traces the scene BVH from the same surface point along the same ray, so off-screen geometry,
// geometry behind the camera and geometry hidden behind the depth buffer still reflect. A traced hit is shaded with
// core's own lighting: the glTF 2.0 metal-rough BRDF of packages/core/src/shaders.ts (GGX D, height-correlated Smith
// G2, Schlick F, Lambert diffuse) under the engine's sun, with a shadow ray (`sceneAny`) toward it, core's flat ambient
// and the instance's emissive. A miss keeps the environment, as SSR does.
const shadeWGSL = `
struct RTLight {light:vec4f,radiance:vec4f,ambient:vec4f,b:vec4f}
@group(1) @binding(5) var<uniform> rt:RTLight;
fn rtShade(h:SceneHit,x:vec3f,r:vec3f)->vec3f {
let mat=sceneMaterial(h.instance);let v=-r;let gn=sceneNormal(h);let n=select(gn,-gn,dot(gn,v)<0.0);let l=rt.light.xyz;
var sun=rt.light.w;
if(rt.b.y>0.5&&sun>0.0&&dot(n,l)>0.0&&sceneAny(x+n*rt.b.x,l,0.0,SCENE_NEVER).instance!=SCENE_MISS){sun=0.0;}
let hv=(v+l)/max(length(v+l),0.0001);
let nl=clamp(dot(n,l),0.0,1.0);let nv=clamp(dot(n,v),0.0001,1.0);let nh=clamp(dot(n,hv),0.0,1.0);let vh=clamp(dot(v,hv),0.0,1.0);
let a=mat.roughness*mat.roughness;let a2=a*a;let kc=cross(n,hv);let qd=max(dot(kc,kc),step(nh,0.0))+a2*nh*nh;let dd=a2/(3.14159265*qd*qd);
let gg=2.0*nl*nv/max(nl*sqrt(a2+(1.0-a2)*nv*nv)+nv*sqrt(a2+(1.0-a2)*nl*nl),1e-30);
let f0=mix(vec3f(0.04),mat.color,mat.metalness);let w=1.0-pow(1.0-vh,5.0);let fr=1.0-(1.0-f0)*w;
let direct=(0.96*w*(1.0-mat.metalness)*mat.color/3.14159265+dd*gg*fr/max(4.0*nl*nv,0.0001))*nl;
return max(vec3f(0),direct*rt.radiance.xyz*sun+mat.color*(1.0-mat.metalness)*rt.radiance.w*rt.ambient.rgb+mat.emissive);
}
`;
const header = () => sceneBvhWGSL({ group: 1, binding: 0 }) + shadeWGSL;
const patch = (code: string, edits: [string | RegExp, string][], what: string): string => {
  for (const [from, to] of edits) {
    const next = code.replace(from, to);
    if (next === code)
      throw margoError('failed', `RTReflections: SSR's ${what} changed shape; update the rt-reflections patch`);
    code = next;
  }
  return header() + code;
};
// The mirror composite. `cover` is the screen's share of the ray (the march's fades, roughness included); the trace adds
// the rest of the roughness-faded share, `rf - cover`, faded by distance like SSR's hits. With models the IBL specular
// removed is scaled by the share the pixel can hold, as SSR does.
const mirror = (code: string, models: boolean): string =>
  patch(
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
    'composite',
  );
// The stochastic rough trace: the sampled ray's screen share is `cover`; the trace adds the rest, so the resolved output
// still holds radiance times share (rgb) and the share (a).
const rough = (code: string): string =>
  patch(
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
    'rough trace',
  );

const isScene = (scene: unknown): scene is GPUSceneBVH =>
  !!scene &&
  typeof (scene as GPUSceneBVH).bindings === 'function' &&
  typeof (scene as GPUSceneBVH).device === 'object' &&
  typeof (scene as GPUSceneBVH).disposed === 'boolean';

/** Ray-traced reflections in a PostStack (HDR effect): SSR's material replay and Hi-Z march, and where the screen holds
 * no hit (off screen, behind the camera, hidden behind nearer geometry, rays toward the camera) a ray through
 * `options.scene`, a `GPUSceneBVH` from @margoengine/bvh/gpu-scene. Traced hits are lit like core meshes: the engine's sun
 * with a shadow ray, its ambient, and the instance's emissive. Every SSR option and method works the same.
 * @throws TypeError when `scene` is not a GPUSceneBVH or `shadows` not a boolean; RangeError when `bias` is not a finite
 * number of at least 0; every error SSR throws. */
export class RTReflections extends SSR {
  declare readonly options: RTReflectionsOptions;
  #uniform?: GPUBuffer;
  #device?: GPUDevice;
  #slice?: GPUBufferBinding;
  readonly #values = new Float32Array(16);
  readonly #groups = new WeakMap<
    GPURenderPipeline,
    { scene: GPUSceneBVH; uniform: GPUBuffer; groups: { get(copy?: GPUBufferBinding): GPUBindGroup } }
  >();
  constructor(options: RTReflectionsOptions) {
    super(options);
    this.#check();
    this.traced = this.#trace;
  }
  /** Alone, RTReflections runs in its own one-effect PostStack; to combine it, put it in your PostStack. */
  static override attach(engine: EngineKernel, options: RTReflectionsOptions): RTReflections {
    const effect = new RTReflections(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  #check(): void {
    const { scene, shadows, bias } = this.options ?? ({} as RTReflectionsOptions);
    if (!isScene(scene))
      throw new TypeError('Invalid RTReflections scene; pass a GPUSceneBVH from @margoengine/bvh/gpu-scene');
    if (shadows !== undefined && typeof shadows !== 'boolean')
      throw new TypeError('Invalid RTReflections shadows; pass a boolean');
    if (bias !== undefined && !(bias >= 0 && Number.isFinite(Math.fround(bias))))
      throw new RangeError('Invalid RTReflections bias; pass a finite number of at least 0');
  }
  readonly #trace: SSRTrace = {
    active: (device) => {
      this.#check();
      const scene = this.options.scene;
      return !scene.disposed && scene.device === device;
    },
    prepare: (c) => {
      const device = c.device;
      if (this.#device !== device) {
        if (this.#device) retire(this.#device, this.#uniform);
        this.#device = device;
        this.#uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      }
      const values = this.#values,
        { direction, radiance, ambient } = (this.engine as Engine).lighting,
        length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
      for (let i = 0; i < 3; i++) values[i] = direction[i] / length;
      values[3] = direction[3];
      values.set(radiance, 4);
      values.fill(1, 8, 11);
      if (ambient) values.set(ambient, 8);
      values[12] = this.options.bias ?? 0.01;
      values[13] = +(this.options.shadows ?? true);
      this.#slice = writeUniform(device, this.#uniform!, values as Float32Array<ArrayBuffer>, c.view ?? c);
    },
    mirror,
    rough,
    group: (device, pipeline) => {
      const scene = this.options.scene,
        uniform = this.#uniform!;
      let entry = this.#groups.get(pipeline);
      if (!entry || entry.scene !== scene || entry.uniform !== uniform) {
        const layout = pipeline.getBindGroupLayout(1);
        entry = {
          scene,
          uniform,
          groups: uniformGroups(uniform, (binding) =>
            device.createBindGroup({
              label: 'rt-reflections scene',
              layout,
              entries: [...scene.bindings(0), { binding: 5, resource: binding }],
            }),
          ),
        };
        this.#groups.set(pipeline, entry);
      }
      return entry.groups.get(this.#slice);
    },
  };
  override onDeviceRestored(engine: Engine): void {
    if (this.#device) retire(this.#device, this.#uniform);
    this.#device = this.#uniform = undefined;
    super.onDeviceRestored(engine);
  }
  override dispose(): void {
    super.dispose();
    if (this.#device) retire(this.#device, this.#uniform);
    this.#device = this.#uniform = undefined;
  }
}
