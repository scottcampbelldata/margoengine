// Render pipelines, command encoders and the replay of command buffers on WebGL2 (W3C WebGPU specification sections
// 10, 13, 17 and 18; Khronos OpenGL ES 3.0 and WebGL 2.0 specifications). Encoders record closures; submit replays
// them against a cache of GL state. Rendering is flipped in y so that row 0 of every target is its top, as in WebGPU
// (the vertex shader negates y and front faces swap), and only the canvas present flips back.
import { fault } from '../../../shared/errors.js';
import { translateWGSL, type GLSLProgram, type GLSLStage } from '../glsl.js';
import type { TextureType } from '../wgsl/types.js';
import { type FormatInfo, hasDepth, hasStencil, VERTEX_FORMATS } from './formats.js';
import type { CompatDevice } from './device.js';
import { type BoundGroup, CompatComputePassEncoder, type CompatComputePipeline } from './compute.js';
import {
  type Bound,
  type CompatBindGroup,
  CompatBindGroupLayout,
  type CompatBuffer,
  type CompatPipelineLayout,
  type CompatSampler,
  type CompatShaderModule,
  type CompatTexture,
  type CompatTextureView,
  type LayoutEntry,
  type TextureStorage,
} from './resources.js';

type Op = (r: Replayer) => void;

const BLEND_FACTORS: Record<string, string> = {
  zero: 'ZERO',
  one: 'ONE',
  src: 'SRC_COLOR',
  'one-minus-src': 'ONE_MINUS_SRC_COLOR',
  'src-alpha': 'SRC_ALPHA',
  'one-minus-src-alpha': 'ONE_MINUS_SRC_ALPHA',
  dst: 'DST_COLOR',
  'one-minus-dst': 'ONE_MINUS_DST_COLOR',
  'dst-alpha': 'DST_ALPHA',
  'one-minus-dst-alpha': 'ONE_MINUS_DST_ALPHA',
  'src-alpha-saturated': 'SRC_ALPHA_SATURATE',
  constant: 'CONSTANT_COLOR',
  'one-minus-constant': 'ONE_MINUS_CONSTANT_COLOR',
};
const BLEND_OPS: Record<string, string> = {
  add: 'FUNC_ADD',
  subtract: 'FUNC_SUBTRACT',
  'reverse-subtract': 'FUNC_REVERSE_SUBTRACT',
  min: 'MIN',
  max: 'MAX',
};
const STENCIL_OPS: Record<string, string> = {
  keep: 'KEEP',
  zero: 'ZERO',
  replace: 'REPLACE',
  invert: 'INVERT',
  'increment-clamp': 'INCR',
  'decrement-clamp': 'DECR',
  'increment-wrap': 'INCR_WRAP',
  'decrement-wrap': 'DECR_WRAP',
};
const TOPOLOGY: Record<string, string> = {
  'point-list': 'POINTS',
  'line-list': 'LINES',
  'line-strip': 'LINE_STRIP',
  'triangle-list': 'TRIANGLES',
  'triangle-strip': 'TRIANGLE_STRIP',
};

interface Attribute {
  readonly location: number;
  readonly slot: number;
  readonly size: number;
  readonly type: number;
  readonly normalized: boolean;
  readonly integer: boolean;
  readonly offset: number;
  readonly stride: number;
  readonly instance: boolean;
}
interface UniformSlot {
  readonly point: number;
  readonly group: number;
  readonly binding: number;
  /** Bytes GL needs bound: the largest block declared at this binding. */
  size: number;
}
interface TextureSlot {
  /** The texture unit, or -1 for a texture read only for its size or level count. */
  unit: number;
  readonly group: number;
  readonly binding: number;
  readonly sampler?: { readonly group: number; readonly binding: number; readonly comparison: boolean };
  readonly type: TextureType;
  readonly levels: WebGLUniformLocation[];
  /** Size uniforms (the view's first level: width, height, depth or layers; see GLSLTexture.size). */
  readonly sizes: WebGLUniformLocation[];
  readonly mipFilters: WebGLUniformLocation[];
  /** textureGather's address modes and comparison uniforms, each read from its sampler (see CompatSampler.modes). */
  readonly modes: { readonly location: WebGLUniformLocation; readonly group: number; readonly binding: number }[];
}
/**
 * A data texture a pipeline reads storage buffers from: one buffer's own (`binding`), or its bind group's shared one
 * (`binding` -1), with the per-draw `ivec4` uniform of each buffer read through it (see GLSLStorage).
 */
interface StorageSlot {
  readonly unit: number;
  readonly group: number;
  readonly binding: number;
  readonly info: { readonly location: WebGLUniformLocation; readonly binding: number }[];
}
interface TargetState {
  readonly blend?: GPUBlendState;
  readonly writeMask: number;
}

/** The blend and write-mask state of a colour target as one string ('' blend for none). */
function targetKey(t: TargetState | null): string {
  const b = t?.blend;
  const blend = b
    ? `${b.color.operation ?? 'add'},${b.color.srcFactor ?? 'one'},${b.color.dstFactor ?? 'zero'},${b.alpha.operation ?? 'add'},${b.alpha.srcFactor ?? 'one'},${b.alpha.dstFactor ?? 'zero'}`
    : '';
  return `${blend}|${t?.writeMask ?? 0}`;
}

/** A GPURenderPipeline: a linked program, its vertex layout and VAO, its fixed-function state and its binding table. */
export class CompatRenderPipeline {
  // When the GLSL went to WebGL2 (device.programs.linkMs).
  private handedOver = 0;
  label: string;
  readonly program: WebGLProgram | null = null;
  readonly vao: WebGLVertexArrayObject | null = null;
  readonly glsl: GLSLProgram | null = null;
  /** Set when the pipeline cannot draw: the message of its validation error. */
  failure: string | null = null;
  readonly attributes: Attribute[] = [];
  readonly uniforms: UniformSlot[] = [];
  readonly textures: TextureSlot[] = [];
  readonly storage: StorageSlot[] = [];
  readonly mode: number;
  readonly cull: number;
  readonly frontFace: number;
  readonly targets: readonly (TargetState | null)[];
  readonly depthStencil?: GPUDepthStencilState;
  readonly alphaToCoverage: boolean;
  readonly sampleCount: number;
  readonly unclippedDepth: boolean;
  baseVertex: WebGLUniformLocation | null = null;
  baseInstance: WebGLUniformLocation | null = null;
  /** Last values of per-program uniforms and VAO bindings, so draws skip unchanged ones. */
  readonly cache = {
    baseVertex: -1,
    baseInstance: -1,
    element: -1,
    pointers: [] as string[],
    levels: new Map<WebGLUniformLocation, number>(),
    sizes: new Map<WebGLUniformLocation, string>(),
    modes: new Map<WebGLUniformLocation, string>(),
    info: new Map<WebGLUniformLocation, string>(),
  };
  /**
   * Without OES_draw_buffers_indexed (ANGLE's OpenGL back end), WebGL2 has one blend state and one write mask for
   * all colour targets: a pipeline whose targets differ draws once per group of targets with the same state, each
   * time with only that group's draw buffers on. Null when one draw does.
   */
  readonly splits: number[][] | null = null;
  /** @internal Sets per-draw uniforms of a program the device built itself (the compute tiers). */
  onDraw: (() => void) | null = null;
  private linked = false;
  private readonly layouts: (CompatBindGroupLayout | null)[];
  private readonly shaders: WebGLShader[] = [];

  constructor(
    readonly device: CompatDevice,
    descriptor: GPURenderPipelineDescriptor,
    private readonly deferLink = false,
    prebuilt?: GLSLProgram,
  ) {
    const gl = device.gl,
      started = performance.now();
    this.label = descriptor.label ?? '';
    const prim = descriptor.primitive ?? {};
    this.mode = device.enum(TOPOLOGY[prim.topology ?? 'triangle-list']);
    this.cull = prim.cullMode === 'front' ? gl.FRONT : prim.cullMode === 'back' ? gl.BACK : 0;
    // y is flipped in the vertex shader, so WebGPU's counter-clockwise front faces are clockwise in GL.
    this.frontFace = prim.frontFace === 'cw' ? gl.CCW : gl.CW;
    this.unclippedDepth = !!prim.unclippedDepth;
    this.depthStencil = descriptor.depthStencil;
    if ((this.depthStencil?.depthBiasClamp ?? 0) !== 0 && !device.ext.polygonOffsetClamp)
      throw device.unsupported('nonzero depthBiasClamp requires EXT_polygon_offset_clamp');
    this.alphaToCoverage = !!descriptor.multisample?.alphaToCoverageEnabled;
    this.sampleCount = descriptor.multisample?.count ?? 1;
    this.targets = [...(descriptor.fragment?.targets ?? [])].map((t) =>
      t ? { blend: t.blend, writeMask: t.writeMask ?? 0xf } : null,
    );
    if (!device.ext.indexed) {
      const groups = new Map<string, number[]>();
      this.targets.forEach((t, i) => {
        if (!t) return;
        const key = targetKey(t);
        groups.set(key, [...(groups.get(key) ?? []), i]);
      });
      if (groups.size > 1) {
        // Each draw after the first must see the depth and stencil the first one saw.
        const ds = descriptor.depthStencil,
          stencilWrites =
            !!ds &&
            (ds.stencilWriteMask ?? 0xffffffff) !== 0 &&
            [ds.stencilFront, ds.stencilBack].some(
              (f) =>
                (f?.passOp ?? 'keep') !== 'keep' ||
                (f?.failOp ?? 'keep') !== 'keep' ||
                (f?.depthFailOp ?? 'keep') !== 'keep',
            );
        if (ds?.depthWriteEnabled || stencilWrites)
          throw device.unsupported(
            "colour targets with different blend states or write masks together with depth or stencil writes (this WebGL2 has no OES_draw_buffers_indexed, so the layer draws once per target state, and later draws would see the first one's depth and stencil)",
          );
        this.splits = [...groups.values()];
      }
    }
    const vertexModule = descriptor.vertex.module as unknown as CompatShaderModule,
      fragmentModule = descriptor.fragment?.module as unknown as CompatShaderModule | undefined;
    const explicit = descriptor.layout !== 'auto' ? (descriptor.layout as unknown as CompatPipelineLayout) : null;
    this.layouts = explicit ? [...explicit.bindGroupLayouts] : [];
    if (!prebuilt && (vertexModule.error || fragmentModule?.error)) {
      this.failure = 'createRenderPipeline: a shader module of the pipeline failed to compile';
      if (!this.deferLink) device.validationError(this.failure);
      return;
    }
    try {
      this.glsl =
        prebuilt ??
        translateWGSL({
          vertex: {
            module: vertexModule.ir as never,
            entryPoint: descriptor.vertex.entryPoint,
            constants: descriptor.vertex.constants as Record<string, number>,
          },
          fragment: descriptor.fragment && {
            module: fragmentModule?.ir as never,
            entryPoint: descriptor.fragment.entryPoint,
            constants: descriptor.fragment.constants as Record<string, number>,
          },
          clipControl: !!device.ext.clipControl,
          points: prim.topology === 'point-list',
          // Storage bindings without a dynamic offset share their bind group's data texture: one unit per group.
          sharedStorage: (group, binding) =>
            !explicit?.bindGroupLayouts[group]?.entries.find((e) => e.binding === binding)?.buffer?.hasDynamicOffset,
          uniformBlockSize: device.adapter.capabilities.limits.MAX_UNIFORM_BLOCK_SIZE,
        });
    } catch (error) {
      if ((error as { code?: string }).code === 'unsupported') throw error;
      this.failure = `createRenderPipeline${this.label ? ` '${this.label}'` : ''}: ${(error as Error).message}`;
      if (!this.deferLink) device.validationError(this.failure);
      return;
    }
    if (device.adapter.tierFormats) {
      const fragment = this.glsl.fragment;
      this.glsl = {
        ...this.glsl,
        fragment: {
          ...fragment,
          source: device.adapter.tierFormats.fragment(
            fragment.source,
            [...(descriptor.fragment?.targets ?? [])],
            fragment.outputs,
          ),
        },
      };
    }
    const inferred = autoLayouts(this.glsl);
    // Prebuilt programs are internal compute lowerings: their layouts retain compute visibility.
    // Validate user render descriptors here, before any backend-specific lowering.
    if (explicit && !prebuilt) {
      for (const [group, required] of inferred.entries()) {
        for (const resource of required.entries) {
          const declared = explicit.bindGroupLayouts[group]?.entries.find((e) => e.binding === resource.binding);
          if (!declared || (declared.visibility & resource.visibility) !== resource.visibility) {
            this.failure = `createRenderPipeline: layout omits group ${group} binding ${resource.binding} or its shader visibility; declare every statically used resource`;
            if (!this.deferLink) device.validationError(this.failure);
            return;
          }
        }
      }
    } else if (!explicit) this.layouts = inferred;
    for (const [slot, layout] of [...(descriptor.vertex.buffers ?? [])].entries()) {
      if (!layout) continue;
      const stride = layout.arrayStride;
      if (stride > 255) throw device.unsupported(`a vertex buffer stride of ${stride} bytes (WebGL allows 255)`);
      for (const a of layout.attributes) {
        const f = VERTEX_FORMATS[a.format];
        if (!f) throw device.unsupported(`vertex format '${a.format}'`);
        if (stride === 0) throw device.unsupported('a vertex buffer stride of 0');
        this.attributes.push({
          location: a.shaderLocation,
          slot,
          size: f[0],
          type: device.enum(f[1]),
          normalized: f[2],
          integer: f[3],
          offset: a.offset,
          stride,
          instance: layout.stepMode === 'instance',
        });
      }
    }
    this.handedOver = performance.now();
    device.programs.count++;
    device.programs.translateMs += this.handedOver - started;
    const program = gl.createProgram() as WebGLProgram;
    for (const stage of [this.glsl.vertex, this.glsl.fragment]) {
      const s = gl.createShader(stage.stage === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER) as WebGLShader;
      gl.shaderSource(s, stage.source);
      gl.compileShader(s);
      gl.attachShader(program, s);
      this.shaders.push(s);
    }
    gl.linkProgram(program);
    this.program = program;
    const vao = gl.createVertexArray() as WebGLVertexArrayObject;
    device.state.bindVertexArray(vao);
    for (const a of this.attributes) {
      gl.enableVertexAttribArray(a.location);
      gl.vertexAttribDivisor(a.location, a.instance ? 1 : 0);
    }
    device.state.bindVertexArray(null);
    this.vao = vao;
    if (!deferLink) this.finish();
  }

  /** Resolves once the program has linked (at once without KHR_parallel_shader_compile). */
  whenLinked(): Promise<void> {
    const ext = this.device.ext.parallel,
      gl = this.device.gl;
    if (!this.program || this.linked || !ext) {
      this.finish();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const poll = () => {
        if (this.device.destroyed || gl.getProgramParameter(this.program as WebGLProgram, ext.COMPLETION_STATUS_KHR)) {
          this.finish();
          resolve();
        } else setTimeout(poll, 2);
      };
      poll();
    });
  }

  /** Checks the link and builds the binding table (once). */
  finish(): void {
    if (this.linked || !this.program || this.failure) return;
    this.linked = true;
    this.device.programs.linkMs += performance.now() - this.handedOver;
    const gl = this.device.gl,
      program = this.program,
      glsl = this.glsl as GLSLProgram;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const logs = this.shaders.map((s) => gl.getShaderInfoLog(s)).filter(Boolean);
      this.failure = `createRenderPipeline${this.label ? ` '${this.label}'` : ''}: WebGL2 refused the translated program: ${[...logs, gl.getProgramInfoLog(program)].join(' ')}`;
      if (!this.deferLink) this.device.validationError(this.failure);
      return;
    }
    for (const s of this.shaders) gl.deleteShader(s);
    this.device.state.useProgram(program);
    const points = new Map<string, UniformSlot>(),
      units = new Map<string, TextureSlot>();
    let textureUnits = 0;
    for (const stage of [glsl.vertex, glsl.fragment] as GLSLStage[]) {
      for (const u of stage.uniforms) {
        const index = gl.getUniformBlockIndex(program, u.block);
        if (index === gl.INVALID_INDEX) continue;
        const key = `${u.group}:${u.binding}`;
        let slot = points.get(key);
        if (!slot) {
          slot = { point: points.size, group: u.group, binding: u.binding, size: 0 };
          points.set(key, slot);
        }
        gl.uniformBlockBinding(program, index, slot.point);
        slot.size = Math.max(
          slot.size,
          gl.getActiveUniformBlockParameter(program, index, gl.UNIFORM_BLOCK_DATA_SIZE) as number,
        );
      }
      for (const t of stage.textures) {
        // A texture read only for its size or level count keeps a slot (the device sets those uniforms from the
        // bound view) but takes no texture unit: the compiler drops its unused sampler.
        const location = gl.getUniformLocation(program, t.name),
          levels = t.levels ? gl.getUniformLocation(program, t.levels) : null,
          size = t.size ? gl.getUniformLocation(program, t.size) : null,
          mipFilter = t.mipFilter ? gl.getUniformLocation(program, t.mipFilter) : null;
        if (!location && !levels && !size && !mipFilter) continue;
        const key = `${t.group}:${t.binding}|${t.sampler ? `${t.sampler.group}:${t.sampler.binding}` : ''}|${t.gather ? `${t.gather.group}:${t.gather.binding}` : ''}`;
        let slot = units.get(key);
        if (!slot) {
          slot = {
            unit: -1,
            group: t.group,
            binding: t.binding,
            sampler: t.sampler,
            type: t.type,
            levels: [],
            sizes: [],
            mipFilters: [],
            modes: [],
          };
          units.set(key, slot);
        }
        if (location) {
          if (slot.unit < 0) slot.unit = textureUnits++;
          gl.uniform1i(location, slot.unit);
        }
        if (levels) slot.levels.push(levels);
        if (size) slot.sizes.push(size);
        if (mipFilter) slot.mipFilters.push(mipFilter);
        const modes = t.gather ? gl.getUniformLocation(program, t.gather.name) : null;
        if (modes && t.gather) slot.modes.push({ location: modes, group: t.gather.group, binding: t.gather.binding });
      }
    }
    // Storage buffers read through data textures take the units after the textures.
    const buffers = new Map<string, StorageSlot>();
    for (const stage of [glsl.vertex, glsl.fragment] as GLSLStage[])
      for (const b of stage.storage) {
        const key = b.shared ? `g${b.group}` : `${b.group}:${b.binding}`;
        let slot = buffers.get(key);
        if (!slot) {
          slot = { unit: textureUnits + buffers.size, group: b.group, binding: b.shared ? -1 : b.binding, info: [] };
          buffers.set(key, slot);
        }
        const texture = gl.getUniformLocation(program, b.texture),
          info = gl.getUniformLocation(program, b.info);
        if (texture) gl.uniform1i(texture, slot.unit);
        if (info) slot.info.push({ location: info, binding: b.binding });
      }
    const used = textureUnits + buffers.size;
    if (used > this.device.limits.maxSampledTexturesPerShaderStage)
      throw this.device.unsupported(
        `a pipeline with ${textureUnits} texture and sampler pairs and ${buffers.size} storage buffers (WebGL2 has ${this.device.limits.maxSampledTexturesPerShaderStage} texture units, and each storage buffer takes one)`,
      );
    this.storage.push(...buffers.values());
    this.uniforms.push(...points.values());
    this.textures.push(...units.values());
    this.baseVertex = gl.getUniformLocation(program, '_bv');
    this.baseInstance = gl.getUniformLocation(program, '_bi');
  }

  getBindGroupLayout(index: number): CompatBindGroupLayout {
    return this.layouts[index] ?? new CompatBindGroupLayout({ entries: [] });
  }
}

/** The 'auto' bind group layouts of a translated program (WebGPU "default pipeline layout"). */
function autoLayouts(glsl: GLSLProgram): CompatBindGroupLayout[] {
  const groups: Map<number, LayoutEntry & { binding: number }>[] = [];
  const add = (group: number, entry: LayoutEntry, stage: number) => {
    const g = (groups[group] ??= new Map());
    const known = g.get(entry.binding);
    g.set(entry.binding, { ...(known ?? entry), visibility: (known?.visibility ?? 0) | stage });
  };
  for (const stage of [glsl.vertex, glsl.fragment]) {
    const bit = stage.stage === 'vertex' ? 1 : 2;
    for (const u of stage.uniforms)
      add(
        u.group,
        {
          binding: u.binding,
          visibility: bit,
          buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: u.minSize },
        },
        bit,
      );
    for (const b of stage.storage)
      add(
        b.group,
        {
          binding: b.binding,
          visibility: bit,
          buffer: {
            type: b.uniform ? 'uniform' : b.access === 'read' ? 'read-only-storage' : 'storage',
            hasDynamicOffset: false,
            minBindingSize: b.minSize,
          },
        },
        bit,
      );
    for (const t of stage.textures) {
      const shape = t.type.shape;
      add(
        t.group,
        {
          binding: t.binding,
          visibility: bit,
          texture: {
            sampleType:
              shape === 'depth' || shape === 'depth_multisampled'
                ? 'depth'
                : t.type.sampled?.name === 'i32'
                  ? 'sint'
                  : t.type.sampled?.name === 'u32'
                    ? 'uint'
                    : 'float',
            viewDimension: t.type.dimension.replace('_', '-'),
            multisampled: shape === 'multisampled' || shape === 'depth_multisampled',
          },
        },
        bit,
      );
      if (t.sampler)
        add(
          t.sampler.group,
          {
            binding: t.sampler.binding,
            visibility: bit,
            sampler: { type: t.sampler.comparison ? 'comparison' : 'filtering' },
          },
          bit,
        );
    }
  }
  const out: CompatBindGroupLayout[] = [];
  for (let i = 0; i < Math.max(groups.length, 1); i++) {
    const layout = new CompatBindGroupLayout({ entries: [] });
    (layout as { entries: readonly LayoutEntry[] }).entries = [...(groups[i]?.values() ?? [])];
    out.push(layout);
  }
  return out;
}

// ---------------------------------------------------------------- command encoding

interface ColorAttachment {
  readonly view: CompatTextureView;
  /** The slice of a 3D view this attachment renders into. */
  readonly depthSlice: number;
  readonly resolveTarget?: CompatTextureView;
  readonly clearValue: readonly number[];
  readonly loadOp: GPULoadOp;
  readonly storeOp: GPUStoreOp;
}
interface PassDescriptor {
  readonly colors: readonly (ColorAttachment | null)[];
  readonly depth?: {
    readonly view: CompatTextureView;
    readonly depthClearValue: number;
    readonly depthLoadOp?: GPULoadOp;
    readonly depthStoreOp?: GPUStoreOp;
    readonly depthReadOnly: boolean;
    readonly stencilClearValue: number;
    readonly stencilLoadOp?: GPULoadOp;
    readonly stencilStoreOp?: GPUStoreOp;
    readonly stencilReadOnly: boolean;
  };
  readonly queries?: CompatQuerySet;
}

const color = (c: GPUColor | undefined): number[] =>
  c === undefined
    ? [0, 0, 0, 0]
    : Array.isArray(c)
      ? [...(c as number[])]
      : [(c as GPUColorDict).r, (c as GPUColorDict).g, (c as GPUColorDict).b, (c as GPUColorDict).a];

/** A GPUCommandBuffer: the recorded operations. */
export class CompatCommandBuffer {
  used = false;
  constructor(
    readonly ops: readonly Op[],
    public label: string,
    /** True when it holds compute passes (their runtime loads before it replays). */
    readonly compute = false,
    readonly readback = false,
  ) {}
}

/**
 * A GPUQuerySet of type `occlusion`: one WebGL2 ANY_SAMPLES_PASSED query per index and use, so a result is 1 when any
 * sample passed and 0 otherwise (WebGPU asks only for zero or not). Timestamp queries are not offered on WebGL2.
 */
export class CompatQuerySet {
  label: string;
  readonly type: GPUQueryType;
  readonly count: number;
  /** The query of each index's last use (null before the first). */
  readonly queries: (WebGLQuery | null)[];
  /** Queries replaced by a newer use, deleted once no resolve still waits for them. */
  private readonly waiting = new Map<WebGLQuery, number>();
  destroyed = false;

  constructor(
    private readonly device: CompatDevice,
    descriptor: GPUQuerySetDescriptor,
  ) {
    if (descriptor.type !== 'occlusion')
      throw device.unsupported(`${descriptor.type} query sets (WebGL2 offers occlusion queries only)`);
    if (!Number.isInteger(descriptor.count) || descriptor.count < 1 || descriptor.count > 4096)
      throw new RangeError('A query set holds 1 to 4096 queries; pass a count in that range');
    this.label = descriptor.label ?? '';
    this.type = descriptor.type;
    this.count = descriptor.count;
    this.queries = new Array(this.count).fill(null);
  }

  /** A fresh query for index `i` (the previous one stays alive while a resolve reads it). */
  begin(i: number): WebGLQuery {
    const gl = this.device.gl,
      old = this.queries[i];
    if (old && !this.waiting.has(old)) gl.deleteQuery(old);
    const q = gl.createQuery() as WebGLQuery;
    this.queries[i] = q;
    return q;
  }

  /** Holds the queries a resolve reads until it has read them. */
  hold(queries: readonly (WebGLQuery | null)[]): void {
    for (const q of queries) if (q) this.waiting.set(q, (this.waiting.get(q) ?? 0) + 1);
  }

  /** Releases held queries, deleting those no longer current. */
  release(queries: readonly (WebGLQuery | null)[]): void {
    for (const q of queries) {
      if (!q) continue;
      const n = (this.waiting.get(q) ?? 1) - 1;
      if (n > 0) this.waiting.set(q, n);
      else {
        this.waiting.delete(q);
        if (!this.queries.includes(q)) this.device.gl.deleteQuery(q);
      }
    }
  }

  /** Same as destroy() (the repository convention; WebGPU code calls destroy()). */
  dispose(): void {
    this.destroy();
  }

  /** Same as dispose(), for `using` (where the browser has Symbol.dispose). */
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const q of this.queries) if (q && !this.waiting.has(q)) this.device.gl.deleteQuery(q);
  }
}

/** A GPUCommandEncoder. */
export class CompatCommandEncoder {
  private readonly ops: Op[] = [];
  private finished = false;
  private compute = false;
  private readback = false;
  constructor(
    private readonly device: CompatDevice,
    public label: string,
  ) {}

  beginRenderPass(d: GPURenderPassDescriptor): CompatRenderPassEncoder {
    if (d.timestampWrites) throw this.device.unsupported('timestamp queries');
    // A snapshot: callers may change their descriptor object once the pass has begun.
    const pass: PassDescriptor = {
      colors: [...d.colorAttachments].map((a) =>
        a
          ? {
              view: viewOf(a.view),
              depthSlice: a.depthSlice ?? 0,
              resolveTarget: a.resolveTarget ? viewOf(a.resolveTarget) : undefined,
              clearValue: color(a.clearValue),
              loadOp: a.loadOp,
              storeOp: a.storeOp,
            }
          : null,
      ),
      depth: d.depthStencilAttachment
        ? {
            view: viewOf(d.depthStencilAttachment.view),
            depthClearValue: d.depthStencilAttachment.depthClearValue ?? 0,
            depthLoadOp: d.depthStencilAttachment.depthLoadOp,
            depthStoreOp: d.depthStencilAttachment.depthStoreOp,
            depthReadOnly: !!d.depthStencilAttachment.depthReadOnly,
            stencilClearValue: d.depthStencilAttachment.stencilClearValue ?? 0,
            stencilLoadOp: d.depthStencilAttachment.stencilLoadOp,
            stencilStoreOp: d.depthStencilAttachment.stencilStoreOp,
            stencilReadOnly: !!d.depthStencilAttachment.stencilReadOnly,
          }
        : undefined,
      queries: (d.occlusionQuerySet as unknown as CompatQuerySet | undefined) ?? undefined,
    };
    this.ops.push((r) => r.beginPass(pass));
    return new CompatRenderPassEncoder(this.ops, d.label ?? '');
  }

  beginComputePass(d: GPUComputePassDescriptor = {}): CompatComputePassEncoder {
    if (d.timestampWrites) throw this.device.unsupported('timestamp queries');
    this.compute = true;
    return new CompatComputePassEncoder(this.ops, this.device, d.label ?? '');
  }

  copyBufferToBuffer(
    src: CompatBuffer,
    a: number | CompatBuffer,
    b?: CompatBuffer | number,
    c?: number,
    d?: number,
  ): void {
    // Both overloads: (src, srcOffset, dst, dstOffset, size) and (src, dst, size?).
    const [srcOffset, dst, dstOffset, size] =
      typeof a === 'number'
        ? [a, b as CompatBuffer, c as number, d ?? src.size - a]
        : [0, a, 0, (b as number | undefined) ?? src.size];
    this.ops.push((r) => r.copyBuffer(src, srcOffset, dst, dstOffset, size));
  }
  copyBufferToTexture(source: GPUTexelCopyBufferInfo, destination: GPUTexelCopyTextureInfo, size: GPUExtent3D): void {
    const s = { ...source },
      d = { ...destination };
    this.ops.push((r) => r.copyBufferToTexture(s as never, d as never, size));
  }
  copyTextureToBuffer(source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyBufferInfo, size: GPUExtent3D): void {
    const s = { ...source },
      d = { ...destination };
    this.readback = true;
    this.ops.push((r) => r.device.readback?.copyTextureToBuffer(r, s as never, d as never, extent(size)));
  }
  copyTextureToTexture(source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyTextureInfo, size: GPUExtent3D): void {
    const s = { ...source },
      d = { ...destination };
    this.ops.push((r) => r.copyTextureToTexture(s as never, d as never, extent(size)));
  }
  clearBuffer(buffer: CompatBuffer, offset = 0, size?: number): void {
    this.ops.push(() => buffer.write(offset, new Uint8Array(size ?? buffer.size - offset)));
  }
  resolveQuerySet(
    querySet: CompatQuerySet,
    firstQuery: number,
    queryCount: number,
    destination: CompatBuffer,
    destinationOffset: number,
  ): void {
    if (firstQuery + queryCount > querySet.count || destinationOffset % 256 || !(destination.usage & 512)) {
      this.device.validationError(
        'resolveQuerySet: the queries lie outside the set, the offset is not a multiple of 256, or the buffer lacks QUERY_RESOLVE',
      );
      return;
    }
    this.ops.push((r) => r.resolveQueries(querySet, firstQuery, queryCount, destination, destinationOffset));
  }
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}

  finish(descriptor: GPUCommandBufferDescriptor = {}): CompatCommandBuffer {
    if (this.finished) this.device.validationError('finish() was already called on this command encoder');
    this.finished = true;
    return new CompatCommandBuffer(this.ops, descriptor.label ?? this.label, this.compute, this.readback);
  }
}

const viewOf = (v: GPUTextureView | GPUTexture): CompatTextureView =>
  'createView' in (v as object) ? (v as unknown as CompatTexture).createView() : (v as unknown as CompatTextureView);

/** The draw commands render passes and render bundles share; each call records one replay step. */
class DrawRecorder {
  constructor(
    protected readonly ops: Op[],
    public label: string,
  ) {}
  setPipeline(pipeline: CompatRenderPipeline): void {
    this.ops.push((r) => r.setPipeline(pipeline));
  }
  setBindGroup(
    index: number,
    group: CompatBindGroup | null,
    offsets?: Iterable<number> | Uint32Array,
    start = 0,
    length?: number,
  ): void {
    const list = offsets ? [...(offsets as Iterable<number>)] : [];
    const dynamic = offsets instanceof Uint32Array ? list.slice(start, start + (length ?? list.length - start)) : list;
    this.ops.push((r) => r.setBindGroup(index, group, dynamic));
  }
  setVertexBuffer(slot: number, buffer: CompatBuffer | null, offset = 0, size?: number): void {
    this.ops.push((r) => r.setVertexBuffer(slot, buffer, offset, size));
  }
  setIndexBuffer(buffer: CompatBuffer, format: GPUIndexFormat, offset = 0, size?: number): void {
    this.ops.push((r) => r.setIndexBuffer(buffer, format, offset, size));
  }
  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    this.ops.push((r) => r.draw(vertexCount, instanceCount, firstVertex, firstInstance));
  }
  drawIndexed(indexCount: number, instanceCount = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0): void {
    this.ops.push((r) => r.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance));
  }
  drawIndirect(buffer: CompatBuffer, offset: number): void {
    this.ops.push((r) => {
      const a = new Uint32Array(r.indirect(buffer, offset, 16));
      r.draw(a[0], a[1], a[2], a[3]);
    });
  }
  drawIndexedIndirect(buffer: CompatBuffer, offset: number): void {
    this.ops.push((r) => {
      const bytes = r.indirect(buffer, offset, 20),
        u = new Uint32Array(bytes),
        i = new Int32Array(bytes);
      r.drawIndexed(u[0], u[1], u[2], i[3], u[4]);
    });
  }
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}
}

/** A GPURenderPassEncoder. */
export class CompatRenderPassEncoder extends DrawRecorder {
  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void {
    this.ops.push((r) => r.setViewport(x, y, width, height, minDepth, maxDepth));
  }
  setScissorRect(x: number, y: number, width: number, height: number): void {
    this.ops.push((r) => r.setScissor(x, y, width, height));
  }
  setBlendConstant(c: GPUColor): void {
    const v = color(c);
    this.ops.push((r) => r.setBlendConstant(v));
  }
  setStencilReference(reference: number): void {
    this.ops.push((r) => r.setStencilReference(reference));
  }
  beginOcclusionQuery(queryIndex: number): void {
    this.ops.push((r) => r.beginQuery(queryIndex));
  }
  endOcclusionQuery(): void {
    this.ops.push((r) => r.endQuery());
  }
  /** Runs the bundles' draws; the pass's pipeline, bind groups and buffers are reset before and after, as in WebGPU. */
  executeBundles(bundles: Iterable<CompatRenderBundle>): void {
    const list = [...bundles];
    this.ops.push((r) => r.executeBundles(list));
  }
  end(): void {
    this.ops.push((r) => r.endPass());
  }
}

/** A GPURenderBundle: recorded draws a render pass replays with executeBundles. */
export class CompatRenderBundle {
  constructor(
    readonly ops: readonly Op[],
    public label: string,
  ) {}
}

/** A GPURenderBundleEncoder. */
export class CompatRenderBundleEncoder extends DrawRecorder {
  private finished = false;
  constructor(
    private readonly device: CompatDevice,
    readonly descriptor: GPURenderBundleEncoderDescriptor,
  ) {
    super([], descriptor.label ?? '');
  }
  finish(descriptor: GPURenderBundleDescriptor = {}): CompatRenderBundle {
    if (this.finished) this.device.validationError('finish() was already called on this render bundle encoder');
    this.finished = true;
    return new CompatRenderBundle(this.ops, descriptor.label ?? this.label);
  }
}

function extent(size: GPUExtent3D): [number, number, number] {
  return Array.isArray(size)
    ? [size[0], size[1] ?? 1, size[2] ?? 1]
    : [
        (size as GPUExtent3DDict).width,
        (size as GPUExtent3DDict).height ?? 1,
        (size as GPUExtent3DDict).depthOrArrayLayers ?? 1,
      ];
}
export function origin(o: GPUOrigin3D | undefined): [number, number, number] {
  if (!o) return [0, 0, 0];
  return Array.isArray(o)
    ? [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0]
    : [(o as GPUOrigin3DDict).x ?? 0, (o as GPUOrigin3DDict).y ?? 0, (o as GPUOrigin3DDict).z ?? 0];
}

// ---------------------------------------------------------------- replay

/**
 * One subresource a framebuffer attaches: a level and layer of a texture storage, a multisample renderbuffer, or the
 * resolved copy of one.
 */
interface Sub {
  readonly key: string;
  readonly owner: CompatTexture;
  readonly info: FormatInfo;
  readonly level: number;
  attach(point: number): void;
}

interface PassState {
  readonly desc: PassDescriptor;
  readonly fbo: WebGLFramebuffer;
  /** Per colour attachment: the 3D slice and the 2D stand-in drawn in its place (see Replayer.standIn), or null. */
  readonly standIns: readonly ([Sub, Sub] | null)[];
  readonly width: number;
  readonly height: number;
  pipeline: CompatRenderPipeline | null;
  applied: CompatRenderPipeline | null;
  groups: ({ group: CompatBindGroup; offsets: number[] } | null)[];
  vertex: ({ buffer: CompatBuffer; offset: number } | null)[];
  index: { buffer: CompatBuffer; type: number; size: number; offset: number } | null;
  stencilReference: number;
  /** The occlusion query running, if any. */
  query: boolean;
}

/** The internal programs the device draws with: full-target triangles that fetch texels (readbacks, copies). */
interface Helper {
  readonly program: WebGLProgram;
  readonly offset: WebGLUniformLocation | null;
  readonly value: WebGLUniformLocation | null;
}

/** Replays recorded operations against the device's GL state. */
export class Replayer {
  private pass: PassState | null = null;
  readonly gl: WebGL2RenderingContext;
  private readonly helpers = new Map<string, Helper>();
  private emptyVao: WebGLVertexArrayObject | null = null;
  constructor(readonly device: CompatDevice) {
    this.gl = device.gl;
  }

  run(ops: readonly Op[]): void {
    for (const op of ops) {
      if (this.device.destroyed) return;
      op(this);
    }
  }

  // ------------------------------------------------ framebuffers

  /** A level and layer of a storage (for a 3D storage, `layer` is the depth slice). */
  sub(s: TextureStorage, level: number, layer: number): Sub {
    const gl = this.gl;
    return {
      key: `s${s.id}.${level}.${layer}`,
      owner: s.texture,
      info: s.info,
      level,
      attach: (point) => {
        if (s.target === gl.TEXTURE_2D) gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, point, gl.TEXTURE_2D, s.gl, level);
        else if (s.target === gl.TEXTURE_CUBE_MAP)
          gl.framebufferTexture2D(
            gl.DRAW_FRAMEBUFFER,
            point,
            gl.TEXTURE_CUBE_MAP_POSITIVE_X + layer - s.layer,
            s.gl,
            level,
          );
        else
          gl.framebufferTextureLayer(
            gl.DRAW_FRAMEBUFFER,
            point,
            s.gl,
            level,
            s.target === gl.TEXTURE_3D ? layer : layer - s.layer,
          );
      },
    };
  }

  /** What a render pass attaches for a view: its renderbuffer, or its level and layer (or 3D slice). */
  private viewSub(v: CompatTextureView, slice?: number): Sub {
    const gl = this.gl,
      t = v.texture;
    if (t.renderbuffer)
      return {
        key: `r${t.id}`,
        owner: t,
        info: t.storageInfo,
        level: 0,
        attach: (point) => gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, point, gl.RENDERBUFFER, t.renderbuffer),
      };
    return this.sub(t.attached(v), v.baseMipLevel, t.dimension === '3d' ? (slice ?? 0) : v.baseArrayLayer);
  }

  /**
   * The 2D stand-in a pass draws in place of a 3D slice when it also attaches depth or stencil: ANGLE's Direct3D 11
   * back end clears such a slice but drops every draw into it, with a complete framebuffer and no GL error (measured on
   * an NVIDIA RTX A6000, Chrome; the same draw into a 2D or array layer, or into the slice with no depth, lands). It
   * has the attached storage's format and level sizes; beginPass loads it from the slice and endPass stores it back.
   */
  private standIn(v: CompatTextureView): Sub {
    const gl = this.gl,
      t = v.texture,
      s = t.attached(v),
      level = v.baseMipLevel,
      texture = t.sliceStandIn(s);
    return {
      key: `z${s.id}.${level}`,
      owner: t,
      info: s.info,
      level,
      attach: (point) => gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, point, gl.TEXTURE_2D, texture, level),
    };
  }

  private depthPoint(info: FormatInfo): number {
    return info.kind === 'depth' ? this.gl.DEPTH_ATTACHMENT : this.gl.DEPTH_STENCIL_ATTACHMENT;
  }

  /** A framebuffer of these colour subresources (null entries leave a draw buffer empty) and depth subresource. */
  private framebuffer(colors: readonly (Sub | null)[], depth?: Sub): WebGLFramebuffer {
    const gl = this.gl,
      device = this.device;
    const key = `${colors.map((c) => c?.key ?? '-').join(',')}|${depth?.key ?? ''}`;
    const owners = [...colors.filter((c): c is Sub => !!c), ...(depth ? [depth] : [])].map((c) => c.owner);
    return device.framebuffer(key, owners, (fbo) => {
      device.state.bindDrawFramebuffer(fbo);
      colors.forEach((c, i) => c?.attach(gl.COLOR_ATTACHMENT0 + i));
      if (depth) depth.attach(this.depthPoint(depth.info));
      gl.drawBuffers(colors.map((c, i) => (c ? gl.COLOR_ATTACHMENT0 + i : gl.NONE)));
      const status = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE)
        device.validationError(
          `The render pass attachments do not form a complete WebGL2 framebuffer (status 0x${status.toString(16)})`,
        );
    });
  }

  /** A framebuffer of one subresource, as colour or as depth and stencil by its format. */
  single(s: Sub): WebGLFramebuffer {
    return hasDepth(s.info) || hasStencil(s.info) ? this.framebuffer([], s) : this.framebuffer([s]);
  }

  /** A framebuffer with level 0, layer 0 of a texture as its one colour attachment (the canvas present reads it). */
  framebufferOf(t: CompatTexture): WebGLFramebuffer {
    const p = t.primary as TextureStorage;
    t.read(p, 0, 1, 0, 1, this.sync);
    return this.framebuffer([this.sub(p, 0, 0)]);
  }

  /** Full colour and depth write masks and no scissor, for clears and blits. */
  private openMasks(): void {
    const gl = this.gl,
      s = this.device.state;
    s.set('colorMask', '1111', () => gl.colorMask(true, true, true, true));
    for (let i = 0; i < 8; i++) s.forget(`colorMask${i}`);
    s.set('depthMask', '1', () => gl.depthMask(true));
    s.set('stencilMask', 'ff', () => gl.stencilMask(0xff));
    for (const face of [gl.FRONT, gl.BACK]) s.forget(`stencilMask${face}`);
    s.enable(gl.RASTERIZER_DISCARD, false);
    this.pass && (this.pass.applied = null);
  }

  /** Copies one subresource into another of the same size and format, texel for texel. */
  private blit(from: Sub, to: Sub, x = 0, y = 0, w?: number, h?: number, dx = x, dy = y): void {
    const gl = this.gl,
      s = this.device.state;
    const read = this.single(from),
      draw = this.single(to);
    const bits = hasDepth(from.info)
      ? gl.DEPTH_BUFFER_BIT | (hasStencil(from.info) ? gl.STENCIL_BUFFER_BIT : 0)
      : hasStencil(from.info)
        ? gl.STENCIL_BUFFER_BIT
        : gl.COLOR_BUFFER_BIT;
    this.openMasks();
    s.enable(gl.SCISSOR_TEST, false);
    s.bindReadFramebuffer(read);
    s.bindDrawFramebuffer(draw);
    const [lw, lh] = to.owner.levelSize(to.level);
    w ??= lw;
    h ??= lh;
    gl.blitFramebuffer(x, y, x + w, y + h, dx, dy, dx + w, dy + h, bits, gl.NEAREST);
  }

  /**
   * Copies texels between an sRGB format and its unorm twin as raw bytes: through a pixel buffer, on the GPU (a blit
   * would decode and encode the colour). Bytes for an sRGB texture go through client memory instead, which waits for the
   * GPU: ANGLE on Metal encodes what reaches an sRGB texture from PIXEL_UNPACK_BUFFER (64 samples as 0.25, not 0.05),
   * and copyTexSubImage2D refuses a unorm source.
   */
  private rawCopy(
    from: Sub,
    to: TextureStorage,
    level: number,
    layer: number,
    [x, y, w, h]: readonly number[],
    [dx, dy]: readonly number[],
  ): void {
    const gl = this.gl,
      s = this.device.state,
      bytes = to.info.srgb ? new Uint8Array(w * h * 4) : null,
      pbo = bytes ? null : (gl.createBuffer() as WebGLBuffer),
      // texSubImage takes either the client bytes or an offset into the bound pixel buffer.
      pixels = (bytes ?? 0) as number;
    s.bindReadFramebuffer(this.single(from));
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    if (bytes) gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    else {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 4, gl.STREAM_COPY);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, pbo);
    }
    s.scratch(to.target, to.gl);
    if (to.target === gl.TEXTURE_2D)
      gl.texSubImage2D(gl.TEXTURE_2D, level, dx, dy, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    else if (to.target === gl.TEXTURE_CUBE_MAP)
      gl.texSubImage2D(
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + layer - to.layer,
        level,
        dx,
        dy,
        w,
        h,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
    else
      gl.texSubImage3D(
        to.target,
        level,
        dx,
        dy,
        to.target === gl.TEXTURE_3D ? layer : layer - to.layer,
        w,
        h,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
    if (pbo) {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      gl.deleteBuffer(pbo);
    }
  }

  /** Brings one subresource of storage `to` up to date from storage `from` (a texture's copies, see TextureStorage). */
  readonly sync = (from: TextureStorage, to: TextureStorage, level: number, layer: number): void => {
    const gl = this.gl,
      [w, h, depth] = from.texture.levelSize(level);
    const slices = from.target === gl.TEXTURE_3D ? depth : 1;
    for (let z = 0; z < slices; z++) {
      const a = from.target === gl.TEXTURE_3D ? z : layer;
      if (this.tierCopy(from, to)) {
        (this.device.readback as NonNullable<CompatDevice['readback']>).copyTierStorage(
          this,
          from,
          to,
          level,
          level,
          [0, 0, a],
          [0, 0, a],
          [w, h, 1],
          true,
        );
      } else if (from.info.internal === to.info.internal) this.blit(this.sub(from, level, a), this.sub(to, level, a));
      else this.rawCopy(this.sub(from, level, a), to, level, a, [0, 0, w, h], [0, 0]);
    }
    this.rebind();
  };

  private tierCopy(from: TextureStorage, to: TextureStorage): boolean {
    const policy = this.device.adapter.tierFormats;
    return (
      !!policy &&
      from.texture.info.kind === 'float' &&
      from.texture.info.name.includes('float') &&
      (from.info.internal !== to.info.internal ||
        policy.target(from.info, 16) !== from.info ||
        policy.target(to.info, 16) !== to.info)
    );
  }

  /** Binds the running pass's framebuffer again after a copy or resolve bound another. */
  rebind(): void {
    const pass = this.pass;
    if (!pass) return;
    this.device.state.bindDrawFramebuffer(pass.fbo);
    this.device.state.enable(this.gl.SCISSOR_TEST, true);
    pass.applied = null;
  }

  /** Brings the resolved copy of a multisampled texture up to date before it is sampled. */
  private resolveForSampling(t: CompatTexture): void {
    if (!t.stale || !t.resolved) return;
    const gl = this.gl,
      resolved = t.resolved;
    const to: Sub = {
      key: `q${t.id}`,
      owner: t,
      info: t.storageInfo,
      level: 0,
      attach: (point) => gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, point, gl.TEXTURE_2D, resolved, 0),
    };
    this.blit(this.viewSub(t.createView()), to);
    t.stale = false;
    this.rebind();
  }

  // ------------------------------------------------ passes

  beginPass(desc: PassDescriptor): void {
    const gl = this.gl,
      s = this.device.state;
    // What each attachment writes, brought up to date first (a pass that loads, or draws over part of a level).
    const prepare = (v: CompatTextureView, slice: number): Sub => {
      const t = v.texture;
      if (t.primary)
        t.read(t.attached(v), v.baseMipLevel, 1, t.dimension === '3d' ? 0 : v.baseArrayLayer, 1, this.sync);
      return this.viewSub(v, slice);
    };
    const standIns = desc.colors.map((c): [Sub, Sub] | null =>
      c && desc.depth && c.view.texture.dimension === '3d' ? [prepare(c.view, c.depthSlice), this.standIn(c.view)] : null,
    );
    const colors = desc.colors.map((c, i) => {
      if (!c) return null;
      const standIn = standIns[i];
      if (!standIn) return prepare(c.view, c.depthSlice);
      if (c.loadOp === 'load' && c.view.texture.initialized) this.blit(standIn[0], standIn[1]);
      return standIn[1];
    });
    const depth = desc.depth ? prepare(desc.depth.view, 0) : undefined;
    for (const c of desc.colors) if (c?.resolveTarget?.texture.primary) prepare(c.resolveTarget, 0);
    const fbo = this.framebuffer(colors, depth);
    const first = desc.colors.find((c) => c)?.view ?? desc.depth?.view;
    const [width, height] = first ? first.texture.levelSize(first.baseMipLevel) : [1, 1];
    this.pass = {
      desc,
      fbo,
      standIns,
      width,
      height,
      pipeline: null,
      applied: null,
      groups: [],
      vertex: [],
      index: null,
      stencilReference: 0,
      query: false,
    };
    s.bindDrawFramebuffer(fbo);
    this.openMasks();
    s.enable(gl.SCISSOR_TEST, true);
    s.set('scissor', `0,0,${width},${height}`, () => gl.scissor(0, 0, width, height));
    s.set('viewport', `0,0,${width},${height}`, () => gl.viewport(0, 0, width, height));
    s.set('depthRange', '0,1', () => gl.depthRange(0, 1));
    s.set('blendColor', '0,0,0,0', () => gl.blendColor(0, 0, 0, 0));
    desc.colors.forEach((c, i) => {
      if (!c) return;
      const t = c.view.texture;
      const clear = c.loadOp === 'clear' ? c.clearValue : !t.initialized ? [0, 0, 0, 0] : null;
      if (!clear) return;
      if (t.info.kind === 'uint')
        gl.clearBufferuiv(
          gl.COLOR,
          i,
          clear.map((x) => x >>> 0),
        );
      else if (t.info.kind === 'sint')
        gl.clearBufferiv(
          gl.COLOR,
          i,
          clear.map((x) => x | 0),
        );
      else gl.clearBufferfv(gl.COLOR, i, clear);
    });
    const d = desc.depth;
    if (d) {
      const info = d.view.texture.info,
        fresh = !d.view.texture.initialized;
      const clearDepth = hasDepth(info) && (d.depthLoadOp === 'clear' || fresh) && !d.depthReadOnly,
        clearStencil = hasStencil(info) && (d.stencilLoadOp === 'clear' || fresh) && !d.stencilReadOnly;
      const depthValue = d.depthLoadOp === 'clear' ? d.depthClearValue : 0,
        stencilValue = d.stencilLoadOp === 'clear' ? d.stencilClearValue : 0;
      if (clearDepth && clearStencil) gl.clearBufferfi(gl.DEPTH_STENCIL, 0, depthValue, stencilValue);
      else if (clearDepth) gl.clearBufferfv(gl.DEPTH, 0, [depthValue]);
      else if (clearStencil) gl.clearBufferiv(gl.STENCIL, 0, [stencilValue]);
    }
  }

  endPass(): void {
    const pass = this.pass;
    if (!pass) return;
    if (pass.query) this.endQuery();
    this.pass = null;
    const gl = this.gl;
    const discard: number[] = [];
    const wrote = (v: CompatTextureView) => {
      const t = v.texture;
      if (t.primary) t.wrote(t.attached(v), v.baseMipLevel, 1, t.dimension === '3d' ? 0 : v.baseArrayLayer, 1);
    };
    pass.desc.colors.forEach((c, i) => {
      if (!c) return;
      const t = c.view.texture,
        standIn = pass.standIns[i];
      if (standIn && c.storeOp === 'store') this.blit(standIn[1], standIn[0]);
      t.initialized = true;
      wrote(c.view);
      if (t.renderbuffer && t.resolved) t.stale = true;
      if (c.resolveTarget) {
        this.blit(this.viewSub(c.view, c.depthSlice), this.viewSub(c.resolveTarget));
        c.resolveTarget.texture.initialized = true;
        wrote(c.resolveTarget);
        this.presentIfCanvas(c.resolveTarget.texture);
      }
      if (c.storeOp === 'discard') {
        discard.push(gl.COLOR_ATTACHMENT0 + i);
        t.initialized = false;
      } else this.presentIfCanvas(t);
    });
    const d = pass.desc.depth;
    if (d) {
      const t = d.view.texture;
      t.initialized = true;
      if (!d.depthReadOnly || !d.stencilReadOnly) wrote(d.view);
      if (t.renderbuffer && t.resolved) t.stale = true;
      if (d.depthStoreOp === 'discard' && (!hasStencil(t.info) || d.stencilStoreOp === 'discard')) {
        discard.push(this.depthPoint(t.info));
        t.initialized = false;
      }
    }
    if (discard.length) {
      this.device.state.bindDrawFramebuffer(pass.fbo);
      gl.invalidateFramebuffer(gl.DRAW_FRAMEBUFFER, discard);
    }
  }

  private presentIfCanvas(t: CompatTexture): void {
    const context = (t as { canvasContext?: { present(): void } }).canvasContext;
    if (context) this.device.queuePresent(context);
  }

  setPipeline(p: CompatRenderPipeline): void {
    if (this.pass) this.pass.pipeline = p;
  }
  setBindGroup(index: number, group: CompatBindGroup | null, offsets: number[]): void {
    // An invalid group (its error was reported at createBindGroup) binds nothing, so its draws are skipped.
    if (this.pass) this.pass.groups[index] = group && !group.invalid ? { group, offsets } : null;
  }
  setVertexBuffer(slot: number, buffer: CompatBuffer | null, offset: number, _size?: number): void {
    if (this.pass) this.pass.vertex[slot] = buffer ? { buffer, offset } : null;
  }
  setIndexBuffer(buffer: CompatBuffer, format: GPUIndexFormat, offset: number, _size?: number): void {
    if (!this.pass) return;
    const gl = this.gl;
    this.pass.index = {
      buffer,
      type: format === 'uint16' ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT,
      size: format === 'uint16' ? 2 : 4,
      offset,
    };
  }
  setViewport(x: number, y: number, w: number, h: number, near: number, far: number): void {
    const gl = this.gl,
      s = this.device.state;
    s.set('viewport', `${x},${y},${w},${h}`, () => gl.viewport(x, y, w, h));
    s.set('depthRange', `${near},${far}`, () => gl.depthRange(near, far));
  }
  setScissor(x: number, y: number, w: number, h: number): void {
    const gl = this.gl;
    this.device.state.set('scissor', `${x},${y},${w},${h}`, () => gl.scissor(x, y, w, h));
  }
  setBlendConstant(c: number[]): void {
    const gl = this.gl;
    this.device.state.set('blendColor', c.join(','), () => gl.blendColor(c[0], c[1], c[2], c[3]));
  }
  setStencilReference(reference: number): void {
    if (!this.pass) return;
    this.pass.stencilReference = reference;
    this.pass.applied = null;
  }

  /** Clears the pass's pipeline, bind groups and buffers (around render bundles, as WebGPU specifies). */
  private resetDrawState(): void {
    const pass = this.pass;
    if (!pass) return;
    pass.pipeline = null;
    pass.groups = [];
    pass.vertex = [];
    pass.index = null;
  }

  executeBundles(bundles: readonly CompatRenderBundle[]): void {
    this.resetDrawState();
    for (const b of bundles) {
      this.run(b.ops);
      this.resetDrawState();
    }
  }

  beginQuery(index: number): void {
    const pass = this.pass,
      set = pass?.desc.queries;
    if (!pass || !set || index >= set.count || pass.query) {
      this.device.validationError(
        'beginOcclusionQuery: the pass has no occlusion query set, the index is outside it, or a query is running',
      );
      return;
    }
    pass.query = true;
    this.gl.beginQuery(this.gl.ANY_SAMPLES_PASSED, set.begin(index));
  }

  endQuery(): void {
    const pass = this.pass;
    if (!pass?.query) {
      this.device.validationError('endOcclusionQuery without beginOcclusionQuery');
      return;
    }
    pass.query = false;
    this.gl.endQuery(this.gl.ANY_SAMPLES_PASSED);
  }

  /** resolveQuerySet: the results land in the buffer once WebGL2 makes them available (a later task). */
  resolveQueries(set: CompatQuerySet, first: number, count: number, dst: CompatBuffer, offset: number): void {
    const gl = this.gl,
      queries = set.queries.slice(first, first + count);
    set.hold(queries);
    dst.readbacks.push({
      forcible: false,
      ready: () =>
        set.destroyed ||
        queries.every((q) => !q || gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) || gl.isContextLost()),
      apply: () => {
        const out = new BigUint64Array(count);
        queries.forEach((q, i) => {
          out[i] = q && !gl.isContextLost() && gl.getQueryParameter(q, gl.QUERY_RESULT) ? 1n : 0n;
        });
        set.release(queries);
        dst.land(offset, new Uint8Array(out.buffer));
      },
    });
  }

  /** Runs one compute dispatch (the compute runtime is loaded before a command buffer with one replays). */
  dispatch(p: CompatComputePipeline, groups: readonly BoundGroup[], count: readonly number[]): void {
    if (!count[0] || !count[1] || !count[2]) return;
    try {
      if (!p.ready()) return;
    } catch (error) {
      p.failure = `createComputePipeline${p.label ? ` '${p.label}'` : ''}: ${(error as Error).message}`;
      this.device.validationError(p.failure);
      return;
    }
    this.device.computeRuntime?.dispatch(this, p, groups, count);
  }

  /** The bytes of an indirect argument block (from the CPU copy; a GPU-written buffer is read back, which stalls). */
  indirect(buffer: CompatBuffer, offset: number, size: number): ArrayBuffer {
    return buffer.bytes().slice(offset, offset + size).buffer;
  }

  // ------------------------------------------------ draws

  private applyPipeline(p: CompatRenderPipeline, pass: PassState): void {
    const gl = this.gl,
      s = this.device.state,
      ext = this.device.ext;
    s.useProgram(p.program);
    s.bindVertexArray(p.vao);
    if (pass.applied === p) return;
    pass.applied = p;
    s.enable(gl.CULL_FACE, p.cull !== 0);
    if (p.cull) s.set('cullFace', String(p.cull), () => gl.cullFace(p.cull));
    s.set('frontFace', String(p.frontFace), () => gl.frontFace(p.frontFace));
    if (ext.depthClamp) s.enable(ext.depthClamp.DEPTH_CLAMP_EXT, p.unclippedDepth);
    const ds = p.depthStencil,
      d = pass.desc.depth;
    const depthOn = !!ds && !!d && hasDepth(d.view.texture.info);
    s.enable(gl.DEPTH_TEST, depthOn);
    if (depthOn && ds) {
      const func = this.device.compare(ds.depthCompare ?? 'always');
      s.set('depthFunc', String(func), () => gl.depthFunc(func));
      const write = !!ds.depthWriteEnabled && !d?.depthReadOnly;
      s.set('depthMask', write ? '1' : '0', () => gl.depthMask(write));
      const bias = ds.depthBias ?? 0,
        slope = ds.depthBiasSlopeScale ?? 0,
        clamp = ds.depthBiasClamp ?? 0;
      s.enable(gl.POLYGON_OFFSET_FILL, bias !== 0 || slope !== 0);
      if (bias || slope)
        s.set('polygonOffset', `${slope},${bias},${clamp}`, () => {
          // The extension and WebGPU share signed min/max semantics; zero disables the clamp.
          if (ext.polygonOffsetClamp) ext.polygonOffsetClamp.polygonOffsetClampEXT(slope, bias, clamp);
          else gl.polygonOffset(slope, bias);
        });
    } else s.enable(gl.POLYGON_OFFSET_FILL, false);
    const stencilOn = !!ds && !!d && hasStencil(d.view.texture.info);
    s.enable(gl.STENCIL_TEST, stencilOn);
    if (stencilOn && ds) {
      // All WebGPU stencil aspects are eight bits. GL clamps a signed GLint instead of truncating it.
      const ref = pass.stencilReference & 0xff,
        read = ds.stencilReadMask ?? 0xffffffff,
        write = d?.stencilReadOnly ? 0 : (ds.stencilWriteMask ?? 0xffffffff);
      for (const [face, f] of [
        [gl.FRONT, ds.stencilFront ?? {}],
        [gl.BACK, ds.stencilBack ?? {}],
      ] as const) {
        const func = this.device.compare(f.compare ?? 'always');
        const op = (o?: GPUStencilOperation) => this.device.enum(STENCIL_OPS[o ?? 'keep']);
        s.set(`stencilFunc${face}`, `${func},${ref},${read}`, () => gl.stencilFuncSeparate(face, func, ref, read));
        s.set(`stencilOp${face}`, `${f.failOp},${f.depthFailOp},${f.passOp}`, () =>
          gl.stencilOpSeparate(face, op(f.failOp), op(f.depthFailOp), op(f.passOp)),
        );
        s.set(`stencilMask${face}`, String(write), () => gl.stencilMaskSeparate(face, write));
      }
      s.forget('stencilMask');
    }
    s.enable(gl.SAMPLE_ALPHA_TO_COVERAGE, p.alphaToCoverage);
    this.applyTargets(p);
  }

  private applyTargets(p: CompatRenderPipeline, only?: number): void {
    const gl = this.gl,
      s = this.device.state,
      indexed = this.device.ext.indexed;
    const states = p.targets.map((t) => {
      const blend = t?.blend;
      const key = blend
        ? `${blend.color.operation ?? 'add'},${blend.color.srcFactor ?? 'one'},${blend.color.dstFactor ?? 'zero'},${blend.alpha.operation ?? 'add'},${blend.alpha.srcFactor ?? 'one'},${blend.alpha.dstFactor ?? 'zero'}`
        : '';
      return { key, blend, mask: t?.writeMask ?? 0 };
    });
    const uniform = states.every((x) => x.key === states[0]?.key && x.mask === states[0]?.mask);
    const apply = (i: number | null, x: (typeof states)[number]) => {
      const tag = i === null ? '' : String(i);
      const m = x.mask;
      const maskKey = `${+!!(m & 1)}${+!!(m & 2)}${+!!(m & 4)}${+!!(m & 8)}`;
      s.set(`colorMask${tag}`, maskKey, () =>
        i === null || !indexed
          ? gl.colorMask(!!(m & 1), !!(m & 2), !!(m & 4), !!(m & 8))
          : indexed.colorMaskiOES(i, !!(m & 1), !!(m & 2), !!(m & 4), !!(m & 8)),
      );
      const on = !!x.blend;
      s.set(`blend${tag}`, on ? x.key : 'off', () => {
        if (i === null || !indexed) {
          if (on) gl.enable(gl.BLEND);
          else gl.disable(gl.BLEND);
        } else if (on) indexed.enableiOES(gl.BLEND, i);
        else indexed.disableiOES(gl.BLEND, i);
        if (!x.blend) return;
        const b = x.blend,
          e = (n?: string) => this.device.enum(n ?? 'ONE');
        const ce = e(BLEND_OPS[b.color.operation ?? 'add']),
          ae = e(BLEND_OPS[b.alpha.operation ?? 'add']);
        const cs = e(BLEND_FACTORS[b.color.srcFactor ?? 'one']),
          cd = e(BLEND_FACTORS[b.color.dstFactor ?? 'zero']),
          as = e(BLEND_FACTORS[b.alpha.srcFactor ?? 'one']),
          ad = e(BLEND_FACTORS[b.alpha.dstFactor ?? 'zero']);
        if (i === null || !indexed) {
          gl.blendEquationSeparate(ce, ae);
          gl.blendFuncSeparate(cs, cd, as, ad);
        } else {
          indexed.blendEquationSeparateiOES(i, ce, ae);
          indexed.blendFuncSeparateiOES(i, cs, cd, as, ad);
        }
      });
    };
    if (uniform || !indexed) {
      // The GL-wide state: identical targets, or (without OES_draw_buffers_indexed) the group a split draw draws.
      if (states.length) apply(null, states[only ?? 0]);
      for (let i = 0; i < 8; i++) {
        s.forget(`colorMask${i}`);
        s.forget(`blend${i}`);
      }
    } else {
      states.forEach((x, i) => apply(i, x));
      s.forget('colorMask');
      s.forget('blend');
    }
  }

  /**
   * Binds the pipeline's uniform blocks, textures and storage buffers from the current bind groups; false when one is
   * missing. Copies and uploads (a view's copy brought up to date, a multisample resolve, a storage buffer's data
   * texture) all happen first: they use texture unit 0 and other GL state, so units are bound only after them.
   */
  private applyBindings(p: CompatRenderPipeline, pass: PassState): boolean {
    const gl = this.gl,
      s = this.device.state,
      device = this.device;
    const lookup = (group: number, binding: number): { bound: Bound; dynamic: number } | null => {
      const g = pass.groups[group];
      const bound = g?.group.entries.get(binding);
      if (!g || !bound) return null;
      const di = g.group.layout.dynamic.indexOf(binding);
      return { bound, dynamic: di >= 0 ? (g.offsets[di] ?? 0) : 0 };
    };
    const samplerAt = (at: { group: number; binding: number }): CompatSampler | null => {
      const sb = lookup(at.group, at.binding);
      if (sb?.bound.kind === 'sampler') return sb.bound.sampler;
      device.validationError(`Draw: no sampler is bound at @group(${at.group}) @binding(${at.binding})`);
      return null;
    };
    for (const u of p.uniforms) {
      const found = lookup(u.group, u.binding);
      if (!found || found.bound.kind !== 'buffer' || !found.bound.buffer.gl) {
        device.validationError(`Draw: nothing usable is bound at @group(${u.group}) @binding(${u.binding})`);
        return false;
      }
      const { buffer, offset, size } = found.bound;
      const start = offset + found.dynamic,
        glSize = Math.max(16, Math.ceil(buffer.size / 16) * 16),
        bind = Math.min(Math.max(size, u.size), glSize - start);
      if (bind < u.size) {
        device.validationError(
          `Draw: the buffer at @group(${u.group}) @binding(${u.binding}) is smaller than its uniform block`,
        );
        return false;
      }
      s.uniformBuffer(u.point, buffer.gl as WebGLBuffer, buffer.id, start, bind);
    }
    // Phase 1: what each unit will hold, with copies, resolves and uploads made now.
    const plan: { unit: number; target: number; texture: WebGLTexture | null; sampler: WebGLSampler }[] = [];
    const ranges = new Map<TextureStorage, string>();
    for (const t of p.textures) {
      const found = lookup(t.group, t.binding);
      if (!found || found.bound.kind !== 'view') {
        device.validationError(`Draw: no texture view is bound at @group(${t.group}) @binding(${t.binding})`);
        return false;
      }
      const view = found.bound.view,
        tex = view.texture,
        stencil = tex.info.kind === 'stencil' || view.aspect === 'stencil-only';
      if (t.unit >= 0 && stencil && !device.ext.stencilTexturing)
        throw device.unsupported('sampling a stencil aspect (this WebGL2 has no WEBGL_stencil_texturing)');
      let sampler: WebGLSampler = device.loadSampler;
      if (t.sampler) {
        const samp = samplerAt(t.sampler);
        if (!samp) return false;
        const unfilterable =
          (hasDepth(tex.info) && !samp.comparison) || tex.info.kind === 'uint' || tex.info.kind === 'sint';
        sampler = unfilterable ? samp.nearest() : samp.sampler;
        if (t.mipFilters.length) {
          const d = samp.d,
            low = d.lodMinClamp ?? 0,
            high = d.lodMaxClamp ?? 32,
            enabled =
              !unfilterable &&
              d.mipmapFilter === 'linear' &&
              (d.minFilter === 'linear') === (d.magFilter === 'linear') &&
              (d.maxAnisotropy ?? 1) === 1 &&
              Number.isInteger(low) &&
              Number.isInteger(high),
            values = [+enabled, low, high],
            key = values.join();
          for (const loc of t.mipFilters)
            if (p.cache.modes.get(loc) !== key) {
              s.useProgram(p.program);
              gl.uniform3fv(loc, values);
              p.cache.modes.set(loc, key);
            }
        }
      }
      for (const m of t.modes) {
        const samp = samplerAt(m);
        if (!samp) return false;
        const key = samp.modes.join();
        if (p.cache.modes.get(m.location) !== key) {
          s.useProgram(p.program);
          gl.uniform4iv(m.location, samp.modes);
          p.cache.modes.set(m.location, key);
        }
      }
      let levels = view.mipLevelCount;
      if (t.unit < 0) {
        // Read for its size or level count only: nothing to bind.
      } else if (tex.renderbuffer) {
        levels = 1;
        this.resolveForSampling(tex);
        plan.push({ unit: t.unit, target: gl.TEXTURE_2D, texture: tex.resolved, sampler });
      } else {
        const range = `${view.baseMipLevel}:${view.baseMipLevel + levels - 1}`,
          sampleState = `${range}:${stencil}`;
        let storage = tex.sampled(view),
          alias = 1;
        // WebGPU lets a pass sample the depth texture it has attached read-only; GL calls that a feedback loop and refuses
        // the draw whatever the masks say, so the draw reads a copy that follows the attachment's depth.
        const attachment = pass.desc.depth?.view;
        if (attachment?.texture === tex && storage === tex.attached(attachment)) storage = tex.sampled(view, alias++);
        // GL keeps one base and max level per texture object: another range of a texture this draw already samples
        // (Bloom's last up step reads two levels of its down chain) reads a copy of its own.
        while (ranges.has(storage) && ranges.get(storage) !== sampleState) storage = tex.sampled(view, alias++);
        ranges.set(storage, sampleState);
        tex.read(storage, view.baseMipLevel, view.mipLevelCount, view.baseArrayLayer, view.arrayLayerCount, this.sync);
        if (storage.levels !== range) {
          s.scratch(storage.target, storage.gl);
          gl.texParameteri(storage.target, gl.TEXTURE_BASE_LEVEL, view.baseMipLevel);
          gl.texParameteri(storage.target, gl.TEXTURE_MAX_LEVEL, view.baseMipLevel + levels - 1);
          storage.levels = range;
        }
        plan.push({ unit: t.unit, target: storage.target, texture: storage.gl, sampler });
      }
      // The sampling aspect belongs to the GL texture object, including resolved MSAA storage.
      // Restore depth on later draws; ordinary views use aliases above for simultaneous aspects.
      if (t.unit >= 0 && hasStencil(tex.info) && device.ext.stencilTexturing) {
        const ext = device.ext.stencilTexturing,
          sampled = plan[plan.length - 1];
        s.scratch(sampled.target, sampled.texture);
        gl.texParameteri(
          sampled.target,
          ext.DEPTH_STENCIL_TEXTURE_MODE_WEBGL,
          stencil ? ext.STENCIL_INDEX_WEBGL : gl.DEPTH_COMPONENT,
        );
      }
      if (t.sizes.length) {
        const [w, h, d] = tex.levelSize(tex.renderbuffer ? 0 : view.baseMipLevel);
        const depth = tex.dimension === '3d' ? d : tex.renderbuffer ? 1 : view.arrayLayerCount;
        const key = `${w},${h},${depth}`;
        for (const loc of t.sizes)
          if (p.cache.sizes.get(loc) !== key) {
            s.useProgram(p.program);
            gl.uniform4i(loc, w, h, depth, 0);
            p.cache.sizes.set(loc, key);
          }
      }
      for (const loc of t.levels)
        if (p.cache.levels.get(loc) !== levels) {
          s.useProgram(p.program);
          gl.uniform1i(loc, levels);
          p.cache.levels.set(loc, levels);
        }
    }
    for (const b of p.storage) {
      const setInfo = (location: WebGLUniformLocation, row: number, size: number, shift: number) => {
        const key = `${row},${size},${shift}`;
        if (p.cache.info.get(location) === key) return;
        s.useProgram(p.program);
        gl.uniform4i(location, row, size, shift, 0);
        p.cache.info.set(location, key);
      };
      if (b.binding < 0) {
        // The bind group's shared data texture: every storage binding without a dynamic offset.
        const group = pass.groups[b.group]?.group,
          data = group?.storageTexture();
        if (!group || !data) {
          device.validationError(`Draw: no bind group with storage buffers is bound at @group(${b.group})`);
          return false;
        }
        for (const i of b.info) {
          const bound = group.entries.get(i.binding),
            row = data.rows.get(i.binding);
          if (bound?.kind !== 'buffer' || row === undefined) {
            device.validationError(`Draw: no storage buffer is bound at @group(${b.group}) @binding(${i.binding})`);
            return false;
          }
          setInfo(i.location, row, bound.size, data.shift);
        }
        plan.push({ unit: b.unit, target: gl.TEXTURE_2D, texture: data.texture, sampler: device.loadSampler });
        continue;
      }
      const found = lookup(b.group, b.binding);
      if (!found || found.bound.kind !== 'buffer') {
        device.validationError(`Draw: no storage buffer is bound at @group(${b.group}) @binding(${b.binding})`);
        return false;
      }
      const { buffer, offset, size } = found.bound;
      const data = buffer.dataTexture();
      if (!data) {
        device.validationError(
          `Draw: the buffer at @group(${b.group}) @binding(${b.binding}) has no GPU copy to read; give it STORAGE usage`,
        );
        return false;
      }
      plan.push({ unit: b.unit, target: gl.TEXTURE_2D, texture: data.texture, sampler: device.loadSampler });
      for (const i of b.info) setInfo(i.location, (offset + found.dynamic) >> 4, size, data.shift);
    }
    // Phase 2: bind the units.
    for (const u of plan) s.unit(u.unit, u.target, u.texture, u.sampler);
    return true;
  }

  /** Points the VAO at the bound vertex buffers; `base` is the base vertex, `instance` the first instance. */
  private applyVertex(p: CompatRenderPipeline, pass: PassState, base: number, instance: number): boolean {
    const gl = this.gl;
    for (const [i, a] of p.attributes.entries()) {
      const vb = pass.vertex[a.slot];
      if (!vb?.buffer.gl) {
        this.device.validationError(`Draw: no vertex buffer at slot ${a.slot}`);
        return false;
      }
      const offset = vb.offset + a.offset + (a.instance ? instance : base) * a.stride;
      if (offset < 0) throw this.device.unsupported('a negative base vertex below the start of a vertex buffer');
      const key = `${vb.buffer.id}:${offset}`;
      if (p.cache.pointers[i] === key) continue;
      p.cache.pointers[i] = key;
      gl.bindBuffer(gl.ARRAY_BUFFER, vb.buffer.gl);
      if (a.integer) gl.vertexAttribIPointer(a.location, a.size, a.type, a.stride, offset);
      else gl.vertexAttribPointer(a.location, a.size, a.type, a.normalized, a.stride, offset);
    }
    return true;
  }

  private ready(baseVertex: number, firstInstance: number): CompatRenderPipeline | null {
    const pass = this.pass,
      p = pass?.pipeline;
    if (!pass || !p) {
      this.device.validationError('Draw without a pipeline or outside a render pass');
      return null;
    }
    p.finish();
    if (p.failure || !p.program) return null;
    // Bindings first: bringing a texture copy up to date or resolving one draws with other GL state.
    if (!this.applyBindings(p, pass)) return null;
    this.applyPipeline(p, pass);
    if (!this.applyVertex(p, pass, baseVertex, firstInstance)) return null;
    p.onDraw?.();
    const gl = this.gl;
    if (p.baseVertex && p.cache.baseVertex !== baseVertex) {
      gl.uniform1ui(p.baseVertex, baseVertex >>> 0);
      p.cache.baseVertex = baseVertex;
    }
    if (p.baseInstance && p.cache.baseInstance !== firstInstance) {
      gl.uniform1ui(p.baseInstance, firstInstance >>> 0);
      p.cache.baseInstance = firstInstance;
    }
    return p;
  }

  draw(count: number, instances: number, first: number, firstInstance: number): void {
    if (!count || !instances) return;
    const p = this.ready(0, firstInstance);
    if (p) this.split(p, () => this.gl.drawArraysInstanced(p.mode, first, count, instances));
  }

  /** Runs a draw once, or once per target group of a split pipeline (see CompatRenderPipeline.splits). */
  private split(p: CompatRenderPipeline, run: () => void): void {
    const pass = this.pass;
    if (!p.splits || !pass) {
      run();
      return;
    }
    const gl = this.gl;
    const all = pass.desc.colors.map((c, i) => (c ? gl.COLOR_ATTACHMENT0 + i : gl.NONE));
    for (const group of p.splits) {
      gl.drawBuffers(all.map((b, i) => (group.includes(i) ? b : gl.NONE)));
      this.applyTargets(p, group[0]);
      run();
    }
    gl.drawBuffers(all);
    pass.applied = null;
  }

  drawIndexed(count: number, instances: number, firstIndex: number, baseVertex: number, firstInstance: number): void {
    if (!count || !instances) return;
    const index = this.pass?.index;
    if (!index?.buffer.element) {
      this.device.validationError('drawIndexed without an index buffer');
      return;
    }
    const p = this.ready(baseVertex, firstInstance);
    if (!p) return;
    if (p.cache.element !== index.buffer.id) {
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, index.buffer.element);
      p.cache.element = index.buffer.id;
    }
    this.split(p, () =>
      this.gl.drawElementsInstanced(p.mode, count, index.type, index.offset + firstIndex * index.size, instances),
    );
  }

  // ------------------------------------------------ helper draws

  /** A full-target triangle program with this fragment shader body (compiled once per device). */
  /** @internal */
  helper(key: string, fragment: string): Helper {
    let h = this.helpers.get(key);
    if (h) return h;
    const gl = this.gl,
      program = gl.createProgram() as WebGLProgram;
    const vertex =
      '#version 300 es\nvoid main() { gl_Position = vec4(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0, 0.0, 1.0); }';
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, `#version 300 es\nprecision highp float;\nprecision highp int;\n${fragment}`],
    ] as const) {
      const shader = gl.createShader(type) as WebGLShader;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw fault(
        'failed',
        `The compatibility layer's own ${key} program did not link (a bug: report it): ${gl.getProgramInfoLog(program)}`,
        'compatibility-layer',
      );
    this.device.state.useProgram(program);
    const texture = gl.getUniformLocation(program, 't');
    if (texture) gl.uniform1i(texture, 0);
    h = { program, offset: gl.getUniformLocation(program, 'o'), value: gl.getUniformLocation(program, 'v') };
    this.helpers.set(key, h);
    return h;
  }

  /** Sets the GL state for a helper draw into the bound framebuffer over (0, 0, w, h). */
  /** @internal */
  helperState(h: Helper, w: number, ht: number): void {
    const gl = this.gl,
      s = this.device.state;
    this.openMasks();
    s.useProgram(h.program);
    s.bindVertexArray((this.emptyVao ??= gl.createVertexArray()));
    for (const cap of [
      gl.CULL_FACE,
      gl.DEPTH_TEST,
      gl.STENCIL_TEST,
      gl.POLYGON_OFFSET_FILL,
      gl.SAMPLE_ALPHA_TO_COVERAGE,
    ])
      s.enable(cap, false);
    s.enable(gl.SCISSOR_TEST, false);
    s.set('blend', 'off', () => gl.disable(gl.BLEND));
    for (let i = 0; i < 8; i++) s.forget(`blend${i}`);
    s.set('viewport', `0,0,${w},${ht}`, () => gl.viewport(0, 0, w, ht));
  }

  // ------------------------------------------------ copies

  copyBuffer(src: CompatBuffer, srcOffset: number, dst: CompatBuffer, dstOffset: number, size: number): void {
    if (!size) return;
    const gl = this.gl;
    if (src.readbacks.length && !src.settle()) {
      // The source still waits for query results: the copy lands after them, in order with dst's other writes.
      dst.readbacks.push({
        forcible: false,
        ready: () => src.settle(),
        apply: () => dst.land(dstOffset, src.bytes().slice(srcOffset, srcOffset + size)),
      });
      return;
    }
    if (dst.readbacks.length && !dst.settle()) {
      const bytes = src.bytes().slice(srcOffset, srcOffset + size);
      dst.readbacks.push({ forcible: true, ready: () => true, apply: () => dst.land(dstOffset, bytes) });
      return;
    }
    if (src.shadow && src.shadowValid) {
      dst.write(dstOffset, src.shadow.subarray(srcOffset, srcOffset + size));
      return;
    }
    if (src.gl && dst.gl) {
      gl.bindBuffer(gl.COPY_READ_BUFFER, src.gl);
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, dst.gl);
      gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, srcOffset, dstOffset, size);
      dst.version++;
      if (dst.shadow) dst.shadowValid = false;
      if (!dst.element) return;
    }
    // A copy the GPU cannot make (into an index buffer, or out of a GPU-only buffer into a CPU-only one).
    dst.write(dstOffset, src.bytes().subarray(srcOffset, srcOffset + size));
  }

  copyBufferToTexture(
    source: GPUTexelCopyBufferInfo & { buffer: CompatBuffer },
    destination: GPUTexelCopyTextureInfo & { texture: CompatTexture },
    size: GPUExtent3D,
  ): void {
    const bytes = source.buffer.bytes();
    writeTexture(
      this.device,
      destination,
      bytes,
      { offset: source.offset ?? 0, bytesPerRow: source.bytesPerRow, rowsPerImage: source.rowsPerImage },
      size,
    );
  }

  copyTextureToTexture(
    source: GPUTexelCopyTextureInfo & { texture: CompatTexture },
    destination: GPUTexelCopyTextureInfo & { texture: CompatTexture },
    [w, h, depth]: [number, number, number],
  ): void {
    const a = source.texture as CompatTexture,
      b = destination.texture as CompatTexture;
    if (a.renderbuffer || b.renderbuffer) throw this.device.unsupported('copying a multisampled texture');
    if (
      a.format !== b.format &&
      a.info.internal.replace('SRGB8_ALPHA8', 'RGBA8') !== b.info.internal.replace('SRGB8_ALPHA8', 'RGBA8')
    )
      throw new TypeError(
        `copyTextureToTexture copies within one format or its sRGB twin (${a.format} to ${b.format}); use textures of matching formats`,
      );
    if (!a.info.renderable)
      throw this.device.unsupported(
        `copying between ${a.format} textures (WebGL2 cannot attach the format to copy it)`,
      );
    const [sx, sy, sz] = origin(source.origin),
      [dx, dy, dz] = origin(destination.origin);
    const from = a.primary as TextureStorage,
      to = b.primary as TextureStorage,
      fromLevel = source.mipLevel ?? 0,
      toLevel = destination.mipLevel ?? 0;
    const a3 = a.dimension === '3d',
      b3 = b.dimension === '3d';
    a.read(from, fromLevel, 1, a3 ? 0 : sz, a3 ? 1 : depth, this.sync);
    b.read(to, toLevel, 1, b3 ? 0 : dz, b3 ? 1 : depth, this.sync);
    if (this.tierCopy(from, to)) {
      (this.device.readback as NonNullable<CompatDevice['readback']>).copyTierStorage(
        this,
        from,
        to,
        fromLevel,
        toLevel,
        [sx, sy, sz],
        [dx, dy, dz],
        [w, h, depth],
      );
      return;
    }
    for (let i = 0; i < depth; i++) {
      const src = this.sub(from, fromLevel, sz + i);
      if (a.info.internal === b.info.internal) this.blit(src, this.sub(to, toLevel, dz + i), sx, sy, w, h, dx, dy);
      else this.rawCopy(src, to, toLevel, dz + i, [sx, sy, w, h], [dx, dy]);
    }
    b.wrote(to, toLevel, 1, b3 ? 0 : dz, b3 ? 1 : depth);
    b.initialized = true;
    this.rebind();
  }
}

// ---------------------------------------------------------------- uploads

const TYPED: Record<string, (b: ArrayBuffer, o: number, n: number) => ArrayBufferView> = {
  UNSIGNED_BYTE: (b, o, n) => new Uint8Array(b, o, n),
  BYTE: (b, o, n) => new Int8Array(b, o, n),
  UNSIGNED_SHORT: (b, o, n) => new Uint16Array(b, o, n >> 1),
  SHORT: (b, o, n) => new Int16Array(b, o, n >> 1),
  HALF_FLOAT: (b, o, n) => new Uint16Array(b, o, n >> 1),
  FLOAT: (b, o, n) => new Float32Array(b, o, n >> 2),
  UNSIGNED_INT: (b, o, n) => new Uint32Array(b, o, n >> 2),
  INT: (b, o, n) => new Int32Array(b, o, n >> 2),
  UNSIGNED_INT_5_9_9_9_REV: (b, o, n) => new Uint32Array(b, o, n >> 2),
  UNSIGNED_INT_2_10_10_10_REV: (b, o, n) => new Uint32Array(b, o, n >> 2),
  UNSIGNED_INT_10F_11F_11F_REV: (b, o, n) => new Uint32Array(b, o, n >> 2),
};

/** Brings the primary storage's levels and layers up to date before an upload writes part of them. */
function beforeUpload(device: CompatDevice, t: CompatTexture, level: number, z: number, depth: number): void {
  const is3d = t.dimension === '3d';
  t.read(t.primary as TextureStorage, level, 1, is3d ? 0 : z, is3d ? 1 : depth, device.replayer.sync);
}
function afterUpload(t: CompatTexture, level: number, z: number, depth: number): void {
  const is3d = t.dimension === '3d';
  t.wrote(t.primary as TextureStorage, level, 1, is3d ? 0 : z, is3d ? 1 : depth);
  t.initialized = true;
}

/** queue.writeTexture and copyBufferToTexture: CPU bytes into a texture region. */
export function writeTexture(
  device: CompatDevice,
  destination: GPUTexelCopyTextureInfo & { texture: CompatTexture },
  data: Uint8Array,
  layout: GPUTexelCopyBufferLayout,
  size: GPUExtent3D,
  storage?: TextureStorage,
): void {
  const gl = device.gl,
    t = destination.texture as CompatTexture,
    info = t.info;
  if (!t.texture) throw device.unsupported('writing a multisampled texture');
  if (info.block) return writeBlocks(device, t, destination, data, layout, size);
  if (!info.bytes || info.kind === 'stencil' || info.kind === 'depth-stencil')
    throw device.unsupported(
      `writing ${info.name} texels (WebGL2 uploads depth and stencil together, so a stencil-only write cannot be made)`,
    );
  const [w, h, depth] = extent(size),
    [x, y, z] = origin(destination.origin);
  const level = destination.mipLevel ?? 0;
  let rowBytes = w * info.bytes;
  const bytesPerRow = layout.bytesPerRow ?? rowBytes,
    rowsPerImage = layout.rowsPerImage ?? h,
    offset = layout.offset ?? 0;
  // Tight rows in GL's order: WebGPU's bytesPerRow need not be a whole number of texels, and bgra swaps channels.
  let tight = new Uint8Array(rowBytes * h * depth);
  for (let layer = 0; layer < depth; layer++)
    for (let row = 0; row < h; row++) {
      const from = offset + layer * bytesPerRow * rowsPerImage + row * bytesPerRow;
      tight.set(data.subarray(from, from + rowBytes), (layer * h + row) * rowBytes);
    }
  if (info.bgra)
    for (let i = 0; i < tight.length; i += 4) {
      const r = tight[i];
      tight[i] = tight[i + 2];
      tight[i + 2] = r;
    }
  const upload = device.adapter.tierFormats?.upload(info, storage?.info ?? t.storageInfo, tight) ?? {
    info,
    bytes: tight,
  };
  tight = upload.bytes;
  const stored = upload.info;
  rowBytes = w * stored.bytes;
  if (!storage) beforeUpload(device, t, level, z, depth);
  const target = storage?.target ?? t.target;
  device.state.scratch(target, storage?.gl ?? t.texture);
  const format = device.enum(stored.format),
    type = device.enum(stored.type);
  const pixels = TYPED[stored.type](tight.buffer, 0, tight.byteLength);
  if (target === gl.TEXTURE_2D) gl.texSubImage2D(gl.TEXTURE_2D, level, x, y, w, h, format, type, pixels);
  else if (target === gl.TEXTURE_CUBE_MAP)
    for (let layer = 0; layer < depth; layer++)
      gl.texSubImage2D(
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + z + layer - (storage?.layer ?? 0),
        level,
        x,
        y,
        w,
        h,
        format,
        type,
        TYPED[stored.type](tight.buffer, layer * rowBytes * h, rowBytes * h),
      );
  else gl.texSubImage3D(target, level, x, y, z - (storage?.layer ?? 0), w, h, depth, format, type, pixels);
  if (!storage) afterUpload(t, level, z, depth);
}

/** writeTexture into a block-compressed texture: whole blocks, uploaded as they are (compressedTexSubImage). */
function writeBlocks(
  device: CompatDevice,
  t: CompatTexture,
  destination: GPUTexelCopyTextureInfo,
  data: Uint8Array,
  layout: GPUTexelCopyBufferLayout,
  size: GPUExtent3D,
): void {
  const gl = device.gl,
    block = t.info.block as NonNullable<FormatInfo['block']>;
  const [w, h, depth] = extent(size),
    [x, y, z] = origin(destination.origin);
  const level = destination.mipLevel ?? 0;
  const across = Math.ceil(w / block.w),
    down = Math.ceil(h / block.h),
    rowBytes = across * block.bytes;
  const bytesPerRow = layout.bytesPerRow ?? rowBytes,
    rowsPerImage = layout.rowsPerImage ?? down,
    offset = layout.offset ?? 0;
  const tight = new Uint8Array(rowBytes * down * depth);
  for (let layer = 0; layer < depth; layer++)
    for (let row = 0; row < down; row++) {
      const from = offset + (layer * rowsPerImage + row) * bytesPerRow;
      tight.set(data.subarray(from, from + rowBytes), (layer * down + row) * rowBytes);
    }
  beforeUpload(device, t, level, z, depth);
  device.state.scratch(t.target, t.texture);
  // A copy of whole blocks may run past a mip level smaller than one block; GL takes the level's own size there.
  const [lw, lh] = t.levelSize(level),
    cw = Math.min(w, lw - x),
    ch = Math.min(h, lh - y);
  const internal = device.enum(t.info.internal),
    image = rowBytes * down;
  if (t.target === gl.TEXTURE_2D) gl.compressedTexSubImage2D(gl.TEXTURE_2D, level, x, y, cw, ch, internal, tight);
  else if (t.target === gl.TEXTURE_CUBE_MAP)
    for (let layer = 0; layer < depth; layer++)
      gl.compressedTexSubImage2D(
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + z + layer,
        level,
        x,
        y,
        cw,
        ch,
        internal,
        tight.subarray(layer * image, (layer + 1) * image),
      );
  else gl.compressedTexSubImage3D(t.target, level, x, y, z, cw, ch, depth, internal, tight);
  afterUpload(t, level, z, depth);
}

/** queue.copyExternalImageToTexture: an image, canvas, video frame or bitmap into a texture. */
export function copyExternalImage(
  device: CompatDevice,
  source: GPUCopyExternalImageSourceInfo,
  destination: GPUCopyExternalImageDestInfo & { texture: CompatTexture },
  size: GPUExtent3D,
): void {
  const gl = device.gl,
    t = destination.texture as CompatTexture,
    info = t.storageInfo;
  if (!t.texture || info.kind !== 'float' || !info.renderable)
    throw device.unsupported(`copying an image into a ${info.name} texture`);
  const [w, h] = extent(size),
    [x, y, z] = origin(destination.origin),
    [sourceX, sourceY] = origin(source.origin as GPUOrigin3D | undefined);
  let image = source.source,
    sx = sourceX,
    sy = sourceY;
  // A whole, unchanged bitmap can be uploaded directly. Drawing it through a
  // 2D canvas irreversibly quantizes straight RGB when alpha is small (and loses
  // RGB entirely at alpha zero). Keep that path only when a transform is needed.
  // WebGL ignores unpack flip and alpha flags for ImageBitmap, so transformed
  // copies still need a drawable source before applying those unpack flags.
  if (
    typeof ImageBitmap !== 'undefined' &&
    image instanceof ImageBitmap &&
    (source.flipY || destination.premultipliedAlpha || sx || sy || w !== image.width || h !== image.height)
  ) {
    const canvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) throw device.unsupported('a 2D canvas for external bitmap copies');
    context.drawImage(image, sx, sy, w, h, 0, 0, w, h);
    image = canvas;
    sx = sy = 0;
  }
  const level = destination.mipLevel ?? 0;
  beforeUpload(device, t, level, z, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!source.flipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!destination.premultipliedAlpha);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, sx);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, sy);
  device.state.scratch(t.target, t.texture);
  const type = info.type === 'HALF_FLOAT' || info.type === 'FLOAT' ? info.type : 'UNSIGNED_BYTE';
  if (t.target === gl.TEXTURE_2D || t.target === gl.TEXTURE_CUBE_MAP)
    gl.texSubImage2D(
      t.target === gl.TEXTURE_CUBE_MAP ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + z : gl.TEXTURE_2D,
      level,
      x,
      y,
      w,
      h,
      device.enum(info.format),
      device.enum(type),
      image as TexImageSource,
    );
  else
    gl.texSubImage3D(
      t.target,
      level,
      x,
      y,
      z,
      w,
      h,
      1,
      device.enum(info.format),
      device.enum(type),
      image as TexImageSource,
    );
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  afterUpload(t, level, z, 1);
}
