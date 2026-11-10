/// <reference lib="esnext.disposable" preserve="true" />
// Clean room: off-axis stereo geometry, Dubois (2001/2009) colour projection, pixel interleaving.
import type { EngineKernel } from '@margoengine/core';
import { Camera, engineRuntime, type RenderView, type Vec3 } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { fullscreen, group, render } from '../../shared/gpu.js';
import { getCameraLayers } from './layers.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };

/** Non-XR stereo packing. Left eye is first unless swapEyes is set. */
export type StereoMode = 'side-by-side' | 'top-bottom' | 'anaglyph' | 'parallax-barrier';
/** Geometry of the two parallel eyes. Distances use the scene's world units (normally metres). */
export interface StereoRigOptions {
  /** Interocular distance, >= 0. Default 0.064 m. */
  eyeSeparation?: number;
  /** Zero-parallax distance, > 0 or Infinity. Default distance to the camera target. */
  focusDistance?: number;
}
/** Two off-axis cameras. No toe-in, vertical disparity or changes to the source camera's pose/projection. */
export class StereoRig {
  /** Left eye camera, reusable in engine views. */
  readonly left = new Camera();
  /** Right eye camera, reusable in engine views. */
  readonly right = new Camera();
  /** Mutable eye geometry; validated on update. */
  readonly options: StereoRigOptions;
  constructor(options: StereoRigOptions = {}) {
    this.options = { ...options };
  }
  /** Refresh the eyes from a camera. Aspect may be read lazily after the engine has resized its canvas. */
  update(source: Camera, aspect: number | (() => number) = 1): void {
    const ratio = () => (typeof aspect === 'function' ? aspect() : aspect);
    source.update(ratio(), true);
    const p = source.position,
      t = source.target,
      up = source.up,
      back = [p[0] - t[0], p[1] - t[1], p[2] - t[2]],
      distance = Math.hypot(...back),
      right = [up[1] * back[2] - up[2] * back[1], up[2] * back[0] - up[0] * back[2], up[0] * back[1] - up[1] * back[0]],
      norm = Math.hypot(...right),
      separation = this.options.eyeSeparation ?? 0.064,
      focus = this.options.focusDistance ?? distance;
    if (!Number.isFinite(separation) || separation < 0 || !(focus > 0))
      throw new RangeError('Invalid stereo geometry; pass finite eyeSeparation >= 0 and focusDistance > 0 or Infinity');
    for (const [eye, sign] of [
      [this.left, -1],
      [this.right, 1],
    ] as const) {
      const offset = (sign * separation) / 2,
        shift = right.map((v) => (v / norm) * offset);
      eye.position = p.map((v, i) => v + shift[i]) as unknown as Vec3;
      eye.target = t.map((v, i) => v + shift[i]) as unknown as Vec3;
      eye.up = up;
      eye.fov = source.fov;
      eye.near = source.near;
      eye.far = source.far;
      eye.project = (out, _aspect, webgpu) => {
        const a = ratio();
        if (!Number.isFinite(a) || a <= 0) throw new RangeError('Invalid stereo aspect; pass a finite aspect > 0');
        if (source.project) source.project(out, a, webgpu);
        else {
          const f = 1 / Math.tan((source.fov * Math.PI) / 360),
            n = source.near,
            z = source.far,
            d = n - z;
          out[0] = f / a;
          out[5] = f;
          out[10] = webgpu ? -n / d : (z + n) / d;
          out[11] = -1;
          out[14] = webgpu ? (-z * n) / d : (2 * z * n) / d;
        }
        if (out[11] === 0)
          out[12] += out[0] * offset; // Parallel projection has no binocular depth disparity.
        else out[8] -= (out[0] * offset) / focus;
      };
    }
  }
}

/** Stereo renderer settings. Update options before render; the engine's normal scene passes run for each eye. */
export interface StereoOutputOptions extends StereoRigOptions {
  /** Default 'side-by-side'. */
  mode?: StereoMode;
  /** Source camera. Default engine.camera. */
  camera?: Camera;
  /** Scene to render. Default engine.scene. */
  scene?: RenderView['scene'];
  /** Layer mask for both eyes. Default the source camera's mask. */
  layers?: number;
  /** Reverse the eyes for crossed viewing or different display wiring. Default false. */
  swapEyes?: boolean;
  /** Interleave columns (default) or rows for parallax-barrier output. Physical drawing-buffer pixels. */
  barrierAxis?: 'columns' | 'rows';
  /** Which stripe parity contains the left eye: 0 (default) or 1. */
  barrierPhase?: 0 | 1;
}

const MODES: StereoMode[] = ['side-by-side', 'top-bottom', 'anaglyph', 'parallax-barrier'];
const SHADER = /* wgsl */ `${fullscreen}
@group(0) @binding(0) var leftEye:texture_2d<f32>;
@group(0) @binding(1) var rightEye:texture_2d<f32>;
@group(0) @binding(2) var linearSampler:sampler;
@group(0) @binding(3) var<uniform> settings:array<vec4f,2>;
fn linear(c:vec3f)->vec3f{return select(pow((c+0.055)/1.055,vec3f(2.4)),c/12.92,c<=vec3f(0.04045));}
fn srgb(c:vec3f)->vec3f {let x=clamp(c,vec3f(0),vec3f(1));return select(1.055*pow(x,vec3f(1.0/2.4))-0.055,12.92*x,x<=vec3f(0.0031308));}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let mode=settings[0].z; var uv=i.uv;var eye=0.0;
 if(mode<0.5){eye=select(0.0,1.0,uv.x>=0.5);uv.x=fract(uv.x*2.0);}
 else if(mode<1.5){eye=select(0.0,1.0,uv.y>=0.5);uv.y=fract(uv.y*2.0);}
 else if(mode>2.5){let stripe=select(i.position.x,i.position.y,settings[1].x>0.5);eye=f32((u32(stripe)+u32(settings[1].y))%2u);}
 var l=textureSampleLevel(leftEye,linearSampler,uv,0.0);var r=textureSampleLevel(rightEye,linearSampler,uv,0.0);
 if(settings[0].w>0.5){let hold=l;l=r;r=hold;}
 if(mode>1.5&&mode<2.5){
  let a=linear(l.rgb);let b=linear(r.rgb);
  let lc=vec3f(dot(a,vec3f(0.437,0.449,0.164)),dot(a,vec3f(-0.062,-0.062,-0.024)),dot(a,vec3f(-0.048,-0.050,-0.017)));
  let rc=vec3f(dot(b,vec3f(-0.011,-0.032,-0.007)),dot(b,vec3f(0.377,0.761,0.009)),dot(b,vec3f(-0.026,-0.093,1.234)));
  return vec4f(srgb(lc+rc),max(l.a,r.a));
 }
 return select(l,r,eye>0.5);
}`;

interface OutputState {
  device: GPUDevice;
  width: number;
  height: number;
  format: GPUTextureFormat;
  left: GPUTexture;
  right: GPUTexture;
  uniform: GPUBuffer;
  pipeline: GPURenderPipeline;
  bindings: GPUBindGroup;
}

/** Replaces the application's engine.render call. Two scene draws and one packing pass, with no XR session. */
export class StereoOutput {
  /** Creates stereo output for the application's frame loop. Defaults match the constructor. */
  static attach(engine: EngineKernel, options: StereoOutputOptions = {}): StereoOutput {
    return new StereoOutput(engine, options);
  }
  /** Mutable settings, validated on render. */
  readonly options: StereoOutputOptions;
  /** The eye cameras, also usable for picking or custom view layouts. */
  readonly rig: StereoRig;
  private state?: OutputState;
  private disposed = false;
  constructor(
    private readonly engine: EngineKernel,
    options: StereoOutputOptions = {},
  ) {
    this.options = { ...options };
    this.rig = new StereoRig(this.options);
  }
  /** Render once; animation/plugin updates happen once for the pair. Use from your application's frame loop. */
  render(delta = 0): void {
    if (this.disposed) throw new MargoError('disposed', 'Stereo output is disposed; create another StereoOutput');
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Invalid stereo delta; pass finite seconds >= 0');
    const engine = this.engine,
      runtime = engineRuntime(engine),
      device = runtime.gpu,
      { mode = 'side-by-side', swapEyes = false, barrierAxis = 'columns', barrierPhase = 0 } = this.options,
      index = MODES.indexOf(mode);
    if (
      index < 0 ||
      !['columns', 'rows'].includes(barrierAxis) ||
      ![0, 1].includes(barrierPhase) ||
      typeof swapEyes !== 'boolean'
    )
      throw new TypeError(
        'Invalid stereo packing; use a supported mode, columns or rows, parity 0 or 1 and boolean swapEyes',
      );
    if (engine.backend !== 'webgpu' || !device)
      throw new MargoError('unsupported', 'Stereo output needs WebGPU or the WebGL2 compatibility layer');
    const canvas = engine.canvas,
      width = Math.max(1, Math.ceil(canvas.width / (index === 0 ? 2 : 1))),
      height = Math.max(1, Math.ceil(canvas.height / (index === 1 ? 2 : 1))),
      format = runtime.renderTarget!.format;
    const state = this.ensure(device, width, height, format),
      camera = this.options.camera ?? engine.camera;
    camera.advance(delta);
    Object.assign(this.rig.options, {
      eyeSeparation: this.options.eyeSeparation,
      focusDistance: this.options.focusDistance,
    });
    this.rig.update(camera, () => (canvas.width / canvas.height) * (index === 0 ? 0.5 : index === 1 ? 2 : 1));
    const scene = this.options.scene,
      layers = this.options.layers ?? getCameraLayers(camera);
    engine.render({
      delta,
      views: [
        {
          id: 'stereo:left',
          camera: this.rig.left,
          viewport: [0, 0, 1, 1],
          target: { color: state.left },
          scene,
          layers,
        },
        {
          id: 'stereo:right',
          camera: this.rig.right,
          viewport: [0, 0, 1, 1],
          target: { color: state.right },
          scene,
          layers,
        },
      ],
    });
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context)
      throw new MargoError('state', 'Stereo output needs the engine canvas context; create a WebGPU engine first');
    device.queue.writeBuffer(
      state.uniform,
      0,
      new Float32Array([
        canvas.width,
        canvas.height,
        index,
        swapEyes ? 1 : 0,
        barrierAxis === 'rows' ? 1 : 0,
        barrierPhase,
        0,
        0,
      ]),
    );
    const encoder = device.createCommandEncoder();
    // view-state: the final packing pass owns the entire canvas and samples the two completed eye views.
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(state.pipeline);
    pass.setBindGroup(0, state.bindings);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
  private ensure(device: GPUDevice, width: number, height: number, format: GPUTextureFormat): OutputState {
    if (
      this.state?.device === device &&
      this.state.width === width &&
      this.state.height === height &&
      this.state.format === format
    )
      return this.state;
    this.release();
    const textures: GPUTexture[] = [];
    let uniform: GPUBuffer | undefined;
    try {
      for (let i = 0; i < 2; i++)
        textures.push(
          device.createTexture({
            size: [width, height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          }),
        );
      uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const pipeline = render(device, SHADER, format),
        [left, right] = textures,
        bindings = group(device, pipeline, [
          left.createView(),
          right.createView(),
          device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
          { buffer: uniform },
        ]);
      return (this.state = { device, width, height, format, left, right, uniform, pipeline, bindings });
    } catch (error) {
      textures.forEach((t) => t.destroy());
      uniform?.destroy();
      throw error;
    }
  }
  private release(): void {
    this.state?.left.destroy();
    this.state?.right.destroy();
    this.state?.uniform.destroy();
    this.state = undefined;
  }
  /** Release eye textures and uniforms. Safe to call more than once. */
  dispose(): void {
    this.disposed = true;
    this.release();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
