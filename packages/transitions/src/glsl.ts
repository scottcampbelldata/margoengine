import type { EngineKernel, Scene } from '@margoengine/core';
import { fault } from '../../shared/errors.js';
import { createCustomTransition, type CustomTransitionOptions } from './custom.js';
import { LiveTransitions, type LiveTransitionOptions } from './live.js';
import type { Transitions } from './index.js';
import { GLSLParser } from './glsl-parser.js';
import { GLSLEmitter } from './glsl-emit.js';
import { preprocessGLSL } from './glsl-preprocess.js';
/** A scalar or flattened vector, column-major matrix or fixed array uniform value. */
export type GLSLUniformValue = number | boolean | readonly (number | boolean)[];
/** Values and coordinate convention for importing a GLSL transition. */
export interface GLSLTransitionOptions {
  /** Additional uniform values, snapshotted into WGSL constants. Default values come from // = JSON annotations. */
  uniforms?: Readonly<Record<string, GLSLUniformValue>>;
  /** GLSL UVs use bottom-left origin by default; false preserves the custom entry's top-left origin. Default true. */
  flipY?: boolean;
}
/**
 * Translates trusted GLSL ES 1.00 containing vec4 transition(vec2 uv) to the custom WGSL function contract.
 * Exposes progress, ratio, getFromColor/getToColor, and from/to sampler2D aliases. No external shader assets are bundled.
 * Syntax/type diagnostics carry code failed; asynchronous factory compilation validates the emitted WGSL before attachment.
 */
export function translateGLSLTransition(source: string, options: GLSLTransitionOptions = {}): string {
  if (typeof source !== 'string' || !source.trim() || source.length > 65536)
    throw new TypeError('GLSL transition needs 1..65536 source code units; supply vec4 transition(vec2 uv)');
  if (options.flipY !== undefined && typeof options.flipY !== 'boolean')
    throw new TypeError('GLSL flipY must be boolean; choose true for bottom-left GLSL coordinates');
  const uniforms: Record<string, GLSLUniformValue> = {};
  for (const m of source.matchAll(
    /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)\s*;[^\n]*?\/\/\s*=\s*([^\n]+)/g,
  )) {
    try {
      uniforms[m[1]!] = JSON.parse(m[2]!);
    } catch {
      throw fault('failed', `GLSL default for ${m[1]} is not JSON; correct its // = annotation`);
    }
  }
  Object.assign(uniforms, options.uniforms);
  const program = new GLSLParser(preprocessGLSL(source)).parse();
  return new GLSLEmitter(program, uniforms, options.flipY ?? true).emit();
}
/** Compiles and attaches a frozen GLSL transition. Call start('wipe',seconds); supplied GLSL controls the treatment. */
export async function createGLSLTransition(
  engine: EngineKernel,
  source: string,
  options: GLSLTransitionOptions & CustomTransitionOptions = {},
): Promise<Transitions> {
  options.signal?.throwIfAborted();
  return createCustomTransition(engine, translateGLSLTransition(source, options), options);
}
/** Compiles and attaches a GLSL transition between borrowed live scenes and cameras. */
export async function createLiveGLSLTransition(
  engine: EngineKernel,
  before: Scene,
  after: Scene,
  source: string,
  options: GLSLTransitionOptions &
    Pick<LiveTransitionOptions, 'beforeCamera' | 'afterCamera'> &
    CustomTransitionOptions = {},
): Promise<LiveTransitions> {
  options.signal?.throwIfAborted();
  return LiveTransitions.custom(engine, before, after, translateGLSLTransition(source, options), options);
}
