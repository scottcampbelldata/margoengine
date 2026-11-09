/// <reference lib="esnext.disposable" preserve="true" />
// Imposter ring for scatter: the far LOD ring drawn as octahedral imposters (Praun and Hoppe 2003; Cigolle et al. 2014,
// JCGT 3(2)) baked by @margoengine/lod's Imposter, in place of its mesh. The distribute pass is the plain Scatter's: the
// far ring keeps its instances, its order and its draw count. After the colour pass, one indirect draw puts a
// camera-facing quad on each far instance, with lod's own imposter shader reading the scatter instance (root, scale,
// yaw and ground tilt) in place of a matrix. The instance count comes from the far ring's draw command, copied on the
// GPU, so nothing is read back. The middle-to-far fade band keeps its complementary Bayer masks.
import type { EngineKernel, Geometry } from '@margoengine/core';
import { engineRuntime, type PassContext } from '@margoengine/core/extension';
import { Imposter, imposterShader } from '@margoengine/lod';
import { Scatter, type ScatterOptions } from '@margoengine/scatter';
import { typeError } from '../../shared/errors.js';
import { overlayDepthPass } from '../../shared/pass.js';
import { applyView } from '../../shared/view-rect.js';
import { fadeCode, poseShader } from './pose.js';
import { unitLight } from '../../shared/unit-light.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number; INDIRECT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

const lodInstances =
  'struct Instance {m:mat4x4f,color:vec4f,emissive:vec4f}\n@group(0) @binding(1) var<storage,read> instances:array<Instance>;';
const fragmentHead = '@fragment fn fragment(i:Out)->Pixel {';

/**
 * lod's imposter shader `code` reading scatter instances: binding 1 of group 0 is a scatter LOD ring
 * (`position = (x, y, z, scale)`, `rotation = (yaw, packed ground normal, fade, fade mode)`), each turned into the
 * matrix its mesh would draw with (yaw, then the ground tilt by `frame.options.z`, then the scale), white tint and no
 * emissive; the fragment stage keeps the ring's LOD fade mask.
 * @throws TypeError when `code` is not lod's imposter shader.
 */
export function imposterRingCode(code: string): string {
  if (code.split(lodInstances).length !== 2 || code.split(fragmentHead).length !== 2)
    throw typeError("imposterRingCode takes @margoengine/lod's imposterShader; pass that shader unchanged", 'scatter');
  const turn = poseShader.slice(poseShader.indexOf('fn scatterGround('), poseShader.indexOf('// ground.xyz is'));
  return code
    .replace(
      lodInstances,
      `struct Instance {m:mat4x4f,color:vec4f,emissive:vec4f}
struct ScatterInstance {position:vec4f,rotation:vec4f}
@group(0) @binding(1) var<storage,read> ring:array<ScatterInstance>;
${turn}${fadeCode}
fn scatterInstance(id:u32)->Instance {
 let d=ring[id];let c=cos(d.rotation.x);let s=sin(d.rotation.x);let k=d.position.w;
 let up=normalize(mix(vec3f(0,1,0),scatterGround(d.rotation.y),frame.options.z));
 let m=mat4x4f(vec4f(scatterTurn(vec3f(1,0,0),c,s,up)*k,0),vec4f(scatterTurn(vec3f(0,1,0),c,s,up)*k,0),vec4f(scatterTurn(vec3f(0,0,1),c,s,up)*k,0),vec4f(d.position.xyz,1));
 return Instance(m,vec4f(1),vec4f(0));
}`,
    )
    .replace(/instances\[(id|i\.id)\]/g, 'scatterInstance($1)')
    .replace(fragmentHead, fragmentHead + '\n if(!lodVisible(i.clip.xy,ring[i.id].rotation.zw)){discard;}');
}

/** {@link ScatterOptions} plus the imposter that draws the far ring. */
export interface ImposterScatterOptions extends ScatterOptions {
  /** The far mesh baked once with `Imposter.bake(engine, farMesh)` from `@margoengine/lod`. */
  imposter: Imposter;
}

/**
 * A {@link Scatter} whose far LOD ring draws as octahedral imposters instead of its mesh: bake the far mesh once with
 * `Imposter.bake(engine, mesh)` from `@margoengine/lod` and pass it as `imposter`. The near and middle rings, the distribute pass,
 * the fade band and the shadow passes (the far ring casts with its mesh) are the plain Scatter's.
 * `ImposterScatter.attach(engine, geometry, { ...options, imposter })`.
 * @throws TypeError when `imposter` is not a lod Imposter.
 */
export class ImposterScatter extends Scatter {
  readonly imposter: Imposter;
  readonly #frame = new Float32Array(32);
  readonly #pass = overlayDepthPass();
  #uniform?: GPUBuffer;
  #indirect?: GPUBuffer;
  #pipeline?: GPURenderPipeline;
  #key = '';
  #group?: GPUBindGroup;
  #texture?: GPUTexture;
  #sampler?: GPUSampler;

  constructor(
    geometry: Geometry | readonly [Geometry, Geometry, Geometry],
    options: ImposterScatterOptions,
  ) {
    super(geometry, options);
    const imposter = options?.imposter;
    if (!(imposter instanceof Imposter))
      throw typeError('ImposterScatter takes an Imposter; bake one with Imposter.bake(engine, farMesh)', 'scatter');
    this.imposter = imposter;
  }

  static override attach(
    engine: EngineKernel,
    geometry: Geometry | readonly [Geometry, Geometry, Geometry],
    options: ImposterScatterOptions,
  ): ImposterScatter {
    const effect = new ImposterScatter(geometry, options);
    engineRuntime(engine).use(effect);
    return effect;
  }

  /** The far ring draws its mesh again while the imposter cannot draw (disposed, or no device yet). */
  protected override drawsRing(ring: number): boolean {
    return ring !== 2 || !this.imposter.ready();
  }

  protected override drawn(c: Context): void {
    super.drawn(c);
    const imp = this.imposter;
    if (!imp.ready()) return;
    const d = c.device,
      samples = c.descriptor.multisample?.count ?? 1,
      depth = c.descriptor.depthStencil!.format,
      key = `${c.format}:${samples}:${depth}`;
    if (!this.#uniform) {
      this.#uniform = d.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.#indirect = d.createBuffer({ size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(this.#indirect, 0, new Uint32Array([4, 0, 0, 0]));
      this.#sampler = d.createSampler({ minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear' });
    }
    const f = this.#frame,
      lighting = this.engine!.lighting;
    f.set(c.camera.matrix);
    f.set(c.camera.position, 16);
    unitLight(f, 20, lighting.direction);
    f.set(lighting.radiance, 24);
    f[28] = +(c.format === 'rgba16float');
    f[29] = +(samples > 1);
    f[30] = this.values[72]; // alignToGround
    d.queue.writeBuffer(this.#uniform, 0, f as Float32Array<ArrayBuffer>);
    if (this.#key !== key) {
      const module = d.createShaderModule({ code: imposterRingCode(imposterShader) });
      this.#pipeline = d.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        primitive: { topology: 'triangle-strip' },
        depthStencil: { format: depth, depthWriteEnabled: true, depthCompare: 'greater-equal' },
        multisample: { count: samples, alphaToCoverageEnabled: samples > 1 },
      });
      this.#key = key;
      this.#group = undefined;
    }
    if (!this.#group || this.#texture !== imp.color) {
      this.#texture = imp.color;
      this.#group = d.createBindGroup({
        layout: this.#pipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.#uniform } },
          { binding: 1, resource: { buffer: this.instances[2] } },
          { binding: 2, resource: imp.color!.createView() },
          { binding: 3, resource: imp.normal!.createView() },
          { binding: 4, resource: this.#sampler! },
          { binding: 5, resource: { buffer: imp.uniform! } },
          { binding: 6, resource: imp.glow!.createView() },
        ],
      });
    }
    // The far ring's instance count (word 1 of its indexed command) into a four-vertex strip's draw.
    c.encoder.copyBufferToBuffer(this.commands!, 44, this.#indirect!, 4, 4);
    this.#pass.colorAttachments[0].view = c.color;
    this.#pass.depthStencilAttachment.view = c.depth;
    const pass = c.encoder.beginRenderPass(this.#pass);
    applyView(pass, c);
    pass.setPipeline(this.#pipeline!);
    pass.setBindGroup(0, this.#group);
    pass.drawIndirect(this.#indirect!, 0);
    pass.end();
  }

  protected override release(): void {
    super.release();
    this.#uniform?.destroy();
    this.#indirect?.destroy();
    this.#uniform = this.#indirect = this.#pipeline = this.#group = this.#texture = this.#sampler = undefined;
    this.#key = '';
  }
}
