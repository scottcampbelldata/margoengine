/// <reference lib="esnext.disposable" preserve="true" />
// Clean room: the four-view layout of a Pepper's ghost pyramid display, from public descriptions only (Pepper 1890,
// patent WO2017196399A1, University of Arizona POPtics notes; see the README). Each pyramid face is a 45-degree
// half-mirror over one wedge of the screen, so a screen point farther from the centre is seen higher up and the
// reflection mirrors the picture: by default each view is mirrored with its top pointing away from the centre.
import type { EngineKernel } from '@margoengine/core';
import { Camera, engineRuntime, type RenderView, type Vec3 } from '@margoengine/core/extension';
import { hexColor } from '@margoengine/math/color';
import { MargoError } from '@margoengine/math/errors';
import { fullscreen, group, render } from '../../shared/gpu.js';
import { getCameraLayers } from './layers.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };

const HELP = '; see https://margoengine.com/errors#camera-hologram';
/** A side of the target. front sits in the bottom slot, back in the top, left and right in their own slots. */
export type HologramSide = 'front' | 'back' | 'left' | 'right';
/** How one view is laid on the screen. */
export interface HologramViewOrientation {
  /** Counter-clockwise turn of the picture in degrees: 0 keeps its top up, 90 turns its top to the left. */
  rotation?: 0 | 90 | 180 | 270;
  /** Mirror the picture left to right before the turn, as a pyramid face's reflection needs. */
  mirror?: boolean;
}
/** Default orientations: every view mirrored, its top pointing away from the screen centre (screen-down pyramid). */
export const HOLOGRAM_VIEWS: Readonly<Record<HologramSide, Readonly<Required<HologramViewOrientation>>>> =
  Object.freeze({
    front: Object.freeze({ rotation: 180 as const, mirror: true }),
    back: Object.freeze({ rotation: 0 as const, mirror: true }),
    left: Object.freeze({ rotation: 90 as const, mirror: true }),
    right: Object.freeze({ rotation: 270 as const, mirror: true }),
  });
const SIDES: HologramSide[] = ['front', 'back', 'left', 'right'];

/** Camera geometry of the four views. Distances use world units (normally metres). */
export interface HologramRigOptions {
  /** Distance from the target to each camera, > 0. Default the source camera's distance to its target. */
  distance?: number;
}
/** Four cameras around the source camera's target, a quarter turn apart about its up axis. */
export class HologramRig {
  /** Looks at the target from the source camera's side. */
  readonly front = new Camera();
  /** Looks from the opposite side. */
  readonly back = new Camera();
  /** Looks from the source camera's left. */
  readonly left = new Camera();
  /** Looks from the source camera's right. */
  readonly right = new Camera();
  /** Mutable geometry; validated on update. */
  readonly options: HologramRigOptions;
  constructor(options: HologramRigOptions = {}) {
    this.options = { ...options };
  }
  /** Place the four cameras from a source camera. Its pose and projection are not changed; views are square. */
  update(source: Camera): void {
    source.update(1, true);
    const p = source.position,
      t = source.target,
      up = source.up,
      u = Math.hypot(...up),
      n = up.map((v) => v / u),
      back = [p[0] - t[0], p[1] - t[1], p[2] - t[2]],
      along = back[0] * n[0] + back[1] * n[1] + back[2] * n[2],
      // The horizontal part of the view direction; the cameras keep the source camera's height above the target.
      flat = back.map((v, i) => v - along * n[i]),
      length = Math.hypot(...flat),
      distance = this.options.distance ?? Math.hypot(...back);
    if (!(length > 1e-9 * Math.hypot(...back)))
      throw new MargoError(
        'state',
        'Hologram source camera looks along its up axis; tilt it or change camera.up' + HELP,
      );
    if (!Number.isFinite(distance) || distance <= 0)
      throw new RangeError('Invalid hologram distance; pass a finite distance > 0' + HELP);
    const f = flat.map((v) => v / length),
      r = [n[1] * f[2] - n[2] * f[1], n[2] * f[0] - n[0] * f[2], n[0] * f[1] - n[1] * f[0]],
      scale = distance / Math.hypot(...back),
      height = along * scale,
      reach = length * scale,
      dirs: Record<HologramSide, number[]> = { front: f, back: f.map((v) => -v), right: r, left: r.map((v) => -v) };
    for (const side of SIDES) {
      const camera = this[side],
        d = dirs[side];
      camera.position = t.map((v, i) => v + d[i] * reach + n[i] * height) as unknown as Vec3;
      camera.target = [t[0], t[1], t[2]];
      camera.up = up;
      camera.fov = source.fov;
      camera.near = source.near;
      camera.far = source.far;
      camera.project = source.project && ((out, _aspect, webgpu) => source.project!(out, 1, webgpu));
    }
  }
}

/** Four-view output settings. Update them before render. */
export interface HologramOutputOptions extends HologramRigOptions {
  /** Source camera: its target is the centre and its side is the front. Default engine.camera. */
  camera?: Camera;
  /** Scene to render. Default engine.scene. */
  scene?: RenderView['scene'];
  /** Layer mask for all four views. Default the source camera's mask. */
  layers?: number;
  /**
   * Side of the empty centre square, as a fraction of the canvas's smaller side, in [0, 1). Default 0.2. Each view is
   * (1 - gap) / 2 across; below 1/3 the views meet along the diagonals and each is cut to its wedge, like a face.
   */
  gap?: number;
  /** Per-side orientation; missing fields keep {@link HOLOGRAM_VIEWS}. */
  views?: Partial<Record<HologramSide, HologramViewOrientation>>;
  /** Clear colour of each view, `#rgb` or `#rrggbb`, or false for the scene's background. Default '#000000'. */
  background?: string | false;
}

// Bindings 0-3: the front, back, left and right pictures. settings[0] = canvas width, height, gap, view size;
// settings[1] = quarter turns per side; settings[2] = mirror per side; settings[3].x = half a texel of a view.
// Each canvas pixel picks the wedge it lies in, finds its place in that side's square slot, undoes the turn and
// mirror and reads the picture; everything outside a slot is black, which a pyramid face does not reflect.
const SHADER = /* wgsl */ `${fullscreen}
@group(0) @binding(0) var front:texture_2d<f32>;
@group(0) @binding(1) var back:texture_2d<f32>;
@group(0) @binding(2) var left:texture_2d<f32>;
@group(0) @binding(3) var right:texture_2d<f32>;
@group(0) @binding(4) var linearSampler:sampler;
@group(0) @binding(5) var<uniform> settings:array<vec4f,4>;
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let size=settings[0].xy;let g=settings[0].z;let v=settings[0].w;
 let d=(i.position.xy-size*0.5)/min(size.x,size.y);
 var side=0u;var s=vec2f(0);
 if(abs(d.y)>=abs(d.x)){
  if(d.y>0.0){side=0u;s=vec2f(d.x+v*0.5,d.y-g*0.5)/v;}else{side=1u;s=vec2f(d.x+v*0.5,d.y+g*0.5+v)/v;}
 } else {
  if(d.x<0.0){side=2u;s=vec2f(d.x+g*0.5+v,d.y+v*0.5)/v;}else{side=3u;s=vec2f(d.x-g*0.5,d.y+v*0.5)/v;}
 }
 if(any(s<vec2f(0))||any(s>vec2f(1))){return vec4f(0,0,0,1);}
 var c=s-0.5;
 for(var k=0u;k<u32(settings[1][side]+0.5);k++){c=vec2f(-c.y,c.x);}
 if(settings[2][side]>0.5){c.x=-c.x;}
 let q=clamp(c+0.5,vec2f(settings[3].x),vec2f(1.0-settings[3].x));
 let a=textureSampleLevel(front,linearSampler,q,0.0);let b=textureSampleLevel(back,linearSampler,q,0.0);
 let l=textureSampleLevel(left,linearSampler,q,0.0);let r=textureSampleLevel(right,linearSampler,q,0.0);
 if(side==0u){return a;} if(side==1u){return b;} if(side==2u){return l;} return r;
}`;

interface OutputState {
  device: GPUDevice;
  side: number;
  format: GPUTextureFormat;
  textures: GPUTexture[];
  uniform: GPUBuffer;
  pipeline: GPURenderPipeline;
  bindings: GPUBindGroup;
}

/** Replaces the application's engine.render call: four square scene views and one layout pass onto the canvas. */
export class HologramOutput {
  /** Creates four-view output for the application's frame loop. Same as the constructor. */
  static attach(engine: EngineKernel, options: HologramOutputOptions = {}): HologramOutput {
    return new HologramOutput(engine, options);
  }
  /** Mutable settings, validated on render. */
  readonly options: HologramOutputOptions;
  /** The four cameras, also usable for picking or custom layouts. */
  readonly rig: HologramRig;
  private state?: OutputState;
  private disposed = false;
  constructor(
    private readonly engine: EngineKernel,
    options: HologramOutputOptions = {},
  ) {
    this.options = { ...options };
    this.rig = new HologramRig(this.options);
  }
  /** The resolved orientation of every side, after validation. */
  orientations(): Record<HologramSide, Required<HologramViewOrientation>> {
    const views = this.options.views ?? {},
      out = {} as Record<HologramSide, Required<HologramViewOrientation>>;
    for (const key of Object.keys(views))
      if (!SIDES.includes(key as HologramSide))
        throw new TypeError(`Unknown hologram side ${key}; use front, back, left or right` + HELP);
    for (const side of SIDES) {
      const { rotation = HOLOGRAM_VIEWS[side].rotation, mirror = HOLOGRAM_VIEWS[side].mirror } = views[side] ?? {};
      if (![0, 90, 180, 270].includes(rotation) || typeof mirror !== 'boolean')
        throw new TypeError(
          'Invalid hologram view orientation; use rotation 0, 90, 180 or 270 and boolean mirror' + HELP,
        );
      out[side] = { rotation, mirror };
    }
    return out;
  }
  /** Render once; animation and plugin updates happen once for the four views. Use from your frame loop. */
  render(delta = 0): void {
    if (this.disposed)
      throw new MargoError('disposed', 'Hologram output is disposed; create another HologramOutput' + HELP);
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid hologram delta; pass finite seconds >= 0' + HELP);
    const { gap = 0.2, background = '#000000' } = this.options;
    if (!Number.isFinite(gap) || gap < 0 || gap >= 1)
      throw new RangeError('Invalid hologram gap; pass a fraction in [0, 1)' + HELP);
    if (background !== false && (String(background).length > 7 || !hexColor(String(background))))
      throw new TypeError('Invalid hologram background; pass #rgb, #rrggbb or false' + HELP);
    const orientation = this.orientations(),
      engine = this.engine,
      runtime = engineRuntime(engine),
      device = runtime.gpu;
    if (engine.backend !== 'webgpu' || !device)
      throw new MargoError('unsupported', 'Hologram output needs WebGPU or the WebGL2 compatibility layer' + HELP);
    const canvas = engine.canvas,
      view = (1 - gap) / 2,
      side = Math.max(1, Math.ceil(view * Math.min(canvas.width, canvas.height))),
      state = this.ensure(device, side, runtime.renderTarget!.format),
      camera = this.options.camera ?? engine.camera;
    camera.advance(delta);
    this.rig.options.distance = this.options.distance;
    this.rig.update(camera);
    const scene = this.options.scene,
      layers = this.options.layers ?? getCameraLayers(camera),
      clear = background === false ? undefined : { color: background };
    engine.render({
      delta,
      views: SIDES.map((name, i) => ({
        id: 'hologram:' + name,
        camera: this.rig[name],
        viewport: [0, 0, 1, 1] as const,
        target: { color: state.textures[i] },
        scene,
        layers,
        clear,
      })),
    });
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context)
      throw new MargoError(
        'state',
        'Hologram output needs the engine canvas context; create a WebGPU engine first' + HELP,
      );
    device.queue.writeBuffer(
      state.uniform,
      0,
      new Float32Array([
        canvas.width,
        canvas.height,
        gap,
        view,
        ...SIDES.map((s) => orientation[s].rotation / 90),
        ...SIDES.map((s) => (orientation[s].mirror ? 1 : 0)),
        0.5 / side,
        0,
        0,
        0,
      ]),
    );
    const encoder = device.createCommandEncoder();
    // view-state: the layout pass owns the entire canvas and samples the four completed views.
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(state.pipeline);
    pass.setBindGroup(0, state.bindings);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
  private ensure(device: GPUDevice, side: number, format: GPUTextureFormat): OutputState {
    if (this.state?.device === device && this.state.side === side && this.state.format === format) return this.state;
    this.release();
    const textures: GPUTexture[] = [];
    let uniform: GPUBuffer | undefined;
    try {
      for (let i = 0; i < 4; i++)
        textures.push(
          device.createTexture({
            size: [side, side],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          }),
        );
      uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const pipeline = render(device, SHADER, format),
        bindings = group(device, pipeline, [
          ...textures.map((t) => t.createView()),
          device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
          { buffer: uniform },
        ]);
      return (this.state = { device, side, format, textures, uniform, pipeline, bindings });
    } catch (error) {
      textures.forEach((t) => t.destroy());
      uniform?.destroy();
      throw error;
    }
  }
  private release(): void {
    this.state?.textures.forEach((t) => t.destroy());
    this.state?.uniform.destroy();
    this.state = undefined;
  }
  /** Release the four view textures and uniforms. Safe to call more than once. */
  dispose(): void {
    this.disposed = true;
    this.release();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
