import { Geometry, type EngineKernel } from '@margoengine/core';
import { engineRuntime, type PassContext } from '@margoengine/core/extension';
import { DepthPyramid, depthPyramidShader, type OccluderInput } from '@margoengine/culling/depth';
import { Scatter, type ScatterOptions } from '@margoengine/scatter';

/** Current-frame Hi-Z culling for Scatter. Camera-hidden instances retain their original shadow rings. */
export class OccludedScatter extends Scatter {
  /** Toggle at runtime. Default true. */
  enabled = true;
  private readonly depth = new DepthPyramid();
  private colour: GPUBuffer[] = [];
  private args?: GPUBuffer;
  private radius?: GPUBuffer;
  private filter?: GPUComputePipeline;
  constructor(meshes: readonly [Geometry, Geometry, Geometry], options: ScatterOptions = {}) {
    super(meshes, options);
  }
  static override attach(
    engine: EngineKernel,
    meshes: readonly [Geometry, Geometry, Geometry],
    options?: ScatterOptions,
  ): OccludedScatter {
    const scatter = new OccludedScatter(meshes, options);
    engineRuntime(engine).use(scatter);
    return scatter;
  }
  /** Add an opaque terrain, building, glTF model or core mesh visible in the scene. */
  addOccluder(source: OccluderInput): this {
    this.depth.add(source);
    return this;
  }
  removeOccluder(source: OccluderInput): this {
    this.depth.remove(source);
    return this;
  }
  protected override colourInstances(): GPUBuffer[] {
    return this.colour;
  }
  protected override colourCommands(): GPUBuffer {
    return this.args!;
  }
  protected override cull(c: Extract<PassContext, { backend: 'webgpu' }>, terrain: GPUTexture): void {
    super.cull(c, terrain);
    const d = c.device;
    if (!this.args) {
      this.colour = this.instances.map((b) => d.createBuffer({ size: b.size, usage: 128 }));
      this.args = d.createBuffer({ size: 60, usage: 128 | 256 | 8 | 4 });
      const args = new Uint32Array(15);
      this.geometries.forEach((g, i) => (args[i * 5] = g.indices.length));
      d.queue.writeBuffer(this.args, 0, args);
      this.radius = d.createBuffer({ size: 16, usage: 64 | 8 });
      const code =
        depthPyramidShader +
        `
struct Instance {position:vec4f,rotation:vec4f}
@group(0) @binding(1) var<storage,read> candidates:array<Instance>;
@group(0) @binding(2) var<storage,read_write> flags:array<u32>;
@group(0) @binding(3) var<uniform> info:vec4f;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;let n=arrayLength(&candidates);if(i>=n){return;}
 let p=candidates[i].position;let r=info.x*p.w;let padded=r+1e-5*(length(p.xyz)+r);
 if((flags[i]|flags[n+i]|flags[2u*n+i])!=0u&&!unoccluded(vec4f(p.xyz,padded))){flags[i]=0u;flags[n+i]=0u;flags[2u*n+i]=0u;}
}`;
      this.filter = d.createComputePipeline({
        layout: 'auto',
        compute: { module: d.createShaderModule({ code }), entryPoint: 'main' },
      });
    }
    if (this.enabled) this.depth.encode(c, this.engine!);
    const pass = c.encoder.beginComputePass();
    if (this.enabled) {
      d.queue.writeBuffer(this.radius!, 0, new Float32Array([this.values[35], 0, 0, 0]));
      const group = d.createBindGroup({
        layout: this.filter!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.depth.uniform! } },
          { binding: 1, resource: { buffer: this.ordered!.candidates } },
          { binding: 2, resource: { buffer: this.ordered!.flags } },
          { binding: 3, resource: { buffer: this.radius! } },
          { binding: 5, resource: { buffer: this.depth.buffer! } },
        ],
      });
      pass.setPipeline(this.filter!);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(this.count / 64));
    }
    this.ordered!.encode(pass, this.colour, this.args!);
    pass.end();
  }
  protected override release(): void {
    super.release();
    this.depth.release();
    this.colour.forEach((b) => b.destroy());
    this.colour = [];
    this.args?.destroy();
    this.radius?.destroy();
    this.args = this.radius = this.filter = undefined;
  }
}
