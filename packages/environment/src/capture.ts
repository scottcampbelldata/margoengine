// Scene captures for Reflector, Refractor and CubeCamera: `engine.render({camera})` into a capture's own HDR target.
// A capture runs the scene part of the frame graph only (see `scenePasses`): shadow maps, light lists, shader patches,
// GPU culling, the main draw and the model passes, all into the capture target with linear output. Post-processing
// (TAA, tone mapping, SSAO, bloom, DOF, FXAA, ...) and overlays are skipped, so their histories and outputs never see
// the capture's camera. Core offers no pass filter, so the engine's frame graph is swapped for a filtered copy for the
// duration of one render and restored (also when the render throws).
import type { EngineKernel, Mesh } from '@margoengine/core';
import { FrameGraph, engineRuntime, type Camera, type FramePass, type PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { invertMatrix } from '@margoengine/math/mat4';
import { SceneTarget } from '../../shared/msaa.js';
import { withHidden } from '../../shared/view-rect.js';

declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  COPY_SRC: number;
  COPY_DST: number;
};

/** The WebGPU pass context a capture's `finish` step receives. */
export type CapturePassContext = Extract<PassContext, { backend: 'webgpu' }>;
/** Chooses the frame-graph passes a capture runs, by name and order; true runs the pass. */
export type CapturePassFilter = (pass: { readonly name: string; readonly order: number }) => boolean;

/**
 * The default capture pass filter: every pass ordered below -110 (GPU culling, part packs, output tags) or from -25
 * up to 9 (sky, shadow maps, light lists, shader patches, the main draw, models, water, decals, transmission). Skipped:
 * -110 to -25, where post effects start their scene capture (TAA, PostStack, SSAO, bloom, DOF, tone mapping, FXAA),
 * and 9 upwards, where they resolve and present (and overlays draw).
 */
export const scenePasses: CapturePassFilter = ({ order }) => order < -110 || (order >= -25 && order < 9);

const OWNER = Symbol.for('margoengine.optional.msaa');
// Core's display transform at the end of its fragment shader, as the post effects replace it for HDR captures.
const DISPLAY = /let mapped=pbrNeutral\([\s\S]*?return vec4f\([^\n]+\);/;

/** @internal An rgba16float colour target with a matching depth, MSAA like the scene, reused across captures. */
export class CaptureTarget {
  device?: GPUDevice;
  color?: GPUTexture;
  depth?: GPUTexture;
  scene?: SceneTarget;
  width = 0;
  height = 0;
  private key = '';
  ensure(device: GPUDevice, width: number, height: number, samples: number, depthFormat: GPUTextureFormat): void {
    const key = `${width}x${height}:${samples}:${depthFormat}`;
    if (this.color && this.key === key && this.device === device) return;
    this.dispose();
    const color = device.createTexture({
        label: 'capture color',
        size: [width, height],
        format: 'rgba16float',
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      }),
      depth = device.createTexture({
        label: 'capture depth',
        size: [width, height],
        format: depthFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    try {
      this.scene = new SceneTarget(device, color, depth, samples);
    } catch (error) {
      color.destroy();
      depth.destroy();
      throw error;
    }
    this.device = device;
    this.color = color;
    this.depth = depth;
    this.width = width;
    this.height = height;
    this.key = key;
  }
  dispose(): void {
    this.scene?.dispose();
    this.color?.destroy();
    this.depth?.destroy();
    this.scene = this.color = this.depth = this.device = undefined;
    this.width = this.height = 0;
    this.key = '';
  }
}

/** @internal One capture: what to draw, through which camera, into which target. */
export interface CaptureJob {
  readonly camera: Camera;
  readonly target: CaptureTarget;
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly exclude?: Iterable<Mesh>;
  readonly filter: CapturePassFilter;
  /** The capturing object; its own surface pass skips itself while `activeCapture()` returns it. */
  readonly owner: object;
  /** Runs inside the capture's frame graph after the scene is drawn and resolved (face copies, mips). */
  finish?(c: CapturePassContext): void;
}

let active: CaptureJob | null = null;
/** @internal The object whose capture is rendering, or null. */
export const activeCapture = (): object | null => active?.owner ?? null;

// The capture's first and last passes: redirect into the job's target with linear output, then resolve and restore.
let saved: Pick<CapturePassContext, 'color' | 'depth' | 'format' | 'descriptor' | 'width' | 'height'> & {
    owner: unknown;
  },
  drawn = false;
const BEGIN: FramePass = {
  name: 'capture:begin',
  order: -1e300,
  execute: (c) => {
    const job = active;
    if (c.backend !== 'webgpu' || !job) return;
    const target = job.target;
    target.ensure(
      c.device,
      job.width,
      job.height,
      c.descriptor.multisample?.count ?? 1,
      c.descriptor.depthStencil?.format ?? 'depth32float',
    );
    saved = {
      color: c.color,
      depth: c.depth,
      format: c.format,
      descriptor: c.descriptor,
      width: c.width,
      height: c.height,
      owner: (c as unknown as Record<symbol, unknown>)[OWNER],
    };
    target.scene!.begin(c);
    c.width = job.width;
    c.height = job.height;
    c.shader = c.shader.replace(DISPLAY, 'return vec4f(linear,1);');
    drawn = true;
  },
};
const END: FramePass = {
  name: 'capture:end',
  order: 1e300,
  execute: (c) => {
    const job = active;
    if (c.backend !== 'webgpu' || !job || !drawn) return;
    job.target.scene!.resolve(c.encoder);
    c.color = saved.color;
    c.depth = saved.depth;
    c.format = saved.format;
    c.descriptor = saved.descriptor;
    c.width = saved.width;
    c.height = saved.height;
    (c as unknown as Record<symbol, unknown>)[OWNER] = saved.owner;
    job.finish?.(c);
  },
};

// Core's FrameGraph keeps its passes in one private array (the one holding the built-in 'main' pass); its field name
// is not public (and is shortened in the published build), so it is found by shape and only read.
function passArray(graph: FrameGraph): readonly FramePass[] | undefined {
  for (const value of Object.values(graph))
    if (
      Array.isArray(value) &&
      value.some((pass) => pass?.name === 'main' && pass.order === 0 && typeof pass.execute === 'function')
    )
      return value as FramePass[];
  return undefined;
}
const graphs = new WeakMap<
  FrameGraph,
  { passes: readonly FramePass[]; revision: number; filter: CapturePassFilter; graph: FrameGraph }
>();

/**
 * @internal Renders `job` through `engine.render({camera, delta: 0})` with a frame graph of the filtered passes
 * (rebuilt only when the engine's graph or the filter changes), the job's layers and excluded meshes. False when the
 * frame did not draw (WebGPU device being restored).
 */
export function captureScene(engine: EngineKernel, job: CaptureJob): boolean {
  // `render({camera})` draws the default scene: swap its graph for the capture's.
  const runtime = engineRuntime(engine),
    frameGraph = runtime.scene.frameGraph,
    passes = passArray(frameGraph);
  if (!passes)
    throw new MargoError(
      'unsupported',
      "Scene capture does not recognise core's frame graph; update @margoengine/core and @margoengine/environment together",
    );
  if (active)
    throw new MargoError(
      'state',
      'A scene capture is already rendering; call update() outside frame passes and other captures',
    );
  let cached = graphs.get(frameGraph);
  if (!cached || cached.passes !== passes || cached.revision !== frameGraph.revision || cached.filter !== job.filter) {
    const graph = new FrameGraph();
    graph.add(BEGIN);
    for (const pass of passes)
      if (pass.name !== 'main' && job.filter({ name: pass.name, order: pass.order }))
        graph.add({ name: pass.name, order: pass.order, execute: pass.execute });
    graph.add(END);
    cached = { passes, revision: frameGraph.revision, filter: job.filter, graph };
    graphs.set(frameGraph, cached);
  }
  const host = runtime.scene as unknown as { frameGraph: FrameGraph };
  active = job;
  drawn = false;
  host.frameGraph = cached.graph;
  try {
    withHidden(engine, job.layers, job.exclude, () => engine.render({ camera: job.camera, delta: 0 }));
  } finally {
    host.frameGraph = frameGraph;
    active = null;
  }
  return drawn;
}

/**
 * Turns WebGPU (reversed-Z, depth 1 at the near plane) projection `p` into an oblique one whose near plane is the
 * view-space plane `plane` (x, y, z, w; points with `plane · (v, 1) >= 0` stay), after Lengyel's oblique near-plane
 * clipping (JGT 2005): row 2 becomes row 3 minus a scaled plane, the scale chosen so the new far plane passes through
 * the frustum corner that lies farthest in front of the plane. Works for perspective and orthographic `p`. Returns
 * false, leaving `p` unchanged, when no part of the frustum lies in front of the plane (nothing to draw).
 */
export function obliqueNearPlane(p: Float64Array, plane: ArrayLike<number>): boolean {
  const inverse = invertMatrix(p, new Float64Array(16));
  if (!inverse) return false;
  // The plane in clip space: plane (row) times the inverse projection.
  const clip = [0, 1, 2, 3].map(
    (c) =>
      plane[0] * inverse[c * 4] +
      plane[1] * inverse[c * 4 + 1] +
      plane[2] * inverse[c * 4 + 2] +
      plane[3] * inverse[c * 4 + 3],
  );
  // Largest plane distance over the clip volume's corners (x, y in -1..1, depth 0..1, w = 1).
  const reach = Math.abs(clip[0]) + Math.abs(clip[1]) + Math.max(0, clip[2]) + clip[3];
  if (!(reach > 0) || !Number.isFinite(reach)) return false;
  const scale = 1 / reach;
  for (let c = 0; c < 4; c++) p[c * 4 + 2] = p[c * 4 + 3] - scale * plane[c];
  return true;
}

/**
 * Core's perspective projection (`Camera.update` without a `project` hook) for WebGPU, so a capture camera can wrap it.
 */
export function perspective(out: Float64Array, fov: number, aspect: number, near: number, far: number): void {
  const f = 1 / Math.tan((fov * Math.PI) / 360),
    d = near - far;
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = -near / d;
  out[11] = -1;
  out[14] = (-far * near) / d;
}

/**
 * View-space plane of the world plane `n · p + w >= 0` for a look-at view built as core's `Camera.update` builds it
 * from `eye`, `target` and `up`.
 */
export function viewPlane(
  eye: ArrayLike<number>,
  target: ArrayLike<number>,
  up: ArrayLike<number>,
  n: ArrayLike<number>,
  w: number,
  out: Float64Array,
): boolean {
  let zx = eye[0] - target[0],
    zy = eye[1] - target[1],
    zz = eye[2] - target[2];
  const zl = Math.hypot(zx, zy, zz);
  if (!zl) return false;
  zx /= zl;
  zy /= zl;
  zz /= zl;
  let xx = up[1] * zz - up[2] * zy,
    xy = up[2] * zx - up[0] * zz,
    xz = up[0] * zy - up[1] * zx;
  const xl = Math.hypot(xx, xy, xz);
  if (!xl) return false;
  xx /= xl;
  xy /= xl;
  xz /= xl;
  const yx = zy * xz - zz * xy,
    yy = zz * xx - zx * xz,
    yz = zx * xy - zy * xx;
  out[0] = n[0] * xx + n[1] * xy + n[2] * xz;
  out[1] = n[0] * yx + n[1] * yy + n[2] * yz;
  out[2] = n[0] * zx + n[1] * zy + n[2] * zz;
  out[3] = n[0] * eye[0] + n[1] * eye[1] + n[2] * eye[2] + w;
  return true;
}
