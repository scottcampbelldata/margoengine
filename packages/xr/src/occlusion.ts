// Real-world occlusion of the scene in AR, from the WebXR Depth Sensing Module (immersive-web.github.io/depth-sensing,
// Editor's Draft 2026-08-25: XRCPUDepthInformation, XRGPUDepthInformation, normDepthBufferFromNormView and the
// sensor's XRViewGeometry). The use case is the dense-depth occlusion of R. Du et al., "DepthLab: Real-time 3D
// Interaction with Depth Maps for Mobile Augmented Reality", UIST 2020, pp. 829-843: virtual content behind a real
// surface is hidden. The test here is Margo's own: each covered sample of the eye's scene depth is rebuilt as a
// view-space point, carried into the depth sensor's view (its pose and projection, so a sensor that is not aligned with
// the eye is reprojected exactly for the drawn surface), and compared there with the real depth at that point. The
// result ramps linearly across `feather` metres around equal depth, averaged over the pixel's covered samples, and
// scales the premultiplied eye colour by one minus it, so the camera image shows through. A pixel with colour but no
// covered sample (the antialiased fringe of a line or edge) takes the average of its 3 by 3 neighbours' first samples.
import type { XREyeTarget } from './eye-target.js';
import type { XRFrameState, XRGPUDepthLike, XRNativeFrame, XRNativeSession, XRView } from './types.js';
import type { XRDepthLike } from './ar.js';
import { margoError } from '../../shared/errors.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** What {@link AROcclusion.create} needs of an `XR`: its session, frames and eyes. */
export interface AROcclusionHost {
  readonly session: XRNativeSession | null;
  onFrame(callback: (state: XRFrameState) => void): () => void;
  onEye(callback: (target: XREyeTarget) => void): () => void;
}
/** Options for {@link AROcclusion.create}. */
export interface AROcclusionOptions {
  /** Metres over which a surface fades from shown to hidden around equal depth; 0 is a hard edge. Default 0.05. */
  feather?: number;
  /** Start on. Default true. */
  enabled?: boolean;
}
/** CPU depth with the data buffer the Depth Sensing Module adds to XRDepthInformation. */
type CPUDepth = XRDepthLike & { readonly data: ArrayBuffer };
type Real = 'r32float' | 'r16uint';

/** WGSL of the occlusion pass for one real-depth format and scene sample count. */
export function occlusionShader(real: Real, samples: number): string {
  const sceneType = samples > 1 ? 'texture_depth_multisampled_2d' : 'texture_depth_2d',
    realType = real === 'r16uint' ? 'texture_2d<u32>' : 'texture_2d<f32>';
  return `struct U { m: mat4x4f, n: mat4x4f, p: vec4f, z: vec4f, v: vec4f, o: vec4f, s: vec4f }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var scene: ${sceneType};
@group(0) @binding(2) var real: ${realType};
@vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3))[i], 0, 1);
}
fn hidden(f: vec2f, z: f32) -> f32 {
  let e = (f - u.v.xy) / u.v.zw;
  let ndc = vec2f(2.0 * e.x - 1.0, 1.0 - 2.0 * e.y);
  let w = u.z.y / (z + u.z.x);
  let c = u.m * vec4f((ndc.x + u.p.z) * w / u.p.x, (ndc.y + u.p.w) * w / u.p.y, -w, 1.0);
  if (c.w <= 0.0) { return 0.0; }
  let b = u.n * vec4f(0.5 + 0.5 * c.x / c.w, 0.5 - 0.5 * c.y / c.w, 0.0, 1.0);
  let t = clamp(vec2i(floor(b.xy * u.s.xy)), vec2i(0), vec2i(u.s.xy) - vec2i(1));
  let d = f32(textureLoad(real, t, 0).r) * u.o.z;
  if (d <= 0.0) { return 0.0; }
  if (u.z.w > 0.0) { return clamp((c.w - d) / u.z.w + 0.5, 0.0, 1.0); }
  return select(0.0, 1.0, c.w > d);
}
fn drawn(z: f32) -> bool {
  return z != u.z.z && u.z.y / (z + u.z.x) > 0.0;
}
@fragment fn fragment(@builtin(position) f: vec4f) -> @location(0) vec4f {
  let q = vec2i(f.xy - u.v.xy + u.o.xy);
  var sum = 0.0;
  var count = 0.0;
  for (var i = 0; i < ${samples}; i++) {
    let z = textureLoad(scene, q, ${samples > 1 ? 'i' : '0'});
    if (drawn(z)) { sum += hidden(f.xy, z); count += 1.0; }
  }
  if (count == 0.0) {
    let low = vec2i(u.o.xy);
    let high = low + vec2i(u.v.zw) - vec2i(1);
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let n = clamp(q + vec2i(dx, dy), low, high);
        let z = textureLoad(scene, n, 0);
        if (drawn(z)) { sum += hidden(f.xy + vec2f(n - q), z); count += 1.0; }
      }
    }
  }
  return vec4f(0.0, 0.0, 0.0, select(0.0, sum / count, count > 0.0));
}
`;
}

/** 4x4 column-major product a times b into out. */
function multiply(out: Float32Array, offset: number, a: ArrayLike<number>, b: ArrayLike<number>): void {
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[offset + c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
}

/**
 * Hides the scene where the real world is in front of it, in an AR session started with the 'depth-sensing' feature,
 * from CPU-optimized depth (uploaded each frame) or GPU-optimized depth (read where the browser leaves it). Works on
 * both XR routes and on the WebGL2 layer's CPU depth.
 * @throws MargoError 'state' without a session, 'unsupported' without depth sensing or with GPU 'luminance-alpha' depth.
 */
export class AROcclusion {
  private feather_: number;
  /** False skips the pass; the scene draws over the real world as before. */
  enabled: boolean;
  private frame: XRNativeFrame | null = null;
  private readonly stops: Array<() => void>;
  private readonly eyes: Array<{ uniform: GPUBuffer; data: Float32Array; texture?: GPUTexture }> = [];
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private device?: GPUDevice;
  private disposed = false;
  private constructor(
    private readonly session: XRNativeSession & { depthUsage?: string; depthDataFormat?: string },
    host: AROcclusionHost,
    options: AROcclusionOptions,
  ) {
    this.feather_ = 0;
    this.feather = options.feather ?? 0.05;
    this.enabled = options.enabled ?? true;
    this.stops = [
      host.onFrame((state) => {
        this.frame = state.frame;
      }),
      host.onEye((target) => this.draw(target)),
    ];
  }
  static create(xr: AROcclusionHost, options: AROcclusionOptions = {}): AROcclusion {
    const session = xr?.session as (XRNativeSession & { depthUsage?: string; depthDataFormat?: string }) | null;
    if (!session) throw margoError('state', 'AROcclusion needs an active XR session; await xr.requestSession first');
    if (session.enabledFeatures && !session.enabledFeatures.includes('depth-sensing'))
      throw margoError(
        'unsupported',
        "The XR session has no 'depth-sensing' feature; ask for it with init: {depthSensing}",
      );
    let usage: string | undefined, format: string | undefined;
    try {
      usage = session.depthUsage;
      format = session.depthDataFormat;
    } catch (cause) {
      throw Object.assign(
        margoError(
          'unsupported',
          'The XR session has no depth sensing; start it with init: {depthSensing: DEPTH_SENSING}',
        ),
        { cause },
      );
    }
    if (usage === 'gpu-optimized' && format === 'luminance-alpha')
      throw margoError(
        'unsupported',
        "GPU-optimized depth in 'luminance-alpha' cannot be read by WebGPU (Depth Sensing, XRGPUDepthInformation); ask for 'float32' or 'unsigned-short'",
      );
    return new AROcclusion(session, xr, options);
  }
  /** Metres over which a surface fades from shown to hidden around equal depth; 0 is a hard edge. */
  get feather(): number {
    return this.feather_;
  }
  set feather(value: number) {
    if (!(Number.isFinite(value) && value >= 0))
      throw new RangeError('AROcclusion feather is in metres, 0 or more; pass a number such as 0.05');
    this.feather_ = value;
  }
  /** This frame's depth for `view`: the GPU texture where the session keeps depth on the GPU, else the CPU data. */
  private information(target: XREyeTarget): { gpu?: XRGPUDepthLike; cpu?: CPUDepth } | null {
    if (this.session.depthUsage === 'gpu-optimized') {
      const gpu = target.binding?.getDepthInformation?.(target.view) ?? null;
      return gpu ? { gpu } : null;
    }
    const frame = this.frame as (XRNativeFrame & { getDepthInformation?(view: XRView): CPUDepth | null }) | null;
    const cpu = frame?.getDepthInformation?.(target.view) ?? null;
    return cpu ? { cpu } : null;
  }
  private draw(target: XREyeTarget): void {
    if (this.disposed || !this.enabled || !target.scene) return;
    const info = this.information(target);
    if (!info) return;
    const { device, encoder, image, view, scene } = target,
      depth = (info.gpu ?? info.cpu)!;
    if (this.device !== device) this.reset(device);
    let eye = this.eyes[target.index];
    if (!eye)
      this.eyes[target.index] = eye = {
        uniform: device.createBuffer({ size: 112 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        data: new Float32Array(112),
      };
    let realView: GPUTextureView, real: Real;
    if (info.gpu) {
      const format = info.gpu.texture.format;
      if (format !== 'r32float' && format !== 'r16uint')
        throw margoError(
          'unsupported',
          `GPU depth arrives as ${format}; start the session with dataFormatPreference ['float32', 'unsigned-short'] so it arrives as r32float or r16uint`,
        );
      real = format;
      realView = info.gpu.texture.createView(info.gpu.getViewDescriptor?.());
    } else {
      const cpu = info.cpu!;
      real = this.session.depthDataFormat === 'float32' ? 'r32float' : 'r16uint';
      const bytes = real === 'r32float' ? 4 : 2;
      if (cpu.data.byteLength < cpu.width * cpu.height * bytes)
        throw margoError(
          'unsupported',
          `CPU depth holds ${cpu.data.byteLength} bytes for ${cpu.width} by ${cpu.height} values of ${bytes} bytes; the session's depthDataFormat must match the data the browser gives (report it to the browser)`,
        );
      if (eye.texture?.width !== cpu.width || eye.texture.height !== cpu.height || eye.texture.format !== real) {
        eye.texture?.destroy();
        eye.texture = device.createTexture({
          size: [cpu.width, cpu.height],
          format: real,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          label: 'AR depth',
        });
      }
      // Row-major without padding (Depth Sensing, XRCPUDepthInformation data); luminance-alpha is the least
      // significant byte first, so it reads as one little-endian 16-bit integer, as unsigned-short does.
      device.queue.writeTexture({ texture: eye.texture }, cpu.data, { bytesPerRow: cpu.width * bytes }, [
        cpu.width,
        cpu.height,
      ]);
      realView = eye.texture.createView();
    }
    const samples = scene.texture.sampleCount,
      key = `${image.colorTexture.format} ${real} ${samples}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({ code: occlusionShader(real, samples), label: 'AR occlusion' });
      const blend = { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' } as const;
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [{ format: image.colorTexture.format, blend: { color: blend, alpha: blend } }],
        },
        label: 'AR occlusion',
      });
      this.pipelines.set(key, pipeline);
    }
    // m: the eye's view space into the sensor's clip space (sensor projection, sensor from reference, reference from
    // eye); the sensor geometry is the view's where the browser gives none (it is aligned).
    const data = eye.data,
      sensor = depth.transform ?? view.transform,
      p = scene.projection,
      box = image.viewport;
    multiply(data, 96, sensor.inverse.matrix, view.transform.matrix);
    multiply(data, 0, depth.projectionMatrix ?? view.projectionMatrix, data.subarray(96, 112));
    data.set(depth.normDepthBufferFromNormView.matrix, 16);
    data.set([p[0], p[5], p[8], p[9], p[10], p[14], scene.clear, this.feather_], 32);
    data.set([box.x, box.y, box.width, box.height, scene.origin[0], scene.origin[1], depth.rawValueToMeters, 0], 40);
    data.set([depth.width, depth.height, 0, 0], 48);
    device.queue.writeBuffer(eye.uniform, 0, data as Float32Array<ArrayBuffer>, 0, 52);
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: eye.uniform, size: 52 * 4 } },
        { binding: 1, resource: scene.texture.createView({ aspect: 'depth-only' }) },
        { binding: 2, resource: realView },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: image.colorTexture.createView(image.getViewDescriptor()), loadOp: 'load', storeOp: 'store' },
      ],
      label: 'AR occlusion',
    });
    pass.setViewport(box.x, box.y, box.width, box.height, 0, 1);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
  }
  private reset(device: GPUDevice): void {
    for (const eye of this.eyes) {
      eye.uniform.destroy();
      eye.texture?.destroy();
    }
    this.eyes.length = 0;
    this.pipelines.clear();
    this.device = device;
  }
  /** Stops the pass and frees its buffers and textures. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.stops) stop();
    this.reset(undefined!);
    this.frame = null;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
