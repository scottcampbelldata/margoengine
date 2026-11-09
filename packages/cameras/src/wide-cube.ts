/// <reference lib="esnext.disposable" preserve="true" />
// Wide-angle projections read from a cube capture, so a fisheye or a Panini reaches past what one rectilinear picture
// holds: 180 degrees across and beyond. Same published maths as ./panini.ts: Sharpless, Postle and German, "Pannini: A
// New Projection for Rendering Wide Angle Perspective Images" (Computational Aesthetics 2010), and the usual fisheye
// mappings r = f g(theta). Each output pixel becomes a direction, and the direction reads the cube.
import type { EngineKernel, Mesh } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext, Vec3 } from '@margoengine/core/extension';
import type { PostStack } from '@margoengine/post';
import { displayShader } from '../../shared/display.js';
import { margoError } from '../../shared/errors.js';
import { fullscreen, group, render } from '../../shared/gpu.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { GAIN, INVERSE, MODES, type WideAngleMode } from './wide-laws.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type WideContext = Extract<PassContext, { backend: 'webgpu' }>;

/** What {@link WideAngleCube} needs of a cube: a `CubeCamera` from `@margoengine/environment/cube-camera` fits. */
export interface WideCubeSource {
  /** Capture point, moved to the camera before each capture. */
  position: Vec3;
  /** `texture_cube<f32>` view holding linear light in the standard WebGPU face layout. */
  readonly view: GPUTextureView;
  /** Captures the next `faces` faces. */
  update(faces?: number): number;
  dispose(): void;
}

/** Options of {@link WideAngleCubeMap}. */
export interface WideAngleCubeMapOptions {
  /** Default 'equidistant'. The laws are those of `WideAngle`. */
  mode?: WideAngleMode;
  /** Degrees across the width of the picture. Default 180. Equidistant and equisolid reach 360, stereographic stops below 360, orthographic at 180, Panini below its own limit (below 360 at `distance` 1). */
  fov?: number;
  /** Panini compression d, 0 or more. Default 1. */
  distance?: number;
  /** Fisheye modes: true (default) leaves black past half of `fov` from the centre, a round picture; false fills the corners as far as the law reaches. */
  circle?: boolean;
}

/** Options of {@link WideAngleCube}. */
export interface WideAngleCubeOptions extends WideAngleCubeMapOptions {
  /** A cube you made and attached. `WideAngleCube.attach` makes one when this is left out, and disposes it with the effect. */
  cube?: WideCubeSource;
  /** Face edge in texels of the cube `attach` makes. Default 512. */
  size?: number;
  /** Faces captured before every engine frame, 0 to 6: fewer spreads the cost and lags the picture. 0 captures only on `capture()`. Default 6. */
  facesPerFrame?: number;
  /** Layer mask the cube `attach` makes draws. Default every layer. */
  layers?: number;
  /** Meshes the cube `attach` makes leaves out: the object the camera rides on, say. */
  exclude?: Iterable<Mesh>;
  /** False passes the plain picture through and captures nothing. Default true. Also `effect.enabled`. */
  enabled?: boolean;
}

const HALF_PI = Math.PI / 2;
const EPS = 1e-9;
// The widest angle from the centre Panini can show: past it the projection folds back (d > 1) or leaves the plane (d < 1).
const paniniReach = (d: number): number => Math.acos(d > 1 ? -1 / d : -d);
const REACH: Record<string, number> = {
  equidistant: Math.PI,
  equisolid: Math.PI,
  stereographic: Math.PI - 1e-6,
  orthographic: HALF_PI,
};

/**
 * The mapping between the projected picture (normalised, x right and y up, -1 to 1) and directions from the camera
 * (x right, y up, z back, as core's view space, so forward is [0, 0, -1]). The same maths runs in the shader; use it to
 * turn a pointer position on the picture into a ray, or to place overlays.
 */
export class WideAngleCubeMap {
  readonly mode: WideAngleMode;
  readonly distance: number;
  readonly fov: number;
  /** Largest angle from the centre shown, in radians; for Panini, across only. */
  readonly limit: number;
  /** Half extent of the output plane, across and up. */
  readonly halfWidth: number;
  readonly halfHeight: number;
  constructor(aspect: number, { mode = 'equidistant', fov = 180, distance = 1, circle = true }: WideAngleCubeMapOptions = {}) {
    if (!(mode in MODES))
      throw new RangeError(
        "Invalid wide angle mode; use 'panini', 'equidistant', 'equisolid', 'stereographic' or 'orthographic'",
      );
    if (!(distance >= 0 && distance < Infinity))
      throw new RangeError('Invalid wide angle distance; use a finite number from 0');
    if (!(aspect > 0 && aspect < Infinity)) throw new RangeError('Invalid wide angle aspect; use a number above 0');
    const half = (fov * Math.PI) / 360,
      reach = mode === 'panini' ? paniniReach(distance) - 1e-6 : REACH[mode];
    if (!(half > 0 && half <= reach))
      throw new RangeError(
        `Invalid wide angle fov ${fov}; ${mode} reaches ${Math.floor((reach * 360) / Math.PI)} degrees across`,
      );
    this.mode = mode;
    this.distance = distance;
    this.fov = fov;
    this.limit = mode === 'panini' || circle ? half : reach;
    this.halfWidth =
      mode === 'panini' ? ((distance + 1) * Math.sin(half)) / (distance + Math.cos(half)) : GAIN[mode](half);
    this.halfHeight = this.halfWidth / aspect;
  }
  /** Unit direction shown at output position (`u`, `v`), or null where the picture shows nothing. */
  toDirection(u: number, v: number): [number, number, number] | null {
    const px = u * this.halfWidth,
      py = v * this.halfHeight;
    if (this.mode === 'panini') {
      const d = this.distance,
        xp = px / (d + 1),
        a = (xp * d) / Math.sqrt(1 + xp * xp);
      if (Math.abs(a) > 1) return null;
      const phi = Math.atan(xp) + Math.asin(a);
      if (Math.abs(phi) > this.limit + EPS) return null;
      const cos = Math.cos(phi),
        t = py / ((d + 1) / (d + cos)),
        length = Math.hypot(1, t);
      return [Math.sin(phi) / length, t / length, -cos / length];
    }
    const r = Math.hypot(px, py),
      theta = INVERSE[this.mode](r);
    if (theta === null || theta > this.limit + EPS) return null;
    const k = r ? Math.sin(theta) / r : 0;
    return [px * k, py * k, -Math.cos(theta)];
  }
  /** Output position of direction ([`x`, `y`, `z`], any length), or null when the picture does not show it. */
  toOutput(x: number, y: number, z: number): [number, number] | null {
    let px: number, py: number;
    if (this.mode === 'panini') {
      const d = this.distance,
        phi = Math.atan2(x, -z),
        flat = Math.hypot(x, z);
      if (Math.abs(phi) > this.limit + EPS || !flat) return null;
      const s = (d + 1) / (d + Math.cos(phi));
      px = s * Math.sin(phi);
      py = (s * y) / flat;
    } else {
      const side = Math.hypot(x, y),
        theta = Math.atan2(side, -z);
      if (theta > this.limit + EPS) return null;
      const k = side ? GAIN[this.mode](theta) / side : 0;
      px = x * k;
      py = y * k;
    }
    const u = px / this.halfWidth,
      v = py / this.halfHeight;
    return Math.abs(u) <= 1 + EPS && Math.abs(v) <= 1 + EPS ? [u, v] : null;
  }
}

const wideShader = (hdr: boolean): string => `${fullscreen}${hdr ? '' : displayShader}
struct Wide {a:vec4f,b:vec4f,right:vec4f,up:vec4f,forward:vec4f}
@group(0) @binding(0) var<uniform> w:Wide;
@group(0) @binding(1) var frame:texture_2d<f32>;
@group(0) @binding(2) var cube:texture_cube<f32>;
@group(0) @binding(3) var smp:sampler;
fn shown(c:vec3f)->vec4f {return vec4f(${hdr ? 'c' : 'toDisplay(c)'},1);}
// a: mode (-1 passes the picture through), panini distance, largest angle shown; b: half width and height of the plane.
@fragment fn fragment(v:Vertex)->@location(0) vec4f {
 let mode=i32(w.a.x);
 if (mode<0) {return shown(textureSampleLevel(frame,smp,v.uv,0).rgb);}
 let p=(v.uv*2-1)*vec2f(1,-1)*w.b.xy;
 var dir=vec3f(0);
 if (mode==0) {
  let d=w.a.y;
  let xp=p.x/(d+1);
  let a=xp*d/sqrt(1+xp*xp);
  if (abs(a)>1) {return shown(vec3f(0));}
  let phi=atan(xp)+asin(a);
  if (abs(phi)>w.a.z+1e-6) {return shown(vec3f(0));}
  let c=cos(phi);
  dir=vec3f(sin(phi),p.y*(d+c)/(d+1),c);
 } else {
  let r=length(p);
  var theta=r;
  if (mode==2) {if (r>2) {return shown(vec3f(0));} theta=2*asin(r/2);}
  else if (mode==3) {theta=2*atan(r/2);}
  else if (mode==4) {if (r>1) {return shown(vec3f(0));} theta=asin(r);}
  if (theta>w.a.z+1e-6) {return shown(vec3f(0));}
  var side=vec2f(0);
  if (r>0) {side=p*(sin(theta)/r);}
  dir=vec3f(side,cos(theta));
 }
 let world=w.right.xyz*dir.x+w.up.xyz*dir.y+w.forward.xyz*dir.z;
 return shown(textureSampleLevel(cube,smp,world,0).rgb);
}`;

/**
 * Panini and fisheye projection read from a cube capture, as an HDR stage of `PostStack`: unlike `WideAngle` it is not
 * limited by one rectilinear picture, so it reaches 180 degrees across and past it (`fov`). The cube is captured at the
 * camera before each engine frame, six scene draws at `facesPerFrame` 6. Faces run the scene passes only, so HDR effects
 * ahead of this stage do not reach the picture; put those that should after it. The camera's position, target and `up`
 * set the view; its `fov` is not used. For frames you draw with `engine.render()`, call `capture()` before each.
 * @throws RangeError for an unknown `mode`, a negative `distance` or a `fov` the mode cannot reach; MargoError `'state'`
 * outside a PostStack or with no cube, `'unsupported'` on a WebGL engine, `'attached'` when joined twice, `'disposed'`
 * after `dispose()`.
 */
export class WideAngleCube implements EnginePlugin {
  readonly name = 'wide-angle-cube';
  private engine?: Engine;
  private stack?: PostStack;
  private cube?: WideCubeSource;
  private ownsCube = false;
  private stacked = false;
  private disposed = false;
  private stopFrames?: () => void;
  private uniform?: GPUBuffer;
  private sampler?: GPUSampler;
  private pipeline?: GPURenderPipeline;
  private key = '';
  private group?: GPUBindGroup;
  private input?: GPUTextureView;
  private cubeView?: GPUTextureView;
  private mapKey = '';
  private lastMap?: WideAngleCubeMap;
  private readonly values = new Float32Array(20);
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly descriptor: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  constructor(readonly options: WideAngleCubeOptions = {}) {
    this.cube = options.cube;
    this.facesPerFrame = options.facesPerFrame ?? 6;
    this.map(1);
  }
  /**
   * Runs a new WideAngleCube alone in its own PostStack with its own cube, all disposed with it (needs
   * `@margoengine/post` and `@margoengine/environment`). To combine it with other effects, attach a `CubeCamera`, pass it
   * as `cube` and put the effect in your own `PostStack`, ahead of the display effect.
   */
  static async attach(engine: EngineKernel, options: WideAngleCubeOptions = {}): Promise<WideAngleCube> {
    const [{ PostStack }, { CubeCamera }] = await Promise.all([
        import('@margoengine/post'),
        import('@margoengine/environment/cube-camera'),
      ]),
      effect = new WideAngleCube(options);
    if (!effect.cube) {
      effect.cube = CubeCamera.attach(engine, {
        size: options.size ?? 512,
        near: engine.camera.near,
        far: engine.camera.far,
        layers: options.layers,
        exclude: options.exclude,
      });
      effect.ownsCube = true;
    }
    try {
      effect.stack = PostStack.attach(engine, [effect]);
    } catch (error) {
      effect.dispose();
      throw error;
    }
    return effect;
  }
  /** Whether the picture is projected (mirrors `options.enabled`). */
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('WideAngleCube enabled must be a boolean; pass true or false');
    this.options.enabled = value;
  }
  /** Faces captured before every engine frame, 0 to 6. */
  facesPerFrame: number;
  /** The mapping for a view of `aspect`, with these options. */
  map(aspect: number): WideAngleCubeMap {
    const o = this.options,
      key = `${aspect}:${o.mode}:${o.fov}:${o.distance}:${o.circle}`;
    if (key !== this.mapKey || !this.lastMap) {
      this.lastMap = new WideAngleCubeMap(aspect, o);
      this.mapKey = key;
    }
    return this.lastMap;
  }
  /**
   * Moves the cube to the camera and captures `faces` faces (default all six). Runs by itself before every frame of
   * `engine.start`; call it before `engine.render()` otherwise. Not from inside a frame pass.
   * @throws MargoError `'state'` when not attached.
   */
  capture(faces = 6): void {
    if (!this.engine) throw margoError('state', 'WideAngleCube is not attached; add it to a PostStack first');
    const p = this.engine.camera.position;
    this.cube!.position = [p[0], p[1], p[2]];
    this.cube!.update(faces);
  }
  private joinStack(_host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw margoError('attached', 'WideAngleCube is already attached; create a new WideAngleCube');
    this.stacked = true;
    return { kind: 'hdr', render: (c, input, output) => this.draw(c, input, output) };
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'WideAngleCube is disposed; create a new WideAngleCube');
    if (!this.stacked)
      throw margoError(
        'state',
        'WideAngleCube runs inside a PostStack; use WideAngleCube.attach(engine) or add it to a PostStack',
      );
    if (!engine.gpu)
      throw margoError('unsupported', 'WideAngleCube requires WebGPU; it does not run on the WebGL2 fallback');
    if (!this.cube)
      throw margoError('state', 'WideAngleCube has no cube; use WideAngleCube.attach(engine) or pass a CubeCamera');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = engine.gpu.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.stopFrames ??= engine.onFrame(() => {
      if (this.enabled && this.facesPerFrame) this.capture(this.facesPerFrame);
    });
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  /** Removes the effect and releases its GPU resources, with the stack and the cube `attach` made. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopFrames?.();
    this.stopFrames = undefined;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.stack?.dispose();
    this.stack = undefined;
    if (this.ownsCube) this.cube?.dispose();
    this.cube = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  // The camera's axes in the world, as core's Camera.update builds them.
  private axes(v: Float32Array): void {
    const { position: p, target: t, up } = this.engine!.camera;
    let fx = t[0] - p[0],
      fy = t[1] - p[1],
      fz = t[2] - p[2];
    const length = Math.hypot(fx, fy, fz);
    fx /= length;
    fy /= length;
    fz /= length;
    let rx = fy * up[2] - fz * up[1],
      ry = fz * up[0] - fx * up[2],
      rz = fx * up[1] - fy * up[0];
    const side = Math.hypot(rx, ry, rz);
    rx /= side;
    ry /= side;
    rz /= side;
    v.set([rx, ry, rz, 0, ry * fz - rz * fy, rz * fx - rx * fz, rx * fy - ry * fx, 0, fx, fy, fz, 0], 8);
  }
  private draw(c: WideContext, input: GPUTextureView, output: StageOutput): void {
    const device = c.device,
      map = this.map(c.width / c.height),
      v = this.values;
    v[0] = this.enabled ? MODES[map.mode] : -1;
    v[1] = map.distance;
    v[2] = map.limit;
    v[4] = map.halfWidth;
    v[5] = map.halfHeight;
    this.axes(v);
    device.queue.writeBuffer(this.uniform!, 0, v);
    const pipeline = this.pipelineFor(device, output),
      view = this.cube!.view;
    if (this.input !== input || this.cubeView !== view || !this.group) {
      this.input = input;
      this.cubeView = view;
      this.group = group(device, pipeline, [{ buffer: this.uniform! }, input, view, this.sampler!]);
    }
    this.attachment.view = output.view;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.descriptor);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.group);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  // One pipeline per output kind; a new one drops the bind group that belonged to the old.
  private pipelineFor(device: GPUDevice, output: StageOutput): GPURenderPipeline {
    const samples = output.multisample?.count ?? 1,
      key = `${output.format}/${samples}/${output.hdr}`;
    if (this.key !== key) {
      this.key = key;
      this.pipeline = render(device, wideShader(output.hdr), output.format, { multisample: output.multisample });
      this.group = undefined;
    }
    return this.pipeline!;
  }
  private release(): void {
    this.uniform?.destroy();
    this.uniform = this.sampler = this.pipeline = this.group = this.input = this.cubeView = undefined;
    this.key = '';
  }
}
