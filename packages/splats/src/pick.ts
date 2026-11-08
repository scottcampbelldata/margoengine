/// <reference lib="esnext.disposable" preserve="true" />
// GPU picking of Gaussian splats, as an overlay of `@margoengine/selection`'s Picking: every splat of the cloud is
// projected again for the 3 x 3 pick tile, with the colour pass's own projection, and drawn as its ellipse after the
// meshes and over their depth, so one pick answers the nearest of both. A splat hits where its Gaussian at the pixel
// reaches the threshold, as `SplatBrush.pick` does, and the nearest such splat centre wins. Nothing here imports selection.
import type { Camera, EngineKernel, Mesh } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { orthographic } from '../../shared/projection.js';
import { viewMatrix } from '../../shared/view.js';
import type { Splats } from './index.js';
import { frame, projectInputs, projectSplat } from './shader.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** What `Picking` hands an overlay for one pick. */
export interface SplatPickContext {
  encoder: GPUCommandEncoder;
  /** The r32uint pick tile, 3 x 3 pixels around the picked pixel. */
  color: GPUTextureView;
  /** Its depth32float depth (reversed Z), holding the meshes already drawn. */
  depth: GPUTextureView;
  /** The camera's view-projection matrix, cropped to the tile. */
  matrix: Float32Array;
  camera: Camera;
  /** The picked view's rectangle in drawing-buffer pixels. */
  rect: readonly number[];
  /** The ID of this overlay's splat 0. */
  firstId: number;
}

/** A splat hit: `hit.mesh` is an empty stand-in mesh for the cloud (see `splatsOf`), as `engine.pick` answers meshes. */
export interface SplatPickHit {
  mesh: Mesh;
  /** The cloud the splat belongs to. */
  splats: Splats;
  /** Index of the splat in the cloud (the order of its `SplatData`, or a pool index under `SplatSet` and `SplatLod`). */
  splat: number;
}

/** What `SplatPicking.attach` needs of `@margoengine/selection`'s Picking. */
export interface SplatPickHost {
  addOverlay(overlay: {
    drawPick(context: SplatPickContext): void;
    pickHit(index: number): SplatPickHit | null;
  }): () => void;
}

/** Options of `SplatPicking.attach`. */
export interface SplatPickingOptions {
  /** The opacity a splat's Gaussian must reach at the pixel to hit, 0 to 1. Default 0.1, as `SplatBrush.pick`. */
  threshold?: number;
}

interface Gpu {
  device: GPUDevice;
  frame: GPUBuffer;
  params: GPUBuffer;
  pipeline: GPURenderPipeline;
  paramsGroup: GPUBindGroup;
  /** The cloud's input buffers the group binds; a restored device or a rebuilt cloud replaces them. */
  inputs?: readonly GPUBuffer[];
  group?: GPUBindGroup;
}

/** Bytes of the projection's frame uniform (`Frame` in shader.ts): two matrices and four vectors. */
const FRAME_BYTES = 192;

/** The projection of shader.ts in a vertex shader, the colour pass's falloff and cap, and an ID for a fragment. */
export const splatPickShader = `${frame}${projectInputs}${projectSplat}
struct Pick {threshold:f32,first:u32}
@group(1) @binding(0) var<uniform> pick:Pick;
struct PickOut {@builtin(position) clip:vec4f,@location(0) corner:vec2f,@location(1) @interpolate(flat) opacity:f32,@location(2) @interpolate(flat) splat:u32}
@vertex fn vertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) index:u32)->PickOut {
  let corners=array<vec2f,4>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(1,1));let e=projectSplat(index).ellipse;let corner=corners[vertex];var o:PickOut;
  o.clip=vec4f(e.center.xy+e.axes.xy*corner.x+e.axes.zw*corner.y,e.center.z,1);o.corner=corner;o.opacity=e.center.w;o.splat=index;
  if(e.center.w==0){o.clip=vec4f(2,2,0,1);}return o;
}
@fragment fn fragment(i:PickOut)->@location(0) u32 {let power=-4.5*dot(i.corner,i.corner);if(power<-4.5){discard;}
  let alpha=min(0.99,i.opacity*exp(power));if(alpha<max(pick.threshold,1.0/255)){discard;}return pick.first+i.splat;}`;

function checkThreshold(value: number): number {
  if (!(value >= 0 && value <= 1)) throw new RangeError('SplatPicking threshold must be 0 to 1');
  return value;
}

/**
 * Makes a `Splats` cloud pickable by `@margoengine/selection`'s `Picking`, and so by `engine.pick`, `picking.pick` and
 * `pickMany` once Picking is attached. Splats and meshes share one depth test: a mesh in front blocks the pick, a splat
 * in front of a mesh wins it. The splats are projected for the pick with the current camera, so a pick needs no drawn
 * frame. `hit.splats` and `hit.splat` name what was hit; `hit.mesh` is an empty stand-in mesh (`splatsOf` maps it back).
 */
export class SplatPicking {
  private gpu?: Gpu;
  private mesh?: Mesh;
  private remove?: () => void;
  private value: number;
  private readonly frameData = new Float32Array(FRAME_BYTES / 4);
  private readonly integers = new Uint32Array(this.frameData.buffer);
  private readonly params = new ArrayBuffer(16);

  /**
   * Registers `splats` with `picking`; undo with `dispose`.
   * @throws MargoError `state` when `splats` is not attached to an engine yet; RangeError for a threshold outside 0 to 1.
   */
  static attach(picking: SplatPickHost, splats: Splats, options: SplatPickingOptions = {}): SplatPicking {
    const engine = splats['engine'] as unknown as EngineKernel | undefined;
    if (!engine) throw new MargoError('state', 'Attach Splats to the engine before SplatPicking.attach');
    const value = new SplatPicking(splats, checkThreshold(options.threshold ?? 0.1));
    // The stand-in is made now, because adding a mesh during a pick would void that pick's answer.
    value.mesh = engine.createMesh();
    value.remove = picking.addOverlay(value);
    return value;
  }
  private constructor(
    readonly splats: Splats,
    threshold: number,
  ) {
    this.value = threshold;
  }

  /** The opacity a splat's Gaussian must reach at the pixel to hit, 0 to 1; takes effect at the next pick. */
  get threshold(): number {
    return this.value;
  }
  set threshold(value: number) {
    this.value = checkThreshold(value);
  }

  /** The cloud `mesh` stands in for, from a `hit.mesh` or an `engine.pick` answer; null for any other mesh. */
  splatsOf(mesh: Mesh | null): Splats | null {
    return mesh && mesh === this.mesh ? this.splats : null;
  }

  private resources(device: GPUDevice): Gpu {
    if (this.gpu?.device === device) return this.gpu;
    this.gpu?.frame.destroy();
    this.gpu?.params.destroy();
    const module = device.createShaderModule({ code: splatPickShader }),
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'r32uint' }] },
        primitive: { topology: 'triangle-strip', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
      }),
      params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return (this.gpu = {
      device,
      frame: device.createBuffer({ size: FRAME_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      params,
      pipeline,
      paramsGroup: device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: params } }],
      }),
    });
  }

  /** @internal Picking's turn: projects every splat for the tile and draws the ones that reach it, with IDs from `firstId`. */
  drawPick(c: SplatPickContext): void {
    const splats = this.splats,
      device = splats['device'],
      inputs = splats['inputs'];
    if (!device || splats['disposed'] || inputs.length < 2 || !splats.count) return;
    const gpu = this.resources(device);
    if (gpu.inputs?.[0] !== inputs[0] || gpu.inputs?.[1] !== inputs[1]) {
      gpu.inputs = [inputs[0], inputs[1]];
      gpu.group = device.createBindGroup({
        layout: gpu.pipeline.getBindGroupLayout(0),
        entries: [gpu.frame, inputs[0], inputs[1]].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
    }
    // The frame the colour pass projects with, for a 3 x 3 target under the cropped matrix: the focal length in pixels
    // and the 0.3 px floor stay the view's, and the ellipses come out in the tile's clip space.
    const f = this.frameData,
      n = this.integers,
      camera = c.camera,
      [, , width, height] = c.rect;
    f.set(c.matrix, 0);
    viewMatrix(f.subarray(16, 32), camera);
    f.set(camera.position, 32);
    f[35] = 0;
    f[36] = f[37] = 3;
    f[38] = f[39] = height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    f[40] = camera.near;
    f[41] = camera.far;
    f[42] = f[43] = 0;
    const o = orthographic(camera.matrix, camera.position);
    if (o) {
      f[38] = (o.sx * width) / 2;
      f[39] = (o.sy * height) / 2;
      f[40] = o.near;
      f[41] = o.far;
      f[43] = 1;
    }
    n[44] = splats.count;
    n[45] = 0;
    n[46] = +splats['mip'];
    n[47] = 0;
    new Float32Array(this.params, 0, 1)[0] = this.value;
    new Uint32Array(this.params, 4, 1)[0] = c.firstId;
    device.queue.writeBuffer(gpu.frame, 0, f);
    device.queue.writeBuffer(gpu.params, 0, this.params);
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: c.depth, depthLoadOp: 'load', depthStoreOp: 'store' },
    });
    pass.setPipeline(gpu.pipeline);
    pass.setBindGroup(0, gpu.group!);
    pass.setBindGroup(1, gpu.paramsGroup);
    pass.draw(4, splats.count);
    pass.end();
  }

  /** @internal The hit of ID `index` of the last `drawPick`. */
  pickHit(index: number): SplatPickHit | null {
    const mesh = this.mesh;
    if (!mesh || !(index >= 0 && index < this.splats.count)) return null;
    return { mesh, splats: this.splats, splat: index };
  }

  /** Leaves Picking and frees the stand-in mesh and GPU buffers; the cloud itself stays. */
  dispose(): void {
    this.remove?.();
    this.remove = undefined;
    this.mesh?.dispose();
    this.mesh = undefined;
    this.gpu?.frame.destroy();
    this.gpu?.params.destroy();
    this.gpu = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
