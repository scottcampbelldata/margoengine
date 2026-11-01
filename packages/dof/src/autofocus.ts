/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { orthographic } from '../../shared/projection.js';
import type { DOF } from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; MAP_READ: number };
declare const GPUTextureUsage: { STORAGE_BINDING: number; COPY_SRC: number };
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** `Autofocus` settings, read from `autofocus.options` every frame. */
export interface AutofocusOptions {
  /** CSS pixel whose depth sets the focus, such as the pointer. Default: the middle of the canvas. */
  point?: readonly [number, number];
  /** World point to keep in focus, with no depth read. Wins over `point`. */
  target?: ArrayLike<number>;
  /** Seconds the focus takes to get about two thirds of the way; 0 jumps. Default 0.2. */
  smoothing?: number;
}

const reader = `@group(0) @binding(0) var depth:texture_depth_2d;
@group(0) @binding(1) var out:texture_storage_2d<r32float,write>;
@group(0) @binding(2) var<uniform> at:vec4u;
@compute @workgroup_size(1) fn main() {
  textureStore(out,vec2i(0),vec4f(textureLoad(depth,vec2i(min(at.xy,textureDimensions(depth)-1u)),0),0,0,0));
}`;

/**
 * Keeps `dof.options.focalDistance` on what a pixel shows, or on a world point. The depth is read back a frame or two
 * later without waiting, so a frame never stalls for it; the sky leaves the focus where it is.
 * @throws TypeError without a `DOF`.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 */
export class Autofocus implements EnginePlugin {
  readonly name = 'dof-autofocus';
  private engine?: Engine;
  private pipeline?: GPUComputePipeline;
  private uniform?: GPUBuffer;
  private texel?: GPUTexture;
  private read?: GPUBuffer;
  private group?: GPUBindGroup;
  private depth?: GPUTexture;
  // The read's progress: 0 free, 1 copied in an earlier frame's commands, 2 mapping.
  private state = 0;
  private near = 0;
  private far = 0;
  private flat = false;
  private previous = 0;
  private settled = false;
  private disposed = false;
  private readonly point = new Uint32Array(4);

  /** Same as `engine.use(new Autofocus(dof, options))`; returns the Autofocus. */
  static attach(engine: EngineKernel, dof: DOF, options: AutofocusOptions = {}): Autofocus {
    const value = new Autofocus(dof, options);
    engineRuntime(engine).use(value);
    return value;
  }
  constructor(
    readonly dof: DOF,
    readonly options: AutofocusOptions = {},
  ) {
    if (!dof?.options) throw new TypeError('Expected a DOF; pass the effect this autofocus drives');
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Autofocus requires WebGPU and a live effect; attach a new Autofocus to a WebGPU engine',
      );
    const d = engine.gpu;
    this.engine = engine;
    this.pipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: d.createShaderModule({ code: reader }), entryPoint: 'main' },
    });
    this.uniform = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.texel = d.createTexture({
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.read = d.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  }
  registerPasses(graph: FrameGraph): void {
    // After every route has resolved the capture's depth: DOF's own CoC pass (20) or present (30), or a PostStack (30).
    graph.add({
      name: 'dof-autofocus:read',
      order: 31,
      execute: (c) => {
        if (c.backend === 'webgpu') this.frame(c);
      },
    });
  }
  private frame(c: Context): void {
    const { target, point } = this.options,
      camera = c.camera,
      ortho = orthographic(camera.matrix, camera.position);
    if (target) {
      const m = camera.matrix,
        at = (row: number) => m[row] * target[0] + m[4 + row] * target[1] + m[8 + row] * target[2] + m[12 + row];
      this.focus(ortho ? ortho.far + (ortho.near - ortho.far) * at(2) : at(3));
      return;
    }
    if (this.state === 1) {
      this.state = 2;
      const read = this.read!;
      read.mapAsync(GPUMapMode.READ).then(
        () => {
          // A released buffer means the device went away or the effect ended: nothing is left to focus.
          if (read !== this.read) return;
          const value = new Float32Array(read.getMappedRange().slice(0))[0];
          read.unmap();
          this.state = 0;
          // Reversed Z: 0 is the far plane, where only the sky is.
          if (value > 0)
            this.focus(
              this.flat
                ? this.far + (this.near - this.far) * value
                : (this.near * this.far) / (this.near + value * (this.far - this.near)),
            );
        },
        (error) => {
          if (read === this.read) throw error;
        },
      );
    }
    const depth = this.dof.depthTexture;
    if (this.state !== 0 || !depth) return;
    if (depth !== this.depth) {
      this.depth = depth;
      this.group = c.device.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: depth.createView({ aspect: 'depth-only' }) },
          { binding: 1, resource: this.texel!.createView() },
          { binding: 2, resource: { buffer: this.uniform! } },
        ],
      });
    }
    const canvas = this.engine!.canvas,
      w = canvas.clientWidth || canvas.width,
      h = canvas.clientHeight || canvas.height;
    this.point[0] = point ? Math.max(0, Math.floor((point[0] * c.width) / w)) : c.width >> 1;
    this.point[1] = point ? Math.max(0, Math.floor((point[1] * c.height) / h)) : c.height >> 1;
    c.device.queue.writeBuffer(this.uniform!, 0, this.point);
    this.near = ortho ? ortho.near : camera.near;
    this.far = ortho ? ortho.far : camera.far;
    this.flat = !!ortho;
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.group!);
    pass.dispatchWorkgroups(1);
    pass.end();
    c.encoder.copyTextureToBuffer({ texture: this.texel! }, { buffer: this.read! }, [1, 1]);
    this.state = 1;
  }
  private focus(distance: number): void {
    const o = this.dof.options,
      smoothing = this.options.smoothing ?? 0.2,
      now = performance.now(),
      goal = Math.max(distance, (o.focalLength ?? 0.05) * 1.01);
    o.focalDistance =
      this.settled && smoothing > 0
        ? goal + ((o.focalDistance ?? 5) - goal) * Math.exp((this.previous - now) / (smoothing * 1000))
        : goal;
    this.previous = now;
    this.settled = true;
  }
  private release(): void {
    this.uniform?.destroy();
    this.texel?.destroy();
    this.read?.destroy();
    this.uniform = this.texel = this.read = this.depth = this.group = this.pipeline = undefined;
    this.state = 0;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
