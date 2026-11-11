import type { Camera } from '@margoengine/core';
import { rangeError } from '../../shared/errors.js';
import type { LineBatches } from './batch.js';
import { lineFrame, type FrameExtension } from './extension.js';
import type { Lines } from './lines.js';
import { frameRows } from './math.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
/** Full-image pixel coordinate system for a cropped rendering camera. */
export interface LineCameraTile {
  /** Full, uncropped view-projection matrix. Copied on assignment. */
  readonly matrix: ArrayLike<number>;
  readonly fullWidth: number;
  readonly fullHeight: number;
  /** Output tile rectangle in full-image pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface TileState extends Omit<LineCameraTile, 'matrix'> {
  matrix: Float32Array;
}
const tiles = new WeakMap<Camera, TileState>();
/** Frame layouts already made with the tile row. */
const wide = new WeakSet<GPUBindGroupLayout>();
const FRAME_BYTES = 112;
type Framed = Pick<Lines, never> & {
  device?: GPUDevice;
  layouts?: { frame: GPUBindGroupLayout; style: GPUBindGroupLayout; pipeline: GPUPipelineLayout };
  frameBuffer?: GPUBuffer;
  frameGroup?: GPUBindGroup;
  frameData: Float32Array;
  pipelines: Map<unknown, GPURenderPipeline>;
};
/**
 * Swaps a renderer's Frame layout, buffer, group and data for the tile-row ones, once per layout, and drops the pipelines
 * made with the old layout. The old buffer is left to the collector, as a pass this frame may already hold it.
 */
function widen(renderer: Framed): GPUDevice | undefined {
  const { device, layouts } = renderer;
  if (!device || !layouts || wide.has(layouts.frame)) return;
  const frame = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: FRAME_BYTES },
      },
    ],
  });
  wide.add(frame);
  renderer.layouts = {
    frame,
    style: layouts.style,
    pipeline: device.createPipelineLayout({ bindGroupLayouts: [frame, layouts.style] }),
  };
  renderer.pipelines.clear();
  const buffer = (renderer.frameBuffer = device.createBuffer({
    size: FRAME_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  }));
  renderer.frameData = new Float32Array(FRAME_BYTES / 4);
  renderer.frameGroup = device.createBindGroup({ layout: frame, entries: [{ binding: 0, resource: { buffer } }] });
  return device;
}
const BASE_FRAME = 'struct Frame{viewProj:mat4x4f,viewport:vec4f,extra:vec4f}',
  VERTEX_END = '\n  return o;\n}';
/** Capture vertices share one subpixel grid before applying a tile's integer pixel translation. */
const tileClipWGSL = /* wgsl */ `fn captureClip(c:vec4f)->vec4f{
  if(frame.extra.y<0.5){return c;}
  let pixel=round(c.xy/c.w*0.5*frame.viewport.xy*256.0)/256.0;
  let translated=pixel+frame.tile.zw*frame.viewport.xy/(2.0*frame.tile.xy);
  return vec4f(translated*2.0*frame.tile.xy/frame.viewport.xy*c.w,c.zw);
}`;
/**
 * The tile row of the Frame uniform (full image over tile size, tile offset in tile clip units) and the capture step at
 * the end of every vertex function. A frame whose camera has no tile writes (1, 1, 0, 0) and flag 0, and its vertices
 * pass through unchanged.
 */
const tileFrame: FrameExtension = {
  lines(lines) {
    const target = lines as unknown as Framed & {
        modules: Map<string, GPUShaderModule>;
        frameBits: Uint32Array;
        frameWritten: Uint32Array;
        frameValid: boolean;
        fogGpu?: { layout: GPUBindGroupLayout; pipeline: GPUPipelineLayout };
      },
      device = widen(target);
    if (!device) return;
    target.modules.clear();
    target.frameBits = new Uint32Array(target.frameData.buffer);
    target.frameWritten = new Uint32Array(FRAME_BYTES / 4);
    target.frameValid = false;
    const fog = target.fogGpu,
      { frame, style } = target.layouts!;
    if (fog) fog.pipeline = device.createPipelineLayout({ bindGroupLayouts: [frame, style, fog.layout] });
  },
  batches(batches: LineBatches, shader) {
    const target = batches as unknown as Framed & { module?: GPUShaderModule },
      device = widen(target);
    if (device) target.module = device.createShaderModule({ code: tileFrame.shader(shader) });
  },
  shader: (code) =>
    code
      .replace(BASE_FRAME, `${BASE_FRAME.slice(0, -1)},tile:vec4f}\n${tileClipWGSL}`)
      .replaceAll(VERTEX_END, `\n  o.clip=captureClip(o.clip);${VERTEX_END}`),
  fill(data, matrix, camera, width, height, ratio, viewHeight, encode) {
    const tile = matrix === camera.matrix ? tiles.get(camera) : undefined;
    if (tile) {
      matrix = tile.matrix;
      ratio *= tile.fullWidth / width;
      width = tile.fullWidth;
      height = viewHeight = tile.fullHeight;
      // The focal length and orthographic scale come from the uncropped projection.
      camera = { fov: camera.fov, matrix: tile.matrix } as Camera;
    }
    frameRows(data, matrix, camera, width, height, ratio, viewHeight, encode);
    data[21] = tile ? 1 : 0;
    data.set(
      tile
        ? [
            tile.fullWidth / tile.width,
            tile.fullHeight / tile.height,
            (tile.fullWidth - 2 * tile.x - tile.width) / tile.width,
            (2 * tile.y + tile.height - tile.fullHeight) / tile.height,
          ]
        : [1, 1, 0, 0],
      24,
    );
  },
};
/**
 * Keeps line joins, widths, dashes and edge distances in the whole image's coordinate system, applying the tile
 * crop only to the completed vertex. Returns an idempotent remover. Does not alter the camera or other views.
 * Use with a camera cropped to the same tile; applies to Lines and LineBatch, including their shader variants.
 * The first call widens every line renderer's Frame uniform (96 to 112 bytes) and adds the capture step to its shaders
 * for the rest of the page; a page that never calls it keeps the base Frame and shaders.
 */
export function setLineCameraTile(camera: Camera, tile: LineCameraTile): () => void {
  if (
    tile.matrix.length !== 16 ||
    !Array.from(tile.matrix).every(Number.isFinite) ||
    ![tile.fullWidth, tile.fullHeight, tile.width, tile.height].every((n) => Number.isSafeInteger(n) && n > 0) ||
    ![tile.x, tile.y].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    tile.x + tile.width > tile.fullWidth ||
    tile.y + tile.height > tile.fullHeight
  )
    throw rangeError('Line tile needs a finite matrix and a positive rectangle inside the full image', 'arguments');
  lineFrame.hook = tileFrame;
  const state = { ...tile, matrix: Float32Array.from(tile.matrix) };
  tiles.set(camera, state);
  return () => {
    if (tiles.get(camera) === state) tiles.delete(camera);
  };
}
