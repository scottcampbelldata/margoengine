// Both eyes through the engine's own frame graph. With an engine made by `createXREngine`, the XR binding shares the
// engine's GPU device (WebXR/WebGPU binding draft, section 2.2: the device of an XR-compatible adapter), so each eye is
// one view of `engine.render({views})` drawn into a texture: every package pass (lines, points, terrain, shadows, post
// effects) runs per eye as it runs per view on the desktop. A blit then moves each eye into the layer's sub-image, and
// the scene's reversed depth into the compositor's forward depth (WebXR Device API: a projection maps depthNear to 0).
import { Camera, type Engine, type RenderView } from '@margoengine/core/extension';
import { margoError } from '../../shared/errors.js';
import type { XRBinding, XRProjectionLayer, XRView, XRViewerPose } from './types.js';
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

interface Eye {
  camera: Camera;
  /** The view's projection with depth reversed, as the scene's pipelines compare depth. */
  readonly projection: Float64Array;
  color?: GPUTexture;
  depth?: GPUTexture;
  uniform: GPUBuffer;
  colorGroup?: GPUBindGroup;
  depthGroup?: GPUBindGroup;
  readonly view: RenderView & { target: { color: GPUTexture; depth: GPUTexture } };
}

/** WGSL of the blit: a full-screen triangle that reads the eye at its own pixel, the layer's viewport offset removed. */
function blit(samples: number, ar: boolean): string {
  const depth = samples > 1 ? 'texture_depth_multisampled_2d' : 'texture_depth_2d';
  // Reversed depth: the scene clears to 0, so a sample above 0 was drawn. Coverage is the share of drawn samples.
  let covered = '0.0';
  for (let s = 0; s < samples; s++) covered += ` + select(0.0, 1.0, textureLoad(d, q, ${s}) > 0.0)`;
  let nearest = 'textureLoad(d, q, 0)';
  for (let s = 1; s < samples; s++) nearest = `max(${nearest}, textureLoad(d, q, ${s}))`;
  return `@group(0) @binding(0) var c: texture_2d<f32>;
@group(0) @binding(1) var d: ${depth};
@group(0) @binding(2) var<uniform> o: vec4i;
@vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3))[i], 0, 1);
}
@fragment fn color(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let q = vec2i(p.xy) - o.xy;
  let c = textureLoad(c, q, 0);
  ${
    ar
      ? `// AR: the clear is black and the real world shows where nothing was drawn. Drawn samples, or light from a
  // pass that writes no depth (a glow, an unlit line), keep the pixel; the colour is already premultiplied by the
  // black clear.
  return vec4f(c.rgb, clamp(max((${covered}) / ${samples}.0, max(c.r, max(c.g, c.b))), 0.0, 1.0));`
      : 'return vec4f(c.rgb, 1.0);'
  }
}
@fragment fn depth(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 {
  let q = vec2i(p.xy) - o.xy;
  return 1.0 - ${nearest};
}
`;
}

/** Draws every eye of a viewer pose through `engine.render({views})` on the engine's device. */
export class EyeViews {
  private readonly eyes: Eye[] = [];
  private readonly views: RenderView[] = [];
  private readonly offset = new Int32Array(4);
  private pipelines?: { color: GPURenderPipeline; depth?: GPURenderPipeline; key: string };
  private readonly options: { views: RenderView[]; delta: number; culling: boolean } = {
    views: this.views,
    delta: 0,
    culling: true,
  };
  constructor(
    private readonly engine: Engine,
    private readonly device: GPUDevice,
  ) {}

  /** Moves eye `i`'s camera to `view`: its pose and its projection, with depth reversed. */
  private place(eye: Eye, view: XRView, projection: ArrayLike<number>): void {
    const m = view.transform.matrix,
      camera = eye.camera,
      p = eye.projection;
    // The pose's columns: x right, y up, z back, then the position. A look-at camera from the position towards -z with
    // the pose's up rebuilds the same rotation.
    camera.position = [m[12], m[13], m[14]];
    camera.target = [m[12] - m[8], m[13] - m[9], m[14] - m[10]];
    camera.up = [m[4], m[5], m[6]];
    for (let i = 0; i < 16; i++) p[i] = projection[i];
    // Clip z in [0, 1] with depthNear at 0; the scene's depth test wants depthNear at 1: z' = w - z.
    for (let column = 0; column < 16; column += 4) p[column + 2] = projection[column + 3] - projection[column + 2];
    camera.near = this.engine.camera.near;
    camera.far = this.engine.camera.far;
    // The vertical field of view packages read (screen-space sizes, level of detail), from the projection's y scale.
    camera.fov = (2 * Math.atan(1 / projection[5]) * 180) / Math.PI;
  }

  private eye(index: number): Eye {
    let eye = this.eyes[index];
    if (!eye) {
      const projection = new Float64Array(16),
        camera = new Camera();
      camera.project = (out) => out.set(projection);
      eye = {
        camera,
        projection,
        uniform: this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        view: { camera, viewport: [0, 0, 1, 1], id: `xr-${index}`, target: undefined! },
      };
      this.eyes[index] = eye;
    }
    return eye;
  }

  /** Makes the eye's textures for a sub-image of `width` by `height`, keeping them while the size holds. */
  private size(eye: Eye, width: number, height: number): void {
    if (eye.color?.width === width && eye.color.height === height) return;
    eye.color?.destroy();
    eye.depth?.destroy();
    eye.color = eye.depth = eye.colorGroup = eye.depthGroup = undefined;
    const target = this.engine.renderTarget!;
    eye.color = this.device.createTexture({
      size: [width, height],
      format: target.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: 'XR eye',
    });
    eye.depth = this.device.createTexture({
      size: [width, height],
      format: target.depthFormat,
      sampleCount: target.samples,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: 'XR eye depth',
    });
    eye.view.target = { color: eye.color, depth: eye.depth };
  }

  private build(layer: GPUTextureFormat, ar: boolean, withDepth: boolean): void {
    const key = `${layer} ${ar}`;
    if (this.pipelines?.key === key && (!withDepth || this.pipelines.depth)) return;
    const samples = this.engine.renderTarget!.samples,
      module = this.device.createShaderModule({ code: blit(samples, ar), label: 'XR eye blit' }),
      layout = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, texture: { sampleType: 'unfilterable-float' } },
          { binding: 1, visibility: 2, texture: { sampleType: 'depth', multisampled: samples > 1 } },
          { binding: 2, visibility: 2, buffer: {} },
        ],
      }),
      pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex = { module, entryPoint: 'vertex' };
    this.pipelines = {
      key,
      color: this.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex,
        fragment: { module, entryPoint: 'color', targets: [{ format: layer }] },
      }),
      depth: withDepth
        ? this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex,
            fragment: { module, entryPoint: 'depth', targets: [] },
            depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'always' },
          })
        : undefined,
    };
    for (const eye of this.eyes) eye.colorGroup = eye.depthGroup = undefined;
  }

  /** Draws this frame's eyes and puts them in `layer`. `delta` in seconds; `ar` keeps the real world behind the scene. */
  render(binding: XRBinding, layer: XRProjectionLayer, viewer: XRViewerPose, delta: number, ar: boolean): void {
    const views = this.views,
      images = [];
    views.length = 0;
    for (let i = 0; i < viewer.views.length; i++) {
      const view = viewer.views[i],
        image = binding.getViewSubImage(layer, view),
        eye = this.eye(i);
      this.place(eye, view, binding.projection?.(view) ?? view.projectionMatrix);
      this.size(eye, image.viewport.width, image.viewport.height);
      eye.view.clear = ar ? { color: '#000000' } : undefined;
      views.push(eye.view);
      images.push(image);
    }
    this.options.delta = delta;
    this.engine.render(this.options);
    const encoder = this.device.createCommandEncoder({ label: 'XR eyes' });
    for (let i = 0; i < images.length; i++) {
      const image = images[i],
        eye = this.eyes[i],
        { x, y, width, height } = image.viewport,
        descriptor = image.getViewDescriptor(),
        depthTexture = image.depthStencilTexture;
      if (depthTexture && depthTexture.format !== 'depth24plus')
        throw margoError('unsupported', `The XR layer's depth is ${depthTexture.format}; create the layer with depth24plus`);
      this.build(image.colorTexture.format, ar, !!depthTexture);
      const pipelines = this.pipelines!;
      this.offset[0] = x;
      this.offset[1] = y;
      this.device.queue.writeBuffer(eye.uniform, 0, this.offset);
      eye.colorGroup ??= this.device.createBindGroup({
        layout: pipelines.color.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: eye.color!.createView() },
          { binding: 1, resource: eye.depth!.createView({ aspect: 'depth-only' }) },
          { binding: 2, resource: { buffer: eye.uniform } },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          // Load, not clear: a clear covers the whole texture, and two eyes may share one texture at two viewports. The
          // triangle writes every pixel of this eye's viewport.
          { view: image.colorTexture.createView(descriptor), loadOp: 'load', storeOp: 'store' },
        ],
      });
      pass.setViewport(x, y, width, height, 0, 1);
      pass.setPipeline(pipelines.color);
      pass.setBindGroup(0, eye.colorGroup);
      pass.draw(3);
      pass.end();
      if (!depthTexture || !pipelines.depth) continue;
      const depth = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depthTexture.createView(descriptor),
          depthLoadOp: 'load',
          depthStoreOp: 'store',
        },
      });
      depth.setViewport(x, y, width, height, 0, 1);
      depth.setPipeline(pipelines.depth);
      depth.setBindGroup(0, eye.colorGroup);
      depth.draw(3);
      depth.end();
    }
    this.device.queue.submit([encoder.finish()]);
    binding.present?.(layer);
  }

  /** Frees the eyes' textures and buffers; the engine and its device stay. */
  dispose(): void {
    for (const eye of this.eyes) {
      eye.color?.destroy();
      eye.depth?.destroy();
      eye.uniform.destroy();
    }
    this.eyes.length = 0;
    this.views.length = 0;
    this.pipelines = undefined;
  }
}
