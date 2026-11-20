// Whole GLSL programs: a vertex and a fragment stage with `main`, linked by name and translated by the shared GLSL
// front end into the WGSL a RawShaderMaterial draws. Written clean room from The OpenGL ES Shading Language 1.00.17 and
// 3.00.6 (storage qualifiers 4.3, built-in variables 7, linking), the OpenGL ES 3.0 specification (window coordinates,
// depth range) and the W3C WGSL and WebGPU specifications (built-in values, interstage variables, coordinate systems).
import { fault } from '../../../shared/errors.js';
import { GLSLParser, type Declaration, type Program } from './parser.js';
import { GLSLEmitter } from './emit.js';
import { preprocessGLSL, type GLSLSourceInfo } from './preprocess.js';
import type { GLSLHost, GLSLHostName, GLSLSampleOptions } from './host.js';
import { presets, presetNames, semantics, type GLSLAttributeSemantic, type GLSLBuiltins, type GLSLPreset } from './presets.js';
export type { GLSLAttributeSemantic, GLSLBuiltins } from './presets.js';

/** The two stages of a GLSL program. */
export type GLSLStage = 'vertex' | 'fragment';
/** What {@link linkGLSLProgram} translates. */
export interface GLSLProgramSource {
  /** GLSL ES 1.00 or 3.00 with `void main()`. */
  readonly vertexShader: string;
  /** GLSL ES 1.00 or 3.00 with `void main()`. */
  readonly fragmentShader: string;
  /** Object-like macros defined before each stage, as `#define NAME value` lines. Default none. */
  readonly defines?: Readonly<Record<string, string | number | boolean>>;
  /** The version of a stage without `#version`. Default 100 (GLSL ES 1.00), as GL reads such a source. */
  readonly glslVersion?: 100 | 300;
  /** Flip v at every 2D texture lookup and texel fetch, so GL's bottom-up texture rows read Margo's top-down images upright. Default true. */
  readonly flipY?: boolean;
  /** `'gl'`: gl_Position is GL clip space (z from -w to w) and gl_FragCoord counts rows from the bottom. Default `'gl'`. */
  readonly clipSpace?: 'gl' | 'webgpu';
  /** Keep WGSL's derivative uniformity rule. Default false. */
  readonly strict?: boolean;
  /**
   * The engine values a program may read under a web convention's names, named by that convention's signature uniform:
   * `'modelViewMatrix'`, `'worldViewProjection'` or `'matrix_model'` (the tables are in the README). `'auto'` picks the
   * one whose names the program uses and refuses a program that uses two; `false` supplies none (declare every
   * uniform and attribute yourself). Default `'auto'`.
   */
  readonly builtins?: GLSLBuiltins;
  /** Uniform names you set yourself: a built-in name listed here is your uniform, not the engine's. Default none. */
  readonly uniformNames?: readonly string[];
  /** What each attribute holds, by GLSL name (`{aPosition: 'position'}`), for `shaderMesh`. Names of the built-ins map by themselves. */
  readonly attributes?: Readonly<Record<string, GLSLAttributeSemantic>>;
  /** Values an attribute the mesh lacks reads, by GLSL name. Default GL's (0, 0, 0, 1), or the convention's own. */
  readonly defaultAttributeValues?: Readonly<Record<string, readonly number[]>>;
  /** Text of each `#include <name>` (or `"name"`) the stages use; `colorspace_fragment` and `tonemapping_fragment` are built in. */
  readonly includes?: Readonly<Record<string, string>>;
  /**
   * What the fragment stage writes: `'srgb'`, display-ready colour (written as returned on a display target, decoded to
   * linear inside an HDR capture), or `'linear'`, linear light that the scene's display transform then maps. A
   * program with `#include <colorspace_fragment>` writes for its target itself. Default `'srgb'`.
   */
  readonly outputColorSpace?: 'srgb' | 'linear';
  /**
   * sampler2D uniforms whose texture the device cannot filter (`rgba32float` without `float32-filterable`), with the
   * filter and wrap GL would apply: each binds as an `unfilterable-float` texture, and its `texture()` lookups read
   * texels with `textureLoad` and filter them as OpenGL ES 3.0.6 section 3.8.10 defines (four loads a level). Default none.
   */
  readonly unfilterable?: Readonly<Record<string, GLSLTexelFilter>>;
  /**
   * The scene's lights as uniforms the program may declare: `sunDirection`, `sunColor`, `ambientLight`, and the lists
   * `pointLights[N]` and `spotLights[N]` (arrays of a struct you declare with any of their fields) with
   * `pointLightCount` and `spotLightCount`. Default false: those names are ordinary uniforms.
   */
  readonly lights?: boolean;
  /** The scene's fog as uniforms: `fogColor`, `fogNear`, `fogFar`, `fogDensity`, `fogHeight`, `fogHeightFalloff`. Default false. */
  readonly fog?: boolean;
  /**
   * Motion vectors for TAA from the vertex stage itself: `true` runs it a second time with last frame's world matrix,
   * view-projection and time, so TAA sees where each vertex was. An object also names, per uniform the motion reads,
   * the uniform that holds its value of last frame (`{shift: 'shiftBefore'}`); those are scalars, vectors or
   * matrices, and the second ones need no declaration. Default false.
   */
  readonly velocity?: boolean | Readonly<Record<string, string>>;
}
/** How `unfilterable` filters a texture: `'mipmap'` is GL's LINEAR_MIPMAP_LINEAR, `'linear'` reads level 0. */
export interface GLSLTexelFilter {
  readonly filter: 'nearest' | 'linear' | 'mipmap';
  readonly wrap: 'clamp' | 'repeat';
}
/**
 * A non-sampler uniform of a linked program and the uniform-block member that holds it. A struct, a block instance or
 * an array of anything but vec3, vec4, mat3, mat4 and their integer vectors is listed one member per leaf, under the
 * name GL gives it (`lights[0].color`), with `root` and `path` saying where its value sits.
 */
export interface GLSLProgramUniform {
  readonly name: string;
  /** Its GLSL type, as declared (an array as `vec4[8]`). */
  readonly glsl: string;
  /** The RawShaderMaterial uniform type that stores it (a bool as u32, a mat2 as vec4f, a non-square matrix as mat4x4f). */
  readonly type: string;
  /** The member's name in `uniforms`. */
  readonly member: string;
  /** Elements of an array member (`uniforms.<member>[i]`). */
  readonly count?: number;
  /** For a leaf: the uniform whose value holds it. */
  readonly root?: string;
  /** For a leaf: field names and `[element, numbers per element in a flat list]` steps from the root's value to it. */
  readonly path?: readonly (string | readonly [number, number])[];
}
/** A sampler uniform of a linked program and the RawShaderMaterial texture that binds it. */
export interface GLSLProgramTexture {
  /** The GLSL name; an element of a sampler array is `maps[1]`. */
  readonly name: string;
  readonly glsl: string;
  readonly dimension: '2d' | 'cube' | '3d' | '2d-array';
  /** `'sint'` or `'uint'` for an integer sampler, `'depth'` for a shadow sampler, `'unfilterable-float'` for one in `unfilterable`; absent for a float one. */
  readonly sampleType?: 'sint' | 'uint' | 'depth' | 'unfilterable-float';
  /** For an element of a sampler array: the array's name and the element's index in its value. */
  readonly root?: string;
  readonly index?: number;
  /** The texture's name in WGSL; its sampler is this name plus `Sampler`. */
  readonly binding: string;
}
/** A vertex input of a linked program. */
export interface GLSLProgramAttribute {
  readonly name: string;
  readonly glsl: string;
  /** What it holds when it is a built-in or mapped by `attributes`. */
  readonly semantic?: GLSLAttributeSemantic;
}
/** A value passed from the vertex to the fragment stage. */
export interface GLSLProgramVarying {
  readonly name: string;
  readonly glsl: string;
  readonly location: number;
  readonly interpolation: 'perspective' | 'centroid' | 'flat';
}
/** The WGSL of a linked program: each stage follows a RawShaderMaterial's prelude. */
export interface GLSLProgramWGSL {
  /** The vertex stage, with an entry `margoGLSLVertex` for a mesh whose attributes carry the GLSL names and types. */
  readonly vertex: string;
  /** The fragment stage, with an entry `margoGLSLFragment`. */
  readonly fragment: string;
  readonly uniforms: readonly GLSLProgramUniform[];
  readonly textures: readonly GLSLProgramTexture[];
  readonly attributes: readonly GLSLProgramAttribute[];
  readonly varyings: readonly GLSLProgramVarying[];
  /** The GLSL ES version both stages share. */
  readonly version: 100 | 300;
  /** The convention whose engine values the program reads, or false. */
  readonly builtins: Exclude<GLSLBuiltins, 'auto'>;
  /** The vertex stage writes gl_PointSize, so `shaderMesh` draws a point list as squares of that size. */
  readonly points: boolean;
  /** The uniforms the scene fills (`lights` and `fog` names the program declares and `uniforms` does not set). */
  readonly scene: readonly string[];
  /** The vertex stage also has the entry `margoGLSLVelocity` (`velocity`). */
  readonly velocity: boolean;
}
/** One attribute of a drawn mesh: its name and WGSL type (`vec3f`). */
export interface GLSLMeshAttribute {
  readonly name: string;
  readonly type: string;
}
/** @internal A linked program: its WGSL, and the vertex entry for any mesh layout. */
export interface GLSLLinked extends GLSLProgramWGSL {
  /** The vertex stage for a mesh with `layout` (attribute names as the mesh has them, mapped by `rename`). */
  vertexFor(layout?: readonly GLSLMeshAttribute[], rename?: (glsl: string) => string): string;
  /** The fragment stage writes display-ready colour itself (`outputColorSpace: 'srgb'` without colorspace_fragment). */
  readonly display: boolean;
}

// Sampler types (GLSL ES 3.00 4.1.7): their dimension and the sample type of the texture they bind.
const textureKinds: Record<string, [GLSLProgramTexture['dimension'], GLSLProgramTexture['sampleType']?]> = {
  sampler2DShadow: ['2d', 'depth'],
  samplerCubeShadow: ['cube', 'depth'],
  sampler2DArrayShadow: ['2d-array', 'depth'],
};
for (const [d, w] of [['2D', '2d'], ['Cube', 'cube'], ['3D', '3d'], ['2DArray', '2d-array']] as const) {
  textureKinds['sampler' + d] = [w];
  textureKinds['isampler' + d] = [w, 'sint'];
  textureKinds['usampler' + d] = [w, 'uint'];
}
// GLSL type -> the raw uniform type that stores it (GLSL ES 3.00 4.1; a bool is 32 bits wide in a uniform block).
/** @internal */
export const uniformTypes: Record<string, string> = {
  float: 'f32',
  int: 'i32',
  uint: 'u32',
  bool: 'u32',
  mat2: 'vec4f',
  mat3: 'mat3x3f',
  mat4: 'mat4x4f',
};
for (const n of [2, 3, 4]) {
  uniformTypes['vec' + n] = `vec${n}f`;
  uniformTypes['ivec' + n] = `vec${n}i`;
  uniformTypes['uvec' + n] = `vec${n}u`;
  uniformTypes['bvec' + n] = `vec${n}u`;
}
const width = (t: string) => Number(/(?:vec|mat)([234])/.exec(t)?.[1] ?? 1);
// Columns and rows of a non-square matrix (mat2x3 has 2 columns of 3 rows), stored in the columns of a mat4x4f.
/** @internal */
export const rect = (t: string) => /^mat([234])x([234])$/.exec(t)?.slice(1).map(Number) as [number, number] | undefined;
// Numbers in one value of a non-aggregate type.
const numbers = (t: string) => (rect(t) ? rect(t)![0] * rect(t)![1] : t.startsWith('mat') ? width(t) ** 2 : width(t));
// Arrays a uniform array holds as it is: elements 16 bytes apart in WGSL as in GLSL's layout.
const direct = /^(?:[iu]?vec[34]|mat[34])\[\d+\]$/;
const kind = (t: string) => (/^(int|ivec)/.test(t) || /^vec\di$|^i32$/.test(t) ? 'i' : /^(uint|uvec)/.test(t) || /^vec\du$|^u32$/.test(t) ? 'u' : 'f');
const wgslType = (t: string) => {
  const n = width(t),
    k = kind(t);
  return n === 1 ? { f: 'f32', i: 'i32', u: 'u32' }[k] : `vec${n}${k}`;
};
/** @internal */
export const identifier = /^[A-Za-z_]\w*$/;
// WebGL minimums for the gl_Max constants (GLSL ES 1.00 7.4 and 3.00 7.3), so a program sized by them fits any device.
const maxima: Record<string, [number, number]> = {
  gl_MaxVertexAttribs: [8, 16],
  gl_MaxVertexUniformVectors: [128, 256],
  gl_MaxVaryingVectors: [8, 15],
  gl_MaxVertexOutputVectors: [16, 16],
  gl_MaxFragmentInputVectors: [15, 15],
  gl_MaxVertexTextureImageUnits: [0, 16],
  gl_MaxCombinedTextureImageUnits: [8, 32],
  gl_MaxTextureImageUnits: [8, 16],
  gl_MaxFragmentUniformVectors: [16, 224],
  gl_MaxDrawBuffers: [1, 4],
  gl_MinProgramTexelOffset: [-8, -8],
  gl_MaxProgramTexelOffset: [7, 7],
};
/** Programs linked, for work-count tests: one per distinct source, defines and options. @internal */
export const glslPrograms = { count: 0 };
const cache = new Map<string, GLSLLinked>();

/** @internal One parsed stage. */
export interface StageUnit {
  stage: GLSLStage;
  text: string;
  header: number;
  version: 100 | 300;
  program: Program;
  /** The built-in includes the stage used. */
  included: Set<string>;
}
const subject = (stage: GLSLStage) => `${stage}Shader`;
/** @internal */
export function refuse(unit: StageUnit | undefined, message: string, name?: string): never {
  const error = fault('failed', `GLSL program: ${unit ? subject(unit.stage) + ': ' : ''}${message}`);
  if (unit) {
    const found = name ? new RegExp(`\\b${name}\\b`).exec(unit.text) : null,
      at = found?.index ?? 0,
      before = unit.text.slice(0, at);
    Object.assign(error, {
      stage: unit.stage,
      line: Math.max(1, before.split('\n').length - unit.header),
      column: at - before.lastIndexOf('\n'),
    });
  }
  throw error;
}
// #include <name> and #include "name": the caller's text, or one of the two built-in chunks, as their documented
// effect (the display transform in two steps): tone mapping when the target is not an HDR capture, sRGB encoding on
// an sRGB display target. MARGO_OUT is the stage's colour output.
const chunks: Record<string, string> = {
  tonemapping_fragment:
    '{vec3 margo_x=max(MARGO_OUT.rgb,vec3(0.0));float margo_m=min(margo_x.r,min(margo_x.g,margo_x.b));' +
    'vec3 margo_v=margo_x-(margo_m<0.08?margo_m-6.25*margo_m*margo_m:0.04);float margo_p=max(margo_v.r,max(margo_v.g,margo_v.b));' +
    'float margo_n=1.0-0.0576/(margo_p-0.52);vec3 margo_t=margo_p<0.76?margo_v:mix(margo_v*(margo_n/margo_p),vec3(margo_n),1.0-1.0/(0.15*(margo_p-margo_n)+1.0));' +
    'if(margo_encoding!=0.0){MARGO_OUT.rgb=margo_t;}}',
  colorspace_fragment:
    '{vec3 margo_x=max(MARGO_OUT.rgb,vec3(0.0));' +
    'if(margo_encoding==1.0){MARGO_OUT.rgb=mix(margo_x*12.92,1.055*pow(margo_x,vec3(1.0/2.4))-0.055,step(vec3(0.0031308),margo_x));}}',
};
function include(stage: GLSLStage, code: string, source: GLSLProgramSource, included: Set<string>, depth = 0): string {
  const given = source.includes ?? {};
  return code.replace(/^[ \t]*#[ \t]*include[ \t]*(?:<([^>\n]*)>|"([^"\n]*)")[^\n]*$/gm, (line, a?: string, b?: string) => {
    const name = (a ?? b)!.trim();
    if (Object.hasOwn(given, name)) {
      if (depth >= 8) throw fault('failed', `GLSL program: ${subject(stage)}: #include <${name}> nests more than 8 deep; an include includes itself`);
      return include(stage, given[name]!, source, included, depth + 1).replace(/\r?\n/g, ' ');
    }
    if (chunks[name]) {
      if (stage !== 'fragment') throw fault('failed', `GLSL program: ${subject(stage)}: #include <${name}> belongs in the fragmentShader`);
      included.add(name);
      const out = /^\s*#\s*version\s+300/m.test(source.fragmentShader)
        ? /^\s*(?:layout\s*\([^)]*\)\s*)?out\s+(?:(?:highp|mediump|lowp)\s+)?vec4\s+([A-Za-z_]\w*)/m.exec(code)?.[1] ??
          /\bout\s+(?:(?:highp|mediump|lowp)\s+)?vec4\s+([A-Za-z_]\w*)/.exec(source.fragmentShader)?.[1] ?? 'gl_FragColor'
        : 'gl_FragColor';
      return chunks[name]!.replaceAll('MARGO_OUT', out);
    }
    throw Object.assign(
      fault('failed', `GLSL program: ${subject(stage)}: #include <${name}> is not known; pass its text in includes, or remove it`),
      { stage, line: code.slice(0, code.indexOf(line)).split('\n').length, column: 1 },
    );
  });
}
function parse(stage: GLSLStage, code: string, source: GLSLProgramSource, extra: readonly string[] = []): StageUnit {
  if (typeof code !== 'string' || !code.trim() || code.length > 65536)
    throw new TypeError(`ShaderMaterial ${subject(stage)} needs 1..65536 code units of GLSL with void main()`);
  const defines = source.defines ?? {},
    versioned = /^\s*#\s*version\b/m.test(code),
    included = new Set<string>(),
    lines = [
      ...(!versioned && source.glslVersion === 300 ? ['#version 300 es'] : []),
      ...Object.entries(defines).map(([k, v]) => `#define ${k} ${typeof v === 'boolean' ? +v : v}`),
      ...extra,
    ];
  code = include(stage, code, source, included);
  const info: GLSLSourceInfo = { version: 100 },
    text = preprocessGLSL(lines.length ? lines.join('\n') + '\n' + code : code, info);
  if (versioned && source.glslVersion !== undefined && source.glslVersion !== info.version)
    throw fault('failed', `GLSL program: ${subject(stage)} declares #version ${info.version} but glslVersion is ${source.glslVersion}; drop one`);
  try {
    return { stage, text, header: lines.length, version: info.version, included, program: new GLSLParser(text, subject(stage)).parse() };
  } catch (error) {
    // The parser counts lines of the text it read; the source starts after the lines put before it.
    if (typeof (error as { line?: unknown })?.line === 'number') {
      (error as { line: number }).line -= lines.length;
      (error as { stage?: string }).stage = stage;
    }
    throw error;
  }
}
/** @internal */
export const has = (q: string, word: string) => new RegExp(`\\b${word}\\b`).test(q);
/** @internal */
export const uses = (unit: StageUnit, name: string) => new RegExp(`\\b${name}\\b`).test(unit.text);
// A uniform as WGSL reads it from the raw uniform block: bools compare against zero, a mat2 is rebuilt from a vec4.
/** @internal */
export function read(u: GLSLProgramUniform): string {
  const m = `uniforms.${u.member}`,
    r = rect(u.glsl);
  if (r) return `mat${r[0]}x${r[1]}f(${Array.from({ length: r[0] }, (_, c) => `${m}[${c}].${'xyzw'.slice(0, r[1])}`).join(',')})`;
  if (u.glsl === 'bool') return `(${m}!=0u)`;
  if (u.glsl.startsWith('bvec')) return `(${m}!=vec${width(u.glsl)}u(0u))`;
  if (u.glsl === 'mat2') return `mat2x2f(${m}.xy,${m}.zw)`;
  return m;
}
// A texture lookup: implicit derivatives in the fragment stage, level 0 in the vertex stage (GLSL ES 3.00 8.8).
const lookup =
  (implicit: boolean, samplerOf: (t: string) => string, modeOf?: (t: string) => string) =>
  (t: string, k: string, c: string, o: GLSLSampleOptions): string => {
    const mode = k === 'sampler2D' ? modeOf?.(t) : undefined;
    if (mode && mode !== '0u' && mode !== '1u') {
      // An unfilterable texture: GL's filter by texel loads; a sampler argument chooses at run time by its mode.
      const off = o.offset ? `vec2i(${o.offset})` : 'vec2i(0)',
        taps = o.lod
          ? `margoTaps(${t},${c},vec4f(0.0),vec2f(${o.lod},1.0),${off},${mode})`
          : o.ddx
            ? `margoTaps(${t},${c},vec4f(${o.ddx},${o.ddy}),vec2f(0.0),${off},${mode})`
            : implicit
              ? `margoTapsAuto(${t},${c},${o.bias ?? '0.0'},${off},${mode})`
              : `margoTaps(${t},${c},vec4f(0.0),vec2f(0.0,1.0),${off},${mode})`;
      if (/^\d+u$/.test(mode)) return taps;
      return `select(${lookup(implicit, samplerOf)(t, k, c, o)},${taps},${mode}>1u)`;
    }
    const array = k.endsWith('2DArray') || k === 'sampler2DArrayShadow',
      at = array ? `${c}.xy,i32(round(${c}.z))` : c,
      off = o.offset ? `,${o.offset}` : '',
      head = `${t},${samplerOf(t)},${at}`;
    // A shadow lookup compares its reference with the texel (WGSL takes no bias or gradients there: level 0).
    if (o.compare) return `textureSampleCompare${!implicit || o.lod || o.ddx ? 'Level' : ''}(${head},${o.compare}${off})`;
    if (/^[iu]/.test(k)) {
      // An integer texture is read at its nearest texel (GL requires nearest filtering of one), level 0, clamped to its
      // edge: GLSL ES 3.00 8.8 with OpenGL ES 3.0.6 3.8.10.
      const n = k.includes('3D') ? 3 : 2,
        size = `vec${n}f(textureDimensions(${t},0))`,
        p = n === 3 ? c : `(${c}).xy`,
        texel = `vec${n}i(clamp(floor(${p}*${size})${o.offset ? `+vec${n}f(${o.offset})` : ''},vec${n}f(0.0),${size}-1.0))`;
      return array
        ? `textureLoad(${t},${texel},clamp(i32(round((${c}).z)),0,i32(textureNumLayers(${t}))-1),0)`
        : `textureLoad(${t},${texel},0)`;
    }
    return o.lod
      ? `textureSampleLevel(${head},${o.lod}${off})`
      : o.ddx
        ? `textureSampleGrad(${head},${o.ddx},${o.ddy}${off})`
        : !implicit
          ? `textureSampleLevel(${head},0.0${off})`
          : o.bias
            ? `textureSampleBias(${head},${o.bias}${off})`
            : `textureSample(${head}${off})`;
  };
// A function's sampler parameter keeps the emitter's own pairing; a sampler uniform pairs with the raw texture's sampler.
const samplerOf = (t: string) => (t.startsWith('argument_') ? t + 's' : t + 'Sampler');
// The texel filter of an unfilterable texture (OpenGL ES 3.0.6 3.8.10): mode bit 0 repeats, 2 and up filter linearly,
// 4 and up blend two mip levels. lambda is log2 of the larger screen-space footprint in texels plus the bias; at or
// below 0 the magnification filter reads level 0. Nearest (modes 0 and 1) is the device's own non-filtering sampler.
const tapCode = `fn margoTexel(t:texture_2d<f32>,i:vec2i,l:i32,m:u32)->vec4f{let n=vec2i(textureDimensions(t,l));return textureLoad(t,select(clamp(i,vec2i(0),n-1),((i%n)+n)%n,(m&1u)==1u),l);}
fn margoBilinear(t:texture_2d<f32>,uv:vec2f,l:i32,o:vec2i,m:u32)->vec4f{let f=uv*vec2f(textureDimensions(t,l))-0.5;let b=floor(f);let w=f-b;let i=vec2i(b)+o;
return mix(mix(margoTexel(t,i,l,m),margoTexel(t,i+vec2i(1,0),l,m),w.x),mix(margoTexel(t,i+vec2i(0,1),l,m),margoTexel(t,i+vec2i(1,1),l,m),w.x),w.y);}
fn margoTaps(t:texture_2d<f32>,uv:vec2f,g:vec4f,b:vec2f,o:vec2i,m:u32)->vec4f{let n=vec2f(textureDimensions(t,0));
let lambda=select(log2(max(length(g.xy*n),length(g.zw*n)))+b.x,b.x,b.y>0.5);
if(m<4u||lambda<=0.0){return margoBilinear(t,uv,0,o,m);}
let q=f32(textureNumLevels(t))-1.0;let l=min(lambda,q);let d=floor(l);let a=margoBilinear(t,uv,i32(d),o,m);
if(d>=q){return a;}
return mix(a,margoBilinear(t,uv,i32(d)+1,o,m),l-d);}
fn margoTapsAuto(t:texture_2d<f32>,uv:vec2f,bias:f32,o:vec2i,m:u32)->vec4f{return margoTaps(t,uv,vec4f(dpdx(uv),dpdy(uv)),vec2f(bias,0.0),o,m);}
`;
const tapMode = (f: GLSLTexelFilter) => (f.filter === 'nearest' ? 0 : f.filter === 'linear' ? 2 : 4) + (f.wrap === 'repeat' ? 1 : 0);

// The GLSL value of an attribute from a mesh attribute of WGSL type `type` (absent: GL's generic default 0, 0, 0, 1).
function adapt(code: string | undefined, type: string | undefined, glsl: string, fallback: readonly number[] = [0, 0, 0, 1]): string {
  const n = width(glsl),
    target = wgslType(glsl);
  if (!code || !type) {
    const v = [0, 1, 2, 3].map((i) => fallback[i] ?? (i === 3 ? 1 : 0)).slice(0, n);
    return `${target}(${v.map((x) => (kind(glsl) === 'f' ? (Number.isInteger(x) ? x.toFixed(1) : String(x)) : Math.trunc(x))).join(',')})`;
  }
  const m = width(type),
    padded = m >= n ? code : `vec4${kind(type)}(${code}${['', ',0,0,1', ',0,1', ',1'][m]})`,
    picked = (m >= n ? m : 4) === n ? padded : `(${padded}).${'xyzw'.slice(0, n)}`;
  return kind(type) === kind(glsl) ? picked : `${target}(${picked})`;
}
// The interstage form of a varying: WGSL carries f32, i32 and u32 scalars and vectors, integers flat.
function varyingType(unit: StageUnit, d: Declaration): string {
  if (!/^(float|u?int|[iu]?vec[234])$/.test(d.type))
    refuse(unit, `varying ${d.name} has type ${d.type}; pass float, int or uint scalars and vectors between the stages`, d.name);
  if (kind(d.type) !== 'f' && !has(d.qualifier, 'flat'))
    refuse(unit, `integer varying ${d.name} must be flat (GLSL ES 3.00 4.3.6)`, d.name);
  return wgslType(d.type);
}
const interpolation = (q: string): GLSLProgramVarying['interpolation'] =>
  has(q, 'flat') ? 'flat' : has(q, 'centroid') ? 'centroid' : 'perspective';
const interpolate = (i: GLSLProgramVarying['interpolation']) =>
  i === 'flat' ? '@interpolate(flat) ' : i === 'centroid' ? '@interpolate(perspective,centroid) ' : '';

/**
 * @internal What `lights`, `fog` and `velocity` add to one link, from glsl/scene.ts: only ShaderMaterial of
 * shader/glsl-material imports it, so ShaderPass and Shadertoy carry none of it.
 */
export interface GLSLSceneLink {
  /** The vertex stage's extra declarations: last frame's uniforms of `velocity` the program does not declare. */
  declare(vs: StageUnit, fs: StageUnit, own: ReadonlySet<string>, preset: GLSLPreset | undefined): string[];
  /** True when uniform `d` is a scene value (its type checked). */
  uniform(unit: StageUnit, d: Declaration, own: ReadonlySet<string>): boolean;
  /** Under `velocity`: the moving values' private variables and helpers; renames them in `names`. */
  motion(
    vs: StageUnit,
    engine: Record<string, GLSLHostName>,
    uniforms: ReadonlyMap<string, GLSLProgramUniform>,
    names: Record<string, GLSLHostName>,
    wgslOf: (unit: StageUnit, t: string) => string,
    helpers: ReadonlySet<string>,
  ): string;
  /** The statements that fill the moving values with this frame's. */
  readonly now: string;
  readonly velocity: boolean;
  /** The velocity entry, from the vertex entry's parameters, attribute statements, copies, main and point code. */
  entry(params: string, lines: string, copy: string, main: string, gl: boolean, sprite: string, vs: StageUnit, names: Record<string, GLSLHostName>): string;
}
/** @internal Starts a link's scene part, or returns undefined when `source` sets no scene option. */
export type GLSLSceneLinker = (source: GLSLProgramSource) => GLSLSceneLink | undefined;

/**
 * @internal Links a GLSL program: parses both stages, joins their uniforms, links varyings by name (locations in vertex
 * declaration order) and translates each stage with `main` called from a generated entry. Cached per source and options.
 */
export function linkGLSLProgram(source: GLSLProgramSource, sceneLinker?: GLSLSceneLinker): GLSLLinked {
  if (!source || typeof source !== 'object') throw new TypeError('ShaderMaterial needs {vertexShader, fragmentShader}');
  const {
    defines = {},
    flipY = true,
    clipSpace = 'gl',
    strict = false,
    glslVersion,
    builtins = 'auto',
    uniformNames = [],
    attributes: semanticOf = {},
    defaultAttributeValues = {},
    includes = {},
    outputColorSpace = 'srgb',
    unfilterable = {},
  } = source;
  const scene = sceneLinker?.(source);
  if (!scene && (source.lights || source.fog || source.velocity))
    throw new TypeError('lights, fog and velocity are options of ShaderMaterial from shader/glsl-material; draw with that ShaderMaterial to use them');
  for (const [k, v] of Object.entries(unfilterable))
    if (!v || !['nearest', 'linear', 'mipmap'].includes(v.filter) || !['clamp', 'repeat'].includes(v.wrap))
      throw new TypeError(`ShaderMaterial unfilterable.${k} needs filter 'nearest', 'linear' or 'mipmap' and wrap 'clamp' or 'repeat'`);
  if (builtins !== false && builtins !== 'auto' && !presetNames.includes(builtins))
    throw new TypeError(`ShaderMaterial builtins must be ${presetNames.map((n) => `'${n}'`).join(', ')}, 'auto' or false`);
  if (outputColorSpace !== 'srgb' && outputColorSpace !== 'linear') throw new TypeError("ShaderMaterial outputColorSpace must be 'srgb' or 'linear'");
  if (!Array.isArray(uniformNames)) throw new TypeError('ShaderMaterial uniformNames must be an array of names');
  for (const [k, v] of Object.entries(semanticOf))
    if (!semantics.includes(v)) throw new TypeError(`ShaderMaterial attributes.${k} must be one of ${semantics.join(', ')}`);
  for (const [k, v] of Object.entries(defaultAttributeValues))
    if (!Array.isArray(v) || !v.length || v.length > 4 || v.some((x) => !Number.isFinite(x)))
      throw new TypeError(`ShaderMaterial defaultAttributeValues.${k} needs 1 to 4 finite numbers`);
  for (const [k, v] of Object.entries(includes))
    if (typeof v !== 'string') throw new TypeError(`ShaderMaterial includes.${k} must be GLSL text`);
  if (typeof defines !== 'object' || defines === null) throw new TypeError('ShaderMaterial defines must be an object');
  for (const [k, v] of Object.entries(defines))
    if (!identifier.test(k) || !['string', 'number', 'boolean'].includes(typeof v) || /[\r\n\\]/.test(String(v)))
      throw new TypeError(`ShaderMaterial define ${k} needs an identifier and a one-line string, number or boolean`);
  if (typeof flipY !== 'boolean' || typeof strict !== 'boolean')
    throw new TypeError('ShaderMaterial flipY and strict must be booleans');
  if (clipSpace !== 'gl' && clipSpace !== 'webgpu') throw new TypeError("ShaderMaterial clipSpace must be 'gl' or 'webgpu'");
  if (glslVersion !== undefined && glslVersion !== 100 && glslVersion !== 300)
    throw new TypeError('ShaderMaterial glslVersion must be 100 or 300');
  const cacheKey = JSON.stringify([
    source.vertexShader,
    source.fragmentShader,
    defines,
    glslVersion ?? 0,
    flipY,
    clipSpace,
    strict,
    builtins,
    [...uniformNames].sort(),
    semanticOf,
    defaultAttributeValues,
    includes,
    outputColorSpace,
    unfilterable,
    source.lights,
    source.fog,
    source.velocity,
  ]);
  const known = cache.get(cacheKey);
  if (known) return known;
  let vs = parse('vertex', source.vertexShader, source),
    fs = parse('fragment', source.fragmentShader, source);
  const own = new Set(uniformNames),
    gl = clipSpace === 'gl';
  // The convention: named, or the one whose names the program uses.
  let preset: GLSLPreset | undefined, chosen: Exclude<GLSLBuiltins, 'auto'> = false;
  const matches = (p: GLSLPreset) => {
    const found: string[] = [];
    for (const unit of [vs, fs]) {
      const declared = new Map(unit.program.globals.map((d) => [d.name, d]));
      for (const [name, u] of Object.entries(p.uniforms)) {
        if (own.has(name)) continue;
        const d = declared.get(name);
        if (d ? has(d.qualifier, 'uniform') && d.type === u.glsl : u.implicit?.includes(unit.stage) && uses(unit, name)) found.push(name);
      }
      if (unit.stage === 'vertex')
        for (const [name, a] of Object.entries(p.attributes)) if (a.implicit && !declared.has(name) && uses(unit, name)) found.push(name);
    }
    return found;
  };
  if (builtins === 'auto') {
    const hits = presetNames.map((n) => [n, matches(presets[n](gl))] as const).filter(([, f]) => f.length);
    if (hits.length > 1)
      refuse(
        undefined,
        `the program uses built-in names of ${hits.length} conventions (${hits.map(([n, f]) => `'${n}': ${f.slice(0, 3).join(', ')}`).join('; ')}); choose one with builtins, or list your own names in uniforms`,
      );
    if (hits[0]) chosen = hits[0][0];
  } else chosen = builtins;
  const extraVertex: string[] = [];
  if (chosen) {
    preset = presets[chosen](gl);
    // A convention that declares its names for the program declares the ones each stage uses and does not declare.
    const implicit = (unit: StageUnit) => {
      const declared = new Set(unit.program.globals.map((d) => d.name)),
        lines: string[] = [];
      for (const [name, u] of Object.entries(preset!.uniforms))
        if (!own.has(name) && u.implicit?.includes(unit.stage) && !declared.has(name) && uses(unit, name)) lines.push(`uniform ${u.glsl} ${name};`);
      if (unit.stage === 'vertex')
        for (const [name, a] of Object.entries(preset!.attributes))
          if (a.implicit && !declared.has(name) && uses(unit, name)) lines.push(`${unit.version === 300 ? 'in' : 'attribute'} ${a.glsl} ${name};`);
      return lines;
    };
    extraVertex.push(...implicit(vs));
    const extraFragment = implicit(fs);
    if (extraFragment.length) fs = parse('fragment', source.fragmentShader, source, extraFragment);
  }
  if (scene) extraVertex.push(...scene.declare(vs, fs, own, preset));
  if (extraVertex.length) vs = parse('vertex', source.vertexShader, source, extraVertex);
  if (vs.version !== fs.version)
    refuse(fs, `the vertexShader is GLSL ES ${vs.version === 300 ? '3.00' : '1.00'} and the fragmentShader ${fs.version === 300 ? '3.00' : '1.00'}; use one version in both`);
  // Uniforms of both stages, joined by name; a name declared in both has one type (GLSL ES 3.00 4.3.5).
  const uniforms = new Map<string, GLSLProgramUniform>(),
    textures = new Map<string, GLSLProgramTexture>(),
    engine: Record<string, GLSLHostName> = {},
    helpers = new Set<string>(),
    sceneNames: string[] = [],
    // Uniforms by name: their type and, for a struct or array copied into a private variable, its WGSL type and value.
    declared = new Map<string, { type: string; shape: string; copy?: [string, string] }>();
  // A type spelled out with its struct fields, so the two stages' declarations of one uniform can be compared.
  const shapeOf = (unit: StageUnit, t: string): string => {
    const [, base, count] = /^(.*?)((?:\[\d+\])*)$/.exec(t)!,
      fields = unit.program.structs.get(base!);
    return (fields ? `${base}{${fields.map((f) => `${f.name}:${shapeOf(unit, f.type)}`).join(';')}}` : base!) + count;
  };
  const wgslOf = (unit: StageUnit, t: string): string => {
    const array = /^(.*)\[(\d+)\]$/.exec(t);
    if (array) return `array<${wgslOf(unit, array[1]!)},${array[2]}>`;
    if (unit.program.structs.has(t)) return 'user_' + t;
    const r = rect(t);
    if (r) return `mat${r[0]}x${r[1]}f`;
    if (t === 'bool') return 'bool';
    if (t.startsWith('bvec')) return `vec${width(t)}<bool>`;
    return t.startsWith('mat') ? `mat${width(t)}x${width(t)}f` : wgslType(t);
  };
  // The leaves of a struct or array uniform, one raw member each, and the WGSL that builds its value from them.
  const flatten = (unit: StageUnit, root: string, t: string, name: string, member: string, path: GLSLProgramUniform['path'] & unknown[]): string => {
    const array = /^(.*)\[(\d+)\]$/.exec(t);
    if (array) {
      const [, element, n] = array,
        size = unit.program.structs.has(element!) ? 0 : numbers(element!);
      return `array<${wgslOf(unit, element!)},${n}>(${Array.from({ length: +n! }, (_, k) => flatten(unit, root, element!, `${name}[${k}]`, `${member}__${k}`, [...path, [k, size]])).join(',')})`;
    }
    const fields = unit.program.structs.get(t);
    if (fields) {
      if (fields.some((f) => /sampler/.test(f.type))) refuse(unit, `uniform ${root} holds a sampler in a struct; declare each sampler as its own uniform`, root);
      return `user_${t}(${fields.map((f) => flatten(unit, root, f.type, `${name}.${f.name}`, `${member}__${f.name}`, [...path, f.name])).join(',')})`;
    }
    const type = uniformTypes[t] ?? (rect(t) ? 'mat4x4f' : undefined);
    if (!type) refuse(unit, `uniform ${root} has a member of type ${t}; use scalars, vectors, matrices, structs and arrays of them`, root);
    const leaf: GLSLProgramUniform = { name, glsl: t, type, member, root, path };
    uniforms.set(name, leaf);
    return read(leaf);
  };
  for (const unit of [vs, fs])
    for (const d of unit.program.globals) {
      if (!has(d.qualifier, 'uniform')) continue;
      const builtin = own.has(d.name) ? undefined : preset?.uniforms[d.name];
      if (builtin) {
        if (builtin.glsl !== d.type)
          refuse(unit, `uniform ${d.name} is the engine's ${builtin.glsl} under builtins '${chosen}'; declare it ${builtin.glsl}, or list it in uniforms to set it yourself`, d.name);
        engine[d.name] = { code: builtin.code, type: builtin.glsl };
        builtin.helpers?.forEach((h) => helpers.add(h));
        continue;
      }
      const known = declared.get(d.name),
        shape = shapeOf(unit, d.type);
      if (known) {
        if (known.shape !== shape) refuse(unit, `uniform ${d.name} is ${known.type} in the vertexShader and ${d.type} here; declare one type`, d.name);
        continue;
      }
      if (scene?.uniform(unit, d, own)) sceneNames.push(d.name);
      const entry: { type: string; shape: string; copy?: [string, string] } = { type: d.type, shape };
      declared.set(d.name, entry);
      const member = 'user_' + d.name,
        samplerArray = /^(\w*sampler\w*)\[(\d+)\]$/.exec(d.type);
      const texture = (name: string, glsl: string, binding: string, extra = {}) => {
        const [dimension, kind] = textureKinds[glsl]!,
          sampleType = glsl === 'sampler2D' && Object.hasOwn(unfilterable, name) ? 'unfilterable-float' : kind;
        textures.set(name, { name, glsl, dimension, ...(sampleType ? { sampleType } : {}), binding, ...extra });
      };
      if (textureKinds[d.type]) texture(d.name, d.type, member);
      else if (samplerArray && textureKinds[samplerArray[1]!])
        // Element k binds as its own texture, user_<name>__k (the emitter's name for maps[k]).
        for (let k = 0; k < +samplerArray[2]!; k++) texture(`${d.name}[${k}]`, samplerArray[1]!, `${member}__${k}`, { root: d.name, index: k });
      else if (uniformTypes[d.type] || rect(d.type))
        uniforms.set(d.name, { name: d.name, glsl: d.type, type: uniformTypes[d.type] ?? 'mat4x4f', member });
      else if (direct.test(d.type)) {
        const [, element, n] = /^(.*)\[(\d+)\]$/.exec(d.type)!;
        uniforms.set(d.name, { name: d.name, glsl: d.type, type: uniformTypes[element!]!, member, count: +n! });
      } else if (/\[\d+\]$/.test(d.type) || unit.program.structs.has(d.type))
        // A struct, block instance or other array is built from its leaves into a private variable when a stage starts.
        entry.copy = [wgslOf(unit, d.type), flatten(unit, d.name, d.type, d.name, member, [])];
      else refuse(unit, `uniform ${d.name} has type ${d.type}; use a scalar, vector, matrix, sampler, struct or array of them`, d.name);
    }
  // Vertex inputs, and the values the vertex stage hands on, in declaration order.
  const attributes: GLSLProgramAttribute[] = [],
    varyings: GLSLProgramVarying[] = [],
    outputs: Declaration[] = [];
  for (const d of vs.program.globals) {
    const q = d.qualifier;
    if (has(q, 'attribute') || has(q, 'in')) {
      if (!/^(float|u?int|[iu]?vec[234]|mat[234])$/.test(d.type))
        refuse(vs, `attribute ${d.name} has type ${d.type}; use a float, int or uint scalar or vector, or a mat2, mat3 or mat4`, d.name);
      const semantic = semanticOf[d.name] ?? preset?.attributes[d.name]?.semantic ?? (semantics.includes(d.name as GLSLAttributeSemantic) ? (d.name as GLSLAttributeSemantic) : undefined);
      attributes.push(semantic ? { name: d.name, glsl: d.type, semantic } : { name: d.name, glsl: d.type });
    } else if (has(q, 'varying') || has(q, 'out')) {
      varyingType(vs, d);
      varyings.push({ name: d.name, glsl: d.type, location: varyings.length, interpolation: interpolation(q) });
    }
  }
  const inputs: GLSLProgramVarying[] = [];
  for (const d of fs.program.globals) {
    const q = d.qualifier;
    if (has(q, 'varying') || has(q, 'in')) {
      varyingType(fs, d);
      const v = varyings.find((x) => x.name === d.name);
      // An input the fragment stage reads needs the vertex stage's output of the same type and interpolation.
      if (!v) {
        if (new RegExp(`\\b${d.name}\\b`, 'g').exec(fs.text) && [...fs.text.matchAll(new RegExp(`\\b${d.name}\\b`, 'g'))].length > 1)
          refuse(fs, `varying ${d.name} is read but the vertexShader does not write it; declare it there too`, d.name);
        continue;
      }
      if (v.glsl !== d.type) refuse(fs, `varying ${d.name} is ${v.glsl} in the vertexShader and ${d.type} here`, d.name);
      if (vs.version === 300 && v.interpolation !== interpolation(q))
        refuse(fs, `varying ${d.name} has other interpolation qualifiers than in the vertexShader`, d.name);
      inputs.push(v);
    } else if (has(q, 'out')) outputs.push(d);
  }
  if (outputs.length > 1)
    refuse(fs, `${outputs.length} colour outputs; the scene pass has one colour target, so declare one output`, outputs[1]!.name);
  const output = outputs[0];
  if (output && (!/^(float|vec[234])$/.test(output.type)))
    refuse(fs, `output ${output.name} has type ${output.type}; the scene's colour target takes float vectors`, output.name);
  if (/\bgl_FragData\s*\[\s*[^0\s]/.test(fs.text))
    refuse(fs, 'gl_FragData above 0 needs more colour targets; the scene pass has one', 'gl_FragData');
  const hostNames: Record<string, GLSLHostName> = { ...engine };
  for (const u of uniforms.values()) if (!u.root) hostNames[u.name] = { code: u.count ? `uniforms.${u.member}` : read(u), type: u.glsl };
  for (const t of textures.values()) if (t.root === undefined) hostNames[t.name] = { code: t.binding, type: t.glsl };
  for (const [name, d] of declared) if (d.copy || /sampler\w*\[/.test(d.type)) hostNames[name] = { code: 'user_' + name, type: d.type };
  // Each stage declares the copies it reads and fills them before main.
  const copies = (unit: StageUnit) => [...declared].filter(([name, d]) => d.copy && uses(unit, name));
  const copyDeclarations = (unit: StageUnit) => copies(unit).map(([name, d]) => `var<private> user_${name}:${d.copy![0]};\n`).join('');
  const copyStatements = (unit: StageUnit) => copies(unit).map(([name, d]) => `user_${name}=${d.copy![1]};\n`).join('');
  // Linearly filtered unfilterable textures by binding (nearest is the device's non-filtering sampler), and the mode of
  // each lookup: a uniform's is known, an argument's is passed.
  const modes = new Map([...textures.values()].filter((t) => t.sampleType === 'unfilterable-float').map((t) => [t.binding, tapMode(unfilterable[t.name]!)] as const).filter(([, m]) => m > 1));
  if (modes.size) helpers.add(tapCode);
  const modeOf = modes.size ? (t: string) => (t.startsWith('argument_') ? t + 'm' : `${modes.get(t) ?? 0}u`) : undefined;
  const helperCode = [...helpers].join('');
  let vertexMain = '',
    fragmentMain = '';
  const translate = (unit: StageUnit, names: Record<string, GLSLHostName>, prologue: string, capture: (n: string) => void) => {
    const text = unit.text;
    for (const [name, [low, high]] of Object.entries(maxima))
      if (uses(unit, name)) names[name] = { code: `i32(${unit.version === 300 ? high : low})`, type: 'int' };
    if (uses(unit, 'gl_DepthRange')) {
      // gl_DepthRange (GLSL ES 1.00 7.5): the window depth range, 0 to 1.
      unit.program.structs.set('gl_DepthRangeParameters', ['near', 'far', 'diff'].map((name) => ({ name, type: 'float', qualifier: '' })));
      names.gl_DepthRange = { code: 'user_gl_DepthRangeParameters(0.0,1.0,1.0)', type: 'gl_DepthRangeParameters' };
    }
    const host: GLSLHost = {
      uniforms: {},
      flipY,
      yUp: gl,
      names,
      colorReaders: {},
      prologue: prologue + helperCode,
      sample: lookup(unit.stage === 'fragment', samplerOf, modeOf),
      samplerOf,
      ...(modeOf ? { samplerMode: modeOf } : {}),
      entry: { name: 'main', type: 'void', params: [] },
      missingEntry: `Define void main() in the ${subject(unit.stage)}`,
      epilogue: (fn) => (capture(fn), ''),
    };
    let wgsl: string;
    try {
      wgsl = new GLSLEmitter(unit.program, host, unit.version).emit();
    } catch (error) {
      if ((error as { code?: string })?.code === 'failed')
        (error as Error).message = (error as Error).message.replace('GLSL translation: ', `GLSL translation: ${subject(unit.stage)}: `);
      throw error;
    }
    return strict ? wgsl : wgsl.replace(/^fn /gm, '@diagnostic(off,derivative_uniformity) fn ');
  };
  const vertexNames: Record<string, GLSLHostName> = {
    ...hostNames,
    gl_Position: { code: 'glsl_Position', type: 'vec4' },
    gl_PointSize: { code: 'glsl_PointSize', type: 'float' },
    gl_VertexID: { code: 'glsl_VertexID', type: 'int' },
    gl_InstanceID: { code: 'glsl_InstanceID', type: 'int' },
  };
  const motionCode = scene?.motion(vs, engine, uniforms, vertexNames, wgslOf, helpers) ?? '';
  const vertexBody = translate(
    vs,
    vertexNames,
    'var<private> glsl_Position:vec4f;\nvar<private> glsl_PointSize:f32;\nvar<private> glsl_VertexID:i32;\nvar<private> glsl_InstanceID:i32;\n' + copyDeclarations(vs) + motionCode,
    (n) => (vertexMain = n),
  );
  const fragmentNames: Record<string, GLSLHostName> = {
    ...hostNames,
    margo_encoding: { code: 'camera.encoding', type: 'float' },
    gl_FragCoord: { code: 'glsl_FragCoord', type: 'vec4' },
    gl_FrontFacing: { code: 'glsl_FrontFacing', type: 'bool' },
    gl_PointCoord: { code: 'glsl_PointCoord', type: 'vec2' },
    gl_FragColor: { code: 'glsl_FragColor', type: 'vec4' },
    gl_FragData: { code: 'glsl_FragData', type: 'vec4[1]' },
    gl_FragDepth: { code: 'glsl_FragDepth', type: 'float' },
    gl_FragDepthEXT: { code: 'glsl_FragDepth', type: 'float' },
  };
  const depth = /\bgl_FragDepth(EXT)?\b/.test(fs.text),
    fragData = /\bgl_FragData\b/.test(fs.text);
  const fragmentBody = translate(
    fs,
    fragmentNames,
    'var<private> glsl_FragCoord:vec4f;\nvar<private> glsl_FrontFacing:bool;\nvar<private> glsl_PointCoord:vec2f=vec2f(0.5);\nvar<private> glsl_FragColor:vec4f;\nvar<private> glsl_FragData:array<vec4f,1>;\nvar<private> glsl_FragDepth:f32;\n' + copyDeclarations(fs),
    (n) => (fragmentMain = n),
  );
  const struct = (list: readonly GLSLProgramVarying[]) =>
    list.map((v) => `,@location(${v.location}) ${interpolate(v.interpolation)}v${v.location}:${wgslType(v.glsl)}`).join('');
  // OpenGL ES 3.0.6 3.4: a point is a square of gl_PointSize pixels (at least 1) around its centre, and is dropped whole
  // when its centre is outside the clip volume.
  const spriteCode = `let c=o.clip;
if(any(abs(c.xy)>vec2f(c.w))||c.z<0.0||c.z>c.w){o.clip=vec4f(0.0,0.0,-1.0,1.0);}
else{o.clip=vec4f(c.xy+a.gl_PointCorner*max(glsl_PointSize,1.0)/camera.viewport.zw*c.w,c.zw);}
`;
  // gl_PointCoord reaches the fragment stage after the program's own varyings.
  const points = uses(vs, 'gl_PointSize'),
    coord = uses(fs, 'gl_PointCoord') ? `,@location(${varyings.length}) margoPointCoord:vec2f` : '';
  // The velocity entry's depth must equal this entry's, which TAA tests with 'equal', so both are invariant.
  const velocity = !!scene?.velocity,
    nowSets = scene?.now ?? '';
  const varyingStruct = `struct GLSLVaryings{@builtin(position)${velocity ? ' @invariant' : ''} clip:vec4f${struct(varyings)}${coord}}\n`;
  const ids = uses(vs, 'gl_VertexID') || uses(vs, 'gl_InstanceID');
  const vertexFor = (layout?: readonly GLSLMeshAttribute[], rename: (glsl: string) => string = (n) => n): string => {
    const lines = attributes.map((a) => {
      const find = (n: string) => layout?.find((l) => l.name === n),
        fallback = defaultAttributeValues[a.name] ?? preset?.attributes[a.name]?.default;
      if (a.glsl.startsWith('mat')) {
        // A matrix attribute takes one vector attribute per column, <name>0 to <name>N-1; an absent column is the identity's.
        const n = width(a.glsl),
          columns = Array.from({ length: n }, (_, i) => {
            const m = find(rename(a.name) + i);
            return adapt(m && 'a.' + m.name, m?.type, `vec${n}`, [0, 1, 2, 3].map((j) => +(i === j)));
          });
        return `user_${a.name}=mat${n}x${n}f(${columns.join(',')});`;
      }
      const m = find(rename(a.name));
      return `user_${a.name}=${adapt(m && 'a.' + m.name, m?.type, a.glsl, fallback)};`;
    });
    // A sized point is drawn as a square: one instance a point, six corners from gl_PointCorner (shaderMesh).
    const sprite = points && !!layout?.some((l) => l.name === 'gl_PointCorner');
    if (ids) lines.push(sprite ? 'glsl_VertexID=i32(margoInstanceIndex);glsl_InstanceID=0;' : 'glsl_VertexID=i32(margoVertexIndex);glsl_InstanceID=i32(margoInstanceIndex);');
    const params = [
      ...(layout?.length ? ['a:Attributes'] : []),
      ...(ids ? ['@builtin(vertex_index) margoVertexIndex:u32', '@builtin(instance_index) margoInstanceIndex:u32'] : []),
    ];
    const motion = velocity
      ? scene!.entry(params.join(','), lines.join('\n'), copyStatements(vs), vertexMain, gl, sprite ? spriteCode : '', vs, vertexNames)
      : '';
    return `${vertexBody}\n${varyingStruct}${motion}@vertex fn margoGLSLVertex(${params.join(',')})->GLSLVaryings{
${lines.join('\n')}
${nowSets}${copyStatements(vs)}${vertexMain}();
var o:GLSLVaryings;
o.clip=glsl_Position;${gl ? '\n// GL clip z runs from -w to w with depth (z/w+1)/2; Margo stores 1 minus that depth (reversed Z).\no.clip.z=(o.clip.w-o.clip.z)*0.5;' : ''}
${sprite ? spriteCode : ''}${coord ? (sprite ? '// gl_PointCoord runs from 0 to 1 across the point, from its upper left corner.\no.margoPointCoord=vec2f(a.gl_PointCorner.x,-a.gl_PointCorner.y)*0.5+0.5;\n' : 'o.margoPointCoord=vec2f(0.5);\n') : ''}${varyings.map((v) => `o.v${v.location}=user_${v.name};`).join('\n')}
return o;
}
`;
  };
  // The fragment entry: GL window coordinates count rows from the bottom and depth from near (0) to far (1).
  const written = output
    ? { float: `vec4f(user_${output.name},0.0,0.0,1.0)`, vec2: `vec4f(user_${output.name},0.0,1.0)`, vec3: `vec4f(user_${output.name},1.0)`, vec4: `user_${output.name}` }[output.type]!
    : fragData
      ? 'glsl_FragData[0]'
      : 'glsl_FragColor';
  // Display-ready colour is written as returned on an sRGB display target and decoded to linear light elsewhere.
  const color = fs.included.has('colorspace_fragment')
    ? written
    : outputColorSpace === 'linear'
      ? `margoDisplay(${written})`
      : `margoGLSLOutput(${written})`;
  const fragment = `${fragmentBody}
${color.startsWith('margoGLSLOutput') ? 'fn margoGLSLOutput(c:vec4f)->vec4f{if(camera.encoding==1.0){return c;}let x=clamp(c.rgb,vec3f(0),vec3f(1));return vec4f(select(x/12.92,pow((x+0.055)/1.055,vec3f(2.4)),x>vec3f(0.04045)),c.a);}\n' : ''}
struct GLSLFragmentIn{@builtin(position) margoPosition:vec4f,@builtin(front_facing) margoFront:bool${struct(inputs)}${coord}}
struct GLSLFragmentOut{@location(0) color:vec4f${depth ? ',@builtin(frag_depth) depth:f32' : ''}}
@fragment fn margoGLSLFragment(i:GLSLFragmentIn)->GLSLFragmentOut{
let p=i.margoPosition;
glsl_FragCoord=${gl ? 'vec4f(p.x,camera.resolution.y-p.y,1.0-p.z,p.w)' : 'p'};
glsl_FrontFacing=i.margoFront;${coord ? '\nglsl_PointCoord=i.margoPointCoord;' : ''}
${copyStatements(fs)}${inputs.map((v) => `user_${v.name}=i.v${v.location};`).join('\n')}
${depth ? 'glsl_FragDepth=glsl_FragCoord.z;\n' : ''}${fragmentMain}();
var o:GLSLFragmentOut;
o.color=${color};
${depth ? `o.depth=${gl ? 'clamp(1.0-glsl_FragDepth,0.0,1.0)' : 'glsl_FragDepth'};\n` : ''}return o;
}
`;
  glslPrograms.count++;
  const linked: GLSLLinked = {
    vertex: vertexFor(attributes.map((a) => ({ name: a.name, type: wgslType(a.glsl) }))),
    fragment,
    uniforms: [...uniforms.values()],
    textures: [...textures.values()],
    attributes,
    varyings,
    version: vs.version,
    builtins: chosen,
    points,
    scene: sceneNames,
    velocity,
    vertexFor,
    display: color.startsWith('margoGLSLOutput'),
  };
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, linked);
  return linked;
}

/**
 * Translates a whole GLSL program (GLSL ES 1.00 or 3.00, a vertex and a fragment stage with `void main()`) to the two
 * WGSL stages a `RawShaderMaterial` of `@margoengine/shader/raw` draws, with the uniforms, textures, attributes and
 * varyings it declares. `ShaderMaterial` does this for you; this shows the WGSL.
 * @throws MargoError `failed` with `stage`, `line` and `column` for a syntax or link error; TypeError for bad options.
 */
export function glslProgramToWGSL(source: GLSLProgramSource, sceneLinker?: GLSLSceneLinker): GLSLProgramWGSL {
  const { vertexFor: _, display: __, ...linked } = linkGLSLProgram(source, sceneLinker);
  return linked;
}
