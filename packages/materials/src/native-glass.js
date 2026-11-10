// Internal gltf-pro adapter. Capture a display scene so each native glass surface can read the light behind it.
import { sceneTarget } from '../../shared/msaa.js';
import { currentFrame, retire } from '../../shared/frame-resources.js';
import { applyView } from '../../shared/view-rect.js';
const captures = new WeakMap();
const frames = new WeakMap();
const shader = `@group(0) @binding(0) var source:texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) k:u32)->@builtin(position) vec4f {
 return vec4f(vec2f(f32((k<<1u)&2u),f32(k&2u))*2.0-1.0,0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {return textureLoad(source,vec2i(p.xy),0);}`;
const binding = 126;

class NativeGlass {
  name = 'materials:native-glass';
  users = new Set();
  constructor(engine) {
    this.engine = engine;
  }
  setup(engine) {
    this.device = engine.gpu;
  }
  registerPasses(graph) {
    graph.add({ name: this.name + ':begin', order: -64, execute: (c) => this.begin(c) });
    graph.add({ name: this.name + ':present', order: 29, execute: (c) => this.present(c) });
  }
  begin(c) {
    if (c.backend !== 'webgpu' || c.format === 'rgba16float' || ![...this.users].some((active) => active())) return;
    currentFrame(c.device, c.view ?? c);
    const samples = c.descriptor.multisample?.count ?? 1;
    const key = [c.width, c.height, c.format, samples, c.descriptor.depthStencil.format].join(':');
    if (this.key !== key) {
      this.release();
      try {
        this.key = key;
        const texture = (format) =>
          c.device.createTexture({
            size: [c.width, c.height],
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          });
        this.color = texture(c.format);
        this.snapshot = texture(c.format);
        this.view = this.snapshot.createView();
        this.entries = [{ binding, resource: this.view }];
        if (samples === 4) {
          this.multisample = c.device.createTexture({
            size: [c.width, c.height],
            format: c.format,
            sampleCount: 4,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });
        }
        this.colorView = (this.multisample ?? this.color).createView();
        this.resolution = {
          label: 'native-glass:resolve',
          colorAttachments: [
            { view: this.colorView, resolveTarget: this.color.createView(), loadOp: 'load', storeOp: 'store' },
          ],
        };
        const module = c.device.createShaderModule({ code: shader });
        const pipeline = (count) =>
          c.device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vertex' },
            fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
            multisample: { count },
          });
        this.copyPipeline = pipeline(1);
        this.presentPipeline = pipeline(samples);
        const group = (p) =>
          c.device.createBindGroup({
            layout: p.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: this.color.createView() }],
          });
        this.copyGroup = group(this.copyPipeline);
        this.presentGroup = group(this.presentPipeline);
      } catch (error) {
        this.release();
        throw error;
      }
    }
    frames.set(c, this);
    // A scene capture that began earlier (TAA's, at order -70) already owns the live color, and its later passes
    // check that they still do. copy() reads that capture's resolved color, so leave the target alone.
    this.redirected = !sceneTarget(c);
    if (!this.redirected) return;
    this.original = c.color;
    c.color = this.colorView;
  }
  copy(c) {
    // A borrowed package capture may own the live color (for example materials' opaque capture).
    const target = sceneTarget(c);
    target?.resolve(c.encoder);
    if (!target && this.multisample) c.encoder.beginRenderPass(this.resolution).end();
    const source = target?.resolvedColor ?? this.color;
    const group =
      source === this.color
        ? this.copyGroup
        : c.device.createBindGroup({
            layout: this.copyPipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: source.createView() }],
          });
    const pass = c.encoder.beginRenderPass({
      label: 'native-glass:copy',
      colorAttachments: [{ view: this.view, loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(this.copyPipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
  }
  present(c) {
    if (frames.get(c) !== this) return;
    if (this.redirected) {
      if (this.multisample) c.encoder.beginRenderPass(this.resolution).end();
      const pass = c.encoder.beginRenderPass({
        label: 'native-glass:present',
        colorAttachments: [{ view: this.original, loadOp: 'load', storeOp: 'store' }],
      });
      pass.setPipeline(this.presentPipeline);
      pass.setBindGroup(0, this.presentGroup);
      applyView(pass, c);
      pass.draw(3);
      pass.end();
      c.color = this.original;
    }
    frames.delete(c);
  }
  release() {
    for (const texture of [this.color, this.multisample, this.snapshot]) retire(this.device, texture);
    this.color = this.multisample = this.snapshot = this.key = undefined;
  }
  onDeviceRestored(engine) {
    this.release();
    this.setup(engine);
  }
  dispose() {
    this.release();
    const scene = this.engine.sceneOf(this);
    if (scene) this.engine.removePlugin(this.name, scene);
  }
}
export function acquireNativeGlass(engine, active) {
  const graph = engine.frameGraph;
  let capture = captures.get(graph);
  if (!capture) {
    capture = new NativeGlass(engine);
    engine.use(capture);
    captures.set(graph, capture);
  }
  capture.users.add(active);
  return () => {
    capture.users.delete(active);
    if (!capture.users.size) {
      captures.delete(graph);
      capture.dispose();
    }
  };
}
export function nativeGlass(c) {
  return frames.get(c);
}

// Keep the native tint's complete material and lighting interface. Its returned share is linear here.
export function nativeGlassShader(code) {
  const faced = /@fragment fn margoTint\(i:Out,@builtin\(front_facing\) front:bool\)/.test(code);
  // Reuse the lit fragment's evaluated surface. In particular, do not evaluate derivative texture/normal hooks twice.
  const surfaceShare = /let s=surface\(i,front\);return ([^;]+);/.exec(code)?.[1];
  const share = surfaceShare ?? `margoGlassShare(i${faced ? ',front' : ''})`;
  return (
    code
      .replace(
        /@fragment fn margoTint\(i:Out(?:,@builtin\(front_facing\) front:bool)?\)->@location\(0\) vec4f \{/,
        `fn margoGlassShare(i:Out${faced ? ',front:bool' : ''})->vec4f {`,
      )
      .replace(
        /fn margoTintEncode\(share:vec3f\)->vec4f \{[^}]+\}/,
        'fn margoTintEncode(share:vec3f)->vec4f {return vec4f(share,1);}',
      )
      .replace(
        'return vec4f(color,',
        `color=margoGlassEncode(margoGlassLinear(color)+margoGlassLinear(textureLoad(margoGlassScene,vec2i(i.clip.xy),0).rgb)*${share}.rgb);return vec4f(color,`,
      )
      .replace(
        'return vec4f(color,select(1.0,s.base.a,f.settings.x>1.5));',
        'let glassAlpha=select(1.0,s.base.a,f.settings.x>1.5);return vec4f(color,glassAlpha+textureLoad(margoGlassScene,vec2i(i.clip.xy),0).a*(1.0-glassAlpha));',
      ) +
    `
@group(2) @binding(${binding}) var margoGlassScene:texture_2d<f32>;
fn margoGlassLinear(c:vec3f)->vec3f {let x=max(c,vec3f(0));return select(x/12.92,pow((x+0.055)/1.055,vec3f(2.4)),x>vec3f(0.04045));}
fn margoGlassEncode(c:vec3f)->vec3f {let x=max(c,vec3f(0));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>vec3f(0.0031308));}`
  );
}
