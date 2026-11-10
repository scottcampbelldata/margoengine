import { applyView, viewLoadOp } from './view-rect.js';
import { retire } from './frame-resources.js';
import { compatibilityLevel } from './compat.js';
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

/** The draws and pass descriptor that copy `count`-sample depth into a `format` attachment, made once per pair. */
function depthCopy(device, source, view, count, format) {
  // Preserve each reversed-Z coverage sample when returning to an outer scene.
  const load = (sample) => depthShader.replace(/return max[^;]+;/, `return textureLoad(source,q,${sample});`),
    draw = (code, multisample) => {
      const module = device.createShaderModule({ code }),
        pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [] },
          depthStencil: { format, depthWriteEnabled: true, depthCompare: 'always' },
          multisample,
        });
      return { pipeline, group: group(device, pipeline, source) };
    };
  return {
    // The compatibility level has no sample_index: one draw per sample, the pipeline's mask writing that sample alone.
    draws:
      count !== 4
        ? [draw(depthShader, { count })]
        : compatibilityLevel(device)
          ? [0, 1, 2, 3].map((sample) => draw(load(sample), { count, mask: 1 << sample }))
          : [draw(load('i32(sample)').replace('p:vec4f)', 'p:vec4f,@builtin(sample_index) sample:u32)'), { count })],
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
}

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
    // The view being captured: depth copies stay inside its rectangle and keep earlier views' depth.
    (this.viewContext ??= {}).view = c.view;
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
    if (!cached) formats.set(format, (cached = depthCopy(this.device, this.depthSource, view, count, format)));
    cached.descriptor.depthStencilAttachment.view = view;
    cached.descriptor.depthStencilAttachment.depthLoadOp = this.viewContext?.view ? 'load' : 'clear';
    const pass = encoder.beginRenderPass(cached.descriptor);
    if (this.viewContext) applyView(pass, this.viewContext);
    // An indexed loop, and the pipeline setup outside this method: it runs up to three times a frame, and a for-of
    // iterator or a context for the setup's closures cost 92 B a call wherever V8 does not optimize them away
    // (Chrome 156 on macOS arm64; tests/frame-alloc.test.js).
    const draws = cached.draws;
    for (let i = 0; i < draws.length; i++) {
      pass.setPipeline(draws[i].pipeline);
      pass.setBindGroup(0, draws[i].group);
      pass.draw(3);
    }
    pass.end();
  }
  resolve(encoder, final = false, depth = true) {
    if (this.samples === 1) return;
    // depth false: the caller reads no 1x depth after this resolve (only a final one may skip it).
    if (depth) this.copyDepth(encoder, this.resolvedDepthView, 1);
    if (final) {
      // A later view loads these samples before resolving the full HDR target.
      // Standalone captures still retire both attachments after their final use.
      const store = this.viewContext?.view ? 'store' : 'discard';
      this.finalResolution.colorAttachments[0].storeOp = store;
      this.finalResolution.depthStencilAttachment.depthStoreOp = store;
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
    descriptor.colorAttachments[0].loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(descriptor);
    pass.setPipeline(this.presentation);
    pass.setBindGroup(0, this.presentationGroup);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  dispose() {
    for (const texture of this.textures) retire(this.device, texture);
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
