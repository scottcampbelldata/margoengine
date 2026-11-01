/// <reference lib="esnext.disposable" preserve="true" />
import type { Camera, EngineKernel, RenderView, Scene } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { hexColor } from '@margoengine/math';
import { invertMatrix } from '@margoengine/math/mat4';
import { fault, rangeError, typeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  COPY_SRC: number;
  COPY_DST: number;
};

/** The outline drawn around what a low-res 3D view shows. */
export interface OutlineOptions {
  /** `#rrggbb`. Default `#000000`. */
  color?: string;
  /** How much farther a neighbouring pixel must be to draw an outline on the nearer one, in world units. Default 0.1. */
  depthEdge?: number;
  /** The angle between surfaces that draws a crease line, in radians; 0 draws none. Default 0.6. */
  crease?: number;
}

/** Settings of {@link Render3D}. */
export interface Render3DOptions {
  /** The camera of the view. Required. */
  camera: Camera;
  /** Low-res size in pixels, whole numbers. Required. */
  width: number;
  /** Low-res size in pixels, whole numbers. Required. */
  height: number;
  /** Where the picture ends up, the same size, or a function returning it such as a pixel layer's `target`. Default a texture of its own, {@link Render3D.output}. */
  target?: GPUTexture | (() => GPUTexture);
  /** Outlines from depth and surface direction, or false for none. Default on. */
  outline?: OutlineOptions | false;
  /** What the view clears to, `#rrggbb`. Default transparent. */
  background?: string;
  /** The scene to draw. Default the engine's. */
  scene?: Scene;
  /** Render-layer bits of the view. Default every layer. */
  layers?: number;
  /** The engine's samples per pixel: 1 with `exactSize`, else its quality tier's. Default 1. */
  samples?: number;
  /** Frame-graph order of the outline pass, before a compositor (30). Default 20. */
  order?: number;
  /** Plugin name, unique per scene. Default `render3d-1`, `render3d-2`, ... */
  name?: string;
}

/** What {@link outlineMask} reads, in the scene's own numbers. */
export interface OutlineFrame {
  /** Depth values row by row; 0 is the far plane, where nothing was drawn. */
  depth: Float32Array;
  width: number;
  height: number;
  /** The camera's world-to-clip matrix, column-major. */
  matrix: ArrayLike<number>;
  /** The camera's position. */
  eye: readonly [number, number, number];
  /** The direction it looks in, unit length. */
  forward: readonly [number, number, number];
}

const invertible = (matrix: ArrayLike<number>) => {
  const inverse = invertMatrix(matrix);
  if (!inverse) throw rangeError('A Render3D camera matrix needs an inverse', 'pixel-low-res');
  return inverse;
};

const worldOf = (frame: OutlineFrame, inverse: ArrayLike<number>, x: number, y: number): number[] | undefined => {
  const d = frame.depth[y * frame.width + x];
  if (!d) return undefined;
  const nx = ((x + 0.5) / frame.width) * 2 - 1,
    ny = 1 - ((y + 0.5) / frame.height) * 2,
    i = inverse,
    w = i[3] * nx + i[7] * ny + i[11] * d + i[15];
  return [0, 1, 2].map((c) => (i[c] * nx + i[c + 4] * ny + i[c + 8] * d + i[c + 12]) / w);
};

/**
 * The CPU form of the outline pass, for tools and tests: 1 where the outline draws. A drawn pixel is outlined when a
 * neighbour is empty or farther by `depthEdge`, or when the surface direction turns by `crease` to the pixel right or below.
 */
export function outlineMask(frame: OutlineFrame, options: OutlineOptions = {}): Uint8Array {
  const { width, height, eye, forward } = frame,
    inverse = invertible(frame.matrix),
    { depthEdge = 0.1, crease = 0.6 } = options,
    out = new Uint8Array(width * height),
    at = (x: number, y: number) =>
      x < 0 || y < 0 || x >= width || y >= height ? undefined : worldOf(frame, inverse, x, y),
    along = (p: number[]) => (p[0] - eye[0]) * forward[0] + (p[1] - eye[1]) * forward[1] + (p[2] - eye[2]) * forward[2],
    normal = (x: number, y: number, p: number[]) => {
      const right = at(x + 1, y),
        down = at(x, y + 1);
      if (!right || !down) return undefined;
      const a = [right[0] - p[0], right[1] - p[1], right[2] - p[2]],
        b = [down[0] - p[0], down[1] - p[1], down[2] - p[2]],
        n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
        size = Math.hypot(n[0], n[1], n[2]);
      return size ? n.map((v) => v / size) : undefined;
    };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = at(x, y);
      if (!p) continue;
      const z = along(p);
      let edge = false;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const q = at(x + dx, y + dy);
        if (x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height) continue;
        if (!q || along(q) - z > depthEdge) edge = true;
      }
      if (!edge && crease > 0) {
        const n = normal(x, y, p);
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
        ]) {
          const q = at(x + dx, y + dy),
            m = q && normal(x + dx, y + dy, q);
          if (n && m && n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < Math.cos(crease)) edge = true;
        }
      }
      if (edge) out[y * width + x] = 1;
    }
  return out;
}

const shader = (samples: number) => /* wgsl */ `
struct Settings{inverse:mat4x4f,eye:vec4f,forward:vec4f,color:vec4f,size:vec2f}
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var image:texture_2d<f32>;
@group(0) @binding(2) var depth:${samples > 1 ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
@vertex fn vertexMain(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
  return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);
}
fn inside(t:vec2i)->bool{return all(t>=vec2i(0))&&all(vec2f(t)<settings.size);}
fn world(t:vec2i)->vec4f{
  let d=textureLoad(depth,t,0);
  if(d==0){return vec4f(0);}
  let n=(vec2f(t)+0.5)/settings.size*2-1;
  let h=settings.inverse*vec4f(n.x,-n.y,d,1);
  return vec4f(h.xyz/h.w,1);
}
fn along(p:vec4f)->f32{return dot(p.xyz-settings.eye.xyz,settings.forward.xyz);}
fn normal(t:vec2i,p:vec4f)->vec4f{
  let r=t+vec2i(1,0);
  let u=t+vec2i(0,1);
  if(!inside(r)||!inside(u)){return vec4f(0);}
  let a=world(r);
  let b=world(u);
  if(a.w==0||b.w==0){return vec4f(0);}
  let n=cross(a.xyz-p.xyz,b.xyz-p.xyz);
  let size=length(n);
  if(size==0){return vec4f(0);}
  return vec4f(n/size,1);
}
fn farther(t:vec2i,z:f32)->bool{
  if(!inside(t)){return false;}
  let q=world(t);
  return q.w==0||along(q)-z>settings.eye.w;
}
fn turned(t:vec2i,n:vec4f)->bool{
  if(!inside(t)){return false;}
  let q=world(t);
  if(q.w==0){return false;}
  let m=normal(t,q);
  return m.w!=0&&dot(n.xyz,m.xyz)<settings.forward.w;
}
@fragment fn fragmentMain(@builtin(position) f:vec4f)->@location(0) vec4f{
  let t=vec2i(f.xy);
  let source=textureLoad(image,t,0);
  let p=world(t);
  if(p.w==0){return source;}
  let z=along(p);
  var edge=farther(t+vec2i(1,0),z)||farther(t-vec2i(1,0),z)||farther(t+vec2i(0,1),z)||farther(t-vec2i(0,1),z);
  if(!edge&&settings.forward.w<1){
    let n=normal(t,p);
    edge=n.w!=0&&(turned(t+vec2i(1,0),n)||turned(t+vec2i(0,1),n));
  }
  if(edge){return settings.color;}
  return source;
}`;

const SETTINGS_BYTES = 128;
let renderCount = 0;

/**
 * Draws the 3D scene small, for a pixel-art look: a view into a low-res target with depth, then an outline from depth and
 * surface direction on the same pixels. Pass {@link view} to `render({views: [...]})` along with your canvas view, and
 * draw the result through a compositor layer (`target: layer.target`). Each pixel is one source colour or the outline
 * colour, never a blend. WebGPU only.
 * @throws TypeError / RangeError on invalid options or, each frame, an invalid camera or outline value.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` when the view is read before
 * the plugin is attached or the target does not fit.
 */
export class Render3D implements EnginePlugin {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** The outline settings, read each frame. False turns it off. */
  outline: OutlineOptions | false;
  readonly #camera: Camera;
  readonly #target?: GPUTexture | (() => GPUTexture);
  readonly #background?: string;
  readonly #sceneToDraw?: Scene;
  readonly #layerMask?: number;
  readonly #samples: number;
  readonly #order: number;
  #engine?: Engine;
  #device?: GPUDevice;
  #colorTexture?: GPUTexture;
  #depthTexture?: GPUTexture;
  #ownOutput?: GPUTexture;
  #madeView?: RenderView;
  #module?: GPUShaderModule;
  #pipeline?: GPURenderPipeline;
  #format?: GPUTextureFormat;
  #uniform?: GPUBuffer;
  #group?: GPUBindGroup;
  readonly #values = new Float32Array(SETTINGS_BYTES / 4);
  #disposed = false;

  constructor(options: Render3DOptions) {
    if (!options?.camera) throw typeError('Render3D needs a camera', 'pixel-low-res');
    const { width, height } = options,
      order = options.order ?? 20,
      samples = options.samples ?? 1;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
      throw rangeError('Invalid Render3D size', 'pixel-low-res');
    if (!Number.isFinite(order) || !Number.isInteger(samples) || samples < 1)
      throw rangeError('Invalid Render3D value', 'pixel-low-res');
    this.#camera = options.camera;
    this.width = width;
    this.height = height;
    this.#target = options.target;
    this.outline = options.outline ?? {};
    this.#background = options.background;
    this.#sceneToDraw = options.scene;
    this.#layerMask = options.layers;
    this.#samples = samples;
    this.#order = order;
    this.name = options.name ?? `render3d-${++renderCount}`;
  }
  /** Creates a low-res view and attaches it to `instance`. */
  static attach(instance: EngineKernel, options: Render3DOptions): Render3D {
    const render = new Render3D(options);
    (options.scene ?? engineRuntime(instance)).use(render);
    return render;
  }
  /** The view to draw this frame. Read it each frame: it changes after a device loss. */
  get view(): RenderView {
    if (this.#disposed) throw fault('disposed', 'Render3D disposed; create a new one', 'disposed');
    const device = this.#engine?.gpu;
    if (!device) throw fault('state', 'Render3D needs attaching before its view is read', 'pixel-low-res');
    if (device !== this.#device) {
      this.#release();
      this.#device = device;
    }
    if (!this.#madeView) {
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        size = [this.width, this.height];
      this.#colorTexture = device.createTexture({ label: 'render3d colour', size, format: 'rgba8unorm', usage });
      this.#depthTexture = device.createTexture({
        label: 'render3d depth',
        size,
        format: device.features.has('depth32float-stencil8') ? 'depth32float-stencil8' : 'depth32float',
        sampleCount: this.#samples,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          (this.#samples > 1 ? 0 : GPUTextureUsage.COPY_SRC),
      });
      this.#madeView = {
        id: this.name,
        camera: this.#camera,
        pixels: true,
        viewport: [0, 0, this.width, this.height],
        target: { color: this.#colorTexture, depth: this.#depthTexture },
        clear: { color: this.#background ?? false },
        ...(this.#sceneToDraw ? { scene: this.#sceneToDraw } : {}),
        ...(this.#layerMask === undefined ? {} : { layers: this.#layerMask }),
      };
    }
    return this.#madeView;
  }
  /** The picture with its outline, when no `target` was given. */
  get output(): GPUTexture {
    void this.view;
    if (this.#target) return typeof this.#target === 'function' ? this.#target() : this.#target;
    this.#ownOutput ??= this.#device!.createTexture({
      label: 'render3d output',
      size: [this.width, this.height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    return this.#ownOutput;
  }
  /** The depth the view drew, for reading back with one sample per pixel. */
  get depth(): GPUTexture {
    void this.view;
    return this.#depthTexture!;
  }
  /** The colour the view drew, before the outline. */
  get color(): GPUTexture {
    void this.view;
    return this.#colorTexture!;
  }
  setup(engine: Engine): void {
    if (this.#disposed) throw fault('disposed', 'Render3D disposed; create a new one');
    if (engine.backend !== 'webgpu') throw fault('unsupported', 'Render3D needs WebGPU', 'webgpu');
    this.#engine = engine;
    const own = (c: PassContext): c is Extract<PassContext, { backend: 'webgpu' }> =>
      c.backend === 'webgpu' && !!this.#colorTexture && c.view?.target?.color === this.#colorTexture;
    // Core's view clear is opaque. Without a background the view keeps the colour below, which this clears to transparent.
    if (!this.#background)
      engine.frameGraph.add({
        name: `${this.name} clear`,
        order: -1,
        execute: (c) => {
          if (own(c))
            c.encoder
              .beginRenderPass({
                colorAttachments: [
                  {
                    view: this.#colorTexture!.createView(),
                    loadOp: 'clear',
                    clearValue: [0, 0, 0, 0],
                    storeOp: 'store',
                  },
                ],
              })
              .end();
        },
      });
    engine.frameGraph.add({
      name: this.name,
      order: this.#order,
      execute: (c) => {
        if (own(c)) this.#run(c);
      },
    });
  }
  onDeviceRestored(): void {
    this.#release();
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    (this.#sceneToDraw ?? this.#engine)?.removePlugin(this.name);
    this.#engine = undefined;
    this.#release();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  #release(): void {
    this.#colorTexture?.destroy();
    this.#depthTexture?.destroy();
    this.#ownOutput?.destroy();
    this.#uniform?.destroy();
    this.#colorTexture = this.#depthTexture = this.#ownOutput = this.#madeView = this.#device = undefined;
    this.#module = this.#uniform = this.#group = this.#pipeline = this.#format = undefined;
  }
  #prepare(device: GPUDevice): void {
    if (this.#module) return;
    this.#module = device.createShaderModule({ label: 'render3d outline', code: shader(this.#samples) });
    this.#uniform = device.createBuffer({
      label: 'render3d outline',
      size: SETTINGS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
  #run(c: Extract<PassContext, { backend: 'webgpu' }>): void {
    const device = c.device,
      output = this.output,
      outline = this.outline;
    if (output.width !== this.width || output.height !== this.height)
      throw fault('state', 'Render3D target differs in size', 'pixel-low-res');
    if (!outline) {
      c.encoder.copyTextureToTexture({ texture: this.#colorTexture! }, { texture: output }, [this.width, this.height]);
      return;
    }
    const { color = '#000000', depthEdge = 0.1, crease = 0.6 } = outline,
      rgb = hexColor(color);
    if (!rgb || !(depthEdge >= 0) || !(crease >= 0)) throw rangeError('Invalid Render3D value', 'pixel-low-res');
    this.#prepare(device);
    const values = this.#values,
      camera = this.#camera,
      dx = camera.target[0] - camera.position[0],
      dy = camera.target[1] - camera.position[1],
      dz = camera.target[2] - camera.position[2],
      size = Math.hypot(dx, dy, dz);
    values.set(invertible(camera.matrix));
    values.set([camera.position[0], camera.position[1], camera.position[2], depthEdge], 16);
    values.set([dx / size, dy / size, dz / size, crease > 0 ? Math.cos(crease) : 2], 20);
    values.set([rgb[0], rgb[1], rgb[2], 1], 24);
    values.set([this.width, this.height], 28);
    device.queue.writeBuffer(this.#uniform!, 0, values);
    if (output.format !== this.#format) {
      this.#format = output.format;
      this.#pipeline = device.createRenderPipeline({
        label: 'render3d outline',
        layout: 'auto',
        vertex: { module: this.#module! },
        fragment: { module: this.#module!, targets: [{ format: output.format }] },
      });
      this.#group = device.createBindGroup({
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.#uniform! } },
          { binding: 1, resource: this.#colorTexture!.createView() },
          { binding: 2, resource: this.#depthTexture!.createView({ aspect: 'depth-only' }) },
        ],
      });
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: output.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
    });
    pass.setPipeline(this.#pipeline!);
    pass.setBindGroup(0, this.#group!);
    pass.draw(3);
    pass.end();
  }
}

/** A captured sprite sheet. */
export interface SpriteFrames {
  /** `rgba8unorm`, ready as a sprite atlas. Yours to destroy. */
  texture: GPUTexture;
  /** One frame per angle, in order: where it sits, and its angle in radians. */
  frames: { x: number; y: number; width: number; height: number; angle: number }[];
}

/** What to capture in {@link renderSpriteFrames}. */
export interface SpriteFramesOptions {
  /** The camera to shoot with. Required. */
  camera: Camera;
  /** The turns about the Y axis to shoot, radians. At least one. */
  angles: readonly number[];
  /** Frame size in pixels. Required. */
  width: number;
  /** Frame size in pixels. Required. */
  height: number;
  /** Frames per row of the sheet. Default as many as angles. */
  columns?: number;
  /** Outlines on the frames, or false. Default on. */
  outline?: OutlineOptions | false;
  /** See {@link Render3DOptions.background}. Default transparent. */
  background?: string;
  /** See {@link Render3DOptions.samples}. Default 1. */
  samples?: number;
}

/**
 * Renders a mesh at several turns into one sprite sheet. Draws frames right away, with delta 0, and puts the mesh's
 * rotation back. @throws RangeError for no angles or a bad size.
 */
export function renderSpriteFrames(
  instance: EngineKernel,
  mesh: { rotation: { x: number; y: number; z: number } },
  options: SpriteFramesOptions,
): SpriteFrames {
  const { angles, width, height, camera, outline, background, samples } = options,
    columns = options.columns ?? angles?.length;
  if (!angles?.length || !Number.isInteger(columns) || columns < 1)
    throw rangeError('Invalid Render3D value', 'pixel-low-res');
  const engine = engineRuntime(instance),
    capture = Render3D.attach(instance, { camera, width, height, outline, background, samples }),
    rows = Math.ceil(angles.length / columns),
    device = engine.gpu!,
    texture = device.createTexture({
      label: 'sprite frames',
      size: [columns * width, rows * height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
    }),
    was = mesh.rotation.y,
    frames: SpriteFrames['frames'] = [];
  try {
    angles.forEach((angle, i) => {
      mesh.rotation.y = angle;
      instance.render({ delta: 0, views: [capture.view] });
      const x = (i % columns) * width,
        y = Math.floor(i / columns) * height,
        encoder = device.createCommandEncoder();
      encoder.copyTextureToTexture({ texture: capture.output }, { texture, origin: [x, y] }, [width, height]);
      device.queue.submit([encoder.finish()]);
      frames.push({ x, y, width, height, angle });
    });
  } finally {
    mesh.rotation.y = was;
    capture.dispose();
  }
  return { texture, frames };
}
