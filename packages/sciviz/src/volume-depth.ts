// Optional scene capture and an opaque-depth snapshot for scientific volume rays.
import type { Engine, EnginePlugin, FrameGraph } from '@margoengine/core/extension';
import { SceneTarget, sceneTarget } from '../../shared/msaa.js';
import type { Drawable, GpuContext } from './render.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };
const captures = new WeakMap<Engine, VolumeDepthCapture>();

// One capture per engine, shared by figures. Existing post captures are borrowed.
export class VolumeDepthCapture implements EnginePlugin {
  readonly name = 'sciviz-volume-depth';
  readonly members = new Set<Drawable>();
  #device!: GPUDevice;
  #views = new Map<
    string,
    {
      target: SceneTarget;
      colour: GPUTexture;
      depth: GPUTexture;
      width: number;
      height: number;
      format: GPUTextureFormat;
      samples: number;
    }
  >();
  #active: SceneTarget | undefined;
  static attach(engine: Engine): VolumeDepthCapture {
    let capture = captures.get(engine);
    if (!capture) {
      capture = new VolumeDepthCapture();
      engine.use(capture);
      captures.set(engine, capture);
    }
    return capture;
  }
  setup(engine: Engine): void {
    this.#device = engine.gpu!;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':begin',
      order: -0.001,
      execute: (c) => {
        this.#active = undefined;
        if (c.backend !== 'webgpu' || ![...this.members].some((d) => d.visible) || sceneTarget(c)) return;
        const key = c.view?.id ?? '',
          samples = c.descriptor.multisample?.count ?? 1;
        let view = this.#views.get(key);
        if (
          !view ||
          view.width !== c.width ||
          view.height !== c.height ||
          view.format !== c.format ||
          view.samples !== samples
        ) {
          if (view) {
            view.target.dispose();
            view.colour.destroy();
            view.depth.destroy();
          }
          const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
          const colour = this.#device.createTexture({ size: [c.width, c.height], format: c.format, usage });
          const depth = this.#device.createTexture({ size: [c.width, c.height], format: 'depth32float', usage });
          view = {
            target: new SceneTarget(this.#device, colour, depth, samples),
            colour,
            depth,
            width: c.width,
            height: c.height,
            format: c.format,
            samples,
          };
          this.#views.set(key, view);
        }
        this.#active = view.target;
        view.target.begin(c);
      },
    });
    graph.add({
      name: this.name + ':present',
      order: 39,
      execute: (c) => {
        if (c.backend === 'webgpu' && this.#active) {
          this.#active.present(c);
          this.#active = undefined;
        }
      },
    });
  }
  forget(drawable: Drawable): void {
    this.members.delete(drawable);
    if (!this.members.size) this.#release();
  }
  onDeviceRestored(engine: Engine): void {
    this.#release();
    this.#device = engine.gpu!;
  }
  #release(): void {
    for (const v of this.#views.values()) {
      v.target.dispose();
      v.colour.destroy();
      v.depth.destroy();
    }
    this.#views.clear();
    this.#active = undefined;
  }
  dispose(): void {
    this.#release();
    this.members.clear();
  }
}

// Read-only snapshot: avoids binding an attachment as a texture during its write pass.
export class VolumeDepthSnapshot {
  #image: GPUTexture | undefined;
  #width = 0;
  #height = 0;
  #pipelines = new Map<number, GPURenderPipeline>();
  #groups = new WeakMap<GPUTextureView, GPUBindGroup>();
  update(context: GpuContext): GPUTextureView {
    const d = context.device,
      target = sceneTarget(context)!;
    const samples = target.samples,
      source = samples === 1 ? target.resolvedDepth.createView({ aspect: 'depth-only' }) : target.depthSource!;
    if (!this.#image || this.#width !== context.width || this.#height !== context.height) {
      this.#image?.destroy();
      this.#width = context.width;
      this.#height = context.height;
      this.#image = d.createTexture({
        size: [context.width, context.height],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    let pipeline = this.#pipelines.get(samples);
    if (!pipeline) {
      const module = d.createShaderModule({
        code: `
@group(0) @binding(0) var source:${samples === 1 ? 'texture_depth_2d' : 'texture_depth_multisampled_2d'};
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));return vec4f(p[i],0.0,1.0);
}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) f32 {
 let q=vec2i(p.xy);var z=textureLoad(source,q,0);
 ${samples === 4 ? 'z=max(z,textureLoad(source,q,1));z=max(z,textureLoad(source,q,2));z=max(z,textureLoad(source,q,3));' : ''}
 return z;
}`,
      });
      pipeline = d.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'r32float' }] },
      });
      this.#pipelines.set(samples, pipeline);
    }
    let group = this.#groups.get(source);
    if (!group) {
      group = d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: source }],
      });
      this.#groups.set(source, group);
    }
    const pass = context.encoder.beginRenderPass({
      colorAttachments: [{ view: this.#image.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    return this.#image.createView();
  }
  dispose(): void {
    this.#image?.destroy();
    this.#image = undefined;
    this.#pipelines.clear();
    this.#groups = new WeakMap();
  }
}

// Clip a ray with zero-to-one reversed-Z scene depth. The reconstructed point is
// transformed into the same metric as the ray; no near/far approximation is used.
export const volumeDepthWGSL = /* wgsl */ `
@group(2) @binding(0) var opaqueDepth:texture_2d<f32>;
fn opaquePoint(pixel:vec2f, ndc:vec2f)->vec4f {
 let z=textureLoad(opaqueDepth,vec2i(pixel),0).r;
 if(z<=0.0){return vec4f(0.0);}
 let p=frame.inverse*vec4f(ndc,z,1.0);return vec4f(p.xyz/p.w,1.0);
}`;
