const fullscreen = `@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}`;
const group = (device, pipeline, view) =>
  device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }] });

const owner = Symbol.for('margoengine.optional.msaa');
const depthShader =
  fullscreen +
  `
@group(0) @binding(0) var source:texture_depth_multisampled_2d;
@fragment fn fragment(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {
 let q=vec2i(p.xy);
 return max(max(textureLoad(source,q,0),textureLoad(source,q,1)),max(textureLoad(source,q,2),textureLoad(source,q,3)));
}`;

/** Optional scene capture: 4x raster attachments, with sampleable 1x outputs. */
export class SceneTarget {
  constructor(device, color, depth, samples = 4) {
    if (samples !== 1 && samples !== 4) throw new RangeError('Scene samples must be 1 or 4');
    this.samples = samples;
    this.device = device;
    this.resolvedColor = color;
    this.resolvedDepth = depth;
    this.textures = [];
    this.pipelines = new Map();
    try {
      if (samples === 1) {
        this.color = color.createView();
        this.depth = depth.createView();
        return;
      }
      for (const texture of [color, depth])
        this.textures.push(
          device.createTexture({
            size: [texture.width, texture.height],
            format: texture.format,
            sampleCount: 4,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          }),
        );
      this.color = this.textures[0].createView();
      this.depth = this.textures[1].createView();
      this.resolution = {
        colorAttachments: [{ view: this.color, resolveTarget: color.createView(), loadOp: 'load', storeOp: 'store' }],
      };
      this.finalResolution = {
        colorAttachments: [{ ...this.resolution.colorAttachments[0], storeOp: 'discard' }],
        depthStencilAttachment: {
          view: this.depth,
          depthLoadOp: 'load',
          depthStoreOp: 'discard',
          stencilReadOnly: true,
        },
      };
      this.depthSource = this.textures[1].createView({ aspect: 'depth-only' });
      this.resolvedDepthView = depth.createView();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  begin(c) {
    Object.assign((this.original ??= {}), {
      color: c.color,
      depth: c.depth,
      format: c.format,
      descriptor: c.descriptor,
      owner: sceneTarget(c),
    });
    c.color = this.color;
    c.depth = this.depth;
    c.format = this.resolvedColor.format;
    if (this.baseDescriptor !== c.descriptor) {
      this.baseDescriptor = c.descriptor;
      this.descriptor = {
        ...c.descriptor,
        depthStencil: { ...c.descriptor.depthStencil, format: this.resolvedDepth.format },
        multisample: { count: this.samples },
      };
    }
    c.descriptor = this.descriptor;
    c[owner] = this;
    this.retired = false;
  }
  copyDepth(encoder, view, count, format = this.resolvedDepth.format) {
    let formats = this.pipelines.get(count);
    if (!formats) this.pipelines.set(count, (formats = new Map()));
    let cached = formats.get(format);
    if (!cached) {
      // Preserve each reversed-Z coverage sample when returning to an outer scene.
      const code =
        count === 4
          ? depthShader
              .replace('p:vec4f)', 'p:vec4f,@builtin(sample_index) sample:u32)')
              .replace(/return max[^;]+;/, 'return textureLoad(source,q,i32(sample));')
          : depthShader;
      const module = this.device.createShaderModule({ code });
      const pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [] },
        depthStencil: { format, depthWriteEnabled: true, depthCompare: 'always' },
        multisample: { count },
      });
      cached = {
        pipeline,
        group: group(this.device, pipeline, this.depthSource),
        descriptor: {
          colorAttachments: [],
          depthStencilAttachment: {
            view,
            depthLoadOp: 'clear',
            depthClearValue: 0,
            depthStoreOp: 'store',
            stencilReadOnly: true,
          },
        },
      };
      formats.set(format, cached);
    }
    cached.descriptor.depthStencilAttachment.view = view;
    const pass = encoder.beginRenderPass(cached.descriptor);
    pass.setPipeline(cached.pipeline);
    pass.setBindGroup(0, cached.group);
    pass.draw(3);
    pass.end();
  }
  resolve(encoder, final = false) {
    if (this.samples === 1) return;
    this.copyDepth(encoder, this.resolvedDepthView, 1);
    if (final) {
      if (this.original)
        this.copyDepth(
          encoder,
          this.original.depth,
          this.original.descriptor.multisample?.count ?? 1,
          this.original.descriptor.depthStencil.format,
        );
      this.retired = true;
    }
    encoder.beginRenderPass(final ? this.finalResolution : this.resolution).end();
  }
  restore(c) {
    const original = this.original;
    if (this.samples === 1) {
      Object.assign(c, {
        color: original.color,
        depth: original.depth,
        format: original.format,
        descriptor: original.descriptor,
      });
      c[owner] = original.owner;
      return;
    }
    if (!this.retired)
      this.copyDepth(
        c.encoder,
        original.depth,
        original.descriptor.multisample?.count ?? 1,
        original.descriptor.depthStencil.format,
      );
    Object.assign(c, {
      color: original.color,
      depth: original.depth,
      format: original.format,
      descriptor: original.descriptor,
    });
    c[owner] = original.owner;
  }
  present(c) {
    this.resolve(c.encoder, true);
    this.restore(c);
    const samples = c.descriptor.multisample?.count ?? 1;
    if (!this.presentation || this.presentationFormat !== c.format || this.presentationSamples !== samples) {
      const module = this.device.createShaderModule({
        code:
          fullscreen +
          '@group(0) @binding(0) var source:texture_2d<f32>;@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{return textureLoad(source,vec2i(p.xy),0);}',
      });
      this.presentation = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        multisample: c.descriptor.multisample,
      });
      this.presentationGroup = group(this.device, this.presentation, this.resolvedColor.createView());
      this.presentationFormat = c.format;
      this.presentationSamples = samples;
    }
    const descriptor = (this.presentationPass ??= {
      colorAttachments: [{ view: c.color, loadOp: 'clear', storeOp: 'store' }],
    });
    descriptor.colorAttachments[0].view = c.color;
    const pass = c.encoder.beginRenderPass(descriptor);
    pass.setPipeline(this.presentation);
    pass.setBindGroup(0, this.presentationGroup);
    pass.draw(3);
    pass.end();
  }
  dispose() {
    for (const texture of this.textures) texture.destroy();
    this.textures = [];
    this.pipelines.clear();
  }
}
export function sceneTarget(c) {
  const target = c[owner];
  return target?.color === c.color && target.depth === c.depth ? target : undefined;
}
export function resolveMSAA(c) {
  sceneTarget(c)?.resolve(c.encoder);
}

export { sceneSamples } from './quality.js';
