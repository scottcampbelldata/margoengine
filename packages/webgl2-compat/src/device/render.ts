// Render pipelines, command encoders and the replay of command buffers on WebGL2 (W3C WebGPU specification sections
// 10, 13, 17 and 18; Khronos OpenGL ES 3.0 and WebGL 2.0 specifications). Encoders record closures; submit replays
// them against a cache of GL state. Rendering is flipped in y so that row 0 of every target is its top, as in WebGPU
// (the vertex shader negates y and front faces swap), and only the canvas present flips back.
import { fault } from '../../../shared/errors.js';
import { translateWGSL, type GLSLProgram, type GLSLStage } from '../glsl.js';
import type { TextureType } from '../wgsl/types.js';
import { type FormatInfo, hasDepth, hasStencil, toHalf, VERTEX_FORMATS } from './formats.js';
import type { CompatDevice } from './device.js';
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
  readonly unit: number;
  readonly group: number;
  readonly binding: number;
  readonly sampler?: { readonly group: number; readonly binding: number; readonly comparison: boolean };
  readonly type: TextureType;
  readonly levels: WebGLUniformLocation[];
}
interface TargetState {
  readonly blend?: GPUBlendState;
  readonly writeMask: number;
}

/** A GPURenderPipeline: a linked program, its vertex layout and VAO, its fixed-function state and its binding table. */
export class CompatRenderPipeline {
  label: string;
  readonly program: WebGLProgram | null = null;
  readonly vao: WebGLVertexArrayObject | null = null;
  readonly glsl: GLSLProgram | null = null;
  /** Set when the pipeline cannot draw: the message of its validation error. */
  failure: string | null = null;
  readonly attributes: Attribute[] = [];
  readonly uniforms: UniformSlot[] = [];
  readonly textures: TextureSlot[] = [];
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
  };
  private linked = false;
  private readonly layouts: (CompatBindGroupLayout | null)[];
  private readonly shaders: WebGLShader[] = [];

  constructor(
    readonly device: CompatDevice,
    descriptor: GPURenderPipelineDescriptor,
    deferLink = false,
  ) {
    const gl = device.gl;
    this.label = descriptor.label ?? '';
    const prim = descriptor.primitive ?? {};
    this.mode = device.enum(TOPOLOGY[prim.topology ?? 'triangle-list']);
    this.cull = prim.cullMode === 'front' ? gl.FRONT : prim.cullMode === 'back' ? gl.BACK : 0;
    // y is flipped in the vertex shader, so WebGPU's counter-clockwise front faces are clockwise in GL.
    this.frontFace = prim.frontFace === 'cw' ? gl.CCW : gl.CW;
    this.unclippedDepth = !!prim.unclippedDepth;
    this.depthStencil = descriptor.depthStencil;
    this.alphaToCoverage = !!descriptor.multisample?.alphaToCoverageEnabled;
    this.sampleCount = descriptor.multisample?.count ?? 1;
    this.targets = [...(descriptor.fragment?.targets ?? [])].map((t) =>
      t ? { blend: t.blend, writeMask: t.writeMask ?? 0xf } : null,
    );
    const vertexModule = descriptor.vertex.module as unknown as CompatShaderModule,
      fragmentModule = descriptor.fragment?.module as unknown as CompatShaderModule | undefined;
    const explicit = descriptor.layout !== 'auto' ? (descriptor.layout as unknown as CompatPipelineLayout) : null;
    this.layouts = explicit ? [...explicit.bindGroupLayouts] : [];
    if (vertexModule.error || fragmentModule?.error) {
      this.failure = 'createRenderPipeline: a shader module of the pipeline failed to compile';
      device.validationError(this.failure);
      return;
    }
    try {
      this.glsl = translateWGSL({
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
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'unsupported') throw error;
      this.failure = `createRenderPipeline${this.label ? ` '${this.label}'` : ''}: ${(error as Error).message}`;
      device.validationError(this.failure);
      return;
    }
    if (!explicit) this.layouts = autoLayouts(this.glsl);
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
    const gl = this.device.gl,
      program = this.program,
      glsl = this.glsl as GLSLProgram;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const logs = this.shaders.map((s) => gl.getShaderInfoLog(s)).filter(Boolean);
      this.failure = `createRenderPipeline${this.label ? ` '${this.label}'` : ''}: WebGL2 refused the translated program: ${[...logs, gl.getProgramInfoLog(program)].join(' ')}`;
      this.device.validationError(this.failure);
      return;
    }
    for (const s of this.shaders) gl.deleteShader(s);
    this.device.state.useProgram(program);
    const points = new Map<string, UniformSlot>(),
      units = new Map<string, TextureSlot>();
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
        const location = gl.getUniformLocation(program, t.name);
        if (!location) continue;
        const key = `${t.group}:${t.binding}|${t.sampler ? `${t.sampler.group}:${t.sampler.binding}` : ''}`;
        let slot = units.get(key);
        if (!slot) {
          slot = { unit: units.size, group: t.group, binding: t.binding, sampler: t.sampler, type: t.type, levels: [] };
          units.set(key, slot);
        }
        gl.uniform1i(location, slot.unit);
        const levels = t.levels ? gl.getUniformLocation(program, t.levels) : null;
        if (levels) slot.levels.push(levels);
      }
    }
    if (units.size > this.device.limits.maxSampledTexturesPerShaderStage)
      throw this.device.unsupported(
        `a pipeline with ${units.size} texture and sampler pairs (WebGL2 has ${this.device.limits.maxSampledTexturesPerShaderStage} units)`,
      );
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
  ) {}
}

/** A GPUCommandEncoder. */
export class CompatCommandEncoder {
  private readonly ops: Op[] = [];
  private finished = false;
  constructor(
    private readonly device: CompatDevice,
    public label: string,
  ) {}

  beginRenderPass(d: GPURenderPassDescriptor): CompatRenderPassEncoder {
    if (d.occlusionQuerySet) throw this.device.unsupported('occlusion queries (milestone M3)');
    if (d.timestampWrites) throw this.device.unsupported('timestamp queries');
    // A snapshot: callers may change their descriptor object once the pass has begun.
    const pass: PassDescriptor = {
      colors: [...d.colorAttachments].map((a) =>
        a
          ? {
              view: viewOf(a.view),
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
    };
    this.ops.push((r) => r.beginPass(pass));
    return new CompatRenderPassEncoder(this.ops, d.label ?? '');
  }

  beginComputePass(): never {
    throw this.device.unsupported('compute passes (compute is milestone M5)');
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
    this.ops.push((r) => r.copyTextureToBuffer(s as never, d as never, extent(size)));
  }
  copyTextureToTexture(source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyTextureInfo, size: GPUExtent3D): void {
    const s = { ...source },
      d = { ...destination };
    this.ops.push((r) => r.copyTextureToTexture(s as never, d as never, extent(size)));
  }
  clearBuffer(buffer: CompatBuffer, offset = 0, size?: number): void {
    this.ops.push(() => buffer.write(offset, new Uint8Array(size ?? buffer.size - offset)));
  }
  resolveQuerySet(): never {
    throw this.device.unsupported('query sets (milestone M3)');
  }
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}

  finish(descriptor: GPUCommandBufferDescriptor = {}): CompatCommandBuffer {
    if (this.finished) this.device.validationError('finish() was already called on this command encoder');
    this.finished = true;
    return new CompatCommandBuffer(this.ops, descriptor.label ?? this.label);
  }
}

const viewOf = (v: GPUTextureView | GPUTexture): CompatTextureView =>
  'createView' in (v as object) ? (v as unknown as CompatTexture).createView() : (v as unknown as CompatTextureView);

/** A GPURenderPassEncoder: each call records one replay step. */
export class CompatRenderPassEncoder {
  constructor(
    private readonly ops: Op[],
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
  beginOcclusionQuery(): void {
    throw fault(
      'unsupported',
      'WebGL2 compatibility cannot do occlusion queries yet (milestone M3)',
      'compatibility-layer',
    );
  }
  endOcclusionQuery(): void {}
  executeBundles(): void {
    throw fault(
      'unsupported',
      'WebGL2 compatibility cannot do render bundles yet (milestone M3)',
      'compatibility-layer',
    );
  }
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}
  end(): void {
    this.ops.push((r) => r.endPass());
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
function origin(o: GPUOrigin3D | undefined): [number, number, number] {
  if (!o) return [0, 0, 0];
  return Array.isArray(o)
    ? [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0]
    : [(o as GPUOrigin3DDict).x ?? 0, (o as GPUOrigin3DDict).y ?? 0, (o as GPUOrigin3DDict).z ?? 0];
}

// ---------------------------------------------------------------- replay

interface PassState {
  readonly desc: PassDescriptor;
  readonly width: number;
  readonly height: number;
  pipeline: CompatRenderPipeline | null;
  applied: CompatRenderPipeline | null;
  readonly groups: ({ group: CompatBindGroup; offsets: number[] } | null)[];
  readonly vertex: ({ buffer: CompatBuffer; offset: number } | null)[];
  index: { buffer: CompatBuffer; type: number; size: number; offset: number } | null;
  stencilReference: number;
}

/** Replays recorded operations against the device's GL state. */
export class Replayer {
  private pass: PassState | null = null;
  private readonly gl: WebGL2RenderingContext;
  constructor(private readonly device: CompatDevice) {
    this.gl = device.gl;
  }

  run(ops: readonly Op[]): void {
    for (const op of ops) {
      if (this.device.destroyed) return;
      op(this);
    }
  }

  // ------------------------------------------------ framebuffers

  /** Attaches a view's subresource to the bound draw framebuffer at `point`. */
  private attach(point: number, v: CompatTextureView): void {
    const gl = this.gl,
      t = v.texture;
    if (t.renderbuffer) gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, point, gl.RENDERBUFFER, t.renderbuffer);
    else if (t.target === gl.TEXTURE_2D)
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, point, gl.TEXTURE_2D, t.texture, v.baseMipLevel);
    else if (t.target === gl.TEXTURE_CUBE_MAP)
      gl.framebufferTexture2D(
        gl.DRAW_FRAMEBUFFER,
        point,
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + v.baseArrayLayer,
        t.texture,
        v.baseMipLevel,
      );
    else gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, point, t.texture, v.baseMipLevel, v.baseArrayLayer);
  }

  private depthPoint(info: FormatInfo): number {
    const gl = this.gl;
    return info.kind === 'depth'
      ? gl.DEPTH_ATTACHMENT
      : info.kind === 'stencil'
        ? gl.DEPTH_STENCIL_ATTACHMENT
        : gl.DEPTH_STENCIL_ATTACHMENT;
  }

  private key(v: CompatTextureView): string {
    return `${v.texture.id}.${v.baseMipLevel}.${v.baseArrayLayer}`;
  }

  /** A framebuffer of these colour views (null entries leave a draw buffer empty) and depth view. */
  private framebuffer(colors: readonly (CompatTextureView | null)[], depth?: CompatTextureView): WebGLFramebuffer {
    const gl = this.gl,
      device = this.device;
    const key = `${colors.map((v) => (v ? this.key(v) : '-')).join(',')}|${depth ? this.key(depth) : ''}`;
    const textures = [...colors.filter((v): v is CompatTextureView => !!v), ...(depth ? [depth] : [])].map(
      (v) => v.texture,
    );
    return device.framebuffer(key, textures, (fbo) => {
      device.state.bindDrawFramebuffer(fbo);
      colors.forEach((v, i) => v && this.attach(gl.COLOR_ATTACHMENT0 + i, v));
      if (depth) this.attach(this.depthPoint(depth.texture.info), depth);
      gl.drawBuffers(colors.map((v, i) => (v ? gl.COLOR_ATTACHMENT0 + i : gl.NONE)));
      const status = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE)
        device.validationError(
          `The render pass attachments do not form a complete WebGL2 framebuffer (status 0x${status.toString(16)})`,
        );
    });
  }

  /** A framebuffer with level 0, layer 0 of a texture as its one colour attachment (the canvas present reads it). */
  framebufferOf(t: CompatTexture): WebGLFramebuffer {
    return this.framebuffer([t.createView()]);
  }

  /** Full colour and depth write masks and no scissor, for clears and blits. */
  private openMasks(): void {
    const gl = this.gl,
      s = this.device.state;
    s.set('colorMask', '1111', () => gl.colorMask(true, true, true, true));
    for (let i = 0; i < 8; i++) s.forget(`colorMask${i}`);
    s.set('depthMask', '1', () => gl.depthMask(true));
    s.set('stencilMask', 'ff', () => gl.stencilMask(0xff));
    s.enable(gl.RASTERIZER_DISCARD, false);
    this.pass && (this.pass.applied = null);
  }

  /** Copies a multisampled renderbuffer into its resolve texture (or another view), one sample per pixel. */
  private blit(from: CompatTextureView, to: CompatTextureView, bits: number): void {
    const gl = this.gl,
      s = this.device.state;
    const read = this.framebuffer(
      bits === gl.COLOR_BUFFER_BIT ? [from] : [],
      bits === gl.COLOR_BUFFER_BIT ? undefined : from,
    );
    const draw = this.framebuffer(
      bits === gl.COLOR_BUFFER_BIT ? [to] : [],
      bits === gl.COLOR_BUFFER_BIT ? undefined : to,
    );
    this.openMasks();
    s.enable(gl.SCISSOR_TEST, false);
    s.bindReadFramebuffer(read);
    s.bindDrawFramebuffer(draw);
    const [w, h] = to.texture.levelSize(to.baseMipLevel);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, bits, gl.NEAREST);
  }

  /** Brings the resolved copy of a multisampled texture up to date before it is sampled. */
  private resolveForSampling(t: CompatTexture): void {
    if (!t.stale || !t.resolved) return;
    const gl = this.gl;
    const src = t.createView(),
      dst = {
        texture: {
          ...t,
          renderbuffer: null,
          target: gl.TEXTURE_2D,
          texture: t.resolved,
          id: -t.id,
          levelSize: () => [t.width, t.height, 1],
        },
        baseMipLevel: 0,
        baseArrayLayer: 0,
      } as unknown as CompatTextureView;
    this.blit(src, dst, hasDepth(t.info) ? gl.DEPTH_BUFFER_BIT : gl.COLOR_BUFFER_BIT);
    t.stale = false;
  }

  // ------------------------------------------------ passes

  beginPass(desc: PassDescriptor): void {
    const gl = this.gl,
      s = this.device.state;
    const colors = desc.colors.map((c) => c?.view ?? null);
    const fbo = this.framebuffer(colors, desc.depth?.view);
    const first = colors.find((v) => v) ?? desc.depth?.view;
    const [width, height] = first ? first.texture.levelSize(first.baseMipLevel) : [1, 1];
    this.pass = {
      desc,
      width,
      height,
      pipeline: null,
      applied: null,
      groups: [],
      vertex: [],
      index: null,
      stencilReference: 0,
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
    this.pass = null;
    const gl = this.gl;
    const discard: number[] = [];
    pass.desc.colors.forEach((c, i) => {
      if (!c) return;
      const t = c.view.texture;
      t.initialized = true;
      if (t.renderbuffer && t.resolved) t.stale = true;
      if (c.resolveTarget) {
        this.blit(c.view, c.resolveTarget, gl.COLOR_BUFFER_BIT);
        c.resolveTarget.texture.initialized = true;
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
      if (t.renderbuffer && t.resolved) t.stale = true;
      if (d.depthStoreOp === 'discard' && (!hasStencil(t.info) || d.stencilStoreOp === 'discard')) {
        discard.push(this.depthPoint(t.info));
        t.initialized = false;
      }
    }
    if (discard.length) {
      this.device.state.bindDrawFramebuffer(
        this.framebuffer(
          pass.desc.colors.map((c) => c?.view ?? null),
          d?.view,
        ),
      );
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
    if (this.pass) this.pass.groups[index] = group ? { group, offsets } : null;
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
        slope = ds.depthBiasSlopeScale ?? 0;
      s.enable(gl.POLYGON_OFFSET_FILL, bias !== 0 || slope !== 0);
      if (bias || slope) s.set('polygonOffset', `${slope},${bias}`, () => gl.polygonOffset(slope, bias));
    } else s.enable(gl.POLYGON_OFFSET_FILL, false);
    const stencilOn = !!ds && !!d && hasStencil(d.view.texture.info);
    s.enable(gl.STENCIL_TEST, stencilOn);
    if (stencilOn && ds) {
      const ref = pass.stencilReference,
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

  private applyTargets(p: CompatRenderPipeline): void {
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
      // The GL-wide state: identical targets, or no OES_draw_buffers_indexed (then target 0 decides for all).
      if (states.length) apply(null, states[0]);
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

  /** Binds the pipeline's uniform blocks and textures from the current bind groups; false when one is missing. */
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
    for (const t of p.textures) {
      const found = lookup(t.group, t.binding);
      if (!found || found.bound.kind !== 'view') {
        device.validationError(`Draw: no texture view is bound at @group(${t.group}) @binding(${t.binding})`);
        return false;
      }
      const view = found.bound.view,
        tex = view.texture;
      let sampler: WebGLSampler = device.loadSampler;
      if (t.sampler) {
        const sb = lookup(t.sampler.group, t.sampler.binding);
        if (!sb || sb.bound.kind !== 'sampler') {
          device.validationError(
            `Draw: no sampler is bound at @group(${t.sampler.group}) @binding(${t.sampler.binding})`,
          );
          return false;
        }
        const samp = sb.bound.sampler as CompatSampler;
        const unfilterable =
          (hasDepth(tex.info) && !samp.comparison) || tex.info.kind === 'uint' || tex.info.kind === 'sint';
        sampler = unfilterable ? samp.nearest() : samp.sampler;
      }
      let target = tex.target,
        glTexture = tex.texture;
      if (tex.renderbuffer) {
        this.resolveForSampling(tex);
        target = gl.TEXTURE_2D;
        glTexture = tex.resolved;
        if (pass) {
          // A resolve leaves the pass's framebuffer unbound: bind it again.
          s.bindDrawFramebuffer(
            this.framebuffer(
              pass.desc.colors.map((c) => c?.view ?? null),
              pass.desc.depth?.view,
            ),
          );
          s.enable(gl.SCISSOR_TEST, true);
          pass.applied = null;
        }
      } else if (
        (view.dimension === '2d' && target !== gl.TEXTURE_2D) ||
        (view.dimension === 'cube' && target !== gl.TEXTURE_CUBE_MAP)
      )
        throw device.unsupported(
          `sampling a ${view.dimension} view of a ${tex.dimension} texture with ${tex.depthOrArrayLayers} layers (texture views are milestone M3)`,
        );
      s.unit(t.unit, target, glTexture, sampler);
      const base = tex.renderbuffer ? 0 : view.baseMipLevel,
        max = tex.renderbuffer ? 0 : view.baseMipLevel + view.mipLevelCount - 1;
      const levels = `${base}:${max}`;
      if (!tex.renderbuffer && tex.levels !== levels) {
        s.activeUnit(t.unit);
        gl.texParameteri(target, gl.TEXTURE_BASE_LEVEL, base);
        gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, max);
        tex.levels = levels;
      }
      for (const loc of t.levels) {
        const n = tex.renderbuffer ? 1 : view.mipLevelCount;
        if (p.cache.levels.get(loc) !== n) {
          gl.uniform1i(loc, n);
          p.cache.levels.set(loc, n);
        }
      }
    }
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
    this.applyPipeline(p, pass);
    if (!this.applyBindings(p, pass) || !this.applyVertex(p, pass, baseVertex, firstInstance)) return null;
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
    if (p) this.gl.drawArraysInstanced(p.mode, first, count, instances);
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
    this.gl.drawElementsInstanced(p.mode, count, index.type, index.offset + firstIndex * index.size, instances);
  }

  // ------------------------------------------------ copies

  copyBuffer(src: CompatBuffer, srcOffset: number, dst: CompatBuffer, dstOffset: number, size: number): void {
    if (!size) return;
    const gl = this.gl;
    if (dst.readbacks.length) dst.settle();
    if (src.shadow && src.shadowValid && !src.readbacks.length) {
      dst.write(dstOffset, src.shadow.subarray(srcOffset, srcOffset + size));
      return;
    }
    if (src.gl && dst.gl) {
      gl.bindBuffer(gl.COPY_READ_BUFFER, src.gl);
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, dst.gl);
      gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, srcOffset, dstOffset, size);
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

  copyTextureToBuffer(
    source: GPUTexelCopyTextureInfo & { texture: CompatTexture },
    destination: GPUTexelCopyBufferInfo & { buffer: CompatBuffer },
    [w, h, depth]: [number, number, number],
  ): void {
    const gl = this.gl,
      t = source.texture as CompatTexture,
      info = t.info;
    if (t.renderbuffer) throw this.device.unsupported('copying a multisampled texture');
    const read = readFormat(info);
    if (!read || hasDepth(info) || info.kind === 'stencil')
      throw this.device.unsupported(`copying a ${info.name} texture to a buffer (milestone M3)`);
    const [x, y, z] = origin(source.origin);
    const level = source.mipLevel ?? 0;
    const dst = destination.buffer,
      bytesPerRow = destination.bytesPerRow ?? w * info.bytes,
      rowsPerImage = destination.rowsPerImage ?? h,
      base = destination.offset ?? 0;
    for (let layer = 0; layer < depth; layer++) {
      const view = t.createView({
        baseMipLevel: level,
        mipLevelCount: 1,
        baseArrayLayer: z + layer,
        arrayLayerCount: 1,
        dimension: t.target === gl.TEXTURE_3D ? '3d' : '2d',
      });
      const fbo = this.framebuffer([view]);
      this.device.state.bindReadFramebuffer(fbo);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      const rowBytes = w * read.bytes,
        total = rowBytes * h;
      const pack = gl.createBuffer() as WebGLBuffer;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, total, gl.STREAM_READ);
      gl.readPixels(x, y, w, h, this.device.enum(read.format), this.device.enum(read.type), 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) as WebGLSync;
      const offset = base + layer * bytesPerRow * rowsPerImage;
      dst.readbacks.push({
        sync,
        pack,
        bytes: total,
        write: (data) => {
          const out = convertRows(data, info, read, w, h, bytesPerRow);
          if (dst.shadow) dst.shadow.set(out.subarray(0, Math.min(out.length, dst.size - offset)), offset);
          if (dst.gl) {
            gl.bindBuffer(gl.COPY_WRITE_BUFFER, dst.gl);
            gl.bufferSubData(gl.COPY_WRITE_BUFFER, offset, out.subarray(0, Math.min(out.length, dst.size - offset)));
          }
        },
      });
    }
  }

  copyTextureToTexture(
    source: GPUTexelCopyTextureInfo & { texture: CompatTexture },
    destination: GPUTexelCopyTextureInfo & { texture: CompatTexture },
    [w, h, depth]: [number, number, number],
  ): void {
    const gl = this.gl,
      a = source.texture as CompatTexture,
      b = destination.texture as CompatTexture;
    if (a.format !== b.format) throw this.device.unsupported('copies between texture formats');
    const [sx, sy, sz] = origin(source.origin),
      [dx, dy, dz] = origin(destination.origin);
    const bits = hasDepth(a.info)
      ? gl.DEPTH_BUFFER_BIT | (hasStencil(a.info) ? gl.STENCIL_BUFFER_BIT : 0)
      : gl.COLOR_BUFFER_BIT;
    for (let i = 0; i < depth; i++) {
      const view = (t: CompatTexture, level: number, layer: number) =>
        t.createView({
          baseMipLevel: level,
          mipLevelCount: 1,
          baseArrayLayer: layer,
          arrayLayerCount: 1,
          dimension: t.target === gl.TEXTURE_3D ? '3d' : '2d',
        });
      const from = view(a, source.mipLevel ?? 0, sz + i),
        to = view(b, destination.mipLevel ?? 0, dz + i);
      const color = bits === gl.COLOR_BUFFER_BIT;
      const read = this.framebuffer(color ? [from] : [], color ? undefined : from),
        draw = this.framebuffer(color ? [to] : [], color ? undefined : to);
      this.openMasks();
      this.device.state.enable(gl.SCISSOR_TEST, false);
      this.device.state.bindReadFramebuffer(read);
      this.device.state.bindDrawFramebuffer(draw);
      gl.blitFramebuffer(sx, sy, sx + w, sy + h, dx, dy, dx + w, dy + h, bits, gl.NEAREST);
    }
    b.initialized = true;
  }
}

/** How readPixels reads a format: RGBA in bytes, floats or 32-bit integers. */
function readFormat(info: FormatInfo): { format: string; type: string; bytes: number } | null {
  if (!info.renderable || info.channelBytes === 0) return null;
  if (info.kind === 'uint') return { format: 'RGBA_INTEGER', type: 'UNSIGNED_INT', bytes: 16 };
  if (info.kind === 'sint') return { format: 'RGBA_INTEGER', type: 'INT', bytes: 16 };
  if (info.kind !== 'float') return null;
  if (info.channelBytes === 1) return { format: 'RGBA', type: 'UNSIGNED_BYTE', bytes: 4 };
  return { format: 'RGBA', type: 'FLOAT', bytes: 16 };
}

/** Converts rows read as RGBA into WebGPU's layout of the format, `bytesPerRow` apart. */
function convertRows(
  data: Uint8Array,
  info: FormatInfo,
  read: { type: string; bytes: number },
  w: number,
  h: number,
  bytesPerRow: number,
): Uint8Array {
  const out = new Uint8Array(bytesPerRow * (h - 1) + w * info.bytes);
  const view = new DataView(out.buffer);
  const f32 = new Float32Array(data.buffer, data.byteOffset, data.byteLength >> 2),
    u32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
  for (let row = 0; row < h; row++)
    for (let x = 0; x < w; x++) {
      const px = row * w + x,
        o = row * bytesPerRow + x * info.bytes;
      for (let c = 0; c < info.channels; c++) {
        const src = info.bgra && c < 3 ? 2 - c : c;
        if (read.type === 'UNSIGNED_BYTE') out[o + c] = data[px * 4 + src];
        else if (read.type === 'FLOAT') {
          if (info.channelBytes === 4) view.setFloat32(o + c * 4, f32[px * 4 + src], true);
          else view.setUint16(o + c * 2, toHalf(f32[px * 4 + src]), true);
        } else {
          const v = u32[px * 4 + src];
          if (info.channelBytes === 4) view.setUint32(o + c * 4, v, true);
          else if (info.channelBytes === 2) view.setUint16(o + c * 2, v & 0xffff, true);
          else out[o + c] = v & 0xff;
        }
      }
    }
  return out;
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

/** queue.writeTexture and copyBufferToTexture: CPU bytes into a texture region. */
export function writeTexture(
  device: CompatDevice,
  destination: GPUTexelCopyTextureInfo & { texture: CompatTexture },
  data: Uint8Array,
  layout: GPUTexelCopyBufferLayout,
  size: GPUExtent3D,
): void {
  const gl = device.gl,
    t = destination.texture as CompatTexture,
    info = t.info;
  if (!t.texture) throw device.unsupported('writing a multisampled texture');
  if (!info.bytes || info.kind === 'stencil' || info.kind === 'depth-stencil')
    throw device.unsupported(`writing ${info.name} texels (milestone M3)`);
  const [w, h, depth] = extent(size),
    [x, y, z] = origin(destination.origin);
  const level = destination.mipLevel ?? 0;
  const rowBytes = w * info.bytes,
    bytesPerRow = layout.bytesPerRow ?? rowBytes,
    rowsPerImage = layout.rowsPerImage ?? h,
    offset = layout.offset ?? 0;
  // Tight rows in GL's order: WebGPU's bytesPerRow need not be a whole number of texels, and bgra swaps channels.
  const tight = new Uint8Array(rowBytes * h * depth);
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
  device.state.scratch(t.target, t.texture);
  const format = device.enum(info.format),
    type = device.enum(info.type);
  const pixels = TYPED[info.type](tight.buffer, 0, tight.byteLength);
  if (t.target === gl.TEXTURE_2D) gl.texSubImage2D(gl.TEXTURE_2D, level, x, y, w, h, format, type, pixels);
  else if (t.target === gl.TEXTURE_CUBE_MAP)
    for (let layer = 0; layer < depth; layer++)
      gl.texSubImage2D(
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + z + layer,
        level,
        x,
        y,
        w,
        h,
        format,
        type,
        TYPED[info.type](tight.buffer, layer * rowBytes * h, rowBytes * h),
      );
  else gl.texSubImage3D(t.target, level, x, y, z, w, h, depth, format, type, pixels);
  t.initialized = true;
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
    info = t.info;
  if (!t.texture || info.kind !== 'float' || !info.renderable)
    throw device.unsupported(`copying an image into a ${info.name} texture`);
  const [w, h] = extent(size),
    [x, y] = origin(destination.origin),
    [sx, sy] = origin(source.origin as GPUOrigin3D | undefined);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!source.flipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!destination.premultipliedAlpha);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, sx);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, sy);
  device.state.scratch(t.target, t.texture);
  const type = info.type === 'HALF_FLOAT' || info.type === 'FLOAT' ? info.type : 'UNSIGNED_BYTE';
  gl.texSubImage2D(
    t.target === gl.TEXTURE_CUBE_MAP ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + origin(destination.origin)[2] : gl.TEXTURE_2D,
    destination.mipLevel ?? 0,
    x,
    y,
    w,
    h,
    device.enum(info.format),
    device.enum(type),
    source.source as TexImageSource,
  );
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  t.initialized = true;
}
