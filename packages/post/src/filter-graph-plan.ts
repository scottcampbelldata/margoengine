// The image filter graph: plain JSON data, its checks, the block-merging optimizer and the WGSL of each pass. No GPU
// calls here. Merging follows point-to-point and local-to-point kernel fusion (Qiao, Reiche, Hannig and Teich 2019;
// docs/clean-room.md): a block runs inside its only consumer's pass when that consumer reads it at its own pixel, or
// copies one of its texels, so the fused pass evaluates the same function at the same coordinates.
import { filterBlocks } from './filter-graph-blocks.js';

/**
 * How a block reads an image input. `'pixel'`: only at its own pixel; the value is an argument of `apply`. `'texel'`:
 * one unfiltered texel a pixel, through `sample_<name>(uv)` (a fused producer is computed again at each call).
 * `'sample'`: filtered, anywhere and any number of times, through `sample_<name>(uv)`. The optimizer can fuse the block
 * feeding a `'pixel'` or `'texel'` input, never a `'sample'` one.
 */
export type FilterImageAccess = 'pixel' | 'texel' | 'sample';
/** A parameter's type. `color` is a `vec4f` that also takes `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha default 1). */
export type FilterParamType = 'float' | 'int' | 'bool' | 'vec2' | 'vec3' | 'vec4' | 'color';
/** A parameter value; in a node a string `'$name'` instead binds the graph input `name`, and `'$time'` the clock. */
export type FilterValue = number | boolean | string | readonly number[];
/** One live parameter: a uniform, changed with no rebuild. */
export interface FilterParam {
  type: FilterParamType;
  default: FilterValue;
  /** Lowest value of each component. Default none. */
  min?: number;
  /** Highest value of each component. Default none. */
  max?: number;
}
/** A compile-time constant of a block, fixed when the runtime is made. */
export interface FilterConst {
  default: number;
  /** Named choices; when given, a node may pass a name or one of the values. */
  options?: Readonly<Record<string, number>>;
}
/** A block type: a WGSL shader block, or an aggregate (`graph`) made of other blocks. Plain JSON data. */
export interface FilterBlock {
  /** Unique type name: letters, digits, `_`, `-` and `:`. A graph's own block replaces a built-in of the same name. */
  type: string;
  /** Image inputs in `apply` order, at most 8; the first is what a disabled block passes through. Default none. */
  images?: Readonly<Record<string, FilterImageAccess>>;
  /** Live parameters in `apply` order, at most 32. Default none. */
  params?: Readonly<Record<string, FilterParam>>;
  /** Compile-time constants, declared in the shader by name. Default none. */
  consts?: Readonly<Record<string, FilterConst>>;
  /** Output size as a share of the graph output, above 0 up to 4. Default 1. */
  scale?: number;
  /** `false` keeps the block in a pass of its own. Default true. */
  optimize?: boolean;
  /**
   * WGSL declaring `fn apply(uv: vec2f, <one vec4f per 'pixel' image>, <one value per param>) -> vec4f`, with any
   * helper functions, constants and structs. It may call `sample_<image>(uv)`, `size_<image>()`, `filterSize()` and
   * `filterOutputSize()`. No bindings, module variables or entry points. Colours are straight alpha.
   */
  wgsl?: string;
  /** An aggregate: its image inputs and value inputs become the block's images and params. Instead of `wgsl`. */
  graph?: FilterGraph;
}
/** One block in a graph. */
export interface FilterNode {
  /** Unique in its graph, and not an input's name: a letter or `_`, then letters, digits, `_` or `-`. */
  id: string;
  type: string;
  /** Block image name to a node id or an image input name. Every image of the block is needed. */
  images?: Readonly<Record<string, string>>;
  /** Parameter values, or `'$input'` / `'$time'`. Default each parameter's default. */
  params?: Readonly<Record<string, FilterValue>>;
  /** Constant values, a number or an option name. */
  consts?: Readonly<Record<string, number | string>>;
  /** Output size as a share of the graph output. Default the block's. On an aggregate it multiplies its blocks'. */
  scale?: number;
  /** `false` passes the first image through (no image: transparent). A boolean or `'$input'`. Not on aggregates. */
  enabled?: boolean | string;
  /** `false` keeps this block in a pass of its own. Default true. */
  optimize?: boolean;
}
/** A graph input: an image supplied to the runtime, or a named value nodes bind with `'$name'`. */
export type FilterInput = { type: 'image' } | FilterParam;
/** A filter graph: plain JSON data, so `JSON.stringify` saves it and {@link parseFilterGraph} loads it. */
export interface FilterGraph {
  /** Format version. Default and only value 1. */
  version?: 1;
  inputs?: Readonly<Record<string, FilterInput>>;
  nodes?: readonly FilterNode[];
  /** The node id or image input shown. */
  output: string;
  /** Custom and aggregate block types this graph carries with it. */
  blocks?: readonly FilterBlock[];
}
/** Options of {@link planFilterGraph}. */
export interface FilterPlanOptions {
  /** Custom block types beside the built-ins and the graph's own. */
  blocks?: readonly FilterBlock[];
  /** Fuse blocks into as few passes as possible. Default true. */
  optimize?: boolean;
  /** Most textures one pass may read. Default 16, WebGPU's guaranteed `maxSampledTexturesPerShaderStage`. */
  maxTextures?: number;
  /** Multiply colour by alpha in the last pass, for a premultiplied canvas. Default false. */
  premultiply?: boolean;
}
/** One draw of a plan. */
export interface FilterPass {
  /** Ids of the blocks fused into this pass, in dependency order (`outer/inner` inside aggregates). */
  readonly blocks: readonly string[];
  /** Textures read: an image input's name, or the index of an earlier pass. */
  readonly reads: readonly (string | number)[];
  /** Size as a share of the graph output. */
  readonly scale: number;
  /** Intermediate texture written, shared with passes whose lifetimes do not overlap; -1 for the output. */
  readonly texture: number;
  /** The pass's complete WGSL module (`vertex` and `fragment` entry points). */
  readonly shader: string;
  /** Size of the uniform array in vec4f. */
  readonly vectors: number;
  /** Where each live value sits in the uniform array. */
  readonly values: readonly { readonly name: string; readonly vector: number }[];
}
/** A settable value of a plan: a graph input (`name`) or a block parameter (`node.param`, `node.enabled`). */
export interface FilterCell {
  readonly type: FilterParamType;
  readonly value: Float32Array;
  min: number;
  max: number;
}
/** The compiled form of a graph. */
export interface FilterPlan {
  readonly passes: readonly FilterPass[];
  /** Intermediate textures needed. */
  readonly textures: number;
  /** Image inputs the output depends on. */
  readonly images: readonly string[];
  readonly cells: ReadonlyMap<string, FilterCell>;
}

const HELP = '; see https://margoengine.com/errors#filter-graph';
const bad = (message: string) => new TypeError(`ImageFilterGraph ${message}${HELP}`);
const outside = (message: string) => new RangeError(`ImageFilterGraph ${message}${HELP}`);
const NAME = /^[A-Za-z_][\w-]*$/,
  IDENTIFIER = /^[A-Za-z]\w*$/,
  TYPE = /^[A-Za-z_][\w:-]*$/;
const MAX_NODES = 256,
  MAX_DEPTH = 8;
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const SIZE: Record<FilterParamType, number> = { float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4, color: 4 };

/** A cell's current value as a number, boolean or array. */
export function readFilterValue({ type, value }: Pick<FilterCell, 'type' | 'value'>): number | boolean | number[] {
  return type === 'bool' ? value[0] !== 0 : SIZE[type] === 1 ? value[0] : Array.from(value.subarray(0, SIZE[type]));
}

/** Checks `value` against a cell's type and bounds and writes it into `into` (4 floats). Nothing is written on error. */
export function filterValue(
  cell: Pick<FilterCell, 'type' | 'min' | 'max'>,
  value: unknown,
  into: Float32Array,
  label: string,
): void {
  const { type, min, max } = cell,
    size = SIZE[type];
  if (!size) throw bad(`${label} has an unknown type ${String(type)}`);
  let list = value;
  if (type === 'color' && typeof value === 'string') {
    const hex = /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.exec(value)?.[1];
    if (!hex) throw bad(`${label} colour must be #rgb, #rrggbb, #rrggbbaa or an array of 3 or 4 numbers`);
    const full = hex.length === 3 ? hex.replace(/./g, '$&$&') : hex;
    list = [0, 2, 4, 6].map((i) => (i < full.length ? parseInt(full.slice(i, i + 2), 16) / 255 : 1));
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw bad(`${label} must be a boolean`);
    into.fill(0);
    into[0] = +value;
    return;
  }
  const many = size > 1,
    array = list as ArrayLike<number>,
    length = many ? array?.length : 1;
  if (
    many
      ? !(Array.isArray(list) || list instanceof Float32Array) ||
        (length !== size && !(type === 'color' && length === 3))
      : typeof list !== 'number'
  )
    throw bad(`${label} must be ${many ? `an array of ${size} numbers` : 'a number'}`);
  for (let i = 0; i < length!; i++) {
    const n = many ? array[i] : (list as number);
    if (typeof n !== 'number' || !Number.isFinite(n) || (type === 'int' && !Number.isInteger(n)))
      throw outside(`${label} must be ${type === 'int' ? 'a whole number' : 'finite'}`);
    if (n < min || n > max) throw outside(`${label} must be from ${min} to ${max}`);
  }
  into.fill(0);
  if (type === 'color') into[3] = 1;
  for (let i = 0; i < length!; i++) into[i] = many ? array[i] : (list as number);
}

const checkScale = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !(value > 0 && value <= 4)) throw outside(`${label} scale must be above 0 up to 4`);
  return value;
};

const code = (source: string) => source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
/** Names a block's WGSL declares at module scope. */
function declared(source: string): Set<string> {
  const names = new Set<string>();
  let depth = 0;
  for (const match of source.matchAll(/[{}]|\b(?:fn|const|struct|alias)\s+([A-Za-z_]\w*)/g)) {
    if (match[0] === '{') depth++;
    else if (match[0] === '}') depth--;
    else if (depth === 0) names.add(match[1]);
  }
  return names;
}

function checkBlock(block: FilterBlock): FilterBlock {
  record(block, 'block');
  const { type } = block;
  if (typeof type !== 'string' || !TYPE.test(type)) throw bad('block type must be a name');
  const label = `block ${type}`;
  if ((typeof block.wgsl === 'string') === (block.graph !== undefined))
    throw bad(`${label} needs wgsl or graph, not both`);
  if (block.scale !== undefined) checkScale(block.scale, label);
  if (block.graph) return block;
  const images = Object.entries(record(block.images, `${label} images`)),
    params = Object.entries(record(block.params, `${label} params`));
  if (images.length > 8 || params.length > 32) throw outside(`${label} takes at most 8 images and 32 params`);
  for (const [name, access] of images)
    if (!IDENTIFIER.test(name) || !['pixel', 'texel', 'sample'].includes(access as string))
      throw bad(`${label} image ${name} must be an identifier read as pixel, texel or sample`);
  for (const [name, param] of params)
    if (!IDENTIFIER.test(name) || name === 'enabled' || !SIZE[(param as FilterParam)?.type])
      throw bad(`${label} param ${name} needs an identifier other than enabled and a known type`);
  for (const [name, constant] of Object.entries(record(block.consts, `${label} consts`)))
    if (!IDENTIFIER.test(name) || !Number.isFinite((constant as FilterConst)?.default))
      throw bad(`${label} const ${name} needs an identifier and a number default`);
  const source = code(block.wgsl!);
  if (/@(?:group|binding|vertex|fragment|compute)\b|\bvar\s*<(?!\s*function\b)|\b(?:override|enable)\s+\w/.test(source))
    throw bad(`${label} wgsl may not declare bindings, module variables, overrides or entry points`);
  if (!declared(source).has('apply')) throw bad(`${label} wgsl must declare fn apply`);
  return block;
}

/**
 * Reads a block written as one annotated WGSL file: the first line is `// filter-block ` followed by the block's JSON
 * (`type`, `images`, `params`, `consts`, `scale`, `optimize`), and the rest is its `wgsl`.
 * @throws TypeError or RangeError for a missing header, bad JSON or a bad block.
 */
export function parseFilterBlock(source: string): FilterBlock {
  const match = typeof source === 'string' && /^\s*\/\/\s*filter-block\s+(\{.*\})[ \t\r]*\n([\s\S]*)$/.exec(source);
  if (!match) throw bad('block file must start with a line // filter-block {json}');
  let header: object;
  try {
    header = JSON.parse(match[1]);
  } catch (error) {
    throw bad(`block header is not JSON (${(error as Error).message})`);
  }
  return checkBlock({ ...(header as FilterBlock), wgsl: match[2] });
}

/**
 * Parses and checks a saved graph.
 * @throws SyntaxError for bad JSON; TypeError or RangeError for a bad graph.
 */
export function parseFilterGraph(json: string, options: FilterPlanOptions = {}): FilterGraph {
  const graph = JSON.parse(json) as FilterGraph;
  planFilterGraph(graph, options);
  return graph;
}

type Ref = number | string;
interface Node {
  id: string;
  block: FilterBlock;
  images: { name: string; access: FilterImageAccess; from: Ref }[];
  params: { type: FilterParamType; cell: string }[];
  consts: [string, number][];
  enabled: string;
  scale: number;
  optimize: boolean;
}
const COPY: FilterBlock = {
  type: 'copy',
  images: { input: 'pixel' },
  wgsl: 'fn apply(uv: vec2f, color: vec4f) -> vec4f { return color; }',
};

function flatten(graph: FilterGraph, custom: readonly FilterBlock[]) {
  const nodes: Node[] = [],
    cells = new Map<string, FilterCell>(),
    builtins = new Map(filterBlocks.map((block) => [block.type, block]));
  for (const block of custom) builtins.set(block.type, checkBlock(block));
  const cell = (name: string, param: FilterParam, value: unknown, label: string) => {
    for (const bound of [param.min, param.max])
      if (bound !== undefined && !Number.isFinite(bound)) throw outside(`${label} bounds must be finite`);
    const made: FilterCell = {
      type: param.type,
      value: new Float32Array(4),
      min: param.min ?? -Infinity,
      max: param.max ?? Infinity,
    };
    filterValue(made, value, made.value, label);
    cells.set(name, made);
  };
  function expand(
    graph: FilterGraph,
    prefix: string,
    registry: Map<string, FilterBlock>,
    images: Map<string, Ref>,
    values: Map<string, string>,
    scale: number,
    optimize: boolean,
    depth: number,
  ): Ref {
    record(graph, 'graph');
    if (graph.version !== undefined && graph.version !== 1) throw bad('graph version must be 1');
    if (depth > MAX_DEPTH) throw outside(`aggregates nest at most ${MAX_DEPTH} deep (does one contain itself?)`);
    if (graph.nodes !== undefined && !Array.isArray(graph.nodes)) throw bad('graph nodes must be an array');
    const types = new Map(registry);
    for (const block of graph.blocks ?? []) types.set(block.type, checkBlock(block));
    const byId = new Map<string, FilterNode>(),
      done = new Map<string, Ref | null>();
    for (const node of graph.nodes ?? []) {
      record(node, 'node');
      if (typeof node.id !== 'string' || !NAME.test(node.id)) throw bad('node id must be a name');
      if (byId.has(node.id) || Object.hasOwn(graph.inputs ?? {}, node.id)) throw bad(`name ${node.id} is used twice`);
      byId.set(node.id, node);
    }
    const resolve = (name: unknown, label: string): Ref => {
      const image = images.get(name as string);
      if (image !== undefined) return image;
      const node = byId.get(name as string);
      if (!node) throw bad(`${label} names no node or image input: ${String(name)}`);
      return visit(node);
    };
    /** The cell a '$name' binds, checked against the type that reads it. */
    const bind = (reference: string, type: FilterParam, label: string): string => {
      const name = reference.slice(1),
        key = name === 'time' && !values.has(name) ? '$time' : values.get(name);
      if (!key) throw bad(`${label} binds ${reference}, which is no value input`);
      const kind = (t: FilterParamType) => (t === 'color' ? 'vec4' : t),
        found = key === '$time' ? undefined : cells.get(key)!;
      if (kind(found?.type ?? 'float') !== kind(type.type))
        throw bad(`${label} is ${type.type} but ${reference} is ${found?.type ?? 'float'}`);
      if (found) {
        found.min = Math.max(found.min, type.min ?? -Infinity);
        found.max = Math.min(found.max, type.max ?? Infinity);
        filterValue(found, readFilterValue(found), found.value, label);
      }
      return key;
    };
    function visit(node: FilterNode): Ref {
      const known = done.get(node.id);
      if (known === null) throw bad(`graph has a cycle through ${node.id}`);
      if (known !== undefined) return known;
      done.set(node.id, null);
      const id = prefix + node.id,
        block = types.get(node.type);
      if (!block) throw bad(`node ${id} has an unknown block type ${String(node.type)}`);
      const inner = block.graph,
        inputs = Object.entries(inner?.inputs ?? {}),
        takes: [string, FilterImageAccess][] = inner
          ? inputs.filter(([, i]) => i.type === 'image').map(([name]) => [name, 'sample'])
          : (Object.entries(block.images ?? {}) as [string, FilterImageAccess][]),
        params: [string, FilterParam][] = inner
          ? (inputs.filter(([, i]) => i.type !== 'image') as [string, FilterParam][])
          : Object.entries(block.params ?? {}),
        given = record(node.images, `node ${id} images`),
        set = record(node.params, `node ${id} params`);
      for (const name of Object.keys(given))
        if (!takes.some(([n]) => n === name)) throw bad(`node ${id} has no image ${name}`);
      for (const name of Object.keys(set))
        if (!params.some(([n]) => n === name)) throw bad(`node ${id} has no param ${name}`);
      for (const name of Object.keys(record(node.consts, `node ${id} consts`)))
        if (!Object.hasOwn(block.consts ?? {}, name)) throw bad(`node ${id} has no const ${name}`);
      const from = takes.map(([name, access]) => ({
        name,
        access,
        from: resolve(given[name], `node ${id} image ${name}`),
      }));
      const bound = params.map(([name, param]) => {
        const value = set[name];
        let key = `${id}.${name}`;
        if (typeof value === 'string' && value.startsWith('$')) key = bind(value, param, `node ${id} param ${name}`);
        else cell(key, param, value === undefined ? param.default : value, `node ${id} param ${name}`);
        return { name, type: param.type, cell: key };
      });
      const own = checkScale(node.scale ?? block.scale ?? 1, `node ${id}`) * scale,
        fuse = optimize && node.optimize !== false && block.optimize !== false;
      let result: Ref;
      if (inner) {
        if (node.enabled !== undefined) throw bad(`node ${id} is an aggregate; enabled is for shader blocks`);
        result = expand(
          inner,
          `${id}/`,
          types,
          new Map(from.map((i) => [i.name, i.from])),
          new Map(bound.map((p) => [p.name, p.cell])),
          own,
          fuse,
          depth + 1,
        );
      } else {
        checkScale(own, `node ${id}`);
        const enabled: FilterParam = { type: 'bool', default: true };
        let key = `${id}.enabled`;
        if (typeof node.enabled === 'string') key = bind(node.enabled, enabled, `node ${id} enabled`);
        else cell(key, enabled, node.enabled ?? true, `node ${id} enabled`);
        const consts = Object.entries(block.consts ?? {}).map(([name, constant]): [string, number] => {
          let value: unknown = node.consts?.[name] ?? constant.default;
          if (typeof value === 'string') value = constant.options?.[value];
          if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            (constant.options && !Object.values(constant.options).includes(value))
          )
            throw outside(`node ${id} const ${name} must be one of its options or a finite number`);
          return [name, value];
        });
        if (nodes.length >= MAX_NODES) throw outside(`graphs take at most ${MAX_NODES} blocks`);
        result =
          nodes.push({ id, block, images: from, params: bound, consts, enabled: key, scale: own, optimize: fuse }) - 1;
      }
      done.set(node.id, result);
      return result;
    }
    for (const node of byId.values()) visit(node);
    return resolve(graph.output, 'graph output');
  }
  record(graph, 'graph');
  const images = new Map<string, Ref>(),
    values = new Map<string, string>();
  for (const [name, input] of Object.entries(record(graph.inputs, 'graph inputs')) as [string, FilterInput][]) {
    if (!NAME.test(name) || name === 'time') throw bad(`input ${name} must be a name other than time`);
    if (input?.type === 'image') images.set(name, name);
    else {
      cell(name, input, input?.default, `input ${name}`);
      values.set(name, name);
    }
  }
  let root = expand(graph, '', builtins, images, values, 1, true, 0);
  if (typeof root === 'string' || nodes[root].scale !== 1) {
    cell('(output).enabled', { type: 'bool', default: true }, true, 'output');
    root =
      nodes.push({
        id: '(output)',
        block: COPY,
        images: [{ name: 'input', access: 'pixel', from: root }],
        params: [],
        consts: [],
        enabled: '(output).enabled',
        scale: 1,
        optimize: true,
      }) - 1;
  }
  return { nodes, cells, root };
}

const WGSL: Record<FilterParamType, string> = {
  float: '.x',
  int: '.x',
  bool: '.x',
  vec2: '.xy',
  vec3: '.xyz',
  vec4: '',
  color: '',
};
const SNAP = (uv: string, size: string) => `clamp(floor(${uv}*${size}),vec2f(0.0),${size}-1.0)`;

/** The WGSL of one pass: `members` in dependency order, the last one its root. */
function shader(nodes: Node[], members: number[], reads: Ref[], premultiply: boolean) {
  const values: { name: string; vector: number }[] = [],
    local = new Map(members.map((n, k) => [n, k]));
  let body = '';
  const slot = (name: string) => {
    let found = values.find((v) => v.name === name);
    if (!found) values.push((found = { name, vector: values.length + 2 }));
    return `u[${found.vector}]`;
  };
  members.forEach((index, k) => {
    const node = nodes[index],
      prefix = `b${k}_`,
      args = ['uv'];
    // Each producer is called from as few places as can be: a compiler inlines calls, so two a block would double the
    // code with every fused block before it.
    let pass = 'vec4f(0.0)',
      colours = '';
    node.images.forEach((image, i) => {
      const fused = typeof image.from === 'number' ? local.get(image.from) : undefined,
        t = `t${reads.indexOf(image.from)}`,
        pixel = fused === undefined ? `textureSampleLevel(${t},linearSampler,uv,0.0)` : `b${fused}(uv)`;
      if (image.access === 'pixel') {
        colours += `let i${i}=${pixel};`;
        args.push(`i${i}`);
      } else {
        const sample = `${prefix}sample_${image.name}`;
        body +=
          fused !== undefined
            ? `fn ${sample}(uv:vec2f)->vec4f{let s=u[0].xy;return b${fused}((${SNAP('uv', 's')}+0.5)/s);}\n`
            : image.access === 'texel'
              ? `fn ${sample}(uv:vec2f)->vec4f{let s=vec2f(textureDimensions(${t}));return textureLoad(${t},vec2i(${SNAP('uv', 's')}),0);}\n`
              : `fn ${sample}(uv:vec2f)->vec4f{return textureSampleLevel(${t},linearSampler,uv,0.0);}\n`;
        body += `fn ${prefix}size_${image.name}()->vec2f{return ${fused === undefined ? `vec2f(textureDimensions(${t}))` : 'u[0].xy'};}\n`;
      }
      if (i === 0) pass = image.access === 'pixel' ? 'i0' : `${prefix}sample_${image.name}(uv)`;
    });
    for (const { type, cell } of node.params) {
      const read = cell === '$time' ? 'u[0].z' : slot(cell) + WGSL[type];
      args.push(type === 'int' ? `i32(${read})` : type === 'bool' ? `(${read}!=0.0)` : read);
    }
    const source = node.consts.map(([name, value]) => `const ${name} = ${value};\n`).join('') + code(node.block.wgsl!),
      names = declared(source);
    for (const image of node.images) names.add(`sample_${image.name}`).add(`size_${image.name}`);
    body += source.replace(/(?<![.\w])[A-Za-z_]\w*/g, (word) => (names.has(word) ? prefix + word : word));
    // A fused result is rounded as the rgba16float texture it stands in for would round it, so the blocks reading it
    // compute from the same numbers as with a pass each: a steep one (a key, a high contrast) would otherwise differ.
    const round = (value: string) =>
      k === members.length - 1 ? value : `quantizeToF16(clamp(${value},vec4f(-65504.0),vec4f(65504.0)))`;
    body += `\nfn b${k}(uv:vec2f)->vec4f{${colours}if(${slot(node.enabled)}.x==0.0){return ${round(pass)};}return ${round(`${prefix}apply(${args.join(',')})`)};}\n`;
  });
  const vectors = values.length + 2,
    result = `b${members.length - 1}(p.xy/u[0].xy)`;
  return {
    vectors,
    values,
    shader:
      `@group(0) @binding(0) var<uniform> u:array<vec4f,${vectors}>;\n@group(0) @binding(1) var linearSampler:sampler;\n` +
      reads.map((_, i) => `@group(0) @binding(${i + 2}) var t${i}:texture_2d<f32>;\n`).join('') +
      'fn filterSize()->vec2f{return u[0].xy;}\nfn filterOutputSize()->vec2f{return u[1].xy;}\n' +
      body +
      `@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{let p=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));return vec4f(p[i],0.0,1.0);}\n` +
      `@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{` +
      (premultiply ? `let c=${result};return vec4f(c.rgb*c.a,c.a);}` : `return ${result};}`),
  };
}

/**
 * Compiles a graph into passes without touching the GPU: checks it, expands aggregates, drops unused blocks, fuses what
 * can be fused, shares intermediate textures between passes and writes each pass's WGSL.
 * @throws TypeError or RangeError for a bad graph, block or value.
 */
export function planFilterGraph(graph: FilterGraph, options: FilterPlanOptions = {}): FilterPlan {
  const { blocks = [], optimize = true, maxTextures = 16, premultiply = false } = options;
  if (!Number.isInteger(maxTextures) || maxTextures < 1) throw outside('maxTextures must be a whole number >= 1');
  const { nodes, cells, root } = flatten(graph, blocks);
  const order: number[] = [],
    uses = new Map<number, { consumer: number; access: FilterImageAccess; count: number }>(),
    seen = new Set<number>();
  const walk = (index: number) => {
    if (seen.has(index)) return;
    seen.add(index);
    for (const { from, access } of nodes[index].images)
      if (typeof from === 'number') {
        uses.set(from, { consumer: index, access, count: (uses.get(from)?.count ?? 0) + 1 });
        walk(from);
      }
    order.push(index);
  };
  walk(root);
  for (const index of order)
    if (nodes[index].images.length > maxTextures)
      throw outside(`block ${nodes[index].id} reads more than ${maxTextures} textures`);
  // Consumers before producers: each block joins its only consumer's pass when it can.
  const group = new Map<number, { root: number; reads: Set<Ref> }>(),
    // Fused texel reads between a block and its pass's root. A disabled texel reader calls its producer from a second
    // place, so one such link a chain keeps the shader's size linear in its blocks.
    links = new Map<number, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const index = order[i],
      node = nodes[index],
      use = uses.get(index),
      own = node.images.map((image) => image.from);
    if (optimize && use?.count === 1 && use.access !== 'sample') {
      const consumer = nodes[use.consumer],
        into = group.get(use.consumer)!;
      const texels = (links.get(use.consumer) ?? 0) + +(use.access === 'texel');
      if (node.optimize && consumer.optimize && node.scale === consumer.scale && texels <= 1) {
        const reads = new Set([...into.reads, ...own]);
        reads.delete(index);
        if (reads.size <= maxTextures) {
          into.reads = reads;
          links.set(index, texels);
          group.set(index, into);
          continue;
        }
      }
    }
    group.set(index, { root: index, reads: new Set(own) });
  }
  const groups = order.filter((index) => group.get(index)!.root === index).map((index) => group.get(index)!),
    passOf = new Map(groups.map((g, i) => [g.root, i])),
    lastRead = new Map<number, number>();
  groups.forEach((g, i) => {
    for (const read of g.reads) if (typeof read === 'number') lastRead.set(read, i);
  });
  const slots: { scale: number; free: boolean }[] = [],
    held = new Map<number, number>(),
    images = new Set<string>();
  const passes = groups.map((g, i): FilterPass => {
    const reads = [...g.reads],
      scale = nodes[g.root].scale,
      // Blocks of a pass keep the dependency order of the whole graph.
      members = order.filter((index) => group.get(index) === g);
    let texture = -1;
    if (g.root !== root) {
      texture = slots.findIndex((s) => s.free && s.scale === scale);
      if (texture < 0) texture = slots.push({ scale, free: false }) - 1;
      slots[texture].free = false;
      held.set(g.root, texture);
    }
    for (const read of reads)
      if (typeof read === 'string') images.add(read);
      else if (lastRead.get(read) === i) slots[held.get(read)!].free = true;
    return {
      blocks: members.map((index) => nodes[index].id),
      reads: reads.map((read) => (typeof read === 'string' ? read : passOf.get(read)!)),
      scale,
      texture,
      ...shader(nodes, members, reads, premultiply && g.root === root),
    };
  });
  const names = Object.keys(graph.inputs ?? {});
  return { passes, textures: slots.length, images: names.filter((name) => images.has(name)), cells };
}
