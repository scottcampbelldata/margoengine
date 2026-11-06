// The Hi-Z depth pyramid both culling classes test against: occluders are drawn depth-only into `pass`, then `encode`
// reduces that depth to a pyramid of the farthest depth per texel. The owner keeps the `Cull` uniform of shaders.ts.
import { depthShader } from './shaders.js';

declare const GPUBufferUsage: { STORAGE: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };

// Occlusion is exact only when core's shader still computes clip positions unchanged and discards nothing beyond
// its single-sided rule; section planes and similar fragment clipping fall back to frustum culling.
export const exactShader = (shader: string): boolean =>
  shader.includes('let p=model*vec4f(i.position,1);\nvar o:Output;o.clip=frame.camera*p;') &&
  shader.split('discard').length === 2;

// Nearest sphere depth is exact when clip z depends on w alone (perspective: row 2 parallel to row 3) or w is constant
// (orthographic); other projections use the bounding box corners only.
export function depthKind(m: Float32Array): number {
  const [a, b, c] = [m[2], m[6], m[10]],
    [x, y, z] = [m[3], m[7], m[11]],
    row3 = Math.hypot(x, y, z);
  if (!row3) return 2;
  return Math.hypot(b * z - c * y, c * x - a * z, a * y - b * x) <= 1e-6 * Math.hypot(a, b, c) * row3 ? 1 : 0;
}

/** The uniform each pyramid level binds at `level * 256`: its own level number. */
export const levelTable = (): Uint32Array => new Uint32Array(16 * 64).map((_, i) => (i % 64 ? 0 : i / 64));

/** A depth-only occluder pipeline; with `fragment` it applies core's single-sided rule per record. */
export function occluderPipeline(d: GPUDevice, samples: number, fragment: boolean): GPURenderPipeline {
  const module = d.createShaderModule({ code: depthShader });
  return d.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vertex',
      buffers: [
        { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        { arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 2, offset: 0, format: 'uint32' }] },
      ],
    },
    fragment: fragment ? { module, entryPoint: 'fragment', targets: [] } : undefined,
    multisample: { count: samples },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
  });
}

/** The size-dependent half of occlusion: the occluder depth target and the pyramid over it. */
export class Pyramid {
  width = 0;
  height = 0;
  /** Levels of the view last planned, level 0 at full resolution. */
  levels = 0;
  /** The pyramid's texels; bind it as `hiz`. Replaced by `resize`. */
  buffer?: GPUBuffer;
  private depth?: GPUTexture;
  private first?: GPUBindGroup;
  private steps: GPUBindGroup[] = [];
  private readonly target: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthClearValue: 0,
    depthLoadOp: 'clear',
    depthStoreOp: 'store',
  };
  /** The render pass occluders draw in. */
  readonly pass: GPURenderPassDescriptor = { colorAttachments: [], depthStencilAttachment: this.target };

  constructor(
    private readonly device: GPUDevice,
    private readonly samples: number,
    private readonly pipelines: { depth0: GPUComputePipeline; reduce: GPUComputePipeline },
    private readonly uniform: GPUBuffer,
    private readonly table: GPUBuffer,
    /** The `Cull` uniform as words: `plan` writes the level table into it. */
    private readonly words: Uint32Array,
  ) {}

  /** Makes the target and pyramid for views of up to width x height. */
  resize(width: number, height: number): void {
    const d = this.device,
      { depth0, reduce } = this.pipelines;
    this.destroy();
    this.depth = d.createTexture({
      size: [width, height],
      format: 'depth32float',
      sampleCount: this.samples,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.width = width;
    this.height = height;
    const buffer = (this.buffer = d.createBuffer({ size: this.plan(width, height) * 4, usage: GPUBufferUsage.STORAGE })),
      view = this.depth.createView(),
      group = (pipeline: GPUComputePipeline, entries: [number, GPUBindingResource][]) =>
        d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: entries.map(([binding, resource]) => ({ binding, resource })),
        });
    this.target.view = view;
    this.first = group(depth0, [
      [0, { buffer: this.uniform }],
      [5, { buffer }],
      [14, view],
    ]);
    this.steps = Array.from({ length: this.levels }, (_, l) =>
      group(reduce, [
        [0, { buffer: this.uniform }],
        [5, { buffer }],
        [13, { buffer: this.table, offset: l * 256, size: 16 }],
      ]),
    );
  }
  /** Writes the level table (offset, width, height) for a width x height view, sets `levels`, returns the texel count. */
  plan(width: number, height: number): number {
    let w = width,
      h = height,
      offset = 0,
      level = 0;
    for (; ; level++) {
      this.words.set([offset, w, h, 0], 48 + level * 4);
      offset += w * h;
      if (w === 1 && h === 1) break;
      w = Math.ceil(w / 2);
      h = Math.ceil(h / 2);
    }
    this.levels = level + 1;
    return offset;
  }
  /** Records the pyramid of a width x height view, from what occluders drew. */
  encode(pass: GPUComputePassEncoder, width: number, height: number): void {
    const { depth0, reduce } = this.pipelines;
    pass.setPipeline(depth0);
    pass.setBindGroup(0, this.first!);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.setPipeline(reduce);
    for (let l = 1; l < this.levels; l++) {
      pass.setBindGroup(0, this.steps[l]);
      pass.dispatchWorkgroups(Math.ceil(this.words[48 + l * 4 + 1] / 8), Math.ceil(this.words[48 + l * 4 + 2] / 8));
    }
  }
  destroy(): void {
    this.depth?.destroy();
    this.buffer?.destroy();
    this.depth = this.buffer = undefined;
    this.width = this.height = 0;
    this.steps = [];
  }
}
