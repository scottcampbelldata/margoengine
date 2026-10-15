import type { Engine, Geometry, PassContext } from '@margoengine/core/extension';
import type { XRBinding, XRProjectionLayer, XRViewerPose } from './types.js';
declare const GPUBufferUsage: { VERTEX: number; INDEX: number; UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };

type Resource = { vertex: GPUBuffer; index: GPUBuffer; instance: GPUBuffer; data: Float32Array; count: number };

export class StereoRenderer {
  private pipeline?: GPURenderPipeline;
  private depthPipeline?: GPURenderPipeline;
  private readonly resources = new Map<Geometry, Resource>();
  private readonly eyes: Array<{
    uniform: GPUBuffer;
    group: GPUBindGroup;
    data: Float32Array;
    color?: GPUTexture;
    depth?: GPUTexture;
    colorView?: GPUTextureView;
    depthView?: GPUTextureView;
    depthGroup?: GPUBindGroup;
  }> = [];
  private readonly used = new Set<Geometry>();
  constructor(private readonly device: GPUDevice) {}
  configure(context: Extract<PassContext, { backend: 'webgpu' }>, format: GPUTextureFormat): void {
    this.dispose();
    const module = this.device.createShaderModule({ code: context.shader });
    this.pipeline = this.device.createRenderPipeline({
      ...context.descriptor,
      multisample: { count: 4 },
      vertex: { ...context.descriptor.vertex, module },
      fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    const depthModule = this.device.createShaderModule({
      code: `@group(0) @binding(0) var depth:texture_depth_multisampled_2d;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}
@fragment fn fragment(@builtin(position) p:vec4f)->@builtin(frag_depth) f32{let q=vec2i(p.xy);return min(min(textureLoad(depth,q,0),textureLoad(depth,q,1)),min(textureLoad(depth,q,2),textureLoad(depth,q,3)));}`,
    });
    this.depthPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: depthModule, entryPoint: 'vertex' },
      fragment: { module: depthModule, entryPoint: 'fragment', targets: [] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'always' },
    });
  }
  render(
    engine: Engine,
    binding: XRBinding,
    layer: XRProjectionLayer,
    viewer: XRViewerPose,
    transparent: boolean,
  ): void {
    const device = this.device,
      pipeline = this.pipeline!;
    const used = this.used;
    used.clear();
    for (const resource of this.resources.values()) resource.count = 0;
    for (const mesh of engine.meshes.values())
      if (mesh.geometry && engine.store.visible[mesh.id]) {
        const geometry = mesh.geometry;
        used.add(geometry);
        let resource = this.resources.get(geometry);
        // Core grows its entity store on demand: rebuild instance storage sized for the old capacity.
        if (resource && resource.data.length < engine.store.capacity * 24) {
          resource.vertex.destroy();
          resource.index.destroy();
          resource.instance.destroy();
          this.resources.delete(geometry);
          resource = undefined;
        }
        if (!resource) {
          const allocated: GPUBuffer[] = [];
          const upload = (data: Float32Array | Uint32Array, usage: number) => {
            if (data.byteLength > device.limits.maxBufferSize) throw new RangeError('XR buffer exceeds device limit');
            const buffer = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
            allocated.push(buffer);
            device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
            return buffer;
          };
          try {
            const data = new Float32Array(engine.store.capacity * 24);
            resource = {
              vertex: upload(geometry.vertices, GPUBufferUsage.VERTEX),
              index: upload(geometry.indices, GPUBufferUsage.INDEX),
              instance: upload(data, GPUBufferUsage.VERTEX),
              data,
              count: 0,
            };
            this.resources.set(geometry, resource);
          } catch (error) {
            for (const buffer of allocated) buffer.destroy();
            throw error;
          }
        }
        const offset = resource.count++ * 24;
        resource.data.set(mesh.matrix, offset);
        resource.data.set(mesh.material.data, offset + 16);
      }
    for (const [geometry, resource] of this.resources) {
      if (!used.has(geometry)) {
        resource.vertex.destroy();
        resource.index.destroy();
        resource.instance.destroy();
        this.resources.delete(geometry);
      } else
        device.queue.writeBuffer(
          resource.instance,
          0,
          resource.data as Float32Array<ArrayBuffer>,
          0,
          resource.count * 24,
        );
    }
    const encoder = device.createCommandEncoder();
    for (let eye = 0; eye < viewer.views.length; eye++) {
      const view = viewer.views[eye],
        image = binding.getViewSubImage(layer, view),
        descriptor = image.getViewDescriptor();
      let frame = this.eyes[eye];
      if (!frame) {
        const uniform = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        try {
          frame = {
            uniform,
            group: device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [{ binding: 0, resource: { buffer: uniform } }],
            }),
            data: new Float32Array(28),
          };
          this.eyes.push(frame);
        } catch (error) {
          uniform.destroy();
          throw error;
        }
      }
      const p = view.projectionMatrix,
        v = view.transform.inverse.matrix,
        data = frame.data;
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++)
          data[c * 4 + r] =
            p[r] * v[c * 4] + p[4 + r] * v[c * 4 + 1] + p[8 + r] * v[c * 4 + 2] + p[12 + r] * v[c * 4 + 3];
      const position = view.transform.position;
      data[16] = position.x;
      data[17] = position.y;
      data[18] = position.z;
      data[19] = 1;
      data.set(engine.lighting.direction, 20);
      data.set(engine.lighting.radiance, 24);
      device.queue.writeBuffer(frame.uniform, 0, data as Float32Array<ArrayBuffer>);
      if (!image.depthStencilTexture) throw new Error('XR projection layer has no depth texture');
      if (
        frame.color?.width !== image.colorTexture.width ||
        frame.color?.height !== image.colorTexture.height ||
        frame.color?.format !== image.colorTexture.format
      ) {
        frame.color?.destroy();
        frame.depth?.destroy();
        frame.color = undefined;
        frame.depth = undefined;
        frame.colorView = frame.depthView = frame.depthGroup = undefined;
        try {
          frame.color = device.createTexture({
            size: [image.colorTexture.width, image.colorTexture.height],
            format: image.colorTexture.format,
            sampleCount: 4,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });
          frame.depth = device.createTexture({
            size: [image.colorTexture.width, image.colorTexture.height],
            format: 'depth24plus',
            sampleCount: 4,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          });
          frame.colorView = frame.color.createView();
          frame.depthView = frame.depth.createView();
          frame.depthGroup = device.createBindGroup({
            layout: this.depthPipeline!.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: frame.depthView }],
          });
        } catch (error) {
          frame.color?.destroy();
          frame.depth?.destroy();
          frame.color = frame.depth = undefined;
          frame.colorView = frame.depthView = frame.depthGroup = undefined;
          throw error;
        }
      }
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: frame.colorView!,
            resolveTarget: image.colorTexture.createView(descriptor),
            loadOp: 'clear',
            storeOp: 'discard',
            clearValue: { r: 0, g: 0, b: 0, a: transparent ? 0 : 1 },
          },
        ],
        depthStencilAttachment: {
          view: frame.depthView!,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 1,
        },
      });
      const viewport = image.viewport;
      pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, 0, 1);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, frame.group);
      for (const [geometry, resource] of this.resources)
        if (resource.count) {
          pass.setVertexBuffer(0, resource.vertex);
          pass.setVertexBuffer(1, resource.instance);
          pass.setIndexBuffer(resource.index, 'uint32');
          pass.drawIndexed(geometry.indices.length, resource.count);
        }
      pass.end();
      // XR projection matrices use forward Z; populate the compositor's 1x depth layer.
      const depthPass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: image.depthStencilTexture.createView(descriptor),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 1,
        },
      });
      depthPass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, 0, 1);
      depthPass.setPipeline(this.depthPipeline!);
      depthPass.setBindGroup(0, frame.depthGroup!);
      depthPass.draw(3);
      depthPass.end();
      encoder
        .beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: { view: frame.depthView!, depthLoadOp: 'load', depthStoreOp: 'discard' },
        })
        .end();
    }
    device.queue.submit([encoder.finish()]);
  }
  dispose(): void {
    for (const resource of this.resources.values()) {
      resource.vertex.destroy();
      resource.index.destroy();
      resource.instance.destroy();
    }
    this.resources.clear();
    for (const eye of this.eyes) {
      eye.uniform.destroy();
      eye.color?.destroy();
      eye.depth?.destroy();
    }
    this.eyes.length = 0;
    this.pipeline = this.depthPipeline = undefined;
  }
}
