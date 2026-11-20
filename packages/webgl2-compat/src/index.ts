// @margoengine/webgl2-compat, root entry: what a browser's WebGL2 offers and which compatibility tier that reaches
// (docs/webgl2-compat-roadmap.md, "Minimum tier"). Nothing runs at import time; the WGSL front end is a separate entry
// so an app that only probes never loads it. Written from the WebGL 2.0 and OpenGL ES 3.0 specifications.

/** @internal Stops one caller's wait without cancelling a module load or native adapter request owned by others. */
export async function waitFor<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return pending;
  let stop: () => void;
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', stop!);
  }
}

/**
 * The tier a WebGL2 context reaches.
 * - `full`: renderable float colour targets (`EXT_color_buffer_float`) and high precision in fragment shaders. The
 *   default minimum for `install()`.
 * - `half-float`: half-float targets only (`EXT_color_buffer_half_float`). The optional `/tiers` entry permits these.
 * - `ldr`: 8-bit targets only, or no high precision in fragment shaders. `/tiers` permits 8-bit targets; a context
 *   without highp fragment precision is still refused, since the layer runs WGSL f32 and integer arithmetic.
 */
export type CompatTier = 'full' | 'half-float' | 'ldr';

/** The extensions the layer looks for, by the name `getExtension` takes. */
export const COMPAT_EXTENSIONS = [
  'EXT_color_buffer_float',
  'EXT_color_buffer_half_float',
  'EXT_float_blend',
  'OES_texture_float_linear',
  'EXT_clip_control',
  'OES_draw_buffers_indexed',
  'WEBGL_draw_instanced_base_vertex_base_instance',
  'WEBGL_multi_draw',
  'KHR_parallel_shader_compile',
  'EXT_texture_filter_anisotropic',
  'EXT_texture_norm16',
  'EXT_depth_clamp',
  'EXT_polygon_offset_clamp',
  'WEBGL_compressed_texture_s3tc',
  'WEBGL_compressed_texture_s3tc_srgb',
  'EXT_texture_compression_bptc',
  'EXT_texture_compression_rgtc',
  'WEBGL_compressed_texture_etc',
  'WEBGL_compressed_texture_astc',
  'EXT_disjoint_timer_query_webgl2',
] as const;

/** One of {@link COMPAT_EXTENSIONS}. */
export type CompatExtension = (typeof COMPAT_EXTENSIONS)[number];

/** Extensions the `full` tier needs. A context without one of them is below the minimum. */
export const REQUIRED_EXTENSIONS: readonly CompatExtension[] = ['EXT_color_buffer_float'];

/** The WebGL2 limits the layer maps onto WebGPU limits, by the name of their `getParameter` enum. */
export const COMPAT_LIMITS = [
  'MAX_TEXTURE_SIZE',
  'MAX_3D_TEXTURE_SIZE',
  'MAX_ARRAY_TEXTURE_LAYERS',
  'MAX_CUBE_MAP_TEXTURE_SIZE',
  'MAX_RENDERBUFFER_SIZE',
  'MAX_TEXTURE_IMAGE_UNITS',
  'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
  'MAX_COMBINED_TEXTURE_IMAGE_UNITS',
  'MAX_UNIFORM_BUFFER_BINDINGS',
  'MAX_UNIFORM_BLOCK_SIZE',
  'MAX_VERTEX_UNIFORM_BLOCKS',
  'MAX_FRAGMENT_UNIFORM_BLOCKS',
  'UNIFORM_BUFFER_OFFSET_ALIGNMENT',
  'MAX_DRAW_BUFFERS',
  'MAX_COLOR_ATTACHMENTS',
  'MAX_SAMPLES',
  'MAX_VERTEX_ATTRIBS',
  'MAX_VARYING_COMPONENTS',
  'MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS',
  'MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS',
  'MAX_ELEMENT_INDEX',
] as const;

/** One of {@link COMPAT_LIMITS}. */
export type CompatLimit = (typeof COMPAT_LIMITS)[number];

/** What a WebGL2 context offers, as {@link webgl2Capabilities} reports it. */
export interface WebGL2Capabilities {
  /** The tier the context reaches; see {@link CompatTier}. */
  readonly tier: CompatTier;
  /** True when the tier is `full`: the compatibility layer can render on this context. */
  readonly supported: boolean;
  /** What keeps the context below `full`: extension names, or `highp-fragment`. Empty when supported. */
  readonly missing: readonly string[];
  /**
   * True when fragment shaders have 32-bit `highp` floats and ints. GLSL ES 3.00 (sections 4.1.3 and 4.5.1) requires
   * both; a context whose `HIGH_INT` report falls short of (31, 30) (Firefox on macOS reports 24, 24) is measured
   * instead: a fragment shader's 32-bit wrapping integer arithmetic must read back exact.
   */
  readonly highpFragment: boolean;
  /** Each extension in {@link COMPAT_EXTENSIONS}: true when `getExtension` returned it. */
  readonly extensions: Readonly<Record<CompatExtension, boolean>>;
  /** Each limit in {@link COMPAT_LIMITS}, as `getParameter` returned it. */
  readonly limits: Readonly<Record<CompatLimit, number>>;
  /** The unmasked renderer name where the browser offers it, else `getParameter(RENDERER)`; for reports. */
  readonly renderer: string;
  /** `getParameter(VERSION)`. */
  readonly version: string;
  /** `getParameter(SHADING_LANGUAGE_VERSION)`. */
  readonly shadingLanguageVersion: string;
}

/** The part of `WebGL2RenderingContext` the probe reads (a structural type, so a test can pass a stand-in). */
export interface WebGL2ProbeContext {
  getExtension(name: string): unknown;
  getParameter(pname: number): unknown;
  getShaderPrecisionFormat(
    shaderType: number,
    precisionType: number,
  ): { readonly precision: number; readonly rangeMin: number; readonly rangeMax: number } | null;
  readonly FRAGMENT_SHADER: number;
  readonly HIGH_FLOAT: number;
  readonly HIGH_INT: number;
  readonly RENDERER: number;
  readonly VERSION: number;
  readonly SHADING_LANGUAGE_VERSION: number;
}

/**
 * Reads what a WebGL2 context offers and the compatibility tier it reaches. Enabling an extension is what
 * `getExtension` does, so the context has every listed extension it supports enabled afterwards (the layer enables
 * them anyway). Pass the context the layer will render with; a context made with `antialias: false` is the one
 * exact-pixel rendering uses.
 * @param gl A WebGL2 context (or anything with its `getExtension`, `getParameter` and `getShaderPrecisionFormat`).
 * @returns The capabilities; {@link WebGL2Capabilities.supported} says whether the layer can render on it.
 */
export function webgl2Capabilities(gl: WebGL2ProbeContext): WebGL2Capabilities {
  if (typeof gl?.getExtension !== 'function' || typeof gl.getParameter !== 'function')
    throw new TypeError('webgl2Capabilities needs a WebGL2RenderingContext; pass canvas.getContext("webgl2")');
  const extensions = {} as Record<CompatExtension, boolean>;
  for (const name of COMPAT_EXTENSIONS) extensions[name] = gl.getExtension(name) != null;
  const limits = {} as Record<CompatLimit, number>;
  for (const name of COMPAT_LIMITS) {
    const pname = (gl as unknown as Record<string, unknown>)[name];
    const value = typeof pname === 'number' ? gl.getParameter(pname) : undefined;
    limits[name] = typeof value === 'number' ? value : 0;
  }
  const float = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT),
    int = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_INT),
    // highp: a 23-bit mantissa, and ints over [-2^31, 2^31) (reported as rangeMin 31, rangeMax 30). A short int report
    // is measured on the GPU where the context can draw: the ES 3.0 query is a report, the shading language the rule.
    reportedInt = (int?.rangeMin ?? 0) >= 31 && (int?.rangeMax ?? 0) >= 30,
    highpFragment =
      (float?.precision ?? 0) >= 23 &&
      (reportedInt ||
        (typeof (gl as Partial<HighpIntProbeContext>).createProgram === 'function' &&
          measureHighpInt(gl as unknown as HighpIntProbeContext)));
  const missing: string[] = REQUIRED_EXTENSIONS.filter((name) => !extensions[name]);
  if (!highpFragment) missing.push('highp-fragment');
  const tier: CompatTier = !missing.length
    ? 'full'
    : highpFragment && extensions.EXT_color_buffer_half_float
      ? 'half-float'
      : 'ldr';
  const text = (pname: number) => String(gl.getParameter(pname) ?? '');
  // RENDERER names the GPU in Firefox, which deprecates WEBGL_debug_renderer_info and warns when it is asked for; where
  // RENDERER is the masked 'WebKit WebGL' (Chromium, WebKit) the unmasked name comes from that extension instead.
  const plain = text(gl.RENDERER),
    unmasked =
      (!plain || plain === 'WebKit WebGL') && gl.getExtension('WEBGL_debug_renderer_info') != null ? text(0x9246) : '';
  return {
    tier,
    supported: tier === 'full',
    missing,
    highpFragment,
    extensions,
    limits,
    renderer: unmasked || plain,
    version: text(gl.VERSION),
    shadingLanguageVersion: text(gl.SHADING_LANGUAGE_VERSION),
  };
}

/** Options for {@link install}. */
export interface InstallOptions {
  /** Cancels this installation's waits before global changes. Default none; rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /** Lowest permitted device tier. Default `full`; `/tiers` opts into `ldr` and reports target substitutions. */
  readonly minimumTier?: CompatTier;
  /** Install even where WebGPU works (for testing the layer on a WebGPU browser). Default false. */
  readonly force?: boolean;
  /**
   * Makes each device's WebGL2 context. Default: a new `OffscreenCanvas` (or detached `<canvas>`) context with
   * `antialias: false`, so exact-pixel rendering stays exact.
   */
  readonly createContext?: (attributes: WebGLContextAttributes) => WebGL2RenderingContext | null;
  /**
   * The most work one compute dispatch may do on the CPU tier, in invocations plus loop iterations. Default
   * 100,000,000 (about one to three seconds of JavaScript). A dispatch that passes it stops, keeps memory as it was
   * and is reported as a `GPUInternalError` with code `failed`; raise it for long, legitimate CPU kernels, or set
   * `device.cpuWorkBudget` on one device.
   */
  readonly cpuWorkBudget?: number;
}

/** What {@link install} did. */
export interface InstallResult {
  /** True when the layer now answers `navigator.gpu` and `getContext('webgpu')`. */
  readonly installed: boolean;
  /** `installed`; `already` (an earlier call installed it); `webgpu` (the browser's own WebGPU works: nothing done). */
  readonly reason: 'installed' | 'already' | 'webgpu';
  /** The layer's `navigator.gpu`, when installed. */
  readonly gpu?: unknown;
}

let device: typeof import('./device.js') | undefined;

/**
 * Installs the WebGL2 compatibility layer: `navigator.gpu` becomes a WebGPU-shaped GPU on WebGL2, `getContext('webgpu')`
 * on canvases returns its canvas context, the `GPUBufferUsage`-style flag objects are defined where missing, and the
 * WebGPU interface names (`GPUBuffer`, `GPUDevice` and the rest) name the layer's classes while it is installed, so
 * `instanceof GPUBuffer` holds for its objects. Core and the packages then run their WebGPU code unchanged. Retains native WebGPU with a linked state warning where the browser's own WebGPU has an adapter,
 * unless `force` is set. The device, back end and WGSL front end load here, on first call, so a page that only probes
 * never downloads them.
 * @param options See {@link InstallOptions}.
 * @returns What was done; see {@link InstallResult}.
 * @throws MargoError code `unsupported` when WebGL2 is below `minimumTier` (default `full`) or lacks highp fragment
 *   precision. The optional `/tiers` entry opts into lower tiers and documents their target precision.
 */
export async function install(options: InstallOptions = {}): Promise<InstallResult> {
  options.signal?.throwIfAborted();
  device ??= await waitFor(import('./device.js'), options.signal);
  options.signal?.throwIfAborted();
  return device.installCompat(options);
}

/**
 * Removes what {@link install} put in place (`navigator.gpu`, the canvas `getContext` patch, the flag objects and the
 * interface names).
 * Devices made while it was installed keep working.
 * @returns True when the layer was installed.
 */
export function uninstall(): boolean {
  return device?.uninstallCompat() ?? false;
}

/** What {@link probeWebGL2} needs to make a context; `OffscreenCanvas` by default. */
export interface ProbeOptions {
  /** A canvas to make the probe context on. Default: a new 1 x 1 `OffscreenCanvas`, or a `<canvas>` without one. */
  readonly canvas?: { getContext(type: 'webgl2', options?: WebGLContextAttributes): unknown };
}

/**
 * Makes a throwaway WebGL2 context (`antialias: false`), reads its capabilities and releases it. Resolves `null`
 * when the browser has no WebGL2 at all.
 * @param options Where to make the context; see {@link ProbeOptions}.
 */
export function probeWebGL2(options: ProbeOptions = {}): WebGL2Capabilities | null {
  const canvas =
    options.canvas ??
    (typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(1, 1)
      : typeof document === 'object'
        ? document.createElement('canvas')
        : undefined);
  if (!canvas) throw new TypeError('probeWebGL2 found no OffscreenCanvas or document; pass {canvas} made in a browser');
  const gl = canvas.getContext('webgl2', { antialias: false, failIfMajorPerformanceCaveat: false }) as
    | (WebGL2ProbeContext & { getExtension(name: 'WEBGL_lose_context'): { loseContext(): void } | null })
    | null;
  if (!gl) return null;
  try {
    return webgl2Capabilities(gl);
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** The GL calls the highp int measurement makes (a structural type, so a test can pass a stand-in). */
interface HighpIntProbeContext {
  createShader(type: number): unknown;
  shaderSource(shader: unknown, source: string): void;
  compileShader(shader: unknown): void;
  createProgram(): unknown;
  attachShader(program: unknown, shader: unknown): void;
  linkProgram(program: unknown): void;
  getProgramParameter(program: unknown, pname: number): unknown;
  getUniformLocation(program: unknown, name: string): unknown;
  useProgram(program: unknown): void;
  uniform4ui(location: unknown, x: number, y: number, z: number, w: number): void;
  createTexture(): unknown;
  bindTexture(target: number, texture: unknown): void;
  texStorage2D(target: number, levels: number, format: number, width: number, height: number): void;
  createFramebuffer(): unknown;
  bindFramebuffer(target: number, framebuffer: unknown): void;
  framebufferTexture2D(target: number, attachment: number, textarget: number, texture: unknown, level: number): void;
  checkFramebufferStatus(target: number): number;
  createVertexArray(): unknown;
  bindVertexArray(array: unknown): void;
  bindBuffer(target: number, buffer: unknown): void;
  viewport(x: number, y: number, width: number, height: number): void;
  disable(cap: number): void;
  enable(cap: number): void;
  isEnabled(cap: number): boolean;
  colorMask(r: boolean, g: boolean, b: boolean, a: boolean): void;
  drawArrays(mode: number, first: number, count: number): void;
  readPixels(x: number, y: number, w: number, h: number, format: number, type: number, pixels: Uint32Array): void;
  getParameter(pname: number): unknown;
  deleteShader(shader: unknown): void;
  deleteProgram(program: unknown): void;
  deleteTexture(texture: unknown): void;
  deleteFramebuffer(framebuffer: unknown): void;
  deleteVertexArray(array: unknown): void;
}

// The inputs: a 32-bit odd constant, a signed value near -2^31, and two shift amounts, passed as uniforms so the
// compiler cannot fold the arithmetic.
const INPUT = [0x9e3779b9, 0x80000001, 16, 7] as const;
const FRAGMENT = `#version 300 es
precision highp float;precision highp int;uniform highp uvec4 u;layout(location=0) out highp uvec4 o;
void main(){uint a=u.x;int s=int(u.y);o=uvec4(a*0x85EBCA6Bu,(a^(a>>u.z))+0xFFFFFFF0u,uint(s*3),uint(s>>1)^uint(s/int(u.w)));}`;
const VERTEX = '#version 300 es\nvoid main(){gl_PointSize=1.0;gl_Position=vec4(0,0,0,1);}';

/** What GLSL ES 3.00 section 4.1.3 makes the probe shader write: 32-bit two's complement, wrapping. */
function expectedHighpInt(): [number, number, number, number] {
  const [a, y, z, w] = INPUT,
    s = y | 0;
  return [
    Math.imul(a, 0x85ebca6b) >>> 0,
    (((a ^ (a >>> z)) >>> 0) + 0xfffffff0) >>> 0,
    Math.imul(s, 3) >>> 0,
    ((s >> 1) ^ Math.trunc(s / w)) >>> 0,
  ];
}

/**
 * Measures 32-bit highp int arithmetic in a fragment shader: one pixel of an RGBA32UI target, read back and
 * compared with `expectedHighpInt`. Leaves the context's bindings and state as it found them.
 * @returns True when every word matches.
 */
function measureHighpInt(gl: HighpIntProbeContext): boolean {
  const C = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    LINK_STATUS: 0x8b82,
    TEXTURE_2D: 0x0de1,
    RGBA32UI: 0x8d70,
    FRAMEBUFFER: 0x8d40,
    DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
    READ_FRAMEBUFFER_BINDING: 0x8caa,
    DRAW_FRAMEBUFFER: 0x8ca9,
    READ_FRAMEBUFFER: 0x8ca8,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    CURRENT_PROGRAM: 0x8b8d,
    VERTEX_ARRAY_BINDING: 0x85b5,
    TEXTURE_BINDING_2D: 0x8069,
    PIXEL_PACK_BUFFER: 0x88eb,
    PIXEL_PACK_BUFFER_BINDING: 0x88ed,
    VIEWPORT: 0x0ba2,
    COLOR_WRITEMASK: 0x0c23,
    SCISSOR_TEST: 0x0c11,
    RASTERIZER_DISCARD: 0x8c89,
    POINTS: 0,
    RGBA_INTEGER: 0x8d99,
    UNSIGNED_INT: 0x1405,
  };
  const saved = {
    draw: gl.getParameter(C.DRAW_FRAMEBUFFER_BINDING),
    read: gl.getParameter(C.READ_FRAMEBUFFER_BINDING),
    program: gl.getParameter(C.CURRENT_PROGRAM),
    vao: gl.getParameter(C.VERTEX_ARRAY_BINDING),
    texture: gl.getParameter(C.TEXTURE_BINDING_2D),
    pack: gl.getParameter(C.PIXEL_PACK_BUFFER_BINDING),
    viewport: gl.getParameter(C.VIEWPORT) as ArrayLike<number>,
    mask: gl.getParameter(C.COLOR_WRITEMASK) as ArrayLike<boolean>,
    scissor: gl.isEnabled(C.SCISSOR_TEST),
    discard: gl.isEnabled(C.RASTERIZER_DISCARD),
  };
  const vs = gl.createShader(C.VERTEX_SHADER),
    fs = gl.createShader(C.FRAGMENT_SHADER),
    program = gl.createProgram(),
    texture = gl.createTexture(),
    framebuffer = gl.createFramebuffer(),
    vao = gl.createVertexArray();
  try {
    gl.shaderSource(vs, VERTEX);
    gl.shaderSource(fs, FRAGMENT);
    gl.compileShader(vs);
    gl.compileShader(fs);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, C.LINK_STATUS)) return false;
    gl.bindTexture(C.TEXTURE_2D, texture);
    gl.texStorage2D(C.TEXTURE_2D, 1, C.RGBA32UI, 1, 1);
    gl.bindFramebuffer(C.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(C.FRAMEBUFFER, C.COLOR_ATTACHMENT0, C.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(C.FRAMEBUFFER) !== C.FRAMEBUFFER_COMPLETE) return false;
    gl.useProgram(program);
    gl.uniform4ui(gl.getUniformLocation(program, 'u'), ...INPUT);
    gl.bindVertexArray(vao);
    gl.bindBuffer(C.PIXEL_PACK_BUFFER, null);
    gl.viewport(0, 0, 1, 1);
    gl.colorMask(true, true, true, true);
    gl.disable(C.SCISSOR_TEST);
    gl.disable(C.RASTERIZER_DISCARD);
    gl.drawArrays(C.POINTS, 0, 1);
    const pixel = new Uint32Array(4);
    gl.readPixels(0, 0, 1, 1, C.RGBA_INTEGER, C.UNSIGNED_INT, pixel);
    return expectedHighpInt().every((word, i) => pixel[i] === word);
  } finally {
    gl.bindFramebuffer(C.DRAW_FRAMEBUFFER, saved.draw);
    gl.bindFramebuffer(C.READ_FRAMEBUFFER, saved.read);
    gl.useProgram(saved.program);
    gl.bindVertexArray(saved.vao);
    gl.bindTexture(C.TEXTURE_2D, saved.texture);
    gl.bindBuffer(C.PIXEL_PACK_BUFFER, saved.pack);
    gl.viewport(saved.viewport[0], saved.viewport[1], saved.viewport[2], saved.viewport[3]);
    gl.colorMask(saved.mask[0], saved.mask[1], saved.mask[2], saved.mask[3]);
    if (saved.scissor) gl.enable(C.SCISSOR_TEST);
    if (saved.discard) gl.enable(C.RASTERIZER_DISCARD);
    gl.deleteVertexArray(vao);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
  }
}
