import { margoError } from './errors.js';
import { SceneTarget, sceneTarget } from './msaa.js';
export const fullscreen = `
struct Vertex { @builtin(position) position:vec4f,@location(0) uv:vec2f }
@vertex fn vertex(@builtin(vertex_index) index:u32)->Vertex {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[index];
 return Vertex(vec4f(p,0,1),vec2f(p.x*0.5+0.5,0.5-p.y*0.5));
}`;
export const meshVertex = `
struct Frame {camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
struct Input {@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) m0:vec4f,@location(3) m1:vec4f,@location(4) m2:vec4f,@location(5) m3:vec4f,@location(6) color:vec4f,@location(7) factors:vec4f}
struct Output {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) id:u32}
@vertex fn vertex(i:Input)->Output {let model=mat4x4f(i.m0,i.m1,i.m2,i.m3);let p=model*vec4f(i.position,1);return Output(frame.camera*p,u32(i.factors.w));}
`;
export function group(device, pipeline, resources) {
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: resources.map((resource, binding) => ({ binding, resource })),
  });
}
export function render(device, code, format, extra = {}) {
  const module = device.createShaderModule({ code });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vertex' },
    fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
    ...extra,
  });
}
export function compute(device, code, entryPoint = 'main') {
  return device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code }), entryPoint },
  });
}
export function draw(c, pipeline, bindGroup, loadOp = 'load') {
  const pass = c.encoder.beginRenderPass({ colorAttachments: [{ view: c.color, loadOp, storeOp: 'store' }] });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
}
export function dispatch(c, pipeline, bindGroup, x, y = 1) {
  const pass = c.encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(x, y);
  pass.end();
}
const key = Symbol.for('margoengine.optional.scene-depth');
/** Shared across independently bundled optional packages on the same engine. */
export function acquireDepth(engine) {
  if (!engine.gpu)
    throw margoError('unsupported', 'Scene depth requires WebGPU; it does not run on the WebGL2 fallback');
  if (engine.hasPlugin('ssao') || engine.hasPlugin('dof'))
    throw margoError('state', 'Supply the depth texture of the effect that owns scene capture');
  let value = engine[key];
  if (!value) {
    value = {
      name: 'optional:scene-depth',
      references: 0,
      texture: undefined,
      color: undefined,
      target: undefined,
      borrowed: false,
      setup() {},
      registerPasses(graph) {
        graph.add({
          name: this.name + ':capture',
          order: -15,
          execute: (c) => {
            if (c.backend !== 'webgpu') return;
            if (engine.hasPlugin('ssao') || engine.hasPlugin('dof'))
              throw margoError('state', 'Supply the depth texture of the effect that owns scene capture');
            const existing = sceneTarget(c);
            this.borrowed = !!existing;
            if (existing) {
              this.borrowedDepth = existing.resolvedDepth;
              return;
            }
            const samples = c.descriptor.multisample?.count ?? 4;
            try {
              if (samples === 1) {
                if (
                  !this.depthView ||
                  this.texture?.width !== c.width ||
                  this.texture?.height !== c.height ||
                  this.texture?.format !== c.descriptor.depthStencil.format
                ) {
                  this.onDeviceRestored();
                  this.texture = c.device.createTexture({
                    size: [c.width, c.height],
                    format: c.descriptor.depthStencil.format,
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
                  });
                  this.depthView = this.texture.createView();
                }
                c.depth = this.depthView;
                return;
              }
              if (
                this.target?.samples !== samples ||
                this.texture?.width !== c.width ||
                this.texture?.height !== c.height ||
                this.texture?.format !== c.descriptor.depthStencil.format ||
                this.color?.format !== c.format
              ) {
                this.onDeviceRestored();
                this.texture = c.device.createTexture({
                  size: [c.width, c.height],
                  format: c.descriptor.depthStencil.format,
                  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
                });
                this.color = c.device.createTexture({
                  size: [c.width, c.height],
                  format: c.format,
                  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
                });
                this.target = new SceneTarget(c.device, this.color, this.texture, samples);
              }
              this.target.begin(c);
            } catch (error) {
              this.onDeviceRestored();
              throw error;
            }
          },
        });
        graph.add({
          name: this.name + ':restore',
          order: 10000,
          execute: (c) => {
            if (c.backend === 'webgpu' && !this.borrowed && c.descriptor.multisample?.count !== 1)
              this.target.present(c);
          },
        });
      },
      onDeviceRestored() {
        this.target?.dispose();
        this.texture?.destroy();
        this.color?.destroy();
        this.target = this.texture = this.color = this.depthView = undefined;
      },
      dispose() {
        this.onDeviceRestored();
        delete engine[key];
      },
    };
    engine.use(value);
    engine[key] = value;
  }
  value.references++;
  let released = false;
  return {
    texture: () => (value.borrowed ? value.borrowedDepth : value.texture),
    release() {
      if (released) return;
      released = true;
      if (--value.references === 0) engine.removePlugin(value.name);
    },
  };
}
