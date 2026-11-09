// The voxel path tracer's route on the WebGL2 compatibility layer, loaded by import() only there (the WebGL2 roadmap,
// "Package routes"). `trace` stores four vec4 sums per pixel and adds to them, which would put it on the layer's CPU tier,
// and the scatter tier would run the whole path once per stored word. Here the WebGPU kernel's own sample loop runs once
// per pixel in a fragment shader writing four rgba32float targets, and a small kernel adds them into the image buffers,
// where the WebGPU kernel stores them. Every other kernel runs as it stands on the layer's own tiers.
import { MargoError } from '@margoengine/math/errors';
import { FRAME, TRACE } from './shaders.js';
import { FLAG_SPLIT } from './layout.js';

declare const GPUShaderStage: { FRAGMENT: number; COMPUTE: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };

const stale = () =>
  new MargoError(
    'unsupported',
    'VoxelPathTracer on WebGL2 needs the shader its compatibility route was written for; update the edits in voxel-pathtracer/src/compat.ts',
  );
const once = (code: string, from: string, to: string): string => {
  if (code.split(from).length !== 2) throw stale();
  return code.replace(from, to);
};

const ENTRY = '@compute @workgroup_size(8,8) fn trace(@builtin(global_invocation_id) gid:vec3u) {';
const LOOP = ' var c=vec4f(0.0);var a=vec4f(0.0);var nn=vec4f(0.0);var cs=vec4f(0.0);';
const STORES = ' if(f.tile.z==0u){accum[slot]=c;';
const IMAGES = [
  '@group(0) @binding(6) var<storage,read_write> accum:array<vec4f>;\n',
  '@group(0) @binding(7) var<storage,read_write> albedo:array<vec4f>;\n',
  '@group(0) @binding(8) var<storage,read_write> normals:array<vec4f>;\n',
  '@group(0) @binding(10) var<storage,read_write> caustics:array<vec4f>;\n',
];

/** `trace` as a fragment shader: the WebGPU kernel's sample loop, unchanged, with the sums as the outputs. */
export function fragmentTrace(code = TRACE): string {
  const entry = code.indexOf(ENTRY),
    from = code.indexOf(LOOP, entry),
    to = code.indexOf(STORES, from);
  if (entry < 0 || from < 0 || to < 0) throw stale();
  return `${IMAGES.reduce((text, line) => once(text, line, ''), code.slice(0, entry))}
struct Sums {@location(0) c:vec4f,@location(1) a:vec4f,@location(2) n:vec4f,@location(3) s:vec4f}
@vertex fn fill(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 return vec4f(f32(i&1u)*4.0-1.0,f32(i>>1u)*4.0-1.0,0.0,1.0);
}
@fragment fn sums(@builtin(position) at:vec4f)->Sums {
 let gid=vec2u(at.xy);
 let px=vec2u(gid.x+f.image.z,gid.y+f.image.w);
 let pixel=px.y*f.image.x+px.x;
${code.slice(from, to)} return Sums(c,a,nn,cs);
}
`;
}

/** Adds one dispatch's sums into the image buffers as `trace` does on WebGPU: a run's first samples replace them. */
export const ADD = /* wgsl */ `${FRAME}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var<storage,read_write> accum:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> albedo:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> normals:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> caustics:array<vec4f>;
@group(1) @binding(0) var sumC:texture_2d<f32>;
@group(1) @binding(1) var sumA:texture_2d<f32>;
@group(1) @binding(2) var sumN:texture_2d<f32>;
@group(1) @binding(3) var sumS:texture_2d<f32>;
@compute @workgroup_size(8,8) fn add(@builtin(global_invocation_id) g:vec3u) {
 if(g.x>=f.tile.x||g.y>=f.tile.y){return;}
 let slot=g.y*f.tile.x+g.x;
 let t=vec2i(g.xy);
 let first=f.tile.z==0u;
 accum[slot]=select(accum[slot],vec4f(0.0),first)+textureLoad(sumC,t,0);
 albedo[slot]=select(albedo[slot],vec4f(0.0),first)+textureLoad(sumA,t,0);
 normals[slot]=select(normals[slot],vec4f(0.0),first)+textureLoad(sumN,t,0);
 if((f.config.z&${FLAG_SPLIT}u)!=0u){caustics[slot]=select(caustics[slot],vec4f(0.0),first)+textureLoad(sumS,t,0);}
}
`;

/** What a trace bind group binds; the route binds the same buffers in its own layouts. */
export interface TraceInputs {
  readonly frame: GPUBufferBinding;
  readonly table0: GPUBuffer;
  readonly voxels: GPUBuffer;
  readonly scene: GPUBuffer;
  readonly materials: GPUBuffer;
  readonly env: GPUBuffer;
  readonly tables: GPUBuffer;
  /** accum, albedo, normals, caustics. */
  readonly images: readonly GPUBufferBinding[];
}

/** The route's stand-in for the `trace` compute pipeline. */
export interface RouteKernel {
  readonly sums: GPURenderPipeline;
}

const FORMAT = 'rgba32float';

/** Runs `trace` on the WebGL2 layer: per dispatch of the WebGPU route, one fragment draw of the sums and the add kernel. */
export class TraceRoute {
  readonly #device: GPUDevice;
  readonly #drawLayout: GPUBindGroupLayout;
  readonly #addLayout: GPUBindGroupLayout;
  readonly #sumsLayout: GPUBindGroupLayout;
  readonly #module: GPUShaderModule;
  readonly #groups = new WeakMap<TraceInputs, { draw: GPUBindGroup; add: GPUBindGroup }>();
  #add: Promise<GPUComputePipeline> | undefined;
  #addPipeline: GPUComputePipeline | undefined;
  #targets:
    | { width: number; height: number; textures: GPUTexture[]; views: GPUTextureView[]; group: GPUBindGroup }
    | undefined;

  constructor(device: GPUDevice, source = TRACE) {
    this.#device = device;
    const F = GPUShaderStage.FRAGMENT,
      C = GPUShaderStage.COMPUTE,
      buffer = (binding: number, type: GPUBufferBindingType, visibility: number) => ({
        binding,
        visibility,
        buffer: { type },
      });
    this.#drawLayout = device.createBindGroupLayout({
      entries: [
        buffer(0, 'uniform', F),
        buffer(1, 'uniform', F),
        buffer(2, 'read-only-storage', F),
        buffer(3, 'read-only-storage', F),
        buffer(4, 'read-only-storage', F),
        buffer(5, 'read-only-storage', F),
        buffer(9, 'uniform', F),
      ],
    });
    this.#addLayout = device.createBindGroupLayout({
      entries: [buffer(0, 'uniform', C), ...[1, 2, 3, 4].map((b) => buffer(b, 'storage', C))],
    });
    this.#sumsLayout = device.createBindGroupLayout({
      entries: [0, 1, 2, 3].map((binding) => ({
        binding,
        visibility: C,
        texture: { sampleType: 'unfilterable-float' as const },
      })),
    });
    this.#module = device.createShaderModule({ code: fragmentTrace(source) });
  }

  /** Compiles the fragment shader (with `TABLES` when the scene has model tables) and, once, the add kernel. */
  async kernel(tables: boolean): Promise<RouteKernel> {
    const device = this.#device;
    this.#add ??= device.createComputePipelineAsync({
      label: 'voxel-pathtracer add',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.#addLayout, this.#sumsLayout] }),
      compute: { module: device.createShaderModule({ code: ADD }), entryPoint: 'add' },
    });
    const [sums, add] = await Promise.all([
      device.createRenderPipelineAsync({
        label: 'voxel-pathtracer trace',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.#drawLayout] }),
        vertex: { module: this.#module, entryPoint: 'fill' },
        fragment: {
          module: this.#module,
          entryPoint: 'sums',
          targets: [{ format: FORMAT }, { format: FORMAT }, { format: FORMAT }, { format: FORMAT }],
          ...(tables ? { constants: { TABLES: 1 } } : {}),
        },
      }),
      this.#add,
    ]);
    this.#addPipeline = add;
    return { sums };
  }

  #sized(width: number, height: number) {
    const held = this.#targets;
    if (held && held.width >= width && held.height >= height) return held;
    const device = this.#device,
      w = Math.max(width, held?.width ?? 0),
      h = Math.max(height, held?.height ?? 0);
    for (const t of held?.textures ?? []) t.destroy();
    const textures = [0, 1, 2, 3].map(() =>
        device.createTexture({
          label: 'voxel-pathtracer sums',
          size: [w, h],
          format: FORMAT,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }),
      ),
      views = textures.map((t) => t.createView());
    this.#targets = {
      width: w,
      height: h,
      textures,
      views,
      group: device.createBindGroup({
        layout: this.#sumsLayout,
        entries: views.map((resource, binding) => ({ binding, resource })),
      }),
    };
    return this.#targets;
  }

  #bound(i: TraceInputs) {
    let groups = this.#groups.get(i);
    if (!groups) {
      const device = this.#device,
        buffer = (binding: number, b: GPUBuffer) => ({ binding, resource: { buffer: b } });
      groups = {
        draw: device.createBindGroup({
          layout: this.#drawLayout,
          entries: [
            { binding: 0, resource: i.frame },
            buffer(1, i.table0),
            buffer(2, i.voxels),
            buffer(3, i.scene),
            buffer(4, i.materials),
            buffer(5, i.env),
            buffer(9, i.tables),
          ],
        }),
        add: device.createBindGroup({
          layout: this.#addLayout,
          entries: [
            { binding: 0, resource: i.frame },
            ...i.images.map((resource, k) => ({ binding: k + 1, resource })),
          ],
        }),
      };
      this.#groups.set(i, groups);
    }
    return groups;
  }

  /** One dispatch of `trace`: `width` x `rows` pixels. */
  encode(encoder: GPUCommandEncoder, kernel: RouteKernel, inputs: TraceInputs, width: number, rows: number): void {
    const targets = this.#sized(width, rows),
      groups = this.#bound(inputs),
      draw = encoder.beginRenderPass({
        label: 'voxel-pathtracer trace',
        colorAttachments: targets.views.map((view) => ({ view, loadOp: 'load' as const, storeOp: 'store' as const })),
      });
    draw.setPipeline(kernel.sums);
    draw.setBindGroup(0, groups.draw);
    draw.setViewport(0, 0, width, rows, 0, 1);
    draw.setScissorRect(0, 0, width, rows);
    draw.draw(3);
    draw.end();
    const add = encoder.beginComputePass({ label: 'voxel-pathtracer add' });
    add.setPipeline(this.#addPipeline as GPUComputePipeline);
    add.setBindGroup(0, groups.add);
    add.setBindGroup(1, targets.group);
    add.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(rows / 8));
    add.end();
  }

  destroy(): void {
    for (const t of this.#targets?.textures ?? []) t.destroy();
    this.#targets = undefined;
  }
}
