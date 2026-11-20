import type { EngineKernel, Scene } from '@margoengine/core';
import { fault } from '../../shared/errors.js';
import { createCustomTransition, type CustomTransitionOptions } from './custom.js';
import { LiveTransitions, type LiveTransitionOptions } from './live.js';
import type { Transitions } from './index.js';
import { GLSLParser, GLSLEmitter, preprocessGLSL, type GLSLHost, type GLSLSourceInfo } from './glsl-front.js';
/** A scalar or flattened vector, column-major matrix or fixed array uniform value. */
export type GLSLUniformValue = number | boolean | readonly (number | boolean)[];
/** The transition contract around the shared GLSL front end: progress, ratio, from/to samplers, getFromColor/getToColor. */
const transitionHost = (uniforms: Readonly<Record<string, GLSLUniformValue>>, flipY: boolean): GLSLHost => ({
  uniforms,
  flipY,
  names: {
    progress: { code: 'settings.x', type: 'float' },
    ratio: { code: '(f32(textureDimensions(after).x)/f32(textureDimensions(after).y))', type: 'float' },
    from: { code: 'before', type: 'sampler2D' },
    to: { code: 'after', type: 'sampler2D' },
    gl_FragCoord: { code: 'user_frag_coord', type: 'vec4' },
  },
  colorReaders: { getFromColor: 'before', getToColor: 'after' },
  prologue: 'var<private> user_frag_coord:vec4f;',
  entry: { name: 'transition', type: 'vec4', params: ['vec2'] },
  missingEntry: 'Supply vec4 transition(vec2 uv)',
  epilogue: (entry) =>
    [
      'fn transition(a:texture_2d<f32>,b:texture_2d<f32>,uv:vec2f,p:f32)->vec4f{',
      'user_frag_coord=vec4f(uv.x*f32(textureDimensions(after).x),(1.0-uv.y)*f32(textureDimensions(after).y),0.0,1.0);',
      `return ${entry}(${flipY ? 'vec2f(uv.x,1.0-uv.y)' : 'uv'});`,
      '}',
    ].join('\n'),
});
/** Values and coordinate convention for importing a GLSL transition. */
export interface GLSLTransitionOptions {
  /** Additional uniform values, snapshotted into WGSL constants. Default values come from // = JSON annotations. */
  uniforms?: Readonly<Record<string, GLSLUniformValue>>;
  /** GLSL UVs use bottom-left origin by default; false preserves the custom entry's top-left origin. Default true. */
  flipY?: boolean;
}
/**
 * Translates trusted GLSL ES 1.00 or 3.00 (`#version 300 es`) containing vec4 transition(vec2 uv) to the custom WGSL function contract.
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
  const info: GLSLSourceInfo = { version: 100 };
  const program = new GLSLParser(preprocessGLSL(source, info)).parse();
  return new GLSLEmitter(program, transitionHost(uniforms, options.flipY ?? true), info.version).emit();
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
