// GLSL input for shader nodes (`glslFn`, `glslToWGSL`) and the GLSL ES 3.00 a node program becomes on the WebGL2
// layer (`toGLSL`). Optional entry @margoengine/shader/glsl; it shares the GLSL front end of transitions/glsl.
// Written clean room from the GLSL ES 1.00 and 3.00 specifications and the W3C WGSL specification.
import { fault } from '../../shared/errors.js';
import { Node, cast, unique, type Builder, type NodeInput, type Resource, type Type } from './node.js';
import { sampled, type BindableTexture } from './texture.js';
import { GLSLParser, type FunctionDeclaration, type Program } from './glsl/parser.js';
import { GLSLEmitter } from './glsl/emit.js';
import { preprocessGLSL, type GLSLSourceInfo } from './glsl/preprocess.js';
import type { GLSLHost, GLSLSampleOptions } from './glsl/host.js';

/** How {@link glslFn} and {@link glslToWGSL} read a GLSL source. */
export interface GLSLFnOptions {
  /** The function to call. Default: the last function the source defines. */
  readonly name?: string;
  /** Object-like macros defined before the source, as `#define NAME value` lines. Default none. */
  readonly defines?: Readonly<Record<string, string | number | boolean>>;
  /** Flip y at every 2D texture lookup and texelFetch, for GLSL written for a bottom-left image origin. Default false. */
  readonly flipY?: boolean;
  /**
   * Keep WGSL's derivative uniformity rule: a texture sample or derivative inside a branch on a per-pixel value is a
   * compile error. Default false: translated functions turn the rule off, so sampling there behaves as GLSL defines it.
   */
  readonly strict?: boolean;
}
/** The texture dimension a GLSL sampler parameter takes. */
export type GLSLSamplerDimension = '2d' | 'cube' | '3d' | '2d-array';
/** A parameter of a translated GLSL function. */
export interface GLSLParameter {
  readonly name: string;
  /** Its GLSL type, as written (`vec3`, `sampler2D`). */
  readonly glsl: string;
  /** Its node type (`vec3f`), or the texture dimension a sampler parameter takes. */
  readonly type: Type | GLSLSamplerDimension;
}
/** A GLSL function translated to WGSL by {@link glslToWGSL}. */
export interface GLSLFunction {
  /** WGSL declarations: the translated functions and an entry that calls the chosen one. */
  readonly code: string;
  /** The WGSL entry's name. A sampler parameter takes two WGSL arguments, the texture and its sampler. */
  readonly name: string;
  readonly params: readonly GLSLParameter[];
  /** The node type the function returns. */
  readonly result: Type;
}

const scalars: Record<string, Type> = { float: 'f32', int: 'i32', uint: 'u32', bool: 'bool' };
const nodeType = (t: string): Type | undefined => {
  const v = /^([ibu]?)vec([234])$/.exec(t);
  if (v) return (v[1] === 'b' ? `vec${v[2]}<bool>` : `vec${v[2]}${v[1] || 'f'}`) as Type;
  const m = /^mat([234])$/.exec(t);
  return m ? (`mat${m[1]}x${m[1]}f` as Type) : scalars[t];
};
const dimensions: Record<string, GLSLSamplerDimension> = {
  sampler2D: '2d',
  samplerCube: 'cube',
  sampler3D: '3d',
  sampler2DArray: '2d-array',
};
const identifier = /^[A-Za-z_]\w*$/;
// Where `at` (an offset into `text`) sits, 1-based, after `header` lines this entry put before the source.
const position = (text: string, at: number, header: number) => {
  const before = text.slice(0, at);
  return { line: before.split('\n').length - header, column: at - before.lastIndexOf('\n') };
};
const cache = new Map<string, GLSLFunction>();
let serial = 0;
/** Translations made, for work-count tests: one per distinct source, options and sampling stage. @internal */
export const glslTranslations = { count: 0 };

// WGSL for a GLSL texture lookup: implicit derivatives in fragment code, level 0 elsewhere (GLSL ES 3.00 8.8).
const lookup =
  (implicit: boolean) =>
  (t: string, kind: string, c: string, o: GLSLSampleOptions): string => {
    const at = kind === 'sampler2DArray' ? `${c}.xy,i32(round(${c}.z))` : c,
      off = o.offset ? `,${o.offset}` : '',
      head = `${t},${t}s,${at}`;
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

/**
 * Translates one GLSL ES 3.00 or 1.00 function (with any helpers, structs and constants it uses) to WGSL, once per
 * distinct source and options. A source without `#version` reads as GLSL ES 3.00. Inputs are the function's
 * parameters: a uniform or a `gl_` built-in inside the source is refused, pass it as an argument.
 * @param stage 'fragment' samples with implicit derivatives; any other stage samples level 0, as `texture()` does.
 * @throws MargoError `failed` (with `line` and `column` for a syntax error or a refused name); TypeError for bad
 *   options. MargoError `unsupported` for a `#version` other than 100 and 300 es.
 */
export function glslToWGSL(
  code: string,
  options: GLSLFnOptions = {},
  stage: 'fragment' | 'vertex' | 'compute' = 'fragment',
): GLSLFunction {
  if (typeof code !== 'string' || !code.trim() || code.length > 65536)
    throw new TypeError('glslToWGSL needs 1..65536 code units of GLSL source with a function in it');
  const { name, defines = {}, flipY = false, strict = false } = options ?? {};
  if (name !== undefined && (typeof name !== 'string' || !identifier.test(name)))
    throw new TypeError('glslFn name must be a GLSL identifier');
  if (typeof flipY !== 'boolean' || typeof strict !== 'boolean')
    throw new TypeError('glslFn flipY and strict must be booleans');
  if (typeof defines !== 'object' || defines === null) throw new TypeError('glslFn defines must be an object');
  for (const [k, v] of Object.entries(defines))
    if (!identifier.test(k) || !['string', 'number', 'boolean'].includes(typeof v) || /[\r\n\\]/.test(String(v)))
      throw new TypeError(`glslFn define ${k} needs an identifier and a one-line string, number or boolean`);
  const implicit = stage === 'fragment';
  const key = JSON.stringify([code, name ?? null, defines, flipY, strict, implicit]);
  const known = cache.get(key);
  if (known) return known;
  // A source without a version directive is GLSL ES 3.00 here, so __VERSION__ and 3.00 built-ins agree.
  const versioned = /^\s*#\s*version\b/m.test(code),
    lines = [
      ...(versioned ? [] : ['#version 300 es']),
      ...Object.entries(defines).map(([k, v]) => `#define ${k} ${typeof v === 'boolean' ? +v : v}`),
    ];
  const info: GLSLSourceInfo = { version: 100 };
  const text = preprocessGLSL(lines.length ? lines.join('\n') + '\n' + code : code, info);
  // The source's first character in the text: each line put before it is a directive, which leaves an empty line.
  const start = lines.length;
  const refuse = (message: string, at: number): never => {
    throw Object.assign(fault('failed', `glslFn: ${message}`), position(text, at, lines.length));
  };
  let program: Program;
  try {
    program = new GLSLParser(text, 'GLSL function').parse();
  } catch (error) {
    // The parser counts lines of the text it read; the source starts after the lines put before it.
    if (typeof (error as { line?: unknown })?.line === 'number') (error as { line: number }).line -= lines.length;
    throw error;
  }
  const uniform = /\buniform\b/.exec(text);
  if (uniform) refuse('a uniform is not available inside a function; pass it as an argument', uniform.index);
  const builtin = /\bgl_\w+/.exec(text);
  if (builtin) refuse(`${builtin[0]} is not available inside a function; pass it as an argument`, builtin.index);
  // Offset of the last match of `pattern` in the text, for messages about a declaration.
  const find = (pattern: string) => {
    let at = start;
    for (const m of text.matchAll(new RegExp(pattern, 'g'))) at = m.index;
    return at;
  };
  const defined = program!.functions.filter((f) => f.body && (name === undefined || f.name === name));
  const entry: FunctionDeclaration =
    defined.at(-1) ?? refuse(name === undefined ? 'the source defines no function' : `the source defines no function ${name}`, start);
  const at = find(String.raw`\b${entry.name}\s*\(`);
  const params = entry.params.map((p): GLSLParameter => {
    if (/\b(out|inout)\b/.test(p.qualifier))
      return refuse(`parameter ${p.name} of ${entry.name} is ${p.qualifier}; the called function takes inputs only`, at);
    const type = dimensions[p.type] ?? nodeType(p.type);
    return type
      ? { name: p.name, glsl: p.type, type }
      : refuse(`parameter ${p.name} has type ${p.type}; use a scalar, vector, square matrix or sampler`, at);
  });
  const result =
    nodeType(entry.type) ?? refuse(`${entry.name} returns ${entry.type}; return a scalar, vector or square matrix`, at);
  glslTranslations.count++;
  const prefix = `glsl${serial++}_`;
  const host: GLSLHost = {
    uniforms: {},
    flipY,
    names: {},
    colorReaders: {},
    prologue: '',
    sample: lookup(implicit),
    entry: { name: entry.name, type: entry.type, params: entry.params.map((p) => p.type) },
    missingEntry: `Define ${entry.name}`,
    epilogue: (fn) => {
      const list = params.map((p, i) =>
          p.glsl in dimensions
            ? `a${i}:texture_${(p.type as string).replace('-', '_')}<f32>,a${i}s:sampler`
            : `a${i}:${p.type}`,
        ),
        args = params.map((p, i) => (p.glsl in dimensions ? `a${i},a${i}s` : `a${i}`));
      return `fn user_entry(${list.join(',')})->${result}{return ${fn}(${args.join(',')});}`;
    },
  };
  let wgsl = new GLSLEmitter(program!, host, info.version).emit();
  // Every name the translation declares at module scope takes this translation's prefix, so any number of GLSL
  // functions share one WGSL module with each other and with the node graph's own names.
  wgsl = wgsl
    .replace(/\buser_/g, prefix)
    .replace(/\baggregate_equal_/g, prefix + 'equal_')
    .replace(/\bmargo_inverse/g, prefix + 'inverse');
  if (!strict) wgsl = wgsl.replace(/^fn /gm, '@diagnostic(off,derivative_uniformity) fn ');
  const translated: GLSLFunction = { code: wgsl, name: prefix + 'entry', params, result };
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(key, translated);
  return translated;
}

// The texture resource `texture()` binds for `source`, so a texture read by nodes and by GLSL binds once.
function textureResource(source: BindableTexture, dimension: GLSLSamplerDimension): Resource {
  const probe = sampled('glslFn', dimension, source, cast(0, 'f32'), undefined);
  let found: Resource | undefined;
  probe.emit(
    {
      resource: (r: Resource) => ((found = r), 'r'),
      expr: () => '0',
      stage: { kind: 'vertex', builtins: {} },
    } as unknown as Builder,
    probe,
  );
  return found!;
}

/**
 * Turns a GLSL function into a node function, as `wgslFn` does for WGSL: the same source runs on WebGPU and on the
 * WebGL2 layer. Call the result with one node or number per parameter, or a `Texture` from `@margoengine/materials`
 * for a sampler parameter. Translation happens here, once per source; errors surface at this call.
 */
export function glslFn<R extends Type = Type>(
  code: string,
  options: GLSLFnOptions = {},
): (...args: (NodeInput | boolean | BindableTexture)[]) => Node<R> {
  const probe = glslToWGSL(code, options),
    id = unique();
  return (...args) => {
    if (args.length !== probe.params.length)
      throw new TypeError(`glslFn ${probe.name}: ${probe.params.length} arguments expected, got ${args.length}`);
    const nodes: Node[] = [],
      textures: Resource[] = [];
    probe.params.forEach((p, i) => {
      const a = args[i],
        label = `glslFn argument ${i + 1} (${p.name})`;
      if (p.glsl in dimensions) textures.push(textureResource(a as BindableTexture, p.type as GLSLSamplerDimension));
      else if (!(a instanceof Node) && (typeof a !== (p.type === 'bool' ? 'boolean' : 'number') || /^mat/.test(p.type)))
        throw new TypeError(`${label} must be a node${/^mat/.test(p.type) ? '' : ' or a ' + (p.type === 'bool' ? 'boolean' : 'number')}`);
      else nodes.push(cast(a as NodeInput, p.type as Type, label));
    });
    // The key names the textures: equal sources with other textures are other expressions.
    const key = `g${id}:${textures.map((t) => (t as { id?: number }).id).join(',')}`;
    return new Node(probe.result as R, key, nodes, (b, n) => {
      const kind = b.stage.kind,
        fn = glslToWGSL(code, options, kind === 'fragment' || kind === 'post' ? 'fragment' : 'vertex');
      b.declare('glsl#' + fn.name, fn.code);
      let k = 0,
        t = 0;
      const list = fn.params.map((p) => {
        if (!(p.glsl in dimensions)) return b.expr(n.args[k++]!);
        const name = b.resource(textures[t++]!);
        return `${name}, ${name}s`;
      });
      return `${fn.name}(${list.join(', ')})`;
    });
  };
}

/** One stage {@link toGLSL} hands to the WebGL2 layer's translator. */
export interface ToGLSLStage {
  readonly source: string;
  readonly entryPoint?: string;
}
/** What {@link toGLSL} hands to the WebGL2 layer's translator (`translateWGSL` of `@margoengine/webgl2-compat/glsl`). */
export interface ToGLSLInput extends ToGLSLOptions {
  readonly vertex: ToGLSLStage;
  readonly fragment?: ToGLSLStage;
}
/** Options of {@link toGLSL}: the layer's own translation options, with its defaults. */
export interface ToGLSLOptions {
  /** The context clips z to [0, w] (EXT_clip_control). Default true. */
  readonly clipControl?: boolean;
  /** The pipeline draws points. Default false. */
  readonly points?: boolean;
  /** Bytes a GLSL uniform block holds. Default 65,536. */
  readonly uniformBlockSize?: number;
  /** acos, asin and atan2 use the layer's float32 versions. Default false. */
  readonly accurateInverseTrig?: boolean;
}
/** The WebGL2 layer's translator, as `await import('@margoengine/webgl2-compat/glsl')` gives it. */
export interface GLSLTranslator<R> {
  translateWGSL(input: ToGLSLInput): R;
}
/** What {@link toGLSL} translates: a NodePass, a NodeMaterial that has drawn, or WGSL stages. */
export type ToGLSLTarget = { code(): string } | object | { readonly vertex: string; readonly fragment?: string };

/**
 * The GLSL ES 3.00 program the WebGL2 layer makes from a NodePass, a NodeMaterial (after it has drawn once) or WGSL
 * stages, with each stage's binding tables. The caller supplies the layer's translator,
 * `await import('@margoengine/webgl2-compat/glsl')`, so this entry never loads the layer itself.
 * @throws MargoError `state` for a NodeMaterial that has not drawn yet; TypeError for another target.
 */
export function toGLSL<R>(target: ToGLSLTarget, glsl: GLSLTranslator<R>, options: ToGLSLOptions = {}): R {
  if (typeof glsl?.translateWGSL !== 'function')
    throw new TypeError(
      "toGLSL needs the layer's translator: toGLSL(target, await import('@margoengine/webgl2-compat/glsl'))",
    );
  const t = target as Record<string, unknown>;
  let vertex: ToGLSLStage, fragment: ToGLSLStage | undefined;
  if (t?.patched instanceof Map) {
    // A NodeMaterial keeps the WGSL of each shader it patched (PassMaterial its outputs on top); the last one drawn.
    const outputs = t.patchedOutputs instanceof Map && t.patchedOutputs.size ? t.patchedOutputs : t.patched;
    const source = [...(outputs as Map<string, string>).values()].at(-1);
    if (source === undefined)
      throw fault('state', 'toGLSL needs a NodeMaterial that has drawn once; render a frame with it first');
    vertex = { source, entryPoint: 'vertex' };
    fragment = { source, entryPoint: 'fragment' };
  } else if (typeof t?.code === 'function') {
    const source = (t.code as () => string)();
    vertex = { source, entryPoint: 'vertex' };
    fragment = { source, entryPoint: 'fragment' };
  } else if (typeof t?.vertex === 'string' && (t.fragment === undefined || typeof t.fragment === 'string')) {
    vertex = { source: t.vertex };
    fragment = t.fragment === undefined ? undefined : { source: t.fragment as string };
  } else throw new TypeError('toGLSL needs a NodePass, a NodeMaterial or { vertex, fragment } WGSL; pass one of them');
  return glsl.translateWGSL({ ...options, vertex, ...(fragment ? { fragment } : {}) });
}
