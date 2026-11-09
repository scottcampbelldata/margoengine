/// <reference lib="esnext.disposable" preserve="true" />
// General cube render target: entry @margoengine/environment/cube-camera.
import type { EngineKernel, Mesh } from '@margoengine/core';
import { Camera, engineRuntime, type Vec3 } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import {
  CaptureTarget,
  captureScene,
  scenePasses,
  type CapturePassContext,
  type CapturePassFilter,
} from './capture.js';
import { checkLayers } from '../../shared/view-rect.js';

export { scenePasses, type CapturePassFilter } from './capture.js';

declare const GPUTextureUsage: {
  TEXTURE_BINDING: number;
  RENDER_ATTACHMENT: number;
  COPY_SRC: number;
  COPY_DST: number;
};

/** Options of {@link CubeCamera}; invalid values throw TypeError or RangeError. */
export interface CubeCameraOptions {
  /** Face edge in texels: a power of two from 8 to 2048 (and the device limit). Default 256. */
  size?: number;
  /** Capture point in world units. Default [0, 0, 0]. */
  position?: Vec3;
  /** Near and far clip distances of the six face cameras. Defaults 0.05 and 1000. */
  near?: number;
  far?: number;
  /** Give the cube a full box-filtered mip chain, rebuilt after each sixth face. Default false (one level). */
  mips?: boolean;
  /** Faces captured before every engine frame (`engine.start`): 0 (only on `update()`) to 6. Default 0. */
  facesPerFrame?: number;
  /** Layer mask the faces draw (@margoengine/cameras/layers). Default every layer. */
  layers?: number;
  /** Meshes left out of the faces (the object the cube map is for, say). */
  exclude?: Iterable<Mesh>;
  /** Frame-graph passes each face runs. Default {@link scenePasses}. */
  passes?: CapturePassFilter;
  /** Plugin name. Default 'cube-camera-N'. */
  name?: string;
}

// Face cameras: forward and up per WebGPU cube layer (+X, -X, +Y, -Y, +Z, -Z). A cube face is the mirror image of a
// right-handed camera's view, so each face is captured with this camera and copied into its layer flipped in x.
const FACES: readonly (readonly [Vec3, Vec3])[] = [
  [
    [1, 0, 0],
    [0, 1, 0],
  ],
  [
    [-1, 0, 0],
    [0, 1, 0],
  ],
  [
    [0, 1, 0],
    [0, 0, -1],
  ],
  [
    [0, -1, 0],
    [0, 0, 1],
  ],
  [
    [0, 0, 1],
    [0, 1, 0],
  ],
  [
    [0, 0, -1],
    [0, 1, 0],
  ],
];
const FLIP = /* wgsl */ `
@group(0) @binding(0) var source:texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  let size=i32(textureDimensions(source,0).x);let q=vec2i(p.xy);return textureLoad(source,vec2i(size-1-q.x,q.y),0);
}`;
const REDUCE = /* wgsl */ `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var linearSampler:sampler;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  return textureSampleLevel(source,linearSampler,p.xy*2.0/vec2f(textureDimensions(source,0)),0.0);
}`;

interface CubeState {
  device: GPUDevice;
  texture: GPUTexture;
  view: GPUTextureView;
  flip: GPURenderPipeline;
  reduce?: GPURenderPipeline;
  sampler: GPUSampler;
  /** Per layer: mip 0 render view, then mip views for the reduction. */
  levels: GPUTextureView[][];
  flipGroup?: { source: GPUTexture; group: GPUBindGroup };
  reduceGroups?: GPUBindGroup[][];
}

let count = 0;

/**
 * Renders the scene from `position` into the six faces of a cube texture: `texture` (`rgba16float`, 6 array layers,
 * optionally a full mip chain) with `view` (dimension 'cube'), ready for `textureSample(cube, sampler, direction)` in
 * the standard WebGPU face layout. Each face is an `engine.render` through a 90-degree face camera, culled against
 * that face, so meshes the main camera culls still appear. `update()` captures all six faces (or the next `faces`);
 * `facesPerFrame` keeps it current before every engine frame. Usable as image-based lighting through
 * `Environment.create(engine, cubeCamera)` and `environment.refresh()`, and as a per-material cube map. Faces run the
 * scene passes only (no post-processing) and hold linear radiance. WebGPU only.
 */
export class CubeCamera {
  readonly name: string;
  readonly size: number;
  readonly mips: boolean;
  /** Capture point in world units; read at each face. */
  position: Vec3;
  /** Meshes left out of the faces. */
  exclude?: Iterable<Mesh>;
  /** Frame-graph passes each face runs. */
  passes: CapturePassFilter;
  /** Increments whenever `texture` is replaced (device restore). */
  version = 0;
  private readonly near: number;
  private readonly far: number;
  private facesValue = 0;
  private layersValue = 0xffffffff;
  private engine?: EngineKernel;
  private state?: CubeState;
  private readonly target = new CaptureTarget();
  private readonly camera = new Camera({ fov: 90 });
  private nextFace = 0;
  private stopFrames?: () => void;
  private disposed = false;
  /** Same as `engine.use(new CubeCamera(options))`; returns the CubeCamera. */
  static attach(engine: EngineKernel, options?: CubeCameraOptions): CubeCamera {
    const value = new CubeCamera(options);
    engine.use(value);
    return value;
  }
  constructor(options: CubeCameraOptions = {}) {
    this.name = options.name ?? `cube-camera-${++count}`;
    if (typeof this.name !== 'string' || !this.name)
      throw new TypeError('CubeCamera name must be a non-empty string; pass a name or omit it');
    const size = options.size ?? 256;
    if (!Number.isInteger(size) || size < 8 || size > 2048 || size & (size - 1))
      throw new RangeError(`CubeCamera size ${size} is invalid; pass a power of two from 8 to 2048`);
    this.size = size;
    this.near = options.near ?? 0.05;
    this.far = options.far ?? 1000;
    if (!(this.near > 0) || !(this.far > this.near) || !Number.isFinite(this.far))
      throw new RangeError(`CubeCamera near ${this.near} and far ${this.far} are invalid; pass 0 < near < far`);
    this.position = options.position ?? [0, 0, 0];
    if (!Array.isArray(this.position) || this.position.length !== 3 || !this.position.every(Number.isFinite))
      throw new TypeError('CubeCamera position must be finite [x, y, z]; pass a point in world units');
    this.mips = options.mips ?? false;
    this.facesPerFrame = options.facesPerFrame ?? 0;
    this.layers = options.layers ?? 0xffffffff;
    this.exclude = options.exclude;
    this.passes = options.passes ?? scenePasses;
    if (typeof this.passes !== 'function')
      throw new TypeError('CubeCamera passes must be a function (pass) => boolean; pass scenePasses or omit it');
    this.camera.near = this.near;
    this.camera.far = this.far;
    // Square faces whatever the canvas aspect: core's perspective at aspect 1 (f = 1 at 90 degrees).
    this.camera.project = (out, _aspect, webgpu) => {
      const near = this.near,
        far = this.far,
        d = near - far;
      out[0] = 1;
      out[5] = 1;
      out[10] = webgpu ? -near / d : (far + near) / d;
      out[11] = -1;
      out[14] = webgpu ? (-far * near) / d : (2 * far * near) / d;
    };
  }
  /** Faces captured before every engine frame, 0 to 6. */
  get facesPerFrame(): number {
    return this.facesValue;
  }
  set facesPerFrame(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 6)
      throw new RangeError(`CubeCamera facesPerFrame ${value} is invalid; pass an integer from 0 to 6`);
    this.facesValue = value;
  }
  get layers(): number {
    return this.layersValue;
  }
  set layers(value: number) {
    this.layersValue = checkLayers(value, 'CubeCamera layers');
  }
  /** The cube texture: `rgba16float`, `size` x `size`, 6 array layers. Replaced on device restore (see `version`). */
  get texture(): GPUTexture {
    return this.live.texture;
  }
  /** `texture_cube<f32>` view of `texture` with every mip. */
  get view(): GPUTextureView {
    return this.live.view;
  }
  private get live(): CubeState {
    if (this.disposed) throw new MargoError('disposed', `${this.name} is disposed; create a new CubeCamera`);
    const device = this.engine && engineRuntime(this.engine).gpu;
    if (!device) throw new MargoError('state', `${this.name} is not attached; engine.use(cubeCamera) first`);
    return this.stateFor(device);
  }

  setup(engine: EngineKernel): void {
    if (this.disposed) throw new MargoError('disposed', `${this.name} is disposed; create a new CubeCamera`);
    if (engine.backend !== 'webgpu')
      throw new MargoError(
        'unsupported',
        'CubeCamera requires the WebGPU backend; use an engine on the WebGPU backend',
      );
    if (this.engine)
      throw new MargoError('attached', `${this.name} is attached to an engine; create another CubeCamera`);
    const device = engineRuntime(engine).gpu!;
    if (this.size > device.limits.maxTextureDimension2D)
      throw new RangeError(`CubeCamera size ${this.size} exceeds the device limit; pass a smaller size`);
    this.engine = engine;
    this.stopFrames = engine.onFrame(() => {
      if (this.facesValue) this.update(this.facesValue);
    });
  }
  onDeviceRestored(): void {
    this.release();
    this.nextFace = 0;
  }

  /**
   * Captures the next `faces` faces now (default all six, in layer order), each through `engine.render` with
   * `delta: 0`; the mip chain is rebuilt after the sixth. Not from inside a frame pass (the engine rejects nested
   * renders). Returns the faces drawn (0 while the device is being restored).
   * @throws RangeError for `faces` outside 1..6; MargoError `state` when not attached or another capture is rendering.
   */
  update(faces = 6): number {
    if (!Number.isInteger(faces) || faces < 1 || faces > 6)
      throw new RangeError(`CubeCamera update faces ${faces} is invalid; pass an integer from 1 to 6`);
    const state = this.live,
      engine = this.engine!,
      camera = this.camera;
    if (!Array.isArray(this.position) || this.position.length !== 3 || !this.position.every(Number.isFinite))
      throw new TypeError('CubeCamera position must be finite [x, y, z]; pass a point in world units');
    let drawn = 0;
    for (let k = 0; k < faces; k++) {
      const face = this.nextFace,
        [forward, up] = FACES[face],
        p = this.position;
      camera.position = [p[0], p[1], p[2]];
      camera.target = [p[0] + forward[0], p[1] + forward[1], p[2] + forward[2]];
      camera.up = up;
      const ok = captureScene(engine, {
        camera,
        target: this.target,
        width: this.size,
        height: this.size,
        layers: this.layersValue,
        exclude: this.exclude,
        filter: this.passes,
        owner: this,
        finish: (c) => this.store(c, state, face),
      });
      if (!ok) break;
      drawn++;
      this.nextFace = (face + 1) % 6;
    }
    return drawn;
  }

  private stateFor(device: GPUDevice): CubeState {
    if (this.state?.device === device) return this.state;
    this.release();
    const levels = this.mips ? Math.log2(this.size) + 1 : 1,
      texture = device.createTexture({
        label: this.name,
        size: [this.size, this.size, 6],
        mipLevelCount: levels,
        format: 'rgba16float',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      }),
      module = device.createShaderModule({ label: 'cube camera flip', code: FLIP });
    this.state = {
      device,
      texture,
      view: texture.createView({ dimension: 'cube' }),
      flip: device.createRenderPipeline({
        label: 'cube camera flip',
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
      }),
      sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
      levels: Array.from({ length: 6 }, (_, layer) =>
        Array.from({ length: levels }, (_, level) =>
          texture.createView({
            dimension: '2d',
            baseArrayLayer: layer,
            arrayLayerCount: 1,
            baseMipLevel: level,
            mipLevelCount: 1,
          }),
        ),
      ),
    };
    this.version++;
    return this.state;
  }
  // Inside the face's frame graph: copy the resolved face into its layer, flipped in x, then the mips after face 5.
  private store(c: CapturePassContext, state: CubeState, face: number): void {
    const source = this.target.color!;
    if (state.flipGroup?.source !== source)
      state.flipGroup = {
        source,
        group: c.device.createBindGroup({
          layout: state.flip.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: source.createView() }],
        }),
      };
    // view-state: offscreen cube face, full capture target.
    const pass = c.encoder.beginRenderPass({
      label: 'cube camera face',
      colorAttachments: [{ view: state.levels[face][0], loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(state.flip);
    pass.setBindGroup(0, state.flipGroup.group);
    pass.draw(3);
    pass.end();
    if (face !== 5 || state.levels[0].length < 2) return;
    if (!state.reduce) {
      const module = c.device.createShaderModule({ label: 'cube camera mips', code: REDUCE });
      state.reduce = c.device.createRenderPipeline({
        label: 'cube camera mips',
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
      });
    }
    state.reduceGroups ??= state.levels.map((views) =>
      views.slice(0, -1).map((view) =>
        c.device.createBindGroup({
          layout: state.reduce!.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: view },
            { binding: 1, resource: state.sampler },
          ],
        }),
      ),
    );
    for (let layer = 0; layer < 6; layer++)
      for (let level = 1; level < state.levels[layer].length; level++) {
        // view-state: offscreen cube mip, full reduced target.
        const reduce = c.encoder.beginRenderPass({
          label: 'cube camera mips',
          colorAttachments: [{ view: state.levels[layer][level], loadOp: 'clear', storeOp: 'store' }],
        });
        reduce.setPipeline(state.reduce);
        reduce.setBindGroup(0, state.reduceGroups[layer][level - 1]);
        reduce.draw(3);
        reduce.end();
      }
  }
  private release(): void {
    this.target.dispose();
    this.state?.texture.destroy();
    this.state = undefined;
  }
  /** Destroys the cube texture and detaches from the engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopFrames?.();
    this.stopFrames = undefined;
    this.release();
    const engine = this.engine;
    this.engine = undefined;
    if (engine && !engine.disposed) engineRuntime(engine).sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
