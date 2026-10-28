// @margoengine/webgl2-compat/glsl: the GLSL ES 3.00 back end of the compatibility layer (roadmap milestone M2). It
// translates the vertex and fragment entry points of checked WGSL into a WebGL2 program and the table the device
// binds resources by. Written clean room from the W3C WGSL and Khronos GLSL ES 3.00 specifications. Nothing runs at
// import time; the root entry never imports this one.
import { checkWGSL } from './wgsl.js';
import { emitStage, type GLSLStage } from './glsl/emit.js';
import type { IRModule } from './wgsl/ir.js';

/** The WGSL front end's types, under the names its own entry gives them (the IR this entry's types refer to). */
export type * from './wgsl.js';
export type {
  GLSLKind,
  GLSLLocation,
  GLSLStage,
  GLSLStorage,
  GLSLTexture,
  GLSLUniform,
  GLSLVarying,
} from './glsl/emit.js';
export { encodeName as glslName, floatLiteral as glslFloat } from './glsl/emit.js';

/** One stage of a pipeline to translate: a module (source or checked IR) and its entry point. */
export interface TranslateStage {
  /** WGSL source; checked here. Pass `module` instead to reuse a checked module. */
  readonly source?: string;
  /** A module from `checkWGSL`. */
  readonly module?: IRModule;
  /** Entry point name. Default: the module's only entry point of the stage. */
  readonly entryPoint?: string;
  /** Pipeline-overridable constants by name or `@id`, as in WebGPU's `GPUProgrammableStage.constants`. */
  readonly constants?: Readonly<Record<string, number | boolean>>;
}

/** What {@link translateWGSL} translates. */
export interface TranslateOptions {
  /** The vertex stage (required). */
  readonly vertex: TranslateStage;
  /** The fragment stage. Without one, the program gets an empty fragment shader (depth-only drawing). */
  readonly fragment?: TranslateStage;
  /**
   * The context has EXT_clip_control set to ZERO_TO_ONE, so clip-space z stays in [0, w] as in WebGPU. Default true;
   * false maps z to [-w, w] at the end of the vertex shader (lower depth precision).
   */
  readonly clipControl?: boolean;
  /** The pipeline draws points (`point-list`): the vertex shader writes `gl_PointSize = 1.0`. Default false. */
  readonly points?: boolean;
  /**
   * Which storage buffers read from their bind group's shared data texture (one texture unit per bind group; the
   * device uses it for every storage binding without a dynamic offset). Default: none, one texture per buffer.
   */
  readonly sharedStorage?: (group: number, binding: number) => boolean;
}

/** A translated pipeline: GLSL ES 3.00 sources and what each stage binds. */
export interface GLSLProgram {
  readonly vertex: GLSLStage;
  readonly fragment: GLSLStage;
}

const EMPTY_FRAGMENT: GLSLStage = {
  stage: 'fragment',
  source: '#version 300 es\nprecision highp float;\nvoid main() {}\n',
  uniforms: [],
  textures: [],
  storage: [],
  inputs: [],
  outputs: [],
  varyings: [],
  fragDepth: false,
  notes: [],
};

function entry(stage: TranslateStage, kind: 'vertex' | 'fragment') {
  const module = stage.module ?? (typeof stage.source === 'string' ? checkWGSL(stage.source) : undefined);
  if (!module) throw new TypeError(`translateWGSL needs the ${kind} stage's WGSL source or checked module`);
  const candidates = module.entryPoints.filter((e) => e.stage === kind);
  const found =
    stage.entryPoint === undefined
      ? candidates.length === 1
        ? candidates[0]
        : undefined
      : candidates.find((e) => e.name === stage.entryPoint);
  if (!found)
    throw new TypeError(
      stage.entryPoint === undefined
        ? `The module has ${candidates.length} ${kind} entry points; name one with entryPoint`
        : `The module has no ${kind} entry point '${stage.entryPoint}'; pass the name of one it declares`,
    );
  return { module, entry: found };
}

/**
 * Translates one vertex or fragment entry point alone, for checking a shader without its pipeline: a vertex stage
 * writes every varying it declares, and a fragment stage's varyings are not matched to a vertex stage.
 * @param stage The module and entry point.
 * @param kind Which stage the entry point is.
 * @param options `clipControl` and `points`, as for {@link translateWGSL}.
 * @returns The stage's GLSL source and binding table.
 * @throws As {@link translateWGSL}.
 */
export function translateStage(
  stage: TranslateStage,
  kind: 'vertex' | 'fragment',
  options: Pick<TranslateOptions, 'clipControl' | 'points'> = {},
): GLSLStage {
  if (kind !== 'vertex' && kind !== 'fragment') throw new TypeError("translateStage needs kind 'vertex' or 'fragment'");
  const s = entry(stage, kind);
  return emitStage(s.module, s.entry, {
    clipControl: options.clipControl ?? true,
    points: options.points ?? false,
    constants: stage.constants,
    prefix: kind === 'vertex' ? 'v' : 'f',
  });
}

/**
 * Translates a render pipeline's WGSL stages to GLSL ES 3.00 for WebGL2.
 * @param options The vertex stage, the optional fragment stage, and how the context is set up.
 * @returns Both shader sources and, per stage, the uniform blocks, combined samplers, vertex inputs, varyings and
 *   fragment outputs the device binds.
 * @throws {WGSLError} when a source does not check. MargoError code `unsupported` for WGSL WebGL2 cannot run yet
 *   (storage writes, storage textures, atomics, cube gathers, cube arrays). TypeError for a missing or ambiguous entry
 *   point.
 */
export function translateWGSL(options: TranslateOptions): GLSLProgram {
  if (!options?.vertex) throw new TypeError('translateWGSL needs a vertex stage: { vertex: { source } }');
  const common = {
    clipControl: options.clipControl ?? true,
    points: options.points ?? false,
    sharedStorage: options.sharedStorage,
  };
  let fragment = EMPTY_FRAGMENT;
  if (options.fragment) {
    const f = entry(options.fragment, 'fragment');
    fragment = emitStage(f.module, f.entry, { ...common, constants: options.fragment.constants, prefix: 'f' });
  }
  const v = entry(options.vertex, 'vertex');
  const vertex = emitStage(v.module, v.entry, {
    ...common,
    constants: options.vertex.constants,
    prefix: 'v',
    varyingsRead: options.fragment ? new Set(fragment.varyings.map((x) => x.location)) : undefined,
  });
  for (const read of fragment.varyings) {
    const written = vertex.varyings.find((x) => x.location === read.location);
    if (!written)
      throw new TypeError(
        `The fragment stage reads @location(${read.location}), which the vertex stage does not write; write it there`,
      );
    if (written.glslType !== read.glslType || written.interpolation !== read.interpolation)
      throw new TypeError(
        `@location(${read.location}) is ${written.glslType} (${written.interpolation}) out of the vertex stage but ${read.glslType} (${read.interpolation}) into the fragment stage; declare the same type and interpolation in both`,
      );
  }
  return { vertex, fragment };
}
