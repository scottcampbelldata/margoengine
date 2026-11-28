// Render pipelines, command encoders and the replay of command buffers on WebGL2 (W3C WebGPU specification sections
// 10, 13, 17 and 18; Khronos OpenGL ES 3.0 and WebGL 2.0 specifications). Encoders record closures; submit replays
// them against a cache of GL state. Rendering is flipped in y so that row 0 of every target is its top, as in WebGPU
// (the vertex shader negates y and front faces swap), and only the canvas present flips back.
import { stageUnits, translateWGSL, type GLSLProgram, type GLSLStage } from '../glsl.js';
import type { IREntryPoint, IRGlobalVar, IRModule } from '../wgsl/ir.js';
import type { TextureType } from '../wgsl/types.js';
import { type FormatInfo, glTexelBytes, hasDepth, hasStencil, VERTEX_FORMATS } from './formats.js';
import type { CompatDevice, FramebufferRecord } from './device.js';
import { S } from './gl.js';
import { fence, fenceDone } from './tasks.js';
import { drawnClear } from './fresh-clears.js';
import { type BoundGroup, CompatComputePassEncoder, type CompatComputePipeline, layoutEntry } from './compute.js';
import { ColorSnap, OP, Tape, type TapePool } from './tape.js';
import {
  type BlockWrite,
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
  levelRange,
  type TextureStorage,
  type Usable,
  twins,
  type Uses,
} from './resources.js';

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
  // dual-source-blending, on WEBGL_blend_func_extended's enums.
  src1: 'SRC1_COLOR_WEBGL',
  'one-minus-src1': 'ONE_MINUS_SRC1_COLOR_WEBGL',
  'src1-alpha': 'SRC1_ALPHA_WEBGL',
  'one-minus-src1-alpha': 'ONE_MINUS_SRC1_ALPHA_WEBGL',
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
/**
 * A colour target's blend and write mask as the replay sets them, worked out once per pipeline (applyTargets made
 * these strings, closures and enum lookups at every pipeline change before KB-COMPAT-FRAMEALLOC1).
 */
interface TargetGL {
  /** The blend state as a key ('off' for none), compared with GLState.blendChanged. */
  readonly key: string;
  readonly mask: number;
  readonly blend: boolean;
  readonly colorOp: number;
  readonly alphaOp: number;
  readonly colorSrc: number;
  readonly colorDst: number;
  readonly alphaSrc: number;
  readonly alphaDst: number;
}

/** The blend and write-mask state of a colour target as one string ('' blend for none). */
function targetKey(t: TargetState | null): string {
  const b = t?.blend;
  const blend = b
    ? `${b.color.operation ?? 'add'},${b.color.srcFactor ?? 'one'},${b.color.dstFactor ?? 'zero'},${b.alpha.operation ?? 'add'},${b.alpha.srcFactor ?? 'one'},${b.alpha.dstFactor ?? 'zero'}`
    : '';
  return `${blend}|${t?.writeMask ?? 0}`;
}

/** Idle programs (no live pipeline uses them) a device keeps for pipelines made again with the same GLSL. */
export const IDLE_PROGRAMS = 64;

/** Buffer ids of the warm draws' uniform buffers (LinkedProgram.warmed): below 0, so no real buffer's id matches. */
let warmIds = 0;
/** Per device, the programs whose warm draw is still on the GPU (LinkedProgram.waiting). */
const warming = new WeakMap<CompatDevice, Set<LinkedProgram>>();

/**
 * A GL program and VAO shared by every pipeline of the device with the same GLSL and vertex attributes (the device's
 * `linked` cache), with its binding table and the uniform values and VAO bindings last set on it. Pipelines made
 * again (a tracer rebuilt, a scene reloaded) reuse it instead of compiling and linking the same program again.
 */
export class LinkedProgram {
  readonly program: WebGLProgram;
  readonly vao: WebGLVertexArrayObject;
  /** The pipelines using it, weakly: with none left it is idle, and the device deletes it beyond IDLE_PROGRAMS. */
  readonly users: (WeakRef<object> | null)[] = [];
  /** The link log when WebGL2 refused the program, '' when it linked; null until checked. */
  refusal: string | null = null;
  /** Texture units the binding table takes, and how many of them textures (the rest are storage buffers). */
  units = 0;
  pairs = 0;
  readonly uniforms: UniformSlot[] = [];
  readonly textures: TextureSlot[] = [];
  readonly storage: StorageSlot[] = [];
  baseVertex: WebGLUniformLocation | null = null;
  baseInstance: WebGLUniformLocation | null = null;
  /** Last values of per-program uniforms and VAO bindings, so draws skip unchanged ones. */
  readonly cache = {
    baseVertex: -1,
    baseInstance: -1,
    element: -1,
    /** Per attribute: the id of the buffer and the byte offset its pointer was last set to (-1: never). */
    pointerBuffers: [] as number[],
    pointerOffsets: [] as number[],
    levels: new Map<WebGLUniformLocation, number>(),
    /** Three numbers a location: the size uniforms' width, height and depth or layers. */
    sizes: new Map<WebGLUniformLocation, Float64Array>(),
    /** Three numbers a location: mip filtering on (1) or off, lodMinClamp, lodMaxClamp. */
    mips: new Map<WebGLUniformLocation, Float64Array>(),
    /** The sampler address modes (CompatSampler.modes) last set at a location. */
    modes: new Map<WebGLUniformLocation, Int32Array>(),
    /** Three numbers a location: a storage buffer's row, size and row shift. */
    info: new Map<WebGLUniformLocation, Float64Array>(),
  };
  // When the GLSL went to WebGL2 (device.programs.linkMs).
  private readonly handedOver = performance.now();
  private readonly shaders: WebGLShader[] = [];
  /** The fence after the warm draw (see warmed()): undefined before it is drawn, null once nothing is left to wait for. */
  private warmFence: WebGLSync | null | undefined;

  constructor(
    private readonly device: CompatDevice,
    private readonly glsl: GLSLProgram,
    private readonly attributes: readonly Attribute[],
  ) {
    const gl = device.gl,
      program = (this.program = gl.createProgram() as WebGLProgram);
    device.programs.count++;
    for (const stage of [glsl.vertex, glsl.fragment]) {
      const s = gl.createShader(stage.stage === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER) as WebGLShader;
      gl.shaderSource(s, stage.source);
      gl.compileShader(s);
      gl.attachShader(program, s);
      this.shaders.push(s);
    }
    gl.linkProgram(program);
    this.vao = gl.createVertexArray() as WebGLVertexArrayObject;
    device.state.bindVertexArray(this.vao);
    for (const a of attributes) {
      gl.enableVertexAttribArray(a.location);
      gl.vertexAttribDivisor(a.location, a.instance ? 1 : 0);
    }
    device.state.bindVertexArray(null);
  }

  /** True once the driver knows the link status (always without KHR_parallel_shader_compile). */
  done(): boolean {
    const ext = this.device.ext.parallel;
    return (
      this.refusal !== null || !ext || !!this.device.gl.getProgramParameter(this.program, ext.COMPLETION_STATUS_KHR)
    );
  }

  /**
   * True while this program has yet to read its link status and binding table and another program's warm draw (see
   * warmed()) is still on the GPU. Those reads are synchronous: the page's thread waits until the browser's GPU thread
   * has run every command before them, and a warm draw there is a pixel shader compile on that one thread (a Chrome
   * trace on an Intel Arc 140V, Chrome 157, ANGLE Direct3D 11: D3DCompile on CrGpuMain for 3 to 22 s a staged voxel
   * path tracer program, one after another, and the page's thread held 18 s in a getUniformBlockIndex behind them,
   * KB-L5a-10). Waiting for the other warm draws' fences, which are polled without blocking, keeps the page's thread
   * free; the GPU thread compiles the same programs in the same time.
   */
  waiting(): boolean {
    const others = warming.get(this.device);
    return this.refusal === null && !!others?.size && !others.has(this);
  }

  /**
   * True once the program can draw into `targets` without compiling again. ANGLE's Direct3D back end compiles a
   * program's pixel shader for the colour targets bound at its first draw, synchronously on the browser's one GPU
   * thread (Edge 157, RTX A6000: a 4-output program linked in 64 ms and its first draw took 67 ms more; the 26 programs
   * of the staged voxel path tracer linked in 65 s and their first 8 x 8 image then took 206 s, KB-VPT-LOBES-COMPAT).
   * A 1-output program pays it too: on an Intel Arc 140V a 1-output program reported its link complete after 58 to
   * 74 ms and its first draw took 194 to 346 ms more (KB6016e), where the RTX A6000 had shown 2 ms; and so does a
   * program with no colour output (a depth-only pass whose fragment stage discards or writes depth: link 45 to 53 ms,
   * first draw 128 to 174 ms more). A draw with rasterizer discard on does not compile it there (a warmed 1-output
   * program still took 131 to 152 ms at its first real draw; drawn rasterizing, its first draw took 1 to 2 ms). So
   * every program there draws once, rasterizing, into 1 x 1 throwaway targets bound at the same attachment points its
   * passes use (a 1 x 1 depth-stencil buffer when it has no colour target), so that compile happens before an async
   * pipeline resolves (WebGPU, createRenderPipelineAsync: the pipeline is ready to use without a stall). Only those
   * targets are written, no resource is read, and the targets are deleted at once. Any other backend: true at once.
   */
  warmed(targets: readonly (TargetState | null)[]): boolean {
    const device = this.device,
      gl = device.gl;
    if (this.warmFence === undefined) {
      // A target with write mask 0 has its draw buffer off at every draw (CompatRenderPipeline.splits), so off here too.
      const colours = targets.flatMap((t, i) => (t && t.writeMask !== 0 ? [i] : []));
      if (this.refusal !== '' || device.destroyed || !/Direct3D|D3D11/.test(device.adapter.capabilities.renderer)) {
        this.warmFence = null;
        return true;
      }
      this.warmFence = this.warmDraw(colours, targets.length);
      if (this.warmFence) {
        let set = warming.get(device);
        if (!set) warming.set(device, (set = new Set()));
        set.add(this);
      }
    }
    if (this.warmFence && !fenceDone(gl, this.warmFence)) return false;
    this.unwarm();
    return true;
  }

  /** Drops the warm draw's fence, and this program from the device's warming set. */
  private unwarm(): void {
    if (this.warmFence) this.device.gl.deleteSync(this.warmFence);
    this.warmFence = null;
    warming.get(this.device)?.delete(this);
  }

  /** The draw warmed() makes, and the fence after it (null when the context is lost). */
  private warmDraw(colours: readonly number[], count: number): WebGLSync | null {
    const device = this.device,
      gl = device.gl,
      s = device.state,
      outputs = this.glsl.fragment.outputs,
      fbo = gl.createFramebuffer() as WebGLFramebuffer,
      vao = gl.createVertexArray() as WebGLVertexArrayObject,
      textures: WebGLTexture[] = [];
    s.bindDrawFramebuffer(fbo);
    for (const i of colours) {
      // Only the base type must match the output's (WebGL 2.0, 5.40): the format is not part of the compiled shader.
      const kind = outputs.find((o) => o.location === i)?.kind,
        texture = gl.createTexture() as WebGLTexture;
      s.scratch(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, kind === 'uint' ? gl.RGBA8UI : kind === 'sint' ? gl.RGBA8I : gl.RGBA8, 1, 1);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, texture, 0);
      textures.push(texture);
    }
    // With no colour target the framebuffer needs another attachment to be complete (WebGL 2.0, 4.4.4).
    const depth = colours.length ? null : (gl.createRenderbuffer() as WebGLRenderbuffer);
    if (depth) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, 1, 1);
      gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth);
    }
    const buffers: number[] = [];
    for (let i = 0; i < count; i++) buffers.push(colours.includes(i) ? gl.COLOR_ATTACHMENT0 + i : gl.NONE);
    gl.drawBuffers(buffers.length ? buffers : [gl.NONE]);
    // Every uniform block gets a buffer of its size and every texture unit nothing (an incomplete texture reads 0), as
    // the draw validation of WebGL 2.0 requires; a disabled attribute reads a constant of its own base type.
    const size = this.uniforms.reduce((n, u) => Math.max(n, u.size), 0),
      ubo = size ? (gl.createBuffer() as WebGLBuffer) : null;
    if (ubo) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
      gl.bufferData(gl.UNIFORM_BUFFER, size, gl.STATIC_DRAW);
      for (const u of this.uniforms) s.uniformBuffer(u.point, ubo, --warmIds, 0, u.size);
    }
    for (let i = 0; i < this.units; i++) s.unit(i, gl.TEXTURE_2D, null, null);
    s.bindVertexArray(vao);
    for (const a of this.attributes) {
      if (!a.integer) gl.vertexAttrib4f(a.location, 0, 0, 0, 1);
      else if (a.type === gl.UNSIGNED_BYTE || a.type === gl.UNSIGNED_SHORT || a.type === gl.UNSIGNED_INT)
        gl.vertexAttribI4ui(a.location, 0, 0, 0, 0);
      else gl.vertexAttribI4i(a.location, 0, 0, 0, 0);
    }
    s.useProgram(this.program);
    // Rasterizing, over the whole 1 x 1 target, with every colour channel written: the compile happens at such a draw.
    s.enable(gl.RASTERIZER_DISCARD, false);
    s.enable(gl.SCISSOR_TEST, false);
    s.viewport(0, 0, 1, 1);
    if (s.changed(S.colorMask, 1, 15)) gl.colorMask(true, true, true, true);
    s.forget(S.colorMaskAt, 8);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const sync = fence(gl);
    s.bindVertexArray(null);
    s.bindDrawFramebuffer(null);
    gl.deleteVertexArray(vao);
    gl.deleteFramebuffer(fbo);
    for (const texture of textures) {
      s.forgetTexture(texture);
      gl.deleteTexture(texture);
    }
    if (depth) gl.deleteRenderbuffer(depth);
    if (ubo) gl.deleteBuffer(ubo);
    return sync;
  }

  /** Deletes the program and VAO (the device drops an idle program, or is destroyed). */
  free(): void {
    const { gl, state } = this.device;
    this.unwarm();
    state.forgetProgram(this.program);
    state.forgetVertexArray(this.vao);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }

  /** Checks the link and builds the binding table (once). */
  finish(): void {
    if (this.refusal !== null) return;
    this.device.programs.linkMs += performance.now() - this.handedOver;
    const gl = this.device.gl,
      program = this.program,
      glsl = this.glsl;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const logs = this.shaders.map((s) => gl.getShaderInfoLog(s)).filter(Boolean);
      this.refusal = [...logs, gl.getProgramInfoLog(program)].join(' ');
      return;
    }
    this.refusal = '';
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
    this.units = textureUnits + buffers.size;
    this.pairs = textureUnits;
    this.storage.push(...buffers.values());
    this.uniforms.push(...points.values());
    this.textures.push(...units.values());
    this.baseVertex = gl.getUniformLocation(program, '_bv');
    this.baseInstance = gl.getUniformLocation(program, '_bi');
  }
}

/** A GPURenderPipeline: a linked program, its vertex layout and VAO, its fixed-function state and its binding table. */
export class CompatRenderPipeline {
  label: string;
  /** The shared program (null when the pipeline failed before it had GLSL). */
  readonly linked: LinkedProgram | null = null;
  readonly program: WebGLProgram | null = null;
  readonly vao: WebGLVertexArrayObject | null = null;
  readonly glsl: GLSLProgram | null = null;
  /** Set when the pipeline cannot draw: the message of its validation error. */
  failure: string | null = null;
  readonly attributes: Attribute[] = [];
  readonly uniforms: readonly UniformSlot[] = [];
  readonly textures: readonly TextureSlot[] = [];
  readonly storage: readonly StorageSlot[] = [];
  readonly mode: number;
  readonly cull: number;
  readonly frontFace: number;
  readonly targets: readonly (TargetState | null)[];
  /** Each target's GL blend and mask (a missing target writes nothing, blends nothing). */
  readonly targetGL: readonly TargetGL[];
  /** True when every target has the same blend and mask: one GL-wide state serves them. */
  readonly sameTargets: boolean;
  readonly depthStencil?: GPUDepthStencilState;
  readonly alphaToCoverage: boolean;
  readonly sampleCount: number;
  readonly unclippedDepth: boolean;
  baseVertex: WebGLUniformLocation | null = null;
  baseInstance: WebGLUniformLocation | null = null;
  /** The program's last uniform values and VAO bindings (see LinkedProgram.cache). */
  readonly cache!: LinkedProgram['cache'];
  /**
   * Without OES_draw_buffers_indexed (ANGLE's OpenGL back end), WebGL2 has one blend state and one write mask for
   * all colour targets: a pipeline whose targets differ draws once per group of targets with the same state, each
   * time with only that group's draw buffers on. Null when one draw does.
   */
  readonly splits: number[][] | null = null;
  /** @internal Sets per-draw uniforms of a program the device built itself (the compute tiers). */
  onDraw: (() => void) | null = null;
  private done = false;
  private readonly layouts: (CompatBindGroupLayout | null)[];

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
    // A src1 factor needs dual-source-blending on the device (WebGPU createRenderPipeline validation).
    const src1 = (f: string | undefined) => !!f && f.includes('src1'),
      dualMissing =
        this.targets.some(
          (t) =>
            !!t?.blend &&
            [t.blend.color.srcFactor, t.blend.color.dstFactor, t.blend.alpha.srcFactor, t.blend.alpha.dstFactor].some(
              src1,
            ),
        ) && !device.features.has('dual-source-blending');
    this.targetGL = this.targets.map((t) => {
      const b = t?.blend,
        e = (name: string) => (dualMissing && name.includes('SRC1') ? 0 : device.enum(name));
      return {
        key: b
          ? `${b.color.operation ?? 'add'},${b.color.srcFactor ?? 'one'},${b.color.dstFactor ?? 'zero'},${b.alpha.operation ?? 'add'},${b.alpha.srcFactor ?? 'one'},${b.alpha.dstFactor ?? 'zero'}`
          : 'off',
        mask: t?.writeMask ?? 0,
        blend: !!b,
        colorOp: b ? e(BLEND_OPS[b.color.operation ?? 'add'] ?? 'ONE') : 0,
        alphaOp: b ? e(BLEND_OPS[b.alpha.operation ?? 'add'] ?? 'ONE') : 0,
        colorSrc: b ? e(BLEND_FACTORS[b.color.srcFactor ?? 'one'] ?? 'ONE') : 0,
        colorDst: b ? e(BLEND_FACTORS[b.color.dstFactor ?? 'zero'] ?? 'ONE') : 0,
        alphaSrc: b ? e(BLEND_FACTORS[b.alpha.srcFactor ?? 'one'] ?? 'ONE') : 0,
        alphaDst: b ? e(BLEND_FACTORS[b.alpha.dstFactor ?? 'zero'] ?? 'ONE') : 0,
      };
    });
    this.sameTargets = this.targetGL.every((x) => x.key === this.targetGL[0].key && x.mask === this.targetGL[0].mask);
    // A target with write mask 0 may have no fragment output (WebGPU createRenderPipeline validation), and WebGL2 refuses
    // a draw whose active draw buffers miss an output whatever the colour mask ("Active draw buffers with missing
    // fragment shader outputs", WebGL 2.0 5.x draw validation in ANGLE): its draw buffer is off for the pipeline's draws.
    const silent = this.targets.some((t) => t?.writeMask === 0);
    if (silent && device.ext.indexed)
      this.splits = [this.targets.flatMap((t, i) => (t && t.writeMask !== 0 ? [i] : []))];
    else if (!device.ext.indexed) {
      const groups = new Map<string, number[]>();
      this.targets.forEach((t, i) => {
        if (!t || t.writeMask === 0) return;
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
      } else if (silent) this.splits = [[...groups.values()][0] ?? []];
    }
    const vertexModule = descriptor.vertex.module as unknown as CompatShaderModule,
      fragmentModule = descriptor.fragment?.module as unknown as CompatShaderModule | undefined;
    const explicit = descriptor.layout !== 'auto' ? (descriptor.layout as unknown as CompatPipelineLayout) : null;
    this.layouts = explicit ? [...explicit.bindGroupLayouts] : [];
    if (dualMissing) {
      this.failure = `createRenderPipeline${this.label ? ` '${this.label}'` : ''}: a src1 blend factor needs the device feature 'dual-source-blending'`;
      if (!this.deferLink) device.validationError(this.failure);
      return;
    }
    if (!prebuilt && (vertexModule.error || fragmentModule?.error)) {
      this.failure = 'createRenderPipeline: a shader module of the pipeline failed to compile';
      if (!this.deferLink) device.validationError(this.failure);
      return;
    }
    try {
      this.glsl = prebuilt ?? translatePipeline(device, descriptor);
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
    // Each stage's texture units, counted from the translation before anything links (KB-BOUNCE-COMPATUNITS1 step 3).
    if (!prebuilt) {
      const over = programUnits(this.glsl, device.adapter.capabilities.limits).over;
      if (over) throw unitsError(device, over);
    }
    // The checked entry points name every resource each stage statically uses, phony assignments included (KB-COMPAT-PHONY1).
    const reached: [IREntryPoint | undefined, number][] = prebuilt
      ? []
      : [
          [stageEntry(vertexModule.ir, 'vertex', descriptor.vertex.entryPoint), 1],
          [stageEntry(fragmentModule?.ir, 'fragment', descriptor.fragment?.entryPoint), 2],
        ];
    const inferred = autoLayouts(this.glsl, reached);
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
    device.programs.translateMs += performance.now() - started;
    // One GL program per GLSL, binding table and vertex layout: a pipeline made again reuses it (most recently used
    // last). GLSL names its uniforms and samplers by order, so WGSL that differs only in @group or @binding numbers
    // gives the same GLSL; the binding table is in the key so each keeps the bindings it declared.
    const { vertex, fragment } = this.glsl,
      table = JSON.stringify([vertex, fragment].map((s) => [s.uniforms, s.textures, s.storage])),
      key = `${vertex.source}\n//\n${fragment.source}\n//\n${table}\n//\n${JSON.stringify(this.attributes)}`,
      cached = device.linked.get(key),
      e = cached ?? new LinkedProgram(device, this.glsl, this.attributes);
    device.linked.delete(key);
    device.linked.set(key, e);
    e.users.push(device.objects.watch(this));
    Object.assign(this, {
      linked: e,
      program: e.program,
      vao: e.vao,
      cache: e.cache,
      uniforms: e.uniforms,
      textures: e.textures,
      storage: e.storage,
    });
    if (deferLink) return;
    // A program already checked (a pipeline made again) costs no wait; any other link runs on the driver's threads
    // while the page goes on, and is checked when the pipeline is first used (CompatDevice.deferLink, KB-COMPAT-SYNCLINK1).
    if (e.refusal === null && device.ext.parallel) this.scope = device.deferLink(this);
    else this.finish();
  }

  /**
   * @internal The validation scope open when this synchronous pipeline was made, while the driver links it on its own
   * threads (null: none was open); undefined once its link is checked, or when it was never deferred.
   */
  scope?: Parameters<CompatDevice['linkError']>[0];

  /** @internal True once the driver knows the link status and reading it waits behind no other program's warm draw. */
  linkKnown(): boolean {
    return !this.linked || (this.linked.done() && !this.linked.waiting());
  }

  /**
   * Resolves once the program has linked (at once without KHR_parallel_shader_compile) and can draw into the
   * pipeline's targets without compiling again (LinkedProgram.warmed).
   */
  whenLinked(): Promise<void> {
    return new Promise((resolve) => {
      const poll = () => {
        if (this.device.destroyed || !this.linked) {
          this.finish();
          resolve();
        } else if (!this.linked.done() || this.linked.waiting()) setTimeout(poll, 2);
        else {
          this.finish();
          if (this.failure || this.linked.warmed(this.targets)) resolve();
          else setTimeout(poll, 2);
        }
      };
      poll();
    });
  }

  /** Checks the link and builds the binding table (once). */
  finish(): void {
    const e = this.linked;
    if (this.done || !e || this.failure) return;
    this.done = true;
    const scope = this.scope;
    this.scope = undefined;
    this.device.linking.delete(this);
    e.finish();
    if (e.refusal) {
      this.failure = `createRenderPipeline${this.label ? ` '${this.label}'` : ''}: WebGL2 refused the translated program: ${e.refusal}`;
      if (scope !== undefined) this.device.linkError(scope, this.failure);
      else if (!this.deferLink) this.device.validationError(this.failure);
      return;
    }
    if (e.units > this.device.limits.maxSampledTexturesPerShaderStage)
      throw this.device.unsupported(
        `a pipeline with ${e.pairs} texture and sampler pairs and ${e.storage.length} storage buffers (WebGL2 has ${this.device.limits.maxSampledTexturesPerShaderStage} texture units, and each storage buffer takes one)`,
      );
    this.baseVertex = e.baseVertex;
    this.baseInstance = e.baseInstance;
  }

  getBindGroupLayout(index: number): CompatBindGroupLayout {
    return this.layouts[index] ?? new CompatBindGroupLayout({ entries: [] });
  }
}

/** One stage's (or both stages' together) texture units against its GL limit (`stageUnits`). */
export interface StageUnits {
  readonly stage: 'vertex' | 'fragment' | 'combined';
  /** Units the stage takes: texture and sampler pairs it reads plus its storage data textures. */
  readonly units: number;
  readonly pairs: number;
  readonly storage: number;
  /** MAX_TEXTURE_IMAGE_UNITS (fragment), MAX_VERTEX_TEXTURE_IMAGE_UNITS or MAX_COMBINED_TEXTURE_IMAGE_UNITS. */
  readonly limit: number;
  /** (group, binding) of each unit; a bind group's shared storage data texture is binding -1. */
  readonly bindings: readonly (readonly [number, number])[];
}
/** The texture units of a render pipeline on the WebGL2 layer, per stage, and the first one past its limit. */
export interface PipelineUnits {
  readonly vertex: StageUnits;
  readonly fragment: StageUnits;
  readonly combined: StageUnits;
  /** The fragment stage, the vertex stage, then both together: the first over its limit, or undefined. */
  readonly over?: StageUnits;
}
/** The GLSL of a render pipeline descriptor, translated as the pipeline translates it (throws as translateWGSL does). */
export function translatePipeline(device: CompatDevice, descriptor: GPURenderPipelineDescriptor): GLSLProgram {
  const kept = device.translations.get(descriptor);
  if (
    kept &&
    kept.vertex === descriptor.vertex.module &&
    kept.fragment === descriptor.fragment?.module &&
    kept.entries === `${descriptor.vertex.entryPoint}|${descriptor.fragment?.entryPoint}`
  ) {
    device.translations.delete(descriptor);
    return kept.glsl;
  }
  const vertexModule = descriptor.vertex.module as unknown as CompatShaderModule,
    fragmentModule = descriptor.fragment?.module as unknown as CompatShaderModule | undefined,
    explicit = descriptor.layout !== 'auto' ? (descriptor.layout as unknown as CompatPipelineLayout) : null,
    limits = device.adapter.capabilities.limits;
  return translateWGSL({
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
    points: descriptor.primitive?.topology === 'point-list',
    // Storage bindings without a dynamic offset share their bind group's data texture: one unit per group.
    sharedStorage: (group, binding) =>
      !explicit?.bindGroupLayouts[group]?.entries.find((e) => e.binding === binding)?.buffer?.hasDynamicOffset,
    uniformBlockSize: limits.MAX_UNIFORM_BLOCK_SIZE,
    textureUnits: { vertex: limits.MAX_VERTEX_TEXTURE_IMAGE_UNITS, fragment: limits.MAX_TEXTURE_IMAGE_UNITS },
    accurateInverseTrig: device.adapter.accurateInverseTrig,
  });
}
/**
 * Counts `glsl`'s texture units per stage against the GL limits (OpenGL ES 3.0: MAX_TEXTURE_IMAGE_UNITS for the
 * fragment stage, MAX_VERTEX_TEXTURE_IMAGE_UNITS, and MAX_COMBINED_TEXTURE_IMAGE_UNITS for both, where a pair both
 * stages read is one unit), so vertex-only storage costs the fragment stage nothing.
 */
export function programUnits(glsl: GLSLProgram, limits: Record<string, number>): PipelineUnits {
  const stage = (s: GLSLStage, name: 'vertex' | 'fragment', limit: number): StageUnits => ({
      stage: name,
      ...stageUnits(s),
      limit,
    }),
    vertex = stage(glsl.vertex, 'vertex', limits.MAX_VERTEX_TEXTURE_IMAGE_UNITS ?? 16),
    fragment = stage(glsl.fragment, 'fragment', limits.MAX_TEXTURE_IMAGE_UNITS ?? 16),
    pairs = new Map<string, [number, number]>(),
    storage = new Map<string, [number, number]>();
  for (const s of [glsl.vertex, glsl.fragment]) {
    for (const t of s.textures)
      if (t.sampled)
        pairs.set(
          `${t.group}:${t.binding}|${t.sampler ? `${t.sampler.group}:${t.sampler.binding}` : ''}|${t.gather ? `${t.gather.group}:${t.gather.binding}` : ''}`,
          [t.group, t.binding],
        );
    for (const b of s.storage)
      storage.set(b.shared ? `g${b.group}` : `${b.group}:${b.binding}`, [b.group, b.shared ? -1 : b.binding]);
  }
  const combined: StageUnits = {
    stage: 'combined',
    units: pairs.size + storage.size,
    pairs: pairs.size,
    storage: storage.size,
    limit: limits.MAX_COMBINED_TEXTURE_IMAGE_UNITS ?? 32,
    bindings: [...pairs.values(), ...storage.values()],
  };
  return { vertex, fragment, combined, over: [fragment, vertex, combined].find((s) => s.units > s.limit) };
}
/**
 * What a pipeline whose `over` stage passes its texture units cannot do, as the layer's coded refusal words it (the
 * device's error and the GLSL corpus check share it).
 */
export function unitsRefusal(over: StageUnits): string {
  const where = over.stage === 'combined' ? 'two stages together take' : `${over.stage} stage takes`;
  return `a render pipeline whose ${where} ${over.units} texture units (${over.pairs} texture and sampler pairs, ${over.storage} storage data textures; this WebGL2 has ${over.limit}): ${over.bindings.map(([g, b]) => (b < 0 ? `group ${g} storage` : `group ${g} binding ${b}`)).join(', ')}`;
}
/** The coded error of a pipeline whose `over` stage passes its texture units (help: errors#texture-units). */
function unitsError(device: CompatDevice, over: StageUnits): Error {
  return Object.assign(device.unsupported(unitsRefusal(over), 'texture-units'), { units: over });
}

/** The entry point of a stage the translation used (the named one, or the stage's only one). */
function stageEntry(
  module: IRModule | null | undefined,
  stage: 'vertex' | 'fragment',
  name: string | undefined,
): IREntryPoint | undefined {
  const candidates = module?.entryPoints.filter((e) => e.stage === stage) ?? [];
  return name === undefined
    ? candidates.length === 1
      ? candidates[0]
      : undefined
    : candidates.find((e) => e.name === name);
}

/**
 * The 'auto' bind group layouts of a translated program (WebGPU "default pipeline layout": one entry for each resource a
 * stage's entry point statically uses, visible to the stages that use it). The GLSL binding tables give the resources the
 * emitted code reads; the checked entry points add those WGSL uses statically that the GLSL drops, such as a phony
 * assignment `_ = u;` (WGSL section 7.7 "Phony Assignment", KB-COMPAT-PHONY1).
 */
function autoLayouts(
  glsl: GLSLProgram,
  reached: readonly (readonly [IREntryPoint | undefined, number])[] = [],
): CompatBindGroupLayout[] {
  const groups: Map<number, LayoutEntry & { binding: number }>[] = [];
  const add = (group: number, entry: LayoutEntry, stage: number) => {
    const g = (groups[group] ??= new Map());
    const known = g.get(entry.binding);
    g.set(entry.binding, { ...(known ?? entry), visibility: (known?.visibility ?? 0) | stage });
  };
  // The checked WGSL first: it has each resource's declared type (a texture_external stays an external texture).
  for (const [entry, bit] of reached)
    for (const g of entry?.globals ?? []) {
      if (g.kind !== 'var' || g.group === undefined || g.binding === undefined) continue;
      const e = layoutEntry(g as IRGlobalVar, bit);
      if (e) add(g.group, e, bit);
    }
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

/** Writes colour `c` into `out` (a pooled snapshot's own array), with `color`'s defaults. */
function colorInto(out: number[], c: GPUColor | undefined): void {
  if (c === undefined) out[0] = out[1] = out[2] = out[3] = 0;
  else if (Array.isArray(c)) {
    out[0] = (c as number[])[0];
    out[1] = (c as number[])[1];
    out[2] = (c as number[])[2];
    out[3] = (c as number[])[3];
  } else {
    out[0] = (c as GPUColorDict).r;
    out[1] = (c as GPUColorDict).g;
    out[2] = (c as GPUColorDict).b;
    out[3] = (c as GPUColorDict).a;
  }
}

/** A GPUCommandBuffer: the recorded operations. */
export class CompatCommandBuffer {
  /** Bit 1: submitted; 2: holds compute passes (their runtime loads before it replays); 4: holds a texture read-back. */
  private flags: number;
  /** The label: '' (the prototype's) unless one is given, so an unlabelled one, which a frame makes many of, has one field fewer. */
  declare label: string;
  constructor(
    /** The recorded commands, which also hold the buffers, textures and query sets they use (submit refuses the buffer when one is destroyed). */
    readonly ops: Tape,
    label: string,
    compute = false,
    readback = false,
  ) {
    this.flags = (compute ? 2 : 0) | (readback ? 4 : 0);
    if (label) this.label = label;
  }
  // The flags share one field: a field is 4 bytes of every command buffer a frame makes (WebGPU hands back one per call).
  get used(): boolean {
    return (this.flags & 1) !== 0;
  }
  set used(value: boolean) {
    this.flags = value ? this.flags | 1 : this.flags & ~1;
  }
  get compute(): boolean {
    return (this.flags & 2) !== 0;
  }
  get readback(): boolean {
    return (this.flags & 4) !== 0;
  }
  get uses(): Uses {
    return this.ops.uses;
  }
  get usesLength(): number {
    return this.ops.usesLength;
  }
  /** Hands the tape to the next encoder; the replay calls it when this buffer has run. */
  release(): void {
    this.ops.pool?.give(this.ops);
  }
}
CompatCommandBuffer.prototype.label = '';

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
  /** destroy() was called (see Usable). */
  get released(): boolean {
    return this.destroyed;
  }

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
    const q = this.device.objects.own(this, gl.createQuery() as WebGLQuery);
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

/** The descriptor a call without one gets, shared (a default `{}` is a new object each call). */
export const NO_DESCRIPTOR: Readonly<{ label?: string }> = Object.freeze({});

/** A GPUCommandEncoder. */
export class CompatCommandEncoder {
  private readonly tape: Tape;
  /** Bit 1: finished; 2: holds compute passes; 4: holds a texture read-back (one field: 4 bytes of every encoder a frame makes). */
  private flags = 0;
  /** The label: '' (the prototype's) unless one is given, so an unlabelled one, which a frame makes many of, has one field fewer. */
  declare label: string;
  constructor(device: CompatDevice, label: string) {
    this.tape = device.tapes.take();
    if (label) this.label = label;
  }
  /** The device, through the tape's pool (a field of its own would be 4 bytes of every encoder a frame makes). */
  private get device(): CompatDevice {
    return (this.tape.pool as TapePool).device;
  }

  beginRenderPass(d: GPURenderPassDescriptor): CompatRenderPassEncoder {
    if (d.timestampWrites) throw this.device.unsupported('timestamp queries');
    const tape = this.tape,
      attachments = d.colorAttachments as Iterable<GPURenderPassColorAttachment | null>,
      list = Array.isArray(attachments) ? attachments : [...attachments],
      // A copy of the descriptor: callers may change theirs once the pass has begun. The snapshot is the tape's own
      // and goes back to the pool with it.
      pass = tape.snapshot(list.length);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a) {
        pass.colors[i] = null;
        continue;
      }
      const c = (pass.slots[i] ??= new ColorSnap());
      c.view = viewOf(a.view);
      c.depthSlice = a.depthSlice ?? 0;
      c.resolveTarget = a.resolveTarget ? viewOf(a.resolveTarget) : undefined;
      colorInto(c.clearValue, a.clearValue);
      c.loadOp = a.loadOp;
      c.storeOp = a.storeOp;
      pass.colors[i] = c;
    }
    const depth = d.depthStencilAttachment;
    if (depth) {
      const z = pass.depthSlot;
      z.view = viewOf(depth.view);
      z.depthClearValue = depth.depthClearValue ?? 0;
      z.depthLoadOp = depth.depthLoadOp;
      z.depthStoreOp = depth.depthStoreOp;
      z.depthReadOnly = !!depth.depthReadOnly;
      z.stencilClearValue = depth.stencilClearValue ?? 0;
      z.stencilLoadOp = depth.stencilLoadOp;
      z.stencilStoreOp = depth.stencilStoreOp;
      z.stencilReadOnly = !!depth.stencilReadOnly;
      pass.depth = z;
    } else pass.depth = undefined;
    pass.queries = (d.occlusionQuerySet as unknown as CompatQuerySet | undefined) ?? undefined;
    for (let i = 0; i < list.length; i++) {
      const a = pass.colors[i];
      if (a) tape.use(a.view.texture);
      if (a?.resolveTarget) tape.use(a.resolveTarget.texture);
    }
    if (pass.depth) tape.use(pass.depth.view.texture);
    if (pass.queries) tape.use(pass.queries);
    tape.obj(OP.BEGIN_PASS, pass);
    return new CompatRenderPassEncoder(tape, d.label ?? '');
  }

  beginComputePass(d: GPUComputePassDescriptor = NO_DESCRIPTOR): CompatComputePassEncoder {
    if (d.timestampWrites) throw this.device.unsupported('timestamp queries');
    this.flags |= 2;
    return new CompatComputePassEncoder(this.tape, d.label ?? '');
  }

  copyBufferToBuffer(
    src: CompatBuffer,
    a: number | CompatBuffer,
    b?: CompatBuffer | number,
    c?: number,
    d?: number,
  ): void {
    // Both overloads: (src, srcOffset, dst, dstOffset, size) and (src, dst, size?). Plain variables: a destructured
    // array literal is an array and an iterator a call.
    let srcOffset = 0,
      dstOffset = 0,
      size: number;
    let dst: CompatBuffer;
    if (typeof a === 'number') {
      srcOffset = a;
      dst = b as CompatBuffer;
      dstOffset = c as number;
      size = d ?? src.size - a;
    } else {
      dst = a;
      size = (b as number | undefined) ?? src.size;
    }
    this.tape.use(src);
    this.tape.use(dst);
    this.tape.copyBuffer(src, dst, srcOffset, dstOffset, size);
  }
  copyBufferToTexture(source: GPUTexelCopyBufferInfo, destination: GPUTexelCopyTextureInfo, size: GPUExtent3D): void {
    if (!this.aligned('copyBufferToTexture', source)) return;
    const s = { ...source },
      d = { ...destination };
    this.tape.use(s.buffer as unknown as Usable);
    this.tape.use(d.texture as unknown as Usable);
    this.tape.closure((r) => r.copyBufferToTexture(s as never, d as never, size));
  }
  copyTextureToBuffer(source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyBufferInfo, size: GPUExtent3D): void {
    if (!this.aligned('copyTextureToBuffer', destination)) return;
    const s = { ...source },
      d = { ...destination };
    this.tape.use(s.texture as unknown as Usable);
    this.tape.use(d.buffer as unknown as Usable);
    this.flags |= 4;
    this.tape.closure((r) => r.device.readback?.copyTextureToBuffer(r, s as never, d as never, extent(size)));
  }
  copyTextureToTexture(source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyTextureInfo, size: GPUExtent3D): void {
    const a = source.texture as unknown as CompatTexture,
      b = destination.texture as unknown as CompatTexture;
    this.tape.use(a);
    this.tape.use(b);
    this.tape.copyTextures(a, b, source, destination, size);
  }
  clearBuffer(buffer: CompatBuffer, offset = 0, size?: number): void {
    this.tape.use(buffer);
    this.tape.closure(() => buffer.write(offset, new Uint8Array(size ?? buffer.size - offset)));
  }
  /** False, after a validation error, when an encoder copy's buffer rows are not 256-byte aligned (WebGPU requires it). */
  private aligned(copy: string, layout: GPUTexelCopyBufferInfo): boolean {
    if (layout.bytesPerRow === undefined || layout.bytesPerRow % 256 === 0) return true;
    this.device.validationError(`${copy}: bytesPerRow ${layout.bytesPerRow} is not a multiple of 256`);
    return false;
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
    this.tape.use(querySet);
    this.tape.use(destination);
    this.tape.closure((r) => r.resolveQueries(querySet, firstQuery, queryCount, destination, destinationOffset));
  }
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}

  finish(descriptor: GPUCommandBufferDescriptor = NO_DESCRIPTOR): CompatCommandBuffer {
    if (this.flags & 1) {
      this.device.validationError('finish() was already called on this command encoder');
      // The first command buffer owns the tape (it goes back to the pool when that one has replayed): this one is
      // empty, as an invalid WebGPU command buffer is.
      return new CompatCommandBuffer(new Tape(), descriptor.label ?? this.label);
    }
    this.flags |= 1;
    return new CompatCommandBuffer(
      this.tape,
      descriptor.label ?? this.label,
      (this.flags & 2) !== 0,
      (this.flags & 4) !== 0,
    );
  }
}
CompatCommandEncoder.prototype.label = '';

const viewOf = (v: GPUTextureView | GPUTexture): CompatTextureView =>
  'createView' in (v as object) ? (v as unknown as CompatTexture).createView() : (v as unknown as CompatTextureView);

/** The draw commands render passes and render bundles share; each call records one replay step. */
class DrawRecorder {
  /** The label: '' (the prototype's) unless one is given, so an unlabelled one, which a frame makes many of, has one field fewer. */
  declare label: string;
  constructor(
    protected readonly tape: Tape,
    label: string,
  ) {
    if (label) this.label = label;
  }
  setPipeline(pipeline: CompatRenderPipeline): void {
    this.tape.obj(OP.SET_PIPELINE, pipeline);
  }
  setBindGroup(
    index: number,
    group: CompatBindGroup | null,
    offsets?: Iterable<number> | Uint32Array,
    start = 0,
    length?: number,
  ): void {
    if (group) this.tape.use(group.uses);
    if (!offsets) this.tape.bindGroup(index, group, undefined, 0, 0);
    else if (offsets instanceof Uint32Array)
      this.tape.bindGroup(index, group, offsets, start, length ?? offsets.length - start);
    else if (Array.isArray(offsets)) this.tape.bindGroup(index, group, offsets, 0, offsets.length);
    else {
      const list = [...offsets];
      this.tape.bindGroup(index, group, list, 0, list.length);
    }
  }
  setVertexBuffer(slot: number, buffer: CompatBuffer | null, offset = 0, size?: number): void {
    if (buffer) this.tape.use(buffer);
    this.tape.objNums3(OP.SET_VERTEX, buffer, slot, offset, size ?? -1);
  }
  setIndexBuffer(buffer: CompatBuffer, format: GPUIndexFormat, offset = 0, size?: number): void {
    this.tape.use(buffer);
    this.tape.indexBuffer(buffer, format, offset, size ?? -1);
  }
  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    this.tape.n4(OP.DRAW, vertexCount, instanceCount, firstVertex, firstInstance);
  }
  drawIndexed(indexCount: number, instanceCount = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0): void {
    this.tape.n5(OP.DRAW_INDEXED, indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
  }
  drawIndirect(buffer: CompatBuffer, offset: number): void {
    this.tape.use(buffer);
    this.tape.objNum(OP.DRAW_INDIRECT, buffer, offset);
  }
  drawIndexedIndirect(buffer: CompatBuffer, offset: number): void {
    this.tape.use(buffer);
    this.tape.objNum(OP.DRAW_INDEXED_INDIRECT, buffer, offset);
  }
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}
}
DrawRecorder.prototype.label = '';

/** A GPURenderPassEncoder. */
export class CompatRenderPassEncoder extends DrawRecorder {
  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void {
    this.tape.n6(OP.VIEWPORT, x, y, width, height, minDepth, maxDepth);
  }
  setScissorRect(x: number, y: number, width: number, height: number): void {
    this.tape.n4(OP.SCISSOR, x, y, width, height);
  }
  setBlendConstant(c: GPUColor): void {
    if (Array.isArray(c)) this.tape.n4(OP.BLEND_CONSTANT, c[0], c[1], c[2], c[3]);
    else {
      const v = color(c);
      this.tape.n4(OP.BLEND_CONSTANT, v[0], v[1], v[2], v[3]);
    }
  }
  setStencilReference(reference: number): void {
    this.tape.num(OP.STENCIL_REFERENCE, reference);
  }
  beginOcclusionQuery(queryIndex: number): void {
    this.tape.num(OP.BEGIN_QUERY, queryIndex);
  }
  endOcclusionQuery(): void {
    this.tape.op(OP.END_QUERY);
  }
  /** Runs the bundles' draws; the pass's pipeline, bind groups and buffers are reset before and after, as in WebGPU. */
  executeBundles(bundles: Iterable<CompatRenderBundle>): void {
    const list = [...bundles];
    for (const b of list) this.tape.use(b.uses);
    this.tape.obj(OP.EXECUTE_BUNDLES, list);
  }
  end(): void {
    this.tape.op(OP.END_PASS);
  }
}

/** A GPURenderBundle: recorded draws a render pass replays with executeBundles. */
export class CompatRenderBundle {
  constructor(
    /** The recorded draws: a bundle replays many times, so its tape is its own and never pooled. */
    readonly ops: Tape,
    public label: string,
    /** What its draws use, flattened so a pass that executes it adds one entry. */
    readonly uses: readonly Usable[] = [],
  ) {}
}

/** A GPURenderBundleEncoder. */
export class CompatRenderBundleEncoder extends DrawRecorder {
  private finished = false;
  constructor(
    private readonly device: CompatDevice,
    readonly descriptor: GPURenderBundleEncoderDescriptor,
  ) {
    super(new Tape(), descriptor.label ?? '');
  }
  finish(descriptor: GPURenderBundleDescriptor = NO_DESCRIPTOR): CompatRenderBundle {
    if (this.finished) this.device.validationError('finish() was already called on this render bundle encoder');
    this.finished = true;
    const tape = this.tape;
    return new CompatRenderBundle(
      tape,
      descriptor.label ?? this.label,
      tape.uses.slice(0, tape.usesLength).flat() as Usable[],
    );
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
  /**
   * The framebuffers made with this subresource first (Replayer.framebuffer): their attachments and the device's
   * record, so a pass finds its framebuffer by the identity of its cached subresources, without a key string.
   */
  fbs?: Attachments[];
}

/** A framebuffer's attachments, as Replayer.framebuffer matches them, and the device's record of it. */
interface Attachments {
  readonly colors: readonly (Sub | null)[];
  readonly depth: Sub | null;
  readonly record: FramebufferRecord;
}

/** What a pass binds in one bind group slot (group null: nothing). Reused from pass to pass. */
interface GroupSlot {
  group: CompatBindGroup | null;
  /** The slot's own list (setBindGroup copies the dynamic offsets into it), of which only the first `count` count. */
  readonly offsets: readonly number[];
  count: number;
}
/** What a pass binds in one vertex buffer slot (buffer null: nothing). Reused from pass to pass. */
interface VertexSlot {
  buffer: CompatBuffer | null;
  offset: number;
}
/** The pass's index buffer (buffer null: none). Reused from pass to pass. */
interface IndexSlot {
  buffer: CompatBuffer | null;
  type: number;
  size: number;
  offset: number;
}

/** The running render pass. One object per replayer, reset by beginPass, so a pass allocates no state of its own. */
interface PassState {
  desc: PassDescriptor;
  fbo: WebGLFramebuffer;
  /** Per colour attachment: the 3D slice and the 2D stand-in drawn in its place (see Replayer.standIn), or null. */
  readonly standIns: ([Sub, Sub] | null)[];
  width: number;
  height: number;
  pipeline: CompatRenderPipeline | null;
  applied: CompatRenderPipeline | null;
  readonly groups: (GroupSlot | undefined)[];
  readonly vertex: (VertexSlot | undefined)[];
  index: IndexSlot | null;
  stencilReference: number;
  /** The occlusion query running, if any. */
  query: boolean;
}

/** The most colour attachments a pass has (WebGPU maxColorAttachments, which the layer reports as 8). */
const MAX_COLORS = 8;
/** The offsets of a compute bind group with none (shared; never written). */
const NO_OFFSETS: readonly number[] = [];

/** The little-endian 32-bit word at byte `at` of `bytes` (an indirect argument: a copy of it would be a typed array and a buffer). */
const word = (bytes: Uint8Array, at: number): number =>
  (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
/** The value a colour attachment that was never written loads as. */
const NO_COLOR: readonly number[] = [0, 0, 0, 0];

/** The internal programs the device draws with: full-target triangles that fetch texels (readbacks, copies). */
export interface Helper {
  readonly program: WebGLProgram;
  readonly offset: WebGLUniformLocation | null;
  readonly value: WebGLUniformLocation | null;
}

/** Replays recorded operations against the device's GL state. */
/** The largest zero-filled unpack buffer Replayer.zero keeps for the next texture (larger ones go after use). */
const ZERO_BYTES_KEPT = 4 << 20;

export class Replayer {
  private pass: PassState | null = null;
  /** The pass state beginPass resets and reuses (`pass` while a pass runs). */
  private readonly passState: PassState = {
    desc: { colors: [] },
    fbo: null as unknown as WebGLFramebuffer,
    // MAX_COLORS long from the start, and never shortened: a pass of fewer attachments setting `length` trimmed the
    // backing store, and the next pass of more grew a new one (KB-COMPAT-FRAMEALLOC1). Entries past a pass's
    // attachment count are not read.
    standIns: new Array<[Sub, Sub] | null>(MAX_COLORS).fill(null),
    width: 1,
    height: 1,
    pipeline: null,
    applied: null,
    groups: [],
    vertex: [],
    index: null,
    stencilReference: 0,
    query: false,
  };
  /** beginPass's colour subresources (MAX_COLORS long); framebuffer() reads the first ones a pass has. */
  private readonly colorSubs: (Sub | null)[] = new Array(MAX_COLORS).fill(null);
  /** Cached subresources: by storage, then level, then layer (3D: depth slice); by texture for a renderbuffer. */
  private readonly subs = new WeakMap<TextureStorage, (Sub | undefined)[][]>();
  private readonly renderbufferSubs = new WeakMap<CompatTexture, Sub>();
  private readonly resolvedSubs = new WeakMap<CompatTexture, { texture: WebGLTexture; sub: Sub }>();
  private readonly stencilResolvedSubs = new WeakMap<CompatTexture, { texture: WebGLTexture; sub: Sub }>();
  /** Clear values passed without an array a call. */
  private readonly clearDepth = new Float32Array(1);
  private readonly clearStencil = new Int32Array(1);
  /** A float colour clear's value as a typed array: WebGL reads a JS array of doubles through one heap number each. */
  private readonly clearFloat = new Float32Array(4);
  private readonly clearUint = new Uint32Array(4);
  private readonly clearInt = new Int32Array(4);
  /** invalidateFramebuffer's attachment lists, one reused array per length (GL copies it). */
  private readonly discards: number[][] = [];
  readonly gl: WebGL2RenderingContext;
  private readonly helpers = new Map<string, Helper>();
  private emptyVao: WebGLVertexArrayObject | null = null;
  constructor(readonly device: CompatDevice) {
    this.gl = device.gl;
  }

  /** Replays a tape: each command's numbers and objects come off the tape in the order the recorder wrote them. */
  run(tape: Tape): void {
    const codes = tape.codes,
      nums = tape.nums,
      objs = tape.objs,
      count = tape.length;
    let n = 0,
      o = 0;
    for (let i = 0; i < count; i++) {
      if (this.device.destroyed) return;
      switch (codes[i]) {
        case OP.CLOSURE:
          (objs[o++] as (r: Replayer) => void)(this);
          break;
        case OP.BEGIN_PASS:
          this.beginPass(objs[o++] as PassDescriptor);
          break;
        case OP.COPY_BUFFER:
          this.copyBuffer(objs[o++] as CompatBuffer, nums[n], objs[o++] as CompatBuffer, nums[n + 1], nums[n + 2]);
          n += 3;
          break;
        case OP.COPY_TEXTURE:
          this.copyTextures(
            objs[o++] as CompatTexture,
            objs[o++] as CompatTexture,
            nums[n],
            nums[n + 1],
            nums[n + 2],
            nums[n + 3],
            nums[n + 4],
            nums[n + 5],
            nums[n + 6],
            nums[n + 7],
            nums[n + 8],
            nums[n + 9],
            nums[n + 10],
          );
          n += 11;
          break;
        case OP.SET_PIPELINE:
          this.setPipeline(objs[o++] as CompatRenderPipeline);
          break;
        case OP.SET_BIND_GROUP: {
          const length = nums[n + 1];
          this.setBindGroup(nums[n], objs[o++] as CompatBindGroup | null, nums, n + 2, length);
          n += 2 + length;
          break;
        }
        case OP.SET_VERTEX:
          this.setVertexBuffer(nums[n], objs[o++] as CompatBuffer | null, nums[n + 1]);
          n += 3;
          break;
        case OP.SET_INDEX:
          this.setIndexBuffer(objs[o++] as CompatBuffer, nums[n + 2] === 0 ? 'uint16' : 'uint32', nums[n]);
          n += 3;
          break;
        case OP.DRAW:
          this.draw(nums[n], nums[n + 1], nums[n + 2], nums[n + 3]);
          n += 4;
          break;
        case OP.DRAW_INDEXED:
          this.drawIndexed(nums[n], nums[n + 1], nums[n + 2], nums[n + 3], nums[n + 4]);
          n += 5;
          break;
        case OP.DRAW_INDIRECT:
          this.drawIndirect(objs[o++] as CompatBuffer, nums[n++]);
          break;
        case OP.DRAW_INDEXED_INDIRECT:
          this.drawIndexedIndirect(objs[o++] as CompatBuffer, nums[n++]);
          break;
        case OP.VIEWPORT:
          this.setViewport(nums[n], nums[n + 1], nums[n + 2], nums[n + 3], nums[n + 4], nums[n + 5]);
          n += 6;
          break;
        case OP.SCISSOR:
          this.setScissor(nums[n], nums[n + 1], nums[n + 2], nums[n + 3]);
          n += 4;
          break;
        case OP.BLEND_CONSTANT:
          this.setBlendConstant(nums[n], nums[n + 1], nums[n + 2], nums[n + 3]);
          n += 4;
          break;
        case OP.STENCIL_REFERENCE:
          this.setStencilReference(nums[n++]);
          break;
        case OP.BEGIN_QUERY:
          this.beginQuery(nums[n++]);
          break;
        case OP.END_QUERY:
          this.endQuery();
          break;
        case OP.EXECUTE_BUNDLES:
          this.executeBundles(objs[o++] as readonly CompatRenderBundle[]);
          break;
        case OP.END_PASS:
          this.endPass();
          break;
        case OP.COMPUTE_BEGIN:
          this.beginCompute();
          break;
        case OP.COMPUTE_PIPELINE:
          this.computePipeline = objs[o++] as CompatComputePipeline;
          break;
        case OP.COMPUTE_BIND: {
          const length = nums[n + 1];
          this.bindCompute(nums[n], objs[o++] as CompatBindGroup | null, nums, n + 2, length);
          n += 2 + length;
          break;
        }
        case OP.DISPATCH: {
          const counts = this.counts;
          counts[0] = nums[n];
          counts[1] = nums[n + 1];
          counts[2] = nums[n + 2];
          n += 3;
          if (this.computePipeline) this.dispatch(this.computePipeline, this.computeGroups, counts);
          break;
        }
        case OP.DISPATCH_INDIRECT: {
          const counts = this.counts,
            bytes = (objs[o++] as CompatBuffer).bytes(),
            at = nums[n++];
          counts[0] = word(bytes, at);
          counts[1] = word(bytes, at + 4);
          counts[2] = word(bytes, at + 8);
          if (this.computePipeline) this.dispatch(this.computePipeline, this.computeGroups, counts);
          break;
        }
      }
    }
  }

  /** The compute pass running: its pipeline, bind groups (reused slots, so a pass allocates none) and workgroup counts. */
  private computePipeline: CompatComputePipeline | null = null;
  private readonly computeSlots: { group: CompatBindGroup; offsets: number[] }[] = [];
  private readonly computeGroups: BoundGroup[] = [];
  private readonly counts = [0, 0, 0];

  /** A compute pass begins with no pipeline and no bind group. */
  private beginCompute(): void {
    this.computePipeline = null;
    for (let i = 0; i < this.computeGroups.length; i++) this.computeGroups[i] = null;
  }

  /** Binds `group` for the compute pass's dispatches (null, or an invalid group, binds nothing). */
  private bindCompute(
    index: number,
    group: CompatBindGroup | null,
    offsets: ArrayLike<number>,
    from: number,
    count: number,
  ): void {
    if (!group || group.invalid) {
      this.computeGroups[index] = null;
      return;
    }
    const slot = (this.computeSlots[index] ??= { group, offsets: NO_OFFSETS as number[] });
    slot.group = group;
    // The offsets list has exactly the offsets bound, as the runtime reads it by index with 0 for a missing one.
    if (slot.offsets.length !== count) slot.offsets = count === 0 ? (NO_OFFSETS as number[]) : new Array<number>(count);
    for (let i = 0; i < count; i++) slot.offsets[i] = offsets[from + i];
    this.computeGroups[index] = slot;
  }

  /** drawIndirect's draw: the four counts read from the buffer (a rare command; its array is the cost of reading). */
  private drawIndirect(buffer: CompatBuffer, offset: number): void {
    const bytes = buffer.bytes();
    this.draw(word(bytes, offset), word(bytes, offset + 4), word(bytes, offset + 8), word(bytes, offset + 12));
  }
  private drawIndexedIndirect(buffer: CompatBuffer, offset: number): void {
    const bytes = buffer.bytes();
    this.drawIndexed(
      word(bytes, offset),
      word(bytes, offset + 4),
      word(bytes, offset + 8),
      word(bytes, offset + 12) | 0,
      word(bytes, offset + 16),
    );
  }

  // ------------------------------------------------ new textures

  /** Uploads one block write (writeBlocks) into storage `s` of a block-compressed texture, in `s`'s own format. */
  putBlocks(s: TextureStorage, write: BlockWrite): void {
    const gl = this.gl,
      { level, x, y, z, w, h, depth, bytes } = write,
      internal = this.device.enum(s.info.internal),
      image = bytes.length / depth;
    this.device.state.scratch(s.target, s.gl);
    if (s.target === gl.TEXTURE_2D) gl.compressedTexSubImage2D(gl.TEXTURE_2D, level, x, y, w, h, internal, bytes);
    else if (s.target === gl.TEXTURE_CUBE_MAP)
      for (let layer = 0; layer < depth; layer++)
        gl.compressedTexSubImage2D(
          gl.TEXTURE_CUBE_MAP_POSITIVE_X + z + layer,
          level,
          x,
          y,
          w,
          h,
          internal,
          bytes.subarray(layer * image, (layer + 1) * image),
        );
    else gl.compressedTexSubImage3D(s.target, level, x, y, z, w, h, depth, internal, bytes);
  }

  /** The framebuffer zero() attaches each new subresource to, and detaches it from after its clear. */
  private zeroFramebuffer: WebGLFramebuffer | null = null;
  /** A zero-filled pixel unpack buffer for zero() uploads (WebGL zero-fills bufferData), kept while small. */
  private zeroBytes: { buffer: WebGLBuffer; size: number } | null = null;

  /**
   * Writes zeros into every level and layer (or 3D slice) of `texture`, which GL has just allocated with texStorage.
   * WebGL reads an unwritten level as zeros, but initialises it itself at the first partial upload or draw that touches
   * it, and Firefox warns for each ("Tex image TEXTURE_2D level 1 is incurring lazy initialization", "Texture has not
   * been initialized prior to a partial upload, forcing the browser to clear it"). Colour-renderable, depth and
   * stencil formats are cleared through a framebuffer; other formats are uploaded whole, one call per level (a partial
   * upload would start the browser's own initialisation), from a zero-filled pixel unpack buffer. Block-compressed
   * formats are left to the browser: an all-zero block is not a zero texel (ASTC's is its error colour). Where the
   * adapter finds clears lost (device/fresh-clears.ts, Radeon 680M under ANGLE D3D11), the float and normalized colour
   * subresources of a texture with more than one level or layer get their zeros from draws instead.
   */
  zero(texture: WebGLTexture, target: number, info: FormatInfo, levels: number, w: number, h: number, d: number): void {
    if (info.block) return;
    const aspect = hasDepth(info) || hasStencil(info);
    if ((aspect || this.clearable(info)) && this.clearLevels(texture, target, info, levels, w, h, d)) return;
    if (!aspect) this.uploadZeros(texture, target, info, levels, w, h, d);
  }

  /** Whether a colour format can be a framebuffer attachment on this context. */
  attachable(info: FormatInfo): boolean {
    return this.clearable(info);
  }

  private clearable(info: FormatInfo): boolean {
    return (
      info.renderable && (info.kind !== 'float' || !info.name.includes('float') || this.device.ext.colorBufferFloat)
    );
  }

  /** zero() by framebuffer clears; false (nothing cleared) when GL does not take the texture as an attachment. */
  private clearLevels(
    texture: WebGLTexture,
    target: number,
    info: FormatInfo,
    levels: number,
    w: number,
    h: number,
    d: number,
  ): boolean {
    const gl = this.gl,
      s = this.device.state,
      point = hasDepth(info) || hasStencil(info) ? this.depthPoint(info) : gl.COLOR_ATTACHMENT0;
    const fbo = (this.zeroFramebuffer ??= gl.createFramebuffer() as WebGLFramebuffer);
    this.openMasks();
    s.enable(gl.SCISSOR_TEST, false);
    s.bindDrawFramebuffer(fbo);
    const attach = (level: number, layer: number, t: WebGLTexture | null) => {
      if (target === gl.TEXTURE_2D) gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, point, gl.TEXTURE_2D, t, level);
      else if (target === gl.TEXTURE_CUBE_MAP)
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, point, gl.TEXTURE_CUBE_MAP_POSITIVE_X + layer, t, level);
      else gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, point, t, level, layer);
    };
    const layersAt = (level: number) =>
      target === gl.TEXTURE_CUBE_MAP ? 6 : target === gl.TEXTURE_3D ? Math.max(1, d >> level) : d;
    const draw = point === gl.COLOR_ATTACHMENT0 && this.drawsClears(info, levels, layersAt(0)),
      // A view copy made at a draw zeroes its storage inside a pass: the pass's viewport comes back after the draws.
      keep = draw && !!this.pass,
      vx = s.num(S.viewport),
      vy = s.num(S.viewport + 1),
      vw = s.num(S.viewport + 2),
      vh = s.num(S.viewport + 3);
    let complete = true;
    for (let level = 0; level < levels && complete; level++)
      for (let layer = 0, n = layersAt(level); layer < n; layer++) {
        attach(level, layer, texture);
        if (level === 0 && layer === 0)
          complete = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        if (!complete) break;
        if (hasDepth(info) && hasStencil(info)) gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 0, 0);
        else if (hasDepth(info)) gl.clearBufferfv(gl.DEPTH, 0, [0]);
        else if (hasStencil(info)) gl.clearBufferiv(gl.STENCIL, 0, [0]);
        else if (info.kind === 'uint') gl.clearBufferuiv(gl.COLOR, 0, [0, 0, 0, 0]);
        else if (info.kind === 'sint') gl.clearBufferiv(gl.COLOR, 0, [0, 0, 0, 0]);
        else if (draw)
          this.drawClear(0, [0, 0, 0, 0], Math.max(1, w >> level), Math.max(1, h >> level), [gl.COLOR_ATTACHMENT0]);
        else gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
      }
    if (keep && vx === vx) s.viewport(vx, vy, vw, vh);
    // Detach (a texture attached to no framebuffer can be deleted at once), and give a pass in replay (a view copy made
    // at a draw) its framebuffer and state back.
    attach(0, 0, null);
    this.rebind();
    return complete;
  }

  /**
   * Whether colour clears of this texture are draws: on an adapter that loses clears (adapter.drawClears,
   * device/fresh-clears.ts), for a float or normalized format with more than one level or layer. There a texture
   * keeps the clears of one subresource only; integer formats keep clearBuffer.
   */
  private drawsClears(info: FormatInfo, levels: number, layers: number): boolean {
    return this.device.adapter.drawClears && info.kind !== 'uint' && info.kind !== 'sint' && levels * layers > 1;
  }

  /**
   * Writes `value` to colour attachment `i` of the bound draw framebuffer over (0, 0, w, h) with a draw instead of
   * clearBufferfv (drawsClears). `buffers` is the framebuffer's draw buffer list, which comes back after the draw.
   */
  private drawClear(i: number, value: ArrayLike<number>, w: number, h: number, buffers: readonly number[]): void {
    const gl = this.gl,
      helper = this.helper(
        `clear${i}`,
        `uniform highp vec4 v;\nlayout(location = ${i}) out highp vec4 c;\nvoid main() { c = v; }`,
      );
    this.helperState(helper, w, h);
    gl.uniform4f(helper.value, value[0], value[1], value[2], value[3]);
    gl.drawBuffers(buffers.map((b, k) => (k === i ? b : gl.NONE)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.drawBuffers(buffers);
  }

  /** zero() by whole-level uploads from a zero-filled pixel unpack buffer. */
  private uploadZeros(
    texture: WebGLTexture,
    target: number,
    info: FormatInfo,
    levels: number,
    w: number,
    h: number,
    d: number,
  ): void {
    const gl = this.gl,
      texel = glTexelBytes(info),
      faces = target === gl.TEXTURE_CUBE_MAP ? 6 : 1,
      size = w * h * d * texel;
    let zeros = this.zeroBytes;
    if (!zeros || zeros.size < size) {
      if (zeros) gl.deleteBuffer(zeros.buffer);
      zeros = this.zeroBytes = { buffer: gl.createBuffer() as WebGLBuffer, size };
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, zeros.buffer);
      gl.bufferData(gl.PIXEL_UNPACK_BUFFER, size, gl.STATIC_DRAW);
    } else gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, zeros.buffer);
    this.device.state.scratch(target, texture);
    const format = this.device.enum(info.format),
      type = this.device.enum(info.type);
    for (let level = 0; level < levels; level++) {
      const lw = Math.max(1, w >> level),
        lh = Math.max(1, h >> level);
      if (target === gl.TEXTURE_3D || target === gl.TEXTURE_2D_ARRAY) {
        const ld = target === gl.TEXTURE_3D ? Math.max(1, d >> level) : d;
        gl.texSubImage3D(target, level, 0, 0, 0, lw, lh, ld, format, type, 0);
      } else
        for (let face = 0; face < faces; face++)
          gl.texSubImage2D(
            faces === 6 ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + face : gl.TEXTURE_2D,
            level,
            0,
            0,
            lw,
            lh,
            format,
            type,
            0,
          );
    }
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    // Keep a small buffer for the next texture; give a large one back at once.
    if (size > ZERO_BYTES_KEPT) {
      gl.deleteBuffer(zeros.buffer);
      this.zeroBytes = null;
    }
  }

  // ------------------------------------------------ framebuffers

  /** A level and layer of a storage (for a 3D storage, `layer` is the depth slice). */
  sub(s: TextureStorage, level: number, layer: number): Sub {
    let levels = this.subs.get(s);
    if (!levels) this.subs.set(s, (levels = []));
    const layers = (levels[level] ??= []);
    return (layers[layer] ??= this.makeSub(s, level, layer));
  }

  private makeSub(s: TextureStorage, level: number, layer: number): Sub {
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

  /** The subresource of a renderbuffer-backed texture, made once per texture. */
  private renderbufferSub(t: CompatTexture): Sub {
    return this.renderbufferSubs.get(t) ?? this.makeRenderbufferSub(t);
  }

  /** renderbufferSub()'s slow path, a method of its own: a function that makes a closure allocates its context on every call. */
  private makeRenderbufferSub(t: CompatTexture): Sub {
    const gl = this.gl,
      sub: Sub = {
        key: `r${t.id}`,
        owner: t,
        info: t.storageInfo,
        level: 0,
        attach: (point) => gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, point, gl.RENDERBUFFER, t.renderbuffer),
      };
    this.renderbufferSubs.set(t, sub);
    return sub;
  }

  /** What a render pass attaches for a view: its renderbuffer, or its level and layer (or 3D slice). */
  private viewSub(v: CompatTextureView, slice?: number): Sub {
    const t = v.texture;
    if (t.renderbuffer) return this.renderbufferSub(t);
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

  /**
   * A framebuffer of the first `count` colour subresources (null entries leave a draw buffer empty) and the depth
   * subresource. One made before is found by the identity of its subresources (Sub.fbs; sub() and viewSub() cache
   * them), so a steady pass builds nothing: the key string, owner list and attach function are made once.
   */
  private framebuffer(colors: readonly (Sub | null)[], count: number, depth: Sub | null): WebGLFramebuffer {
    let lead = depth;
    for (let i = 0; i < count; i++)
      if (colors[i]) {
        lead = colors[i];
        break;
      }
    const list = lead?.fbs;
    if (list)
      for (let k = 0; k < list.length; k++) {
        const a = list[k];
        if (a.depth !== depth || a.colors.length !== count || a.record.dead) continue;
        let same = true;
        for (let i = 0; i < count && same; i++) same = a.colors[i] === colors[i];
        if (same) return this.device.framebufferAgain(a.record);
      }
    return this.makeFramebuffer(colors, count, depth, lead);
  }

  /**
   * framebuffer()'s slow path, once per set of attachments (not made yet, or deleted with one of its textures). A
   * method of its own: its attach function captures the attachments, and a function that makes a closure allocates
   * the closure's context on every call, the steady ones included.
   */
  private makeFramebuffer(
    colors: readonly (Sub | null)[],
    count: number,
    depth: Sub | null,
    lead: Sub | null,
  ): WebGLFramebuffer {
    const list = lead?.fbs;
    if (list) for (let k = list.length - 1; k >= 0; k--) if (list[k].record.dead) list.splice(k, 1);
    const own = colors.slice(0, count),
      gl = this.gl,
      device = this.device,
      buffers = own.map((c, i) => (c ? gl.COLOR_ATTACHMENT0 + i : gl.NONE)),
      key = `${own.map((c) => c?.key ?? '-').join(',')}|${depth?.key ?? ''}`,
      owners = [...own.filter((c): c is Sub => !!c), ...(depth ? [depth] : [])].map((c) => c.owner);
    const record = device.framebuffer(key, owners, (fbo, made) => {
      device.state.bindDrawFramebuffer(fbo);
      for (let i = 0; i < own.length; i++) own[i]?.attach(gl.COLOR_ATTACHMENT0 + i);
      if (depth) depth.attach(this.depthPoint(depth.info));
      gl.drawBuffers(buffers);
      // Once, when made: the same attachments again keep their completeness (see CompatDevice.framebuffer).
      if (!made) return;
      const status = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE)
        device.validationError(
          `The render pass attachments do not form a complete WebGL2 framebuffer (status 0x${status.toString(16)})`,
        );
    });
    if (lead) (lead.fbs ??= []).push({ colors: own, depth, record });
    return record.fbo;
  }

  /** A framebuffer of one subresource, as colour or as depth and stencil by its format. */
  single(s: Sub): WebGLFramebuffer {
    if (hasDepth(s.info) || hasStencil(s.info)) return this.framebuffer(this.colorSubs, 0, s);
    const colors = this.colorSubs,
      held = colors[0];
    colors[0] = s;
    const fbo = this.framebuffer(colors, 1, null);
    colors[0] = held;
    return fbo;
  }

  /**
   * Copies level 0 of canvas texture `t` into the context's drawing buffer, upside down (WebGL's rows run bottom-up),
   * with alpha 1 when `opaque`: a full-target triangle of the layer's own that fetches one texel a pixel, so the copy
   * is exact. Not blitFramebuffer and a colour-masked clear: Chrome's ANGLE D3D11 backend makes a flipped blit and a
   * masked clear with shaders of its own, and after them the fragment-stage uniform blocks of a later draw that
   * changes no binding sometimes read zero (docs/known-bugs.md, "ANGLE D3D11 flipped blit").
   */
  presentTexture(t: CompatTexture, opaque: boolean): void {
    const gl = this.gl,
      state = this.device.state,
      p = t.primary as TextureStorage;
    t.read(p, 0, 1, 0, 1, this.sync);
    const h = this.helper(
      'present',
      'uniform highp sampler2D t;\nuniform ivec4 o;\nout highp vec4 c;\n' +
        'void main() { c = texelFetch(t, ivec2(int(gl_FragCoord.x), o.y - 1 - int(gl_FragCoord.y)), 0); if (o.x == 1) c.a = 1.0; }',
    );
    state.bindDrawFramebuffer(null);
    this.helperState(h, t.width, t.height);
    state.unit(0, p.target, p.gl, this.device.loadSampler);
    const all = levelRange(0, t.mipLevelCount - 1);
    if (p.levels !== all) {
      state.activeUnit(0);
      gl.texParameteri(p.target, gl.TEXTURE_BASE_LEVEL, 0);
      gl.texParameteri(p.target, gl.TEXTURE_MAX_LEVEL, t.mipLevelCount - 1);
      p.levels = all;
    }
    gl.uniform4i(h.offset, opaque ? 1 : 0, t.height, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * copyExternalImageToTexture from an ImageBitmap (KB0477). WebGL ignores the unpack flip and alpha flags for an
   * ImageBitmap and uploads it as it is held (WebGL 1.0 section 5.14.8): straight or premultiplied colour, which the
   * page cannot ask (a bitmap made with premultiplyAlpha 'default' is premultiplied in Chromium). WebGPU's copy reads
   * the source in its own alpha state and converts it to the requested one (WebGPU section 3.11). So the source region
   * is uploaded as held (`held`), and a copy drawn through a 2D canvas, which stores premultiplied colour, is uploaded
   * as stored (`stored`): a premultiplied bitmap is copied unchanged, so the two are equal, and a straight one differs
   * wherever premultiplying changes a byte. One point per texel marks a 1 x 1 texture where they differ (`straight`),
   * on the GPU with no readback. A draw over the destination region then writes each texel, flipped and converted:
   * multiplied by alpha when straight colour must become premultiplied, divided by a non-zero alpha when premultiplied
   * colour must become straight (both in f32, as the WebGPU copy), and sRGB-decoded for an sRGB destination, whose
   * attachment encodes it again. Drawing through a canvas alone (the old path) quantised straight RGB at low alpha.
   */
  copyBitmap(
    bitmap: ImageBitmap,
    [sx, sy, w, h]: readonly number[],
    flipY: boolean,
    t: CompatTexture,
    level: number,
    [x, y, z]: readonly number[],
    premultiplied: boolean,
  ): void {
    const gl = this.gl,
      state = this.device.state;
    const canvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) throw this.device.unsupported('a 2D canvas for ImageBitmap copies');
    context.drawImage(bitmap, sx, sy, w, h, 0, 0, w, h);
    const scratch = (internal: number, width: number, height: number, image?: TexImageSource) => {
      const texture = gl.createTexture() as WebGLTexture;
      state.scratch(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, internal, width, height);
      if (image) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, image);
      return texture;
    };
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, sx);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, sy);
    const held = scratch(gl.RGBA8, w, h, bitmap);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    const stored = scratch(gl.RGBA8, w, h, canvas as TexImageSource);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const straight = scratch(gl.R8, 1, 1);
    const fbo = gl.createFramebuffer() as WebGLFramebuffer;
    state.bindDrawFramebuffer(fbo);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, straight, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    const mark = this.helper(
      'bitmap-alpha',
      'out vec4 c;\nvoid main() { c = vec4(1.0); }',
      'precision highp float;\nprecision highp int;\nuniform highp sampler2D t;\nuniform highp sampler2D b;\nuniform ivec4 o;\n' +
        'void main() {\n' +
        '  ivec2 p = ivec2(gl_VertexID % o.x, gl_VertexID / o.x);\n' +
        '  gl_PointSize = 1.0;\n' +
        '  gl_Position = texelFetch(t, p, 0) != texelFetch(b, p, 0) ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);\n' +
        '}',
    );
    this.helperState(mark, 1, 1);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    state.unit(0, gl.TEXTURE_2D, held, this.device.loadSampler);
    state.unit(1, gl.TEXTURE_2D, stored, this.device.loadSampler);
    gl.uniform4i(mark.offset, w, 0, 0, 0);
    gl.drawArrays(gl.POINTS, 0, w * h);
    const s = t.primary as TextureStorage,
      srgb = s.info.internal.includes('SRGB');
    state.bindDrawFramebuffer(this.single(this.sub(s, level, z)));
    const draw = this.helper(
      'bitmap-copy',
      'uniform highp sampler2D t;\nuniform highp sampler2D b;\nuniform ivec4 o;\nout highp vec4 c;\n' +
        'void main() {\n' +
        '  ivec2 p = ivec2(gl_FragCoord.xy) - o.xy;\n' +
        '  if (o.z > 0) p.y = o.z - 1 - p.y;\n' +
        '  c = texelFetch(t, p, 0);\n' +
        '  bool held = texelFetch(b, ivec2(0), 0).r > 0.5, want = (o.w & 1) != 0;\n' +
        '  if (held && want) c.rgb *= c.a;\n' +
        '  else if (!held && !want && c.a != 0.0) c.rgb /= c.a;\n' +
        '  if ((o.w & 2) != 0) c.rgb = mix(c.rgb / 12.92, pow((c.rgb + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c.rgb));\n' +
        '}',
    );
    this.helperState(draw, w, h);
    state.viewport(x, y, w, h);
    state.unit(0, gl.TEXTURE_2D, held, this.device.loadSampler);
    state.unit(1, gl.TEXTURE_2D, straight, this.device.loadSampler);
    gl.uniform4i(draw.offset, x, y, flipY ? h : 0, (premultiplied ? 1 : 0) | (srgb ? 2 : 0));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    state.bindDrawFramebuffer(null);
    gl.deleteFramebuffer(fbo);
    for (const texture of [held, stored, straight]) {
      state.forgetTexture(texture);
      gl.deleteTexture(texture);
    }
  }

  /** Full colour and depth write masks and no scissor, for clears and blits. */
  private openMasks(): void {
    const gl = this.gl,
      s = this.device.state;
    if (s.changed(S.colorMask, 1, 15)) gl.colorMask(true, true, true, true);
    s.forget(S.colorMaskAt, 8);
    if (s.changed(S.depthMask, 1, 1)) gl.depthMask(true);
    if (s.changed(S.stencilMask, 1, 0xff)) gl.stencilMask(0xff);
    s.forget(S.stencilMaskFront, 2);
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
    w ??= to.owner.levelWidth(to.level);
    h ??= to.owner.levelHeight(to.level);
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
      w = from.texture.levelWidth(level),
      h = from.texture.levelHeight(level),
      depth = from.texture.levelDepth(level);
    const slices = from.target === gl.TEXTURE_3D ? depth : 1;
    for (let z = 0; z < slices; z++) {
      const a = from.target === gl.TEXTURE_3D ? z : layer;
      if (from.info.block) this.decodeBlocks(from, to, level, a);
      else if (this.tierCopy(from, to)) {
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

  /**
   * Fills a level and layer of `to`, a decoded copy of a block-compressed texture (CompatTexture.copy), from the blocks
   * as `to`'s view format reads them: a full-target draw that fetches each texel through the GPU's own decoder, so the
   * copy holds what sampling the blocks returns (sRGB already decoded). GLSL ES 3.00 has no texelFetch for cube
   * samplers, so a cube source is read at the direction of each texel's centre (OpenGL ES 3.0, section 3.8.10, table
   * 3.21, inverted) at an exact level through the nearest sampler, which selects exactly that texel.
   */
  private decodeBlocks(from: TextureStorage, to: TextureStorage, level: number, layer: number): void {
    const gl = this.gl,
      state = this.device.state,
      t = from.texture,
      src = t.blocksIn(to.format),
      w = t.levelWidth(level),
      h = t.levelHeight(level);
    const kind = src.target === gl.TEXTURE_CUBE_MAP ? 'cube' : src.target === gl.TEXTURE_2D_ARRAY ? 'array' : '2d';
    const fetch =
      kind === 'cube'
        ? '  vec2 q = gl_FragCoord.xy / vec2(o.zw) * 2.0 - 1.0;\n' +
          '  vec3 d = o.y == 0 ? vec3(1.0, -q.y, -q.x) : o.y == 1 ? vec3(-1.0, -q.y, q.x) : o.y == 2 ? vec3(q.x, 1.0, q.y)' +
          ' : o.y == 3 ? vec3(q.x, -1.0, -q.y) : o.y == 4 ? vec3(q.x, -q.y, 1.0) : vec3(-q.x, -q.y, -1.0);\n' +
          '  c = textureLod(t, d, float(o.x));\n'
        : kind === 'array'
          ? '  c = texelFetch(t, ivec3(ivec2(gl_FragCoord.xy), o.y), o.x);\n'
          : '  c = texelFetch(t, ivec2(gl_FragCoord.xy), o.x);\n';
    const sampler = kind === 'cube' ? 'samplerCube' : kind === 'array' ? 'sampler2DArray' : 'sampler2D';
    const helper = this.helper(
      `decode-${kind}`,
      `uniform highp ${sampler} t;\nuniform ivec4 o;\nout highp vec4 c;\nvoid main() {\n${fetch}}`,
    );
    // A view copy made at a draw is decoded inside a pass: the pass's viewport comes back after the decode draw.
    const keep = !!this.pass,
      vx = state.num(S.viewport),
      vy = state.num(S.viewport + 1),
      vw = state.num(S.viewport + 2),
      vh = state.num(S.viewport + 3);
    state.bindDrawFramebuffer(this.single(this.sub(to, level, layer)));
    this.helperState(helper, w, h);
    state.unit(0, src.target, src.gl, this.device.loadSampler);
    const all = levelRange(0, t.mipLevelCount - 1);
    if (src.levels !== all) {
      state.activeUnit(0);
      gl.texParameteri(src.target, gl.TEXTURE_BASE_LEVEL, 0);
      gl.texParameteri(src.target, gl.TEXTURE_MAX_LEVEL, t.mipLevelCount - 1);
      src.levels = all;
    }
    gl.uniform4i(helper.offset, level, layer - src.layer, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (keep && vx === vx) state.viewport(vx, vy, vw, vh);
  }

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

  /**
   * The subresource of a multisampled texture's resolved copy (`own`: the stencil aspect's), made once while the copy is
   * the same GL texture, so the framebuffer a blit into it uses is found by identity (a new one every frame made a
   * key string, owner list and closures for every sampled multisampled texture, KB-COMPAT-FRAMEALLOC1).
   */
  private resolvedSub(t: CompatTexture, resolved: WebGLTexture, own: boolean): Sub {
    const held = (own ? this.stencilResolvedSubs : this.resolvedSubs).get(t);
    return held && held.texture === resolved ? held.sub : this.makeResolvedSub(t, resolved, own);
  }

  /** resolvedSub()'s slow path (a closure's context is allocated on every call of the function that makes it). */
  private makeResolvedSub(t: CompatTexture, resolved: WebGLTexture, own: boolean): Sub {
    const gl = this.gl,
      sub: Sub = {
        key: `q${own ? 's' : ''}${t.id}`,
        owner: t,
        info: t.storageInfo,
        level: 0,
        attach: (point) => gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, point, gl.TEXTURE_2D, resolved, 0),
      };
    (own ? this.stencilResolvedSubs : this.resolvedSubs).set(t, { texture: resolved, sub });
    return sub;
  }

  /**
   * Brings the resolved copy of a multisampled texture that a binding of aspect `stencil` reads up to date, and returns
   * it: a depth-stencil texture's stencil aspect has a copy of its own (CompatTexture.resolvedFor).
   */
  private resolveForSampling(t: CompatTexture, stencil: boolean): WebGLTexture | null {
    const resolved = t.resolvedFor(stencil),
      own = resolved !== t.resolved;
    if (!resolved || !(own ? t.staleStencil : t.stale)) return resolved;
    this.blit(this.renderbufferSub(t), this.resolvedSub(t, resolved, own));
    if (own) t.staleStencil = false;
    else t.stale = false;
    this.rebind();
    return resolved;
  }

  // ------------------------------------------------ passes

  /** What an attachment writes, brought up to date first (a pass that loads, or draws over part of a level). */
  private prepare(v: CompatTextureView, slice: number): Sub {
    const t = v.texture;
    if (t.primary) t.read(t.attached(v), v.baseMipLevel, 1, t.dimension === '3d' ? 0 : v.baseArrayLayer, 1, this.sync);
    return this.viewSub(v, slice);
  }

  beginPass(desc: PassDescriptor): void {
    const gl = this.gl,
      s = this.device.state,
      pass = this.passState,
      cs = desc.colors,
      n = cs.length,
      colors = this.colorSubs,
      standIns = pass.standIns;
    this.device.passes.run++;
    for (let i = 0; i < n; i++) {
      const c = cs[i];
      standIns[i] =
        c && desc.depth && c.view.texture.dimension === '3d'
          ? [this.prepare(c.view, c.depthSlice), this.standIn(c.view)]
          : null;
    }
    for (let i = 0; i < n; i++) {
      const c = cs[i],
        standIn = standIns[i];
      if (!c) colors[i] = null;
      else if (!standIn) colors[i] = this.prepare(c.view, c.depthSlice);
      else {
        if (c.loadOp === 'load' && c.view.texture.initialized) this.blit(standIn[0], standIn[1]);
        colors[i] = standIn[1];
      }
    }
    const depth = desc.depth ? this.prepare(desc.depth.view, 0) : null;
    for (let i = 0; i < n; i++) {
      const r = cs[i]?.resolveTarget;
      if (r?.texture.primary) this.prepare(r, 0);
    }
    const fbo = this.framebuffer(colors, n, depth);
    for (let i = 0; i < n; i++) colors[i] = null;
    let first = desc.depth?.view;
    for (let i = 0; i < n; i++) {
      const c = cs[i];
      if (c) {
        first = c.view;
        break;
      }
    }
    const width = first ? Math.max(1, first.texture.width >> first.baseMipLevel) : 1,
      height = first ? Math.max(1, first.texture.height >> first.baseMipLevel) : 1;
    pass.desc = desc;
    pass.fbo = fbo;
    pass.width = width;
    pass.height = height;
    pass.pipeline = pass.applied = null;
    pass.stencilReference = 0;
    pass.query = false;
    this.clearSlots(pass);
    this.pass = pass;
    s.bindDrawFramebuffer(fbo);
    this.openMasks();
    s.enable(gl.SCISSOR_TEST, true);
    s.scissor(0, 0, width, height);
    s.viewport(0, 0, width, height);
    if (s.changed(S.depthRange, 2, 0, 1)) gl.depthRange(0, 1);
    if (s.changed(S.blendColor, 4, 0, 0, 0, 0)) gl.blendColor(0, 0, 0, 0);
    let drew = false;
    for (let i = 0; i < n; i++) {
      const c = cs[i];
      if (!c) continue;
      const t = c.view.texture;
      const clear = c.loadOp === 'clear' ? c.clearValue : !t.initialized ? NO_COLOR : null;
      if (!clear) continue;
      if (this.drawsClears(t.info, t.mipLevelCount, t.depthOrArrayLayers)) {
        // Rounded to the target's steps first: the export may narrow the float otherwise than a clear (drawnClear).
        this.drawClear(i, drawnClear(t.format, clear), width, height, this.drawBuffersOf(cs));
        drew = true;
      } else if (t.info.kind === 'uint') {
        // Typed arrays convert as `>>> 0` and `| 0` do.
        const v = this.clearUint;
        for (let k = 0; k < 4; k++) v[k] = clear[k];
        gl.clearBufferuiv(gl.COLOR, i, v);
      } else if (t.info.kind === 'sint') {
        const v = this.clearInt;
        for (let k = 0; k < 4; k++) v[k] = clear[k];
        gl.clearBufferiv(gl.COLOR, i, v);
      } else {
        const v = this.clearFloat;
        for (let k = 0; k < 4; k++) v[k] = clear[k];
        gl.clearBufferfv(gl.COLOR, i, v);
      }
    }
    // The clear draws keep the pass's viewport (the attachment size) but turn the scissor test off.
    if (drew) s.enable(gl.SCISSOR_TEST, true);
    const d = desc.depth;
    if (d) {
      const info = d.view.texture.info,
        fresh = !d.view.texture.initialized;
      const clearDepth = hasDepth(info) && (d.depthLoadOp === 'clear' || fresh) && !d.depthReadOnly,
        clearStencil = hasStencil(info) && (d.stencilLoadOp === 'clear' || fresh) && !d.stencilReadOnly;
      const depthValue = d.depthLoadOp === 'clear' ? d.depthClearValue : 0,
        stencilValue = d.stencilLoadOp === 'clear' ? d.stencilClearValue : 0;
      if (clearDepth && clearStencil) gl.clearBufferfi(gl.DEPTH_STENCIL, 0, depthValue, stencilValue);
      else if (clearDepth) {
        this.clearDepth[0] = depthValue;
        gl.clearBufferfv(gl.DEPTH, 0, this.clearDepth);
      } else if (clearStencil) {
        this.clearStencil[0] = stencilValue;
        gl.clearBufferiv(gl.STENCIL, 0, this.clearStencil);
      }
    }
  }

  /** The draw buffer list of a pass's colour attachments (a closure in beginPass would cost a context per pass). */
  private drawBuffersOf(cs: readonly (ColorAttachment | null)[]): number[] {
    const gl = this.gl;
    return cs.map((a, k) => (a ? gl.COLOR_ATTACHMENT0 + k : gl.NONE));
  }

  /** Unbinds the pass's bind groups, vertex buffers and index buffer, keeping their slot objects. */
  private clearSlots(pass: PassState): void {
    for (let i = 0; i < pass.groups.length; i++) {
      const g = pass.groups[i];
      if (g) g.group = null;
    }
    for (let i = 0; i < pass.vertex.length; i++) {
      const v = pass.vertex[i];
      if (v) v.buffer = null;
    }
    if (pass.index) pass.index.buffer = null;
  }

  /** Marks what a pass wrote through view `v` as written. */
  private wrote(v: CompatTextureView): void {
    const t = v.texture;
    if (t.primary) t.wrote(t.attached(v), v.baseMipLevel, 1, t.dimension === '3d' ? 0 : v.baseArrayLayer, 1);
  }

  endPass(): void {
    const pass = this.pass;
    if (!pass) return;
    if (pass.query) this.endQuery();
    this.pass = null;
    const gl = this.gl,
      cs = pass.desc.colors;
    let discards = 0,
      depthPoint = 0;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (!c) continue;
      const t = c.view.texture,
        standIn = pass.standIns[i];
      if (standIn && c.storeOp === 'store') this.blit(standIn[1], standIn[0]);
      t.initialized = true;
      this.wrote(c.view);
      if (t.renderbuffer && t.resolved) t.stale = t.staleStencil = true;
      if (c.resolveTarget) {
        this.blit(this.viewSub(c.view, c.depthSlice), this.viewSub(c.resolveTarget));
        c.resolveTarget.texture.initialized = true;
        this.wrote(c.resolveTarget);
        this.presentIfCanvas(c.resolveTarget.texture);
      }
      if (c.storeOp === 'discard') {
        discards++;
        t.initialized = false;
      } else this.presentIfCanvas(t);
    }
    const d = pass.desc.depth;
    if (d) {
      const t = d.view.texture;
      t.initialized = true;
      if (!d.depthReadOnly || !d.stencilReadOnly) this.wrote(d.view);
      if (t.renderbuffer && t.resolved) t.stale = t.staleStencil = true;
      if (d.depthStoreOp === 'discard' && (!hasStencil(t.info) || d.stencilStoreOp === 'discard')) {
        depthPoint = this.depthPoint(t.info);
        discards++;
        t.initialized = false;
      }
    }
    if (!discards) return;
    // The attachments to invalidate, in attachment order, in the reused list of that length.
    const list = (this.discards[discards] ??= new Array(discards).fill(0));
    let k = 0;
    for (let i = 0; i < cs.length; i++) if (cs[i]?.storeOp === 'discard') list[k++] = gl.COLOR_ATTACHMENT0 + i;
    if (depthPoint) list[k++] = depthPoint;
    this.device.state.bindDrawFramebuffer(pass.fbo);
    gl.invalidateFramebuffer(gl.DRAW_FRAMEBUFFER, list);
  }

  private presentIfCanvas(t: CompatTexture): void {
    const context = (t as { canvasContext?: { present(): void } }).canvasContext;
    if (context) this.device.queuePresent(context);
  }

  setPipeline(p: CompatRenderPipeline): void {
    if (this.pass) this.pass.pipeline = p;
  }
  /** Binds `group` at `index` with the `count` dynamic offsets at `offsets[from]` (copied into the slot's own list). */
  setBindGroup(
    index: number,
    group: CompatBindGroup | null,
    offsets: ArrayLike<number>,
    from = 0,
    count = offsets.length,
  ): void {
    const pass = this.pass;
    if (!pass) return;
    // An invalid group (its error was reported at createBindGroup) binds nothing, so its draws are skipped.
    const bound = group && !group.invalid ? group : null,
      slot = (pass.groups[index] ??= { group: null, offsets: [], count: 0 }),
      list = slot.offsets as number[];
    slot.group = bound;
    slot.count = count;
    for (let i = 0; i < count; i++) list[i] = offsets[from + i];
  }
  setVertexBuffer(slot: number, buffer: CompatBuffer | null, offset: number, _size?: number): void {
    const pass = this.pass;
    if (!pass) return;
    const v = pass.vertex[slot];
    if (v) {
      v.buffer = buffer;
      v.offset = offset;
    } else pass.vertex[slot] = { buffer, offset };
  }
  setIndexBuffer(buffer: CompatBuffer, format: GPUIndexFormat, offset: number, _size?: number): void {
    const pass = this.pass;
    if (!pass) return;
    const gl = this.gl,
      ix = (pass.index ??= { buffer: null, type: 0, size: 0, offset: 0 });
    ix.buffer = buffer;
    ix.type = format === 'uint16' ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
    ix.size = format === 'uint16' ? 2 : 4;
    ix.offset = offset;
  }
  setViewport(x: number, y: number, w: number, h: number, near: number, far: number): void {
    const gl = this.gl,
      s = this.device.state;
    s.viewport(x, y, w, h);
    if (s.changed(S.depthRange, 2, near, far)) gl.depthRange(near, far);
  }
  setScissor(x: number, y: number, w: number, h: number): void {
    this.device.state.scissor(x, y, w, h);
  }
  setBlendConstant(r: number, g: number, b: number, a: number): void {
    if (this.device.state.changed(S.blendColor, 4, r, g, b, a)) this.gl.blendColor(r, g, b, a);
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
    this.clearSlots(pass);
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
      discard: () => set.release(queries),
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

  /** The bytes of an indirect argument block (a copy: the replay itself reads the words in place, see `word`). */
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
    if (p.cull && s.changed(S.cullFace, 1, p.cull)) gl.cullFace(p.cull);
    if (s.changed(S.frontFace, 1, p.frontFace)) gl.frontFace(p.frontFace);
    if (ext.depthClamp) s.enable(ext.depthClamp.DEPTH_CLAMP_EXT, p.unclippedDepth);
    const ds = p.depthStencil,
      d = pass.desc.depth;
    const depthOn = !!ds && !!d && hasDepth(d.view.texture.info);
    s.enable(gl.DEPTH_TEST, depthOn);
    if (depthOn && ds) {
      const func = this.device.compare(ds.depthCompare ?? 'always');
      if (s.changed(S.depthFunc, 1, func)) gl.depthFunc(func);
      const write = !!ds.depthWriteEnabled && !d?.depthReadOnly;
      if (s.changed(S.depthMask, 1, write ? 1 : 0)) gl.depthMask(write);
      const bias = ds.depthBias ?? 0,
        slope = ds.depthBiasSlopeScale ?? 0,
        clamp = ds.depthBiasClamp ?? 0;
      s.enable(gl.POLYGON_OFFSET_FILL, bias !== 0 || slope !== 0);
      // The extension and WebGPU share signed min/max semantics; zero disables the clamp.
      if ((bias || slope) && s.changed(S.polygonOffset, 3, slope, bias, clamp)) {
        if (ext.polygonOffsetClamp) ext.polygonOffsetClamp.polygonOffsetClampEXT(slope, bias, clamp);
        else gl.polygonOffset(slope, bias);
      }
    } else s.enable(gl.POLYGON_OFFSET_FILL, false);
    const stencilOn = !!ds && !!d && hasStencil(d.view.texture.info);
    s.enable(gl.STENCIL_TEST, stencilOn);
    if (stencilOn && ds) {
      // All WebGPU stencil aspects are eight bits. GL clamps a signed GLint instead of truncating it.
      const ref = pass.stencilReference & 0xff,
        read = ds.stencilReadMask ?? 0xffffffff,
        write = d?.stencilReadOnly ? 0 : (ds.stencilWriteMask ?? 0xffffffff);
      this.stencilFace(
        gl.FRONT,
        ds.stencilFront,
        ref,
        read,
        write,
        S.stencilFuncFront,
        S.stencilOpFront,
        S.stencilMaskFront,
      );
      this.stencilFace(
        gl.BACK,
        ds.stencilBack,
        ref,
        read,
        write,
        S.stencilFuncBack,
        S.stencilOpBack,
        S.stencilMaskBack,
      );
      s.forget(S.stencilMask);
    }
    s.enable(gl.SAMPLE_ALPHA_TO_COVERAGE, p.alphaToCoverage);
    this.applyTargets(p);
  }

  /** One face's stencil test, operations and write mask, each cached at its slots (S). */
  private stencilFace(
    face: number,
    f: GPUStencilFaceState | undefined,
    ref: number,
    read: number,
    write: number,
    funcAt: number,
    opAt: number,
    maskAt: number,
  ): void {
    const gl = this.gl,
      s = this.device.state,
      device = this.device;
    const func = device.compare(f?.compare ?? 'always');
    if (s.changed(funcAt, 3, func, ref, read)) gl.stencilFuncSeparate(face, func, ref, read);
    const fail = device.enum(STENCIL_OPS[f?.failOp ?? 'keep']),
      depthFail = device.enum(STENCIL_OPS[f?.depthFailOp ?? 'keep']),
      pass = device.enum(STENCIL_OPS[f?.passOp ?? 'keep']);
    if (s.changed(opAt, 3, fail, depthFail, pass)) gl.stencilOpSeparate(face, fail, depthFail, pass);
    if (s.changed(maskAt, 1, write)) gl.stencilMaskSeparate(face, write);
  }

  private applyTargets(p: CompatRenderPipeline, only?: number): void {
    const s = this.device.state,
      indexed = this.device.ext.indexed,
      targets = p.targetGL;
    if (p.sameTargets || !indexed) {
      // The GL-wide state: identical targets, or (without OES_draw_buffers_indexed) the group a split draw draws.
      if (targets.length) this.applyTarget(-1, targets[only ?? 0]);
      s.forget(S.colorMaskAt, 8);
      for (let i = 0; i < 8; i++) s.forgetBlend(i);
    } else {
      for (let i = 0; i < targets.length; i++) this.applyTarget(i, targets[i]);
      s.forget(S.colorMask);
      s.forgetBlend(-1);
    }
  }

  /** The blend and write mask of draw buffer `i` (-1: the GL-wide state) as target `x` asks. */
  private applyTarget(i: number, x: TargetGL): void {
    const gl = this.gl,
      s = this.device.state,
      indexed = i < 0 ? null : this.device.ext.indexed,
      m = x.mask;
    if (s.changed(i < 0 ? S.colorMask : S.colorMaskAt + i, 1, m)) {
      if (indexed) indexed.colorMaskiOES(i, !!(m & 1), !!(m & 2), !!(m & 4), !!(m & 8));
      else gl.colorMask(!!(m & 1), !!(m & 2), !!(m & 4), !!(m & 8));
    }
    if (!s.blendChanged(i, x.key)) return;
    if (!indexed) {
      if (x.blend) gl.enable(gl.BLEND);
      else gl.disable(gl.BLEND);
    } else if (x.blend) indexed.enableiOES(gl.BLEND, i);
    else indexed.disableiOES(gl.BLEND, i);
    if (!x.blend) return;
    if (!indexed) {
      gl.blendEquationSeparate(x.colorOp, x.alphaOp);
      gl.blendFuncSeparate(x.colorSrc, x.colorDst, x.alphaSrc, x.alphaDst);
    } else {
      indexed.blendEquationSeparateiOES(i, x.colorOp, x.alphaOp);
      indexed.blendFuncSeparateiOES(i, x.colorSrc, x.colorDst, x.alphaSrc, x.alphaDst);
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
    for (let k = 0; k < p.uniforms.length; k++) {
      const u = p.uniforms[k],
        bound = this.boundAt(pass, u.group, u.binding);
      if (!bound || bound.kind !== 'buffer' || !bound.buffer.gl) {
        device.validationError(`Draw: nothing usable is bound at @group(${u.group}) @binding(${u.binding})`);
        return false;
      }
      const buffer = bound.buffer;
      const start = bound.offset + this.dynamic,
        glSize = Math.max(16, Math.ceil(buffer.size / 16) * 16),
        bind = Math.min(Math.max(bound.size, u.size), glSize - start);
      if (bind < u.size) {
        device.validationError(
          `Draw: the buffer at @group(${u.group}) @binding(${u.binding}) is smaller than its uniform block`,
        );
        return false;
      }
      s.uniformBuffer(u.point, buffer.gl as WebGLBuffer, buffer.id, start, bind);
    }
    // Phase 1: what each unit will hold, with copies, resolves and uploads made now (kept in the replayer's plan arrays,
    // reused by every draw).
    this.rangeCount = 0;
    this.planned = 0;
    for (let k = 0; k < p.textures.length; k++) {
      const t = p.textures[k],
        found = this.boundAt(pass, t.group, t.binding);
      if (!found || found.kind !== 'view') {
        device.validationError(`Draw: no texture view is bound at @group(${t.group}) @binding(${t.binding})`);
        return false;
      }
      const view = found.view,
        tex = view.texture,
        stencil = tex.info.kind === 'stencil' || view.aspect === 'stencil-only';
      if (t.unit >= 0 && stencil && !device.ext.stencilTexturing)
        throw device.unsupported('sampling a stencil aspect (this WebGL2 has no WEBGL_stencil_texturing)');
      let sampler: WebGLSampler = device.loadSampler;
      if (t.sampler) {
        const samp = this.samplerAt(pass, t.sampler);
        if (!samp) return false;
        const unfilterable =
          (hasDepth(tex.info) && !samp.comparison) || tex.info.kind === 'uint' || tex.info.kind === 'sint';
        sampler = unfilterable ? samp.nearest() : samp.sampler;
        if (t.mipFilters.length) {
          const sd = samp.d,
            low = sd.lodMinClamp ?? 0,
            high = sd.lodMaxClamp ?? 32,
            enabled =
              !unfilterable &&
              sd.mipmapFilter === 'linear' &&
              (sd.minFilter === 'linear') === (sd.magFilter === 'linear') &&
              (sd.maxAnisotropy ?? 1) === 1 &&
              Number.isInteger(low) &&
              Number.isInteger(high),
            on = enabled ? 1 : 0;
          for (let m = 0; m < t.mipFilters.length; m++) {
            const loc = t.mipFilters[m];
            let held = p.cache.mips.get(loc);
            if (held && held[0] === on && held[1] === low && held[2] === high) continue;
            if (!held) p.cache.mips.set(loc, (held = new Float64Array(3)));
            held[0] = on;
            held[1] = low;
            held[2] = high;
            s.useProgram(p.program);
            gl.uniform3f(loc, on, low, high);
          }
        }
      }
      for (let m = 0; m < t.modes.length; m++) {
        const mode = t.modes[m],
          samp = this.samplerAt(pass, mode);
        if (!samp) return false;
        // A sampler's modes never change: the array itself says whether the uniform holds them.
        if (p.cache.modes.get(mode.location) !== samp.modes) {
          s.useProgram(p.program);
          gl.uniform4iv(mode.location, samp.modes);
          p.cache.modes.set(mode.location, samp.modes);
        }
      }
      let levels = view.mipLevelCount;
      if (t.unit < 0) {
        // Read for its size or level count only: nothing to bind.
      } else if (tex.renderbuffer) {
        levels = 1;
        this.plan(t.unit, gl.TEXTURE_2D, this.resolveForSampling(tex, stencil), sampler);
      } else {
        const range = levelRange(view.baseMipLevel, view.baseMipLevel + levels - 1),
          sampleState = range * 2 + (stencil ? 1 : 0);
        let storage = tex.sampled(view),
          alias = 1;
        // WebGPU lets a pass sample the depth texture it has attached read-only; GL calls that a feedback loop and refuses
        // the draw whatever the masks say, so the draw reads a copy that follows the attachment's depth.
        const attachment = pass.desc.depth?.view;
        if (attachment?.texture === tex && storage === tex.attached(attachment)) storage = tex.sampled(view, alias++);
        // GL keeps one base and max level per texture object: another range of a texture this draw already samples
        // (Bloom's last up step reads two levels of its down chain) reads a copy of its own.
        for (let held = this.rangeOf(storage); held >= 0 && held !== sampleState; held = this.rangeOf(storage))
          storage = tex.sampled(view, alias++);
        if (this.rangeOf(storage) < 0) {
          this.rangeStores[this.rangeCount] = storage;
          this.rangeStates[this.rangeCount++] = sampleState;
        }
        tex.read(storage, view.baseMipLevel, view.mipLevelCount, view.baseArrayLayer, view.arrayLayerCount, this.sync);
        if (storage.levels !== range) {
          s.scratch(storage.target, storage.gl);
          gl.texParameteri(storage.target, gl.TEXTURE_BASE_LEVEL, view.baseMipLevel);
          gl.texParameteri(storage.target, gl.TEXTURE_MAX_LEVEL, view.baseMipLevel + levels - 1);
          storage.levels = range;
        }
        this.plan(t.unit, storage.target, storage.gl, sampler);
      }
      // The sampling aspect belongs to the GL texture object, including resolved MSAA storage.
      // Restore depth on later draws; ordinary views use aliases above for simultaneous aspects.
      if (t.unit >= 0 && hasStencil(tex.info) && device.ext.stencilTexturing) {
        const ext = device.ext.stencilTexturing,
          last = this.planned - 1;
        s.scratch(this.planTargets[last], this.planTextures[last]);
        gl.texParameteri(
          this.planTargets[last],
          ext.DEPTH_STENCIL_TEXTURE_MODE_WEBGL,
          stencil ? ext.STENCIL_INDEX_WEBGL : gl.DEPTH_COMPONENT,
        );
      }
      if (t.sizes.length) {
        const level = tex.renderbuffer ? 0 : view.baseMipLevel,
          w = Math.max(1, tex.width >> level),
          h = Math.max(1, tex.height >> level),
          depth =
            tex.dimension === '3d'
              ? Math.max(1, tex.depthOrArrayLayers >> level)
              : tex.renderbuffer
                ? 1
                : view.arrayLayerCount;
        for (let m = 0; m < t.sizes.length; m++) {
          const loc = t.sizes[m];
          let held = p.cache.sizes.get(loc);
          if (held && held[0] === w && held[1] === h && held[2] === depth) continue;
          if (!held) p.cache.sizes.set(loc, (held = new Float64Array(3)));
          held[0] = w;
          held[1] = h;
          held[2] = depth;
          s.useProgram(p.program);
          gl.uniform4i(loc, w, h, depth, 0);
        }
      }
      for (let m = 0; m < t.levels.length; m++) {
        const loc = t.levels[m];
        if (p.cache.levels.get(loc) !== levels) {
          s.useProgram(p.program);
          gl.uniform1i(loc, levels);
          p.cache.levels.set(loc, levels);
        }
      }
    }
    for (let k = 0; k < p.storage.length; k++) {
      const b = p.storage[k];
      if (b.binding < 0) {
        // The bind group's shared data texture: every storage binding without a dynamic offset.
        const group = pass.groups[b.group]?.group,
          data = group?.storageTexture();
        if (!group || !data) {
          device.validationError(`Draw: no bind group with storage buffers is bound at @group(${b.group})`);
          return false;
        }
        for (let m = 0; m < b.info.length; m++) {
          const i = b.info[m],
            bound = group.entries.get(i.binding),
            row = data.rows.get(i.binding);
          if (bound?.kind !== 'buffer' || row === undefined) {
            device.validationError(`Draw: no storage buffer is bound at @group(${b.group}) @binding(${i.binding})`);
            return false;
          }
          this.storageInfo(p, i.location, row, bound.size, data.shift);
        }
        this.plan(b.unit, gl.TEXTURE_2D, data.texture, device.loadSampler);
        continue;
      }
      const found = this.boundAt(pass, b.group, b.binding);
      if (!found || found.kind !== 'buffer') {
        device.validationError(`Draw: no storage buffer is bound at @group(${b.group}) @binding(${b.binding})`);
        return false;
      }
      const dynamic = this.dynamic,
        data = found.buffer.dataTexture();
      if (!data) {
        device.validationError(
          `Draw: the buffer at @group(${b.group}) @binding(${b.binding}) has no GPU copy to read; give it STORAGE usage`,
        );
        return false;
      }
      this.plan(b.unit, gl.TEXTURE_2D, data.texture, device.loadSampler);
      for (let m = 0; m < b.info.length; m++)
        this.storageInfo(p, b.info[m].location, (found.offset + dynamic) >> 4, found.size, data.shift);
    }
    // Phase 2: bind the units.
    for (let k = 0; k < this.planned; k++)
      s.unit(this.planUnits[k], this.planTargets[k], this.planTextures[k], this.planSamplers[k]);
    return true;
  }

  /** Dynamic offset of the binding boundAt found last. */
  private dynamic = 0;
  /**
   * Storages a draw samples, with the level range and aspect each is set to (applyBindings), `rangeCount` long and
   * emptied per draw: arrays, since Map.clear() makes a new table, a hundred and more bytes a draw.
   */
  private readonly rangeStores: TextureStorage[] = [];
  private readonly rangeStates: number[] = [];
  private rangeCount = 0;
  /** The sample state rangeStores holds for `storage` this draw, -1 when the draw does not sample it yet. */
  private rangeOf(storage: TextureStorage): number {
    for (let i = 0; i < this.rangeCount; i++) if (this.rangeStores[i] === storage) return this.rangeStates[i];
    return -1;
  }
  /** What applyBindings binds to each unit, `planned` entries long. */
  private planned = 0;
  private readonly planUnits: number[] = [];
  private readonly planTargets: number[] = [];
  private readonly planTextures: (WebGLTexture | null)[] = [];
  private readonly planSamplers: WebGLSampler[] = [];

  /** Adds a unit's binding to the plan. */
  private plan(unit: number, target: number, texture: WebGLTexture | null, sampler: WebGLSampler): void {
    const k = this.planned++;
    this.planUnits[k] = unit;
    this.planTargets[k] = target;
    this.planTextures[k] = texture;
    this.planSamplers[k] = sampler;
  }

  /** What the pass binds at (group, binding), with its dynamic offset in `dynamic`; undefined for nothing. */
  private boundAt(pass: PassState, group: number, binding: number): Bound | undefined {
    const g = pass.groups[group],
      bound = g?.group?.entries.get(binding);
    if (!g?.group || !bound) return undefined;
    const di = g.group.layout.dynamic.indexOf(binding);
    this.dynamic = di >= 0 && di < g.count ? g.offsets[di] : 0;
    return bound;
  }

  private samplerAt(pass: PassState, at: { readonly group: number; readonly binding: number }): CompatSampler | null {
    const bound = this.boundAt(pass, at.group, at.binding);
    if (bound?.kind === 'sampler') return bound.sampler;
    this.device.validationError(`Draw: no sampler is bound at @group(${at.group}) @binding(${at.binding})`);
    return null;
  }

  /** Sets a storage buffer's row, size and shift uniform when they changed. */
  private storageInfo(
    p: CompatRenderPipeline,
    location: WebGLUniformLocation,
    row: number,
    size: number,
    shift: number,
  ): void {
    let held = p.cache.info.get(location);
    if (held && held[0] === row && held[1] === size && held[2] === shift) return;
    if (!held) p.cache.info.set(location, (held = new Float64Array(3)));
    held[0] = row;
    held[1] = size;
    held[2] = shift;
    this.device.state.useProgram(p.program);
    this.gl.uniform4i(location, row, size, shift, 0);
  }

  /** Points the VAO at the bound vertex buffers; `base` is the base vertex, `instance` the first instance. */
  private applyVertex(p: CompatRenderPipeline, pass: PassState, base: number, instance: number): boolean {
    const gl = this.gl,
      buffers = p.cache.pointerBuffers,
      offsets = p.cache.pointerOffsets;
    for (let i = 0; i < p.attributes.length; i++) {
      const a = p.attributes[i],
        vb = pass.vertex[a.slot],
        buffer = vb?.buffer;
      if (!vb || !buffer?.gl) {
        this.device.validationError(`Draw: no vertex buffer at slot ${a.slot}`);
        return false;
      }
      const offset = vb.offset + a.offset + (a.instance ? instance : base) * a.stride;
      if (offset < 0) throw this.device.unsupported('a negative base vertex below the start of a vertex buffer');
      if (buffers[i] === buffer.id && offsets[i] === offset) continue;
      buffers[i] = buffer.id;
      offsets[i] = offset;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer.gl);
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
    this.device.passes.draws++;
    const p = this.ready(0, firstInstance);
    if (!p) return;
    // Once, or once per target group of a split pipeline (see CompatRenderPipeline.splits), with no closure per draw.
    const groups = p.splits && this.pass ? p.splits.length : 1;
    for (let g = 0; g < groups; g++) {
      this.splitGroup(p, g);
      this.gl.drawArraysInstanced(p.mode, first, count, instances);
    }
    this.splitEnd(p);
  }

  /** Before draw `g` of a split pipeline (CompatRenderPipeline.splits): its group's draw buffers and target state. */
  private splitGroup(p: CompatRenderPipeline, g: number): void {
    const pass = this.pass;
    if (!p.splits || !pass) return;
    const gl = this.gl,
      group = p.splits[g],
      colors = pass.desc.colors,
      buffers = this.drawList;
    buffers.length = colors.length;
    for (let i = 0; i < colors.length; i++)
      buffers[i] = colors[i] && group.includes(i) ? gl.COLOR_ATTACHMENT0 + i : gl.NONE;
    gl.drawBuffers(buffers);
    this.applyTargets(p, group[0]);
  }

  /** After the draws of a split pipeline: every draw buffer back on. */
  private splitEnd(p: CompatRenderPipeline): void {
    const pass = this.pass;
    if (!p.splits || !pass) return;
    const gl = this.gl,
      colors = pass.desc.colors,
      buffers = this.drawList;
    buffers.length = colors.length;
    for (let i = 0; i < colors.length; i++) buffers[i] = colors[i] ? gl.COLOR_ATTACHMENT0 + i : gl.NONE;
    gl.drawBuffers(buffers);
    pass.applied = null;
  }

  /** A draw buffer list the replay fills and hands to drawBuffers (reused; GL copies it). */
  private readonly drawList: number[] = [];

  drawIndexed(count: number, instances: number, firstIndex: number, baseVertex: number, firstInstance: number): void {
    if (!count || !instances) return;
    this.device.passes.draws++;
    const index = this.pass?.index,
      buffer = index?.buffer;
    if (!index || !buffer?.element) {
      this.device.validationError('drawIndexed without an index buffer');
      return;
    }
    // Writes still waiting land in the element buffer first (a copyTextureToBuffer into it lands a task later). Before
    // ready(): landing one binds vertex array null to write the element buffer, which would undo the draw's vertex array.
    buffer.drain();
    const p = this.ready(baseVertex, firstInstance);
    if (!p) return;
    if (p.cache.element !== buffer.id) {
      // Unbind first: on Chromium (Metal, under load) a new index buffer bound to a vertex array that last held a
      // since-deleted index buffer kept drawing the deleted buffer's indices ("Vertex buffer is not big enough for
      // the draw call", sciviz glyphs drew nothing), and binding another buffer in between cleared it.
      // Raw GL replay also reproduces stale retired indices on ANGLE D3D11; detach preserves replacement bytes.
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, null);
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, buffer.element);
      p.cache.element = buffer.id;
    }
    const groups = p.splits && this.pass ? p.splits.length : 1;
    for (let g = 0; g < groups; g++) {
      this.splitGroup(p, g);
      this.gl.drawElementsInstanced(p.mode, count, index.type, index.offset + firstIndex * index.size, instances);
    }
    this.splitEnd(p);
  }

  // ------------------------------------------------ helper draws

  /** A full-target triangle program with this fragment shader body (compiled once per device). */
  /** @internal */
  helper(
    key: string,
    fragment: string,
    vertex = 'void main() { gl_Position = vec4(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0, 0.0, 1.0); }',
  ): Helper {
    let h = this.helpers.get(key);
    if (h) return h;
    const gl = this.gl,
      program = gl.createProgram() as WebGLProgram;
    for (const [type, source] of [
      [gl.VERTEX_SHADER, `#version 300 es\n${vertex}`],
      [gl.FRAGMENT_SHADER, `#version 300 es\nprecision highp float;\nprecision highp int;\n${fragment}`],
    ] as const) {
      const shader = gl.createShader(type) as WebGLShader;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    // On a lost context nothing links: that is the device's loss, never the layer's own program. Chrome answers the
    // link status a GPU reset waited for before isContextLost() turns true (KB-COMPAT-LOSSREPORT1), so a failure is an
    // internal error, which the device drops when the context is found lost a task later and reports otherwise. The
    // unlinked program is kept: its draws do nothing, and it is not linked and reported again at every use.
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      this.device.internalError(
        `The compatibility layer's own ${key} program did not link (a bug: report it): ${gl.getProgramInfoLog(program)}`,
      );
      h = { program, offset: null, value: null };
      this.helpers.set(key, h);
      return h;
    }
    this.device.state.useProgram(program);
    const texture = gl.getUniformLocation(program, 't'),
      second = gl.getUniformLocation(program, 'b');
    if (texture) gl.uniform1i(texture, 0);
    if (second) gl.uniform1i(second, 1);
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
    s.enable(gl.CULL_FACE, false);
    s.enable(gl.DEPTH_TEST, false);
    s.enable(gl.STENCIL_TEST, false);
    s.enable(gl.POLYGON_OFFSET_FILL, false);
    s.enable(gl.SAMPLE_ALPHA_TO_COVERAGE, false);
    s.enable(gl.SCISSOR_TEST, false);
    if (s.blendChanged(-1, 'off')) gl.disable(gl.BLEND);
    for (let i = 0; i < 8; i++) s.forgetBlend(i);
    s.viewport(0, 0, w, ht);
  }

  // ------------------------------------------------ copies

  /**
   * copyBuffer() while a buffer still waits for query results: the copy lands after them, in order with the other
   * writes. A method of its own, since a function that makes a closure allocates the closure's context on every call.
   */
  private copyBufferLater(
    src: CompatBuffer,
    srcOffset: number,
    dst: CompatBuffer,
    dstOffset: number,
    size: number,
  ): void {
    if (src.readbacks.length && !src.settle()) {
      // The source still waits for query results: the copy lands after them, in order with dst's other writes.
      dst.readbacks.push({
        forcible: false,
        ready: () => src.settle(),
        apply: () => dst.land(dstOffset, src.bytes().slice(srcOffset, srcOffset + size)),
      });
      return;
    }
    const bytes = src.bytes().slice(srcOffset, srcOffset + size);
    dst.readbacks.push({ forcible: true, ready: () => true, apply: () => dst.land(dstOffset, bytes) });
  }

  copyBuffer(src: CompatBuffer, srcOffset: number, dst: CompatBuffer, dstOffset: number, size: number): void {
    if (!size) return;
    const gl = this.gl;
    if ((src.readbacks.length && !src.settle()) || (dst.readbacks.length && !dst.settle())) {
      this.copyBufferLater(src, srcOffset, dst, dstOffset, size);
      return;
    }
    if (src.shadow && src.shadowValid) {
      dst.writeRange(dstOffset, src.shadow, srcOffset, size);
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
    const [sx, sy, sz] = origin(source.origin),
      [dx, dy, dz] = origin(destination.origin);
    this.copyTextures(
      source.texture,
      destination.texture,
      source.mipLevel ?? 0,
      sx,
      sy,
      sz,
      destination.mipLevel ?? 0,
      dx,
      dy,
      dz,
      w,
      h,
      depth,
    );
  }

  /** copyTextureToTexture() with its regions as numbers, the form a tape records (no arrays or option objects). */
  copyTextures(
    a: CompatTexture,
    b: CompatTexture,
    fromLevel: number,
    sx: number,
    sy: number,
    sz: number,
    toLevel: number,
    dx: number,
    dy: number,
    dz: number,
    w: number,
    h: number,
    depth: number,
  ): void {
    if (a.renderbuffer || b.renderbuffer) throw this.device.unsupported('copying a multisampled texture');
    if (a.format !== b.format && !twins(a.info, b.info))
      throw new TypeError(
        `copyTextureToTexture copies within one format or its sRGB twin (${a.format} to ${b.format}); use textures of matching formats`,
      );
    if (a.info.block) {
      // Blocks are copied as they are (WebGPU "copyTextureToTexture()"): read from the source's kept blocks and written
      // into the destination as a writeTexture would, so its sRGB twin and kept blocks follow.
      const block = a.info.block,
        across = Math.ceil(w / block.w) * block.bytes,
        down = Math.ceil(h / block.h),
        tight = new Uint8Array(across * down * depth);
      blocksOf(a, 'copyTextureToTexture').blockRegion(fromLevel, sx, sy, sz, w, h, depth, tight, false);
      const destination = { texture: b, mipLevel: toLevel, origin: [dx, dy, dz] };
      writeBlocks(this.device, b, destination, tight, { bytesPerRow: across, rowsPerImage: down }, [w, h, depth]);
      this.rebind();
      return;
    }
    if (!a.info.renderable)
      throw this.device.unsupported(
        `copying between ${a.format} textures (WebGL2 cannot attach the format to copy it)`,
      );
    const from = a.primary as TextureStorage,
      to = b.primary as TextureStorage;
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

/**
 * The source of a copy out of a block-compressed texture, which reads the blocks the texture keeps (CompatTexture.blocks);
 * WebGPU allows such a copy only from a texture made with COPY_SRC usage.
 */
export function blocksOf(t: CompatTexture, copy: string): CompatTexture {
  if (!t.blocks)
    throw new TypeError(
      `${copy} reads a texture made with GPUTextureUsage.COPY_SRC; '${t.label}' (${t.format}) was made without it`,
    );
  return t;
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
  const block = t.info.block as NonNullable<FormatInfo['block']>;
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
  // A copy of whole blocks may run past a mip level smaller than one block; GL takes the level's own size there.
  const lw = t.levelWidth(level),
    lh = t.levelHeight(level);
  const write: BlockWrite = { level, x, y, z, w: Math.min(w, lw - x), h: Math.min(h, lh - y), depth, bytes: tight };
  device.replayer.putBlocks(t.primary as TextureStorage, write);
  if (t.blocks) t.blockRegion(level, x, y, z, w, h, depth, tight, true);
  if (t.blockTwin) device.replayer.putBlocks(t.blockTwin, write);
  else if (t.blockWrites) {
    const covers = (a: BlockWrite, b: BlockWrite) =>
      a.level === b.level &&
      a.x <= b.x &&
      a.y <= b.y &&
      a.z <= b.z &&
      a.x + a.w >= b.x + b.w &&
      a.y + a.h >= b.y + b.h &&
      a.z + a.depth >= b.z + b.depth;
    t.blockWrites = t.blockWrites.filter((earlier) => !covers(write, earlier));
    t.blockWrites.push(write);
  }
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
  const image = source.source,
    sx = sourceX,
    sy = sourceY;
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
    if (!w || !h) return;
    if (!device.replayer.attachable(info))
      throw device.unsupported(`copying an ImageBitmap into a ${info.name} texture (it cannot be drawn into here)`);
    const level = destination.mipLevel ?? 0;
    beforeUpload(device, t, level, z, 1);
    device.replayer.copyBitmap(
      image,
      [sx, sy, w, h],
      !!source.flipY,
      t,
      level,
      [x, y, z],
      !!destination.premultipliedAlpha,
    );
    afterUpload(t, level, z, 1);
    return;
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
