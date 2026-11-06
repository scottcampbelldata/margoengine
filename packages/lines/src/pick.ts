/// <reference lib="esnext.disposable" preserve="true" />
// GPU picking of lines, as an overlay of `@margoengine/selection`'s Picking: lines draw into its 3 x 3 pick tile after the
// meshes, over the meshes' depth, so one pick answers the nearest of both. Nothing here imports selection.
import type { Camera, EngineKernel, Mesh } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { VERTICES_PER_SEGMENT } from './geometry.js';
import type { Line } from './line.js';
import type { Lines } from './lines.js';
import { clipCut, lineShader } from './shader.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUShaderStage: { FRAGMENT: number };

/** What `Picking` hands an overlay for one pick. */
export interface LinePickContext {
  encoder: GPUCommandEncoder;
  /** The r32uint pick tile, 3 x 3 pixels around the picked pixel. */
  color: GPUTextureView;
  /** Its depth32float depth, holding the meshes already drawn. */
  depth: GPUTextureView;
  /** The camera's view-projection matrix, cropped to the tile. */
  matrix: Float32Array;
  camera: Camera;
  /** The picked view's rectangle in drawing-buffer pixels. */
  rect: readonly number[];
  /** The ID of this overlay's item 0. */
  firstId: number;
}

/** What `LinePicking.attach` needs of `@margoengine/selection`'s Picking. */
export interface LinePickHost {
  addOverlay(overlay: {
    drawPick(context: LinePickContext): void;
    pickHit(index: number): { mesh: Mesh; line: object; segment: number } | null;
  }): () => void;
}

/** One line's part of the IDs of the last pick. */
interface Entry {
  line: Line;
  first: number;
}

interface Gpu {
  device: GPUDevice;
  frame: GPUBuffer;
  frameGroup: GPUBindGroup;
  baseLayout: GPUBindGroupLayout;
  base?: GPUBuffer;
  baseGroup?: GPUBindGroup;
  depthTested: GPURenderPipeline;
  onTop: GPURenderPipeline;
}

/** Bytes between two lines' ID bases: WebGPU's dynamic offset alignment. */
const BASE_STRIDE = 256;
/** IDs an overlay owns in Picking. A pick past this many segments in all stops at the line that reaches it. */
const MAX_IDS = 2 ** 28;

const pickFragment = /* wgsl */ `
@group(2) @binding(0) var<uniform> pickBase:vec4u;
@fragment fn fragment(i:Out)->@location(0) u32{
  // Hits where the line is drawn: the antialiased geometry's outer ramp does not count, dash gaps do.
  if(style.b.z>0.0&&clamp(i.edge.y+0.5-abs(i.edge.x),0.0,1.0)*clamp(0.5-i.edge.z,0.0,1.0)*clamp(0.5-i.edge.w,0.0,1.0)<0.5){discard;}
  ${clipCut}
  return pickBase.x+i.segment;
}`;

/** The line shader with the segment carried to the fragment and the fragment replaced by an ID write. */
export function linePickShader(): string {
  const end = lineShader.indexOf('fn encode('),
    fields = '@location(3) world:vec3f,\n',
    world = '  o.world=mix(';
  if (end < 0 || !lineShader.includes(fields) || !lineShader.includes(world))
    throw new MargoError('unsupported', 'Line picking needs the line shader it was written for; update its edits with it');
  return (
    lineShader
      .slice(0, end)
      .replace(fields, `${fields}  @location(4) @interpolate(flat) segment:u32,\n`)
      .replace(world, `  o.segment=ii;\n${world}`) + pickFragment
  );
}

/**
 * Makes the lines of a `Lines` plugin pickable by `@margoengine/selection`'s `Picking`, and so by `engine.pick` once
 * Picking is attached. Lines and meshes share one depth test: a pick answers whichever is nearest at the pixel, and a
 * line behind a mesh is not hit. `onTop` lines win as they draw. `hit.line` and `hit.segment` name what was hit;
 * `hit.mesh` is the mesh a line follows or else an empty stand-in mesh, as `engine.pick` can only answer meshes
 * (`lineOf` maps it back). Dash gaps hit, parts cut by clipping planes do not.
 */
export class LinePicking {
  private gpu?: Gpu;
  private entries: Entry[] = [];
  private readonly standIns = new Map<Line, Mesh>();
  private readonly owners = new Map<Mesh, Line>();
  private readonly frameData = new Float32Array(24);
  private remove?: () => void;

  /**
   * Registers `lines` with `picking`; undo with `dispose`.
   * @throws MargoError `state` when `lines` is not attached to an engine yet.
   */
  static attach(picking: LinePickHost, lines: Lines): LinePicking {
    if (!lines['engine']) throw new MargoError('state', 'Attach Lines to the engine before LinePicking.attach');
    const value = new LinePicking(lines);
    value.remove = picking.addOverlay(value);
    lines['watchers'].add(value);
    for (const line of lines.lines) value.added(line);
    return value;
  }
  private constructor(readonly lines: Lines) {}

  /** The line `mesh` stands in for, from a `hit.mesh` or an `engine.pick` answer; null for any other mesh. */
  lineOf(mesh: Mesh | null): Line | null {
    return (mesh && this.owners.get(mesh)) ?? null;
  }

  private resources(device: GPUDevice, layouts: NonNullable<Lines['layouts']>): Gpu {
    if (this.gpu?.device === device) return this.gpu;
    const frame = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      baseLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
          },
        ],
      }),
      layout = device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layouts.style, baseLayout] }),
      module = device.createShaderModule({ code: linePickShader() }),
      pipeline = (depthCompare: GPUCompareFunction) =>
        device.createRenderPipeline({
          layout,
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: 'r32uint' }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare },
        });
    return (this.gpu = {
      device,
      frame,
      frameGroup: device.createBindGroup({
        layout: layouts.frame,
        entries: [{ binding: 0, resource: { buffer: frame } }],
      }),
      baseLayout,
      depthTested: pipeline('greater-equal'),
      onTop: pipeline('always'),
    });
  }

  /**
   * @internal A line joined: its stand-in is made now, because adding a mesh during a pick would void that pick's answer.
   */
  added(line: Line): void {
    if (this.standIns.has(line)) return;
    const mesh = (this.lines['engine'] as unknown as EngineKernel).createMesh();
    this.standIns.set(line, mesh);
    this.owners.set(mesh, line);
  }

  /** @internal A line left: its stand-in goes with it. */
  removed(line: Line): void {
    const mesh = this.standIns.get(line);
    if (!mesh) return;
    this.standIns.delete(line);
    this.owners.delete(mesh);
    mesh.dispose();
  }

  /** @internal Picking's turn: draws every line into the tile with IDs from `firstId`. */
  drawPick(c: LinePickContext): void {
    const lines = this.lines,
      device = lines['device'],
      layouts = lines['layouts'],
      engine = lines['engine'] as unknown as EngineKernel | undefined;
    this.entries = [];
    if (!device || !layouts || !engine) return;
    lines['collect'](engine);
    const lists = lines['drawLists'],
      depthTested = [...lists[0], ...lists[1]],
      top = [...lists[2], ...lists[3]],
      count = depthTested.length + top.length;
    if (count) {
      const gpu = this.resources(device, layouts),
        bases = new Uint32Array((count * BASE_STRIDE) / 4);
      if ((gpu.base?.size ?? 0) < bases.byteLength) {
        gpu.base?.destroy();
        gpu.base = device.createBuffer({
          size: bases.byteLength * 2,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        gpu.baseGroup = device.createBindGroup({
          layout: gpu.baseLayout,
          entries: [{ binding: 0, resource: { buffer: gpu.base, size: 16 } }],
        });
      }
      const canvas = engine.canvas,
        ratio = canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
      // A 3 x 3 target under the cropped matrix keeps every distance in drawing-buffer pixels.
      lines['fillFrame'](this.frameData, c.matrix, c.camera, 3, 3, ratio, c.rect[3], 0);
      device.queue.writeBuffer(gpu.frame, 0, this.frameData as Float32Array<ArrayBuffer>);
      const pass = c.encoder.beginRenderPass({
        colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: c.depth, depthLoadOp: 'load', depthStoreOp: 'store' },
      });
      pass.setBindGroup(0, gpu.frameGroup);
      let next = 0,
        slot = 0;
      for (const [list, pipeline] of [
        [depthTested, gpu.depthTested],
        [top, gpu.onTop],
      ] as const) {
        pass.setPipeline(pipeline);
        for (const [line, r] of list) {
          const segments = line.segmentCount;
          if (next + segments > MAX_IDS) break;
          bases[(slot * BASE_STRIDE) / 4] = c.firstId + next;
          this.entries.push({ line, first: next });
          pass.setBindGroup(1, r.group);
          pass.setBindGroup(2, gpu.baseGroup!, [slot * BASE_STRIDE]);
          pass.draw(VERTICES_PER_SEGMENT, segments);
          next += segments;
          slot++;
        }
      }
      device.queue.writeBuffer(gpu.base!, 0, bases);
      pass.end();
    }
    for (const list of lists) list.length = 0;
  }

  /** @internal The hit of ID `index` of the last `drawPick`. */
  pickHit(index: number): { mesh: Mesh; line: Line; segment: number } | null {
    const entries = this.entries;
    let low = 0,
      high = entries.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (entries[middle].first <= index) low = middle;
      else high = middle - 1;
    }
    const entry = entries[low];
    if (!entry) return null;
    const mesh = entry.line.attachedMesh ?? this.standIns.get(entry.line);
    return mesh ? { mesh, line: entry.line, segment: index - entry.first } : null;
  }

  /** Leaves Picking and frees the stand-in meshes and GPU buffers. */
  dispose(): void {
    this.remove?.();
    this.remove = undefined;
    this.lines['watchers'].delete(this);
    for (const mesh of this.standIns.values()) mesh.dispose();
    this.standIns.clear();
    this.owners.clear();
    this.entries = [];
    this.gpu?.frame.destroy();
    this.gpu?.base?.destroy();
    this.gpu = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
