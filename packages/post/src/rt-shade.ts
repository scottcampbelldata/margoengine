import type { Engine, PassContext } from '@margoengine/core/extension';
import { sceneBvhWGSL, type GPUSceneBVH } from '@margoengine/bvh/gpu-scene';
import { margoError } from '../../shared/errors.js';
import { retire, uniformGroups, writeUniform } from '../../shared/frame-resources.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type PostPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** The options a traced effect adds: the scene, the sun's shadow ray at hits and the ray start offset. */
export interface TracedOptions {
  /** What rays trace where the screen holds no hit: a `GPUSceneBVH` (@margoengine/bvh/gpu-scene) on the engine's
   * device. Set `options.scene` to swap it; a disposed scene, or one from a lost device, runs the screen-space effect. */
  scene: GPUSceneBVH;
  /** A shadow ray toward the sun from every traced hit. Default true. */
  shadows?: boolean;
  /** Scene units a traced ray starts off its surface, along the normal, so it does not hit that surface. Default 0.01. */
  bias?: number;
}

// Traced hits are lit with core's own lighting: the glTF 2.0 metal-rough BRDF of packages/core/src/shaders.ts (GGX D,
// height-correlated Smith G2, Schlick F, Lambert diffuse) under the engine's sun, with a shadow ray (`sceneAny`) toward
// it, core's flat ambient and the instance's emissive. `r` is the ray direction, so the view vector is -r.
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
/** The scene in group 1 (bindings 0-4), the light at binding 5 and `rtShade(hit, point, direction)`. */
export const tracedHeader = (): string => sceneBvhWGSL({ group: 1, binding: 0 }) + shadeWGSL;

const isScene = (scene: unknown): scene is GPUSceneBVH =>
  !!scene &&
  typeof (scene as GPUSceneBVH).bindings === 'function' &&
  typeof (scene as GPUSceneBVH).device === 'object' &&
  typeof (scene as GPUSceneBVH).disposed === 'boolean';

/** Throws on invalid traced options; `owner` names the effect in the message. */
export function checkTraced(options: TracedOptions | undefined, owner: string): void {
  const { scene, shadows, bias } = options ?? ({} as TracedOptions);
  if (!isScene(scene))
    throw new TypeError(`Invalid ${owner} scene; pass a GPUSceneBVH from @margoengine/bvh/gpu-scene`);
  if (shadows !== undefined && typeof shadows !== 'boolean')
    throw new TypeError(`Invalid ${owner} shadows; pass a boolean`);
  if (bias !== undefined && !(bias >= 0 && Number.isFinite(Math.fround(bias))))
    throw new RangeError(`Invalid ${owner} bias; pass a finite number of at least 0`);
}

/** The light uniform and the group-1 bind groups of a traced effect. */
export class TracedLight {
  #uniform?: GPUBuffer;
  #device?: GPUDevice;
  #slice?: GPUBufferBinding;
  readonly #values = new Float32Array(16);
  readonly #groups = new WeakMap<
    GPURenderPipeline,
    { scene: GPUSceneBVH; uniform: GPUBuffer; groups: { get(copy?: GPUBufferBinding): GPUBindGroup } }
  >();
  /** True when `options.scene` is live on `device`. */
  active(options: TracedOptions, device: GPUDevice): boolean {
    return !options.scene.disposed && options.scene.device === device;
  }
  /** Writes this view's light from the engine's lighting. */
  prepare(c: PostPassContext, engine: Engine, options: TracedOptions): void {
    const device = c.device;
    if (this.#device !== device) {
      this.release();
      this.#device = device;
      this.#uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    const values = this.#values,
      { direction, radiance, ambient } = engine.lighting,
      length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    for (let i = 0; i < 3; i++) values[i] = direction[i] / length;
    values[3] = direction[3];
    values.set(radiance, 4);
    values.fill(1, 8, 11);
    if (ambient) values.set(ambient, 8);
    values[12] = options.bias ?? 0.01;
    values[13] = +(options.shadows ?? true);
    this.#slice = writeUniform(device, this.#uniform!, values as Float32Array<ArrayBuffer>, c.view ?? c);
  }
  /** Bind group 1 of a patched pipeline for the view `prepare` last wrote. */
  group(device: GPUDevice, pipeline: GPURenderPipeline, scene: GPUSceneBVH): GPUBindGroup {
    const uniform = this.#uniform!;
    let entry = this.#groups.get(pipeline);
    if (!entry || entry.scene !== scene || entry.uniform !== uniform) {
      const layout = pipeline.getBindGroupLayout(1);
      entry = {
        scene,
        uniform,
        groups: uniformGroups(uniform, (binding) =>
          device.createBindGroup({
            label: 'traced scene',
            layout,
            entries: [...scene.bindings(0), { binding: 5, resource: binding }],
          }),
        ),
      };
      this.#groups.set(pipeline, entry);
    }
    return entry.groups.get(this.#slice);
  }
  release(): void {
    if (this.#device) retire(this.#device, this.#uniform);
    this.#device = this.#uniform = undefined;
  }
}

/** Applies text edits to an effect's shader and prepends the traced header; throws when the shader changed shape. */
export function patchTraced(code: string, edits: [string | RegExp, string][], what: string): string {
  for (const [from, to] of edits) {
    const next = code.replace(from, to);
    if (next === code) throw margoError('failed', `${what} changed shape; update its traced patch`);
    code = next;
  }
  return tracedHeader() + code;
}
