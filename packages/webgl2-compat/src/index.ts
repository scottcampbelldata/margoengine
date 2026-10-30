// @margoengine/webgl2-compat, root entry: what a browser's WebGL2 offers and which compatibility tier that reaches
// (docs/webgl2-compat-roadmap.md, "Minimum tier"). Nothing runs at import time; the WGSL front end is a separate entry
// so an app that only probes never loads it. Written from the WebGL 2.0 and OpenGL ES 3.0 specifications.

/**
 * The tier a WebGL2 context reaches.
 * - `full`: renderable float colour targets (`EXT_color_buffer_float`) and high precision in fragment shaders. The
 *   only tier the compatibility layer renders on.
 * - `half-float`: half-float targets only (`EXT_color_buffer_half_float`). Below the minimum: use the
 *   `@margoengine/webgl` preview on these devices.
 * - `ldr`: 8-bit targets only, or no high precision in fragment shaders. Below the minimum, as above.
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
  /** True when fragment shaders have 32-bit `highp` floats and ints (GLSL ES 3.00 makes it optional). */
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
    // highp: a 23-bit mantissa, and ints over [-2^31, 2^31) (reported as rangeMin 31, rangeMax 30).
    highpFragment = (float?.precision ?? 0) >= 23 && (int?.rangeMin ?? 0) >= 31 && (int?.rangeMax ?? 0) >= 30;
  const missing: string[] = REQUIRED_EXTENSIONS.filter((name) => !extensions[name]);
  if (!highpFragment) missing.push('highp-fragment');
  const tier: CompatTier = !missing.length
    ? 'full'
    : highpFragment && extensions.EXT_color_buffer_half_float
      ? 'half-float'
      : 'ldr';
  const text = (pname: number) => String(gl.getParameter(pname) ?? '');
  // The unmasked name where the browser still offers it (WEBGL_debug_renderer_info, UNMASKED_RENDERER_WEBGL).
  const unmasked = gl.getExtension('WEBGL_debug_renderer_info') != null ? text(0x9246) : '';
  return {
    tier,
    supported: tier === 'full',
    missing,
    highpFragment,
    extensions,
    limits,
    renderer: unmasked || text(gl.RENDERER),
    version: text(gl.VERSION),
    shadingLanguageVersion: text(gl.SHADING_LANGUAGE_VERSION),
  };
}

/** Options for {@link install}. */
export interface InstallOptions {
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
 * `instanceof GPUBuffer` holds for its objects. Core and the packages then run their WebGPU code unchanged. Does nothing where the browser's own WebGPU has an adapter,
 * unless `force` is set. The device, back end and WGSL front end load here, on first call, so a page that only probes
 * never downloads them.
 * @param options See {@link InstallOptions}.
 * @returns What was done; see {@link InstallResult}.
 * @throws MargoError code `unsupported` when the browser has no WebGL2 at the `full` tier (the message names what is
 *   missing); keep the `@margoengine/webgl` preview for those browsers.
 */
export async function install(options: InstallOptions = {}): Promise<InstallResult> {
  device ??= await import('./device.js');
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
