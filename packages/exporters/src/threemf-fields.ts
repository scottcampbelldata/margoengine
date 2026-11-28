// The 3MF volumetric, implicit and displacement extensions' writer, which `export3MF` loads when a node asks for one.
// From the 3MF Consortium's specifications: Volumetric and Implicit Extensions
// (https://github.com/3MFConsortium/spec_volumetric) and Displacement Extension
// (https://github.com/3MFConsortium/spec_displacement).
import { isMixColor } from './mix-color.js';
import { num, type ExportNode, type Geo } from './scene.js';
import type { ThreeMFConstituent, ThreeMFLattice } from './threemf.js';

/** A volumetric function's data type. */
export type ThreeMFValueType = 'scalar' | 'vector' | 'matrix' | 'resourceid';

/** How a sampler treats a coordinate outside 0 to 1. */
export type ThreeMFTileStyle = 'wrap' | 'mirror' | 'clamp';

/**
 * A voxel grid as PNG pictures of one size and pixel layout: `u` runs across the columns, `v` across the rows and `w`
 * across the sheets.
 */
export interface ThreeMFImageStack {
  sheets: readonly Uint8Array[];
  name?: string;
}

/**
 * A function that samples an image stack at its `pos` input, in 0 to 1 on each axis. Its outputs are `color` (a vector)
 * and `red`, `green`, `blue` and `alpha` (scalars), each `sample * scale + offset`.
 */
export interface ThreeMFImageFunction {
  image: ThreeMFImageStack;
  /** Default `'linear'`. */
  filter?: 'linear' | 'nearest';
  /** One tile style, or one each for `u`, `v` and `w`. Default `'wrap'`. */
  tile?: ThreeMFTileStyle | readonly [ThreeMFTileStyle, ThreeMFTileStyle, ThreeMFTileStyle];
  /** Default 0. */
  offset?: number;
  /** Default 1. */
  scale?: number;
  name?: string;
}

/** One node of an implicit function's graph. */
export interface ThreeMFNode {
  /** Letters, digits and `_`; not `inputs` or `outputs`. */
  id: string;
  /** The native node's element name, such as `'addition'`, `'length'`, `'constant'` or `'functioncall'`. */
  op: string;
  /** Each input by name, as `'node.output'` of an earlier node or `'inputs.name'` of the function. */
  in?: Readonly<Record<string, string>>;
  /**
   * What a constant node holds: a number (`constant`), three (`constvec`), sixteen in rows (`constmat`), or for
   * `constresourceid` a function, a mesh node or a mesh node with a lattice. A mesh is in the function's coordinates.
   */
  value?: number | ArrayLike<number> | ThreeMFFunction | ExportNode | { node: ExportNode; lattice: ThreeMFLattice };
  /**
   * The output types of a `functioncall` whose function comes from an input, which the writer cannot look up. Default
   * the called function's own.
   */
  outputs?: Readonly<Record<string, ThreeMFValueType>>;
  /** `functiongradient` and `normalizedistance`: the called function's scalar output. */
  scalarOutput?: string;
  /** `functiongradient` and `normalizedistance`: the called function's vector input to differentiate. */
  vectorInput?: string;
  /** `beamlattice`: the distance band around the lattice that must be exact. Default 0. */
  accurateRange?: number;
  name?: string;
}

/** A closed-form function: a graph of native nodes (implicit extension). */
export interface ThreeMFImplicitFunction {
  /** The inputs by name. Default `{ pos: 'vector' }`, what a volume or level set supplies. */
  inputs?: Readonly<Record<string, ThreeMFValueType>>;
  /** In order: a node reads only inputs and the nodes before it. */
  nodes: readonly ThreeMFNode[];
  /** Each output by name, as `'node.output'` or `'inputs.name'`. */
  outputs: Readonly<Record<string, string>>;
  name?: string;
}

/** A function of volumetric data. One object used twice is written once. */
export type ThreeMFFunction = ThreeMFImageFunction | ThreeMFImplicitFunction;

/** A function's output sampled over an object. */
export interface ThreeMFField {
  function: ThreeMFFunction;
  /**
   * The output to sample. Default `'color'` or `'red'` of an image function, or an implicit function's one output of the
   * type needed.
   */
  channel?: string;
  /**
   * A column-major 4 x 4 matrix from the node's geometry coordinates to the function's. Default: for an image function,
   * the geometry's bounding box onto 0 to 1; for an implicit function, the identity.
   */
  transform?: ArrayLike<number>;
  /** The smallest feature to resolve, in scene units. Default 0, no hint. */
  minFeatureSize?: number;
  /** The value where the function is undefined. Default 0. */
  fallback?: number;
}

/** A named property over an object's volume, under a namespace of its owner. */
export interface ThreeMFVolumeProperty extends ThreeMFField {
  namespace: string;
  /** An XML name without a colon. */
  name: string;
  /** A consumer that cannot process it must say so. Default `false`. */
  required?: boolean;
}

/** What fills an object's volume. */
export interface ThreeMFVolume {
  /** Linear RGB, from a vector output. */
  color?: ThreeMFField;
  /** A mixture of base materials, each material's share from a scalar output. */
  composite?: readonly (ThreeMFConstituent & ThreeMFField)[];
  properties?: readonly ThreeMFVolumeProperty[];
}

/** A shape bounded where a function's scalar output is zero, inside the node's mesh. */
export interface ThreeMFLevelSet extends ThreeMFField {
  /** Evaluates the whole bounding box of the mesh instead of its inside. Default `false`. */
  boundingBoxOnly?: boolean;
}

/** A height map that moves a node's surface (displacement extension). */
export interface ThreeMFDisplacement {
  /** A PNG picture. */
  image: Uint8Array;
  /** The height of a white sample, in the node's geometry units; negative sinks the surface. */
  height: number;
  /** The height of a black sample. Default 0. */
  offset?: number;
  /** Default `'G'`. */
  channel?: 'R' | 'G' | 'B' | 'A';
  /** One tile style for `u` and `v`, or one each. Default `'wrap'`. */
  tile?: ThreeMFTileStyle | 'none' | readonly [ThreeMFTileStyle | 'none', ThreeMFTileStyle | 'none'];
  /** Default `'auto'`. */
  filter?: 'auto' | 'linear' | 'nearest';
  /** Which UV set of the geometry places the picture. Default 0. */
  texCoord?: 0 | 1 | 2 | 3;
  /**
   * `'smooth'`, the default, moves each welded vertex along the mean of its triangles' normals, so the surface stays
   * closed; `'normals'` uses the geometry's vertex normals.
   */
  vectors?: 'smooth' | 'normals';
  /** A factor of the height at each vertex, 0 or more, given its position in geometry coordinates. Default 1. */
  factor?: (position: [number, number, number]) => number;
}

/** What the writer needs of `export3MF`. */
export interface FieldContext {
  id(): number;
  escaped(text: string): string;
  /** File units per scene unit. */
  scale: number;
  /** Adds a property resource, before every object. */
  group(xml: string): void;
  /** Adds a volumetric resource, in order, after the property resources and before the objects. */
  resource(xml: string): void;
  /** Adds a PNG part that the root model part samples. */
  file(name: string, data: Uint8Array): void;
  /** Writes a mesh node, as given, as an object among the volumetric resources, and gives its id. */
  mesh(node: ExportNode, lattice: ThreeMFLattice | undefined): number;
}

type Types = Record<string, ThreeMFValueType>;

const fail = (message: string): never => {
  throw new RangeError(`3MF ${message}`);
};
const IDENTIFIER = /^[A-Za-z0-9_]+$/;
const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const TILES = ['wrap', 'mirror', 'clamp'];
const IMAGE_OUTPUTS: Types = { color: 'vector', red: 'scalar', green: 'scalar', blue: 'scalar', alpha: 'scalar' };
const ELEMENTWISE: ThreeMFValueType[] = ['scalar', 'vector', 'matrix'];
const NOT_MATRIX: ThreeMFValueType[] = ['scalar', 'vector'];
const words = (text: string): string[] => text.split(' ');

/** Native nodes whose result has the one type all of their inputs share: their inputs and the types allowed. */
const SAME = new Map<string, [string[], ThreeMFValueType[]]>();
for (const op of words('abs sqrt exp log log2 log10 cosh sinh tanh round ceil floor sign fract'))
  SAME.set(op, [['A'], ELEMENTWISE]);
for (const op of words('sin cos tan asin acos atan')) SAME.set(op, [['A'], NOT_MATRIX]);
for (const op of words('addition subtraction multiplication division fmod mod pow min max'))
  SAME.set(op, [['A', 'B'], ELEMENTWISE]);
SAME.set('atan2', [['A', 'B'], NOT_MATRIX]);
SAME.set('clamp', [['A', 'min', 'max'], ELEMENTWISE]);
SAME.set('select', [['A', 'B', 'C', 'D'], ELEMENTWISE]);

const all = (names: string, type: ThreeMFValueType): Types => Object.fromEntries(words(names).map((n) => [n, type]));
const COLUMNS: [Types, Types] = [all('A B C D', 'vector'), { result: 'matrix' }];
/** Native nodes of fixed types: inputs, then outputs. */
const FIXED: Record<string, [Types, Types]> = {
  composevector: [all('x y z', 'scalar'), { result: 'vector' }],
  vectorfromscalar: [{ A: 'scalar' }, { result: 'vector' }],
  decomposevector: [{ A: 'vector' }, all('x y z', 'scalar')],
  composematrix: [
    all([0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => `m${r}${c}`).join(' ')).join(' '), 'scalar'),
    { result: 'matrix' },
  ],
  matrixfromcolumns: COLUMNS,
  matrixfromrows: COLUMNS,
  dot: [all('A B', 'vector'), { result: 'scalar' }],
  cross: [all('A B', 'vector'), { result: 'vector' }],
  matvecmultiplication: [{ A: 'matrix', B: 'vector' }, { result: 'vector' }],
  transpose: [{ A: 'matrix' }, { result: 'matrix' }],
  inverse: [{ A: 'matrix' }, { result: 'matrix' }],
  length: [{ A: 'vector' }, { result: 'scalar' }],
  mesh: [{ pos: 'vector', mesh: 'resourceid' }, { distance: 'scalar' }],
  unsignedmesh: [{ pos: 'vector', mesh: 'resourceid' }, { distance: 'scalar' }],
  beamlattice: [{ pos: 'vector', beamlattice: 'resourceid' }, { distance: 'scalar' }],
  constant: [{}, { value: 'scalar' }],
  constvec: [{}, { vector: 'vector' }],
  constmat: [{}, { matrix: 'matrix' }],
  constresourceid: [{}, { value: 'resourceid' }],
};

/** What a function offers: its id in the file and the types of its inputs and outputs. */
interface Written {
  id: number;
  inputs: Types;
  outputs: Types;
}

/** A PNG's size and pixel layout, from its header chunk. */
function pngHeader(bytes: Uint8Array, what: string): { width: number; height: number; layout: string } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  if (!(bytes instanceof Uint8Array) || bytes.length < 33 || signature.some((v, i) => bytes[i] !== v))
    throw new TypeError(`3MF ${what} must be PNG bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset),
    width = view.getUint32(16),
    height = view.getUint32(20);
  if (!width || !height) fail(`${what} has no pixels`);
  return { width, height, layout: `${bytes[24]} ${bytes[25]}` };
}

const finite = (value: number, what: string): string =>
  typeof value === 'number' && Number.isFinite(value) ? num(value) : fail(`${what} must be a finite number`);
const oneOf = <T extends string>(value: T, list: readonly string[], what: string): T =>
  list.includes(value) ? value : fail(`${what} must be one of ${list.join(', ')}`);

/** Column-major 4 x 4 product `a b`. */
function multiply(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

/** The writer of one file's volumetric and displacement resources. */
export function fieldWriter(context: FieldContext) {
  const { id, escaped, scale } = context,
    functions = new Map<ThreeMFFunction, Written>(),
    images = new Map<ThreeMFImageStack, number>(),
    writing = new Set<ThreeMFFunction>(),
    volumes = new Map<string, number>(),
    /** The prefix of each property namespace. */
    prefixes = new Map<string, string>(),
    used = { volumetric: false, implicit: false, references: false, levelSet: false, displacement: false };
  let sheetFolders = 0,
    heightMaps = 0;
  const named = (name: string | undefined, attribute = 'displayname'): string =>
    name === undefined ? '' : ` ${attribute}="${escaped(String(name))}"`;

  const image = (stack: ThreeMFImageStack): number => {
    let at = images.get(stack);
    if (at !== undefined) return at;
    const sheets = stack?.sheets;
    if (!Array.isArray(sheets) || !sheets.length) fail('image stacks need at least one sheet');
    const headers = (sheets as readonly Uint8Array[]).map((sheet) => pngHeader(sheet, 'image sheets')),
      [first] = headers;
    if (headers.some((h) => h.width !== first.width || h.height !== first.height || h.layout !== first.layout))
      fail('image sheets must share one size, colour type and bit depth');
    const folder = `3D/volumetric/stack${++sheetFolders}`,
      listed = (sheets as readonly Uint8Array[]).map((data, i) => {
        const path = `${folder}/sheet${String(i + 1).padStart(4, '0')}.png`;
        context.file(path, data);
        return `<v:imagesheet path="/${path}"/>`;
      });
    images.set(stack, (at = id()));
    context.resource(
      `<v:image3d id="${at}"${named(stack.name, 'name')}><v:imagestack rowcount="${first.height}" columncount="${first.width}" sheetcount="${sheets.length}">${listed.join('')}</v:imagestack></v:image3d>`,
    );
    return at;
  };

  const functionOf = (source: ThreeMFFunction): Written => {
    let found = functions.get(source);
    if (found) return found;
    if (typeof source !== 'object' || source === null) throw new TypeError('3MF volumetric data needs a function');
    if (writing.has(source)) fail('functions must not call themselves, directly or through one another');
    writing.add(source);
    found = 'image' in source ? imageFunction(source) : implicitFunction(source);
    writing.delete(source);
    functions.set(source, found);
    used.volumetric = true;
    return found;
  };

  const imageFunction = (source: ThreeMFImageFunction): Written => {
    const { filter = 'linear', tile = 'wrap', offset = 0, scale: factor = 1 } = source,
      tiles = typeof tile === 'string' ? [tile, tile, tile] : Array.from(tile);
    if (tiles.length !== 3) fail('image functions take one tile style or three');
    const styles = tiles.map((t, i) => ` tilestyle${'uvw'[i]}="${oneOf(t, TILES, 'tile style')}"`),
      sampled = image(source.image),
      at = id();
    context.resource(
      `<v:functionfromimage3d id="${at}"${named(source.name)} image3did="${sampled}" valueoffset="${finite(offset, 'function offset')}" valuescale="${finite(factor, 'function scale')}" filter="${oneOf(filter, ['linear', 'nearest'], 'filter')}"${styles.join('')}/>`,
    );
    return { id: at, inputs: { pos: 'vector' }, outputs: IMAGE_OUTPUTS };
  };

  const implicitFunction = ({ inputs = { pos: 'vector' }, nodes, outputs, name }: ThreeMFImplicitFunction): Written => {
    if (!Array.isArray(nodes)) fail('implicit functions need a list of nodes');
    const identifier = (value: string): string =>
        typeof value === 'string' && IDENTIFIER.test(value)
          ? value
          : fail(`identifier ${JSON.stringify(value)} must be letters, digits and _`),
      /** The type of every output a later node may read. */
      known = new Map<string, ThreeMFValueType>(),
      /** The function or mesh each constant resource id names. */
      resources = new Map<string, ThreeMFFunction | undefined>(),
      ids = new Set<string>(),
      read = (ref: string): ThreeMFValueType =>
        known.get(ref) ?? fail(`reference ${JSON.stringify(ref)} names no input or earlier node's output`),
      reference = (name: string, ref: string, type: ThreeMFValueType): string =>
        `<i:${type === 'resourceid' ? 'resourceref' : `${type}ref`} identifier="${identifier(name)}" ref="${ref}"/>`,
      declared = (types: Types): string =>
        Object.entries(types)
          .map(([n, type]) => {
            oneOf(type, ['scalar', 'vector', 'matrix', 'resourceid'], 'data type');
            return `<i:${type} identifier="${identifier(n)}"/>`;
          })
          .join('');
    const head = declared(inputs);
    for (const [n, type] of Object.entries(inputs)) known.set(`inputs.${n}`, type);
    const body = (nodes as readonly ThreeMFNode[]).map((node) => {
      const { op, in: wired = {}, value } = node,
        own = identifier(node.id);
      if (own === 'inputs' || own === 'outputs' || ids.has(own))
        fail(`node identifier ${own} is reserved or used twice`);
      ids.add(own);
      const types = Object.entries(wired).map(([n, ref]) => [n, ref, read(ref)] as const),
        expect = (wanted: Types, open = false): void => {
          for (const [n, type] of Object.entries(wanted))
            if (types.find((t) => t[0] === n)?.[2] !== type) fail(`node ${own} needs a ${type} input ${n}`);
          if (!open && types.length !== Object.keys(wanted).length)
            fail(`node ${own} has an input ${op} does not take`);
        };
      let results: Types,
        attributes = '';
      const same = SAME.get(op);
      if (same) {
        const [names, allowed] = same,
          type = types.find((t) => t[0] === names[0])?.[2];
        if (!type || !allowed.includes(type)) fail(`node ${own}: ${op} takes ${allowed.join(' or ')} inputs`);
        expect(Object.fromEntries(names.map((n) => [n, type!])));
        results = { result: type! };
      } else if (Object.hasOwn(FIXED, op)) {
        expect(FIXED[op][0]);
        results = FIXED[op][1];
        const list = (count: number): string[] => {
          const values = Array.from(value as ArrayLike<number>);
          if (values.length !== count) fail(`node ${own} needs ${count} numbers`);
          return values.map((v) => finite(v, `node ${own}'s value`));
        };
        if (op === 'constant') attributes = ` value="${finite(value as number, `node ${own}'s value`)}"`;
        else if (op === 'constvec') {
          const [x, y, z] = list(3);
          attributes = ` x="${x}" y="${y}" z="${z}"`;
        } else if (op === 'constmat') attributes = ` matrix="${list(16).join(' ')}"`;
        else if (op === 'constresourceid') {
          if (typeof value !== 'object' || value === null)
            fail(`node ${own} needs a function or a mesh node as its value`);
          // A function has an image or outputs; anything else is a mesh node, bare or with its lattice.
          const given = value as object,
            isFunction = 'image' in given || 'outputs' in given;
          let written: number;
          if (isFunction) {
            written = functionOf(value as ThreeMFFunction).id;
            resources.set(`${own}.value`, value as ThreeMFFunction);
          } else {
            const { node: mesh, lattice } = value as { node?: ExportNode; lattice?: ThreeMFLattice };
            used.references = true;
            written = context.mesh(mesh ?? (value as ExportNode), lattice);
          }
          attributes = ` value="${written}"`;
        } else if (op === 'beamlattice' && node.accurateRange !== undefined)
          attributes = ` accuraterange="${finite(node.accurateRange, 'accurateRange')}"`;
      } else if (op === 'functioncall' || op === 'functiongradient' || op === 'normalizedistance') {
        expect({ functionID: 'resourceid', ...(op === 'functioncall' ? {} : { step: 'scalar' }) }, true);
        const target = resources.get(wired.functionID),
          called = target && functions.get(target);
        if (called) {
          // A function call's other inputs are the called function's own; a gradient's `step` is its own too.
          expect({
            functionID: 'resourceid',
            ...(op === 'functioncall' ? {} : { step: 'scalar' }),
            ...called.inputs,
          });
        }
        if (op === 'functioncall') {
          const given = node.outputs ?? called?.outputs;
          if (!given) fail(`node ${own} calls a function the writer cannot look up; give its outputs`);
          results = given!;
        } else {
          const { scalarOutput = '', vectorInput = '' } = node;
          identifier(scalarOutput);
          identifier(vectorInput);
          if (called && (called.outputs[scalarOutput] !== 'scalar' || called.inputs[vectorInput] !== 'vector'))
            fail(`node ${own} needs a scalar output and a vector input of the function it calls`);
          attributes = ` scalaroutput="${scalarOutput}" vectorinput="${vectorInput}"`;
          results =
            op === 'normalizedistance'
              ? { result: 'scalar' }
              : { vector: 'vector', gradient: 'vector', magnitude: 'scalar' };
        }
      } else return fail(`has no implicit node ${JSON.stringify(op)}`);
      const wiring = types.map(([n, ref, type]) => reference(n, ref, type)).join(''),
        out = declared(results);
      for (const [n, type] of Object.entries(results)) known.set(`${own}.${n}`, type);
      return `<i:${op} identifier="${own}"${named(node.name)}${attributes}>${wiring ? `<i:in>${wiring}</i:in>` : ''}<i:out>${out}</i:out></i:${op}>`;
    });
    const offered: Types = {},
      tail = Object.entries(outputs ?? {}).map(([n, ref]) => {
        const type = read(ref);
        if (type === 'resourceid') fail('a function does not output a resource id');
        offered[n] = type;
        return reference(n, ref, type);
      });
    if (!tail.length) fail('implicit functions need at least one output');
    used.implicit = true;
    const at = id();
    context.resource(
      `<i:implicitfunction id="${at}"${named(name)}><i:in>${head}</i:in>${body.join('')}<i:out>${tail.join('')}</i:out></i:implicitfunction>`,
    );
    return { id: at, inputs: { ...inputs }, outputs: offered };
  };

  /**
   * A field's attributes. `toGeometry` takes the file's object coordinates to the node's geometry coordinates, and
   * `box` is the geometry's bounds, minimum then maximum.
   */
  const field = (
    given: ThreeMFField,
    type: ThreeMFValueType | undefined,
    toGeometry: readonly number[],
    box: readonly number[],
    what: string,
  ): string => {
    const written = functionOf(given.function),
      sampled = 'image' in given.function;
    if (Object.keys(written.inputs).join() !== 'pos' || written.inputs.pos !== 'vector')
      fail(`${what} needs a function whose one input is a vector pos`);
    const matching = Object.keys(written.outputs).filter((n) => !type || written.outputs[n] === type),
      channel =
        given.channel ??
        (sampled ? (type === 'vector' ? 'color' : 'red') : matching.length === 1 ? matching[0] : undefined);
    if (channel === undefined || !matching.includes(channel))
      fail(`${what} needs a channel that is a ${type ?? ''} output of its function`);
    let own = given.transform ? Array.from(given.transform) : undefined;
    if (own && (own.length !== 16 || !own.every(Number.isFinite)))
      fail(`${what} transform must hold 16 finite numbers`);
    if (!own && sampled) {
      const size = [0, 1, 2].map((k) => box[k + 3] - box[k] || 1);
      own = [1 / size[0], 0, 0, 0, 0, 1 / size[1], 0, 0, 0, 0, 1 / size[2], 0];
      own.push(-box[0] / size[0], -box[1] / size[1], -box[2] / size[2], 1);
    }
    const m = own ? multiply(own, toGeometry) : toGeometry,
      rows = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14].map((i) => m[i]),
      identity = rows.every((v, i) => v === (i % 4 === 0 && i < 9 ? 1 : 0)),
      { minFeatureSize, fallback } = given;
    if (minFeatureSize !== undefined && !(minFeatureSize >= 0)) fail(`${what} minFeatureSize must be 0 or more`);
    return (
      ` functionid="${written.id}" channel="${channel}"${identity ? '' : ` transform="${rows.map(num).join(' ')}"`}` +
      (minFeatureSize === undefined ? '' : ` minfeaturesize="${num(minFeatureSize * scale)}"`) +
      (fallback === undefined ? '' : ` fallbackvalue="${finite(fallback, `${what} fallback`)}"`)
    );
  };

  /** A `volumedata` resource's id; equal ones are written once. */
  const volume = (
    { color, composite, properties = [] }: ThreeMFVolume,
    toGeometry: readonly number[],
    box: readonly number[],
  ): number => {
    let body = '';
    if (composite !== undefined) {
      if (!composite.length) fail('volume composites need at least one material');
      const mappings = composite.map((m) => field(m, 'scalar', toGeometry, box, 'composite material')),
        bases = composite.map(({ name, color }) => {
          if (typeof name !== 'string' || !name || !isMixColor(color))
            fail("composite materials need a name and a '#RRGGBB' or '#RRGGBBAA' colour");
          return `<base name="${escaped(name)}" displaycolor="${color.toUpperCase()}"/>`;
        }),
        key = `m${bases.join('')}`;
      let group = volumes.get(key);
      if (group === undefined) {
        volumes.set(key, (group = id()));
        context.group(`<basematerials id="${group}">${bases.join('')}</basematerials>`);
      }
      body += `<v:composite basematerialid="${group}">${mappings.map((a) => `<v:materialmapping${a}/>`).join('')}</v:composite>`;
    }
    if (color) body += `<v:color${field(color, 'vector', toGeometry, box, 'volume color')}/>`;
    const seen = new Set<string>();
    for (const property of properties) {
      const { namespace, name, required = false } = property;
      if (typeof namespace !== 'string' || !namespace || typeof name !== 'string' || !NCNAME.test(name))
        fail('volume properties need a namespace and an XML name without a colon');
      let prefix = prefixes.get(namespace);
      if (!prefix) prefixes.set(namespace, (prefix = `vp${prefixes.size}`));
      const full = `${prefix}:${name}`;
      if (seen.has(full)) fail(`volume property ${name} is given twice`);
      seen.add(full);
      body += `<v:property name="${full}" required="${!!required}"${field(property, undefined, toGeometry, box, `volume property ${name}`)}/>`;
    }
    if (!body) fail('volumes need a color, a composite or a property');
    let at = volumes.get(body);
    if (at === undefined) {
      volumes.set(body, (at = id()));
      context.resource(`<v:volumedata id="${at}">${body}</v:volumedata>`);
    }
    used.volumetric = true;
    return at;
  };

  /** A level set object's element. */
  const levelSet = (
    given: ThreeMFLevelSet,
    meshId: number,
    volumeId: number | undefined,
    toGeometry: readonly number[],
    box: readonly number[],
  ): string => {
    const attributes = field(given, 'scalar', toGeometry, box, 'level set');
    used.levelSet = true;
    if ('nodes' in given.function) used.references = true;
    return `<v:levelset${attributes} meshid="${meshId}"${given.boundingBoxOnly ? ' meshbboxonly="true"' : ''}${volumeId === undefined ? '' : ` volumeid="${volumeId}"`}/>`;
  };

  /**
   * Turns a node's triangle mesh into a displacement mesh. `vertices` are its welded positions in file units,
   * `triangles` three of their indices for each face and `sources` the geometry and vertex each corner came from;
   * `turn` takes a geometry normal into the object's frame.
   */
  const displacement = (
    given: ThreeMFDisplacement,
    vertices: ArrayLike<number>,
    triangles: ArrayLike<number>,
    sources: readonly (readonly [Geo, number])[],
    turn: readonly number[],
  ): { group: number; corners: string[] } => {
    const {
      image: picture,
      height,
      offset = 0,
      channel = 'G',
      tile = 'wrap',
      filter = 'auto',
      texCoord = 0,
      vectors = 'smooth',
      factor,
    } = given;
    pngHeader(picture, 'displacement images');
    const tiles = typeof tile === 'string' ? [tile, tile] : Array.from(tile);
    if (tiles.length !== 2) fail('displacement takes one tile style or two');
    const [u, v] = tiles.map((t) => oneOf(t, [...TILES, 'none'], 'tile style'));
    oneOf(channel, ['R', 'G', 'B', 'A'], 'displacement channel');
    oneOf(filter, ['auto', 'linear', 'nearest'], 'displacement filter');
    oneOf(vectors, ['smooth', 'normals'], 'displacement vectors');
    const amplitude = finite(height * scale, 'displacement height'),
      base = finite(offset * scale, 'displacement offset');
    if (triangles.length < 12) fail('displacement meshes need at least four triangles');
    const unit = (x: number, y: number, z: number): number[] | undefined => {
        const length = Math.hypot(x, y, z);
        return length > 0 ? [x / length, y / length, z / length] : undefined;
      },
      faces: number[][] = [],
      sums = new Float64Array(vertices.length);
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [triangles[t] * 3, triangles[t + 1] * 3, triangles[t + 2] * 3],
        e = [0, 1, 2].map((k) => vertices[b + k] - vertices[a + k]),
        f = [0, 1, 2].map((k) => vertices[c + k] - vertices[a + k]),
        n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
      // The cross product's length is twice the area, which weighs each triangle's share.
      for (const at of [a, b, c]) for (let k = 0; k < 3; k++) sums[at + k] += n[k];
      faces.push(unit(n[0], n[1], n[2]) ?? [0, 0, 1]);
    }
    const normals = new Map<string, number>(),
      coordinates = new Map<string, number>(),
      indexIn = (known: Map<string, number>, key: string): number => {
        let at = known.get(key);
        if (at === undefined) known.set(key, (at = known.size));
        return at;
      };
    const corners: string[] = [];
    for (let t = 0; t < triangles.length; t += 3) {
      const keys = [0, 1, 2].map((k) => {
        const [geometry, vertex] = sources[t + k],
          uvs = [geometry.uvs, geometry.uvs1, geometry.uvs2, geometry.uvs3][texCoord];
        if (!uvs) fail(`displacement needs the geometry's UV set ${texCoord}`);
        let direction: number[] | undefined;
        if (vectors === 'normals') {
          const own = geometry.normals;
          if (!own) fail("displacement vectors 'normals' need the geometry's normals");
          const [x, y, z] = [0, 1, 2].map((axis) => own![vertex * 3 + axis]);
          direction = unit(
            ...([0, 1, 2].map((r) => turn[r] * x + turn[4 + r] * y + turn[8 + r] * z) as [number, number, number]),
          );
        } else {
          const at = triangles[t + k] * 3;
          direction = unit(sums[at], sums[at + 1], sums[at + 2]);
        }
        const face = faces[t / 3];
        // A vector must point out of its triangle (displacement extension 3.2.1); a sharp fold takes the face's own.
        if (!direction || direction[0] * face[0] + direction[1] * face[1] + direction[2] * face[2] <= 1e-6)
          direction = face;
        const normal = indexIn(normals, direction.map(num).join(' '));
        let weight = 1;
        if (factor) {
          const p = geometry.positions;
          weight = factor([p[vertex * 3], p[vertex * 3 + 1], p[vertex * 3 + 2]]);
          if (!(weight >= 0 && Number.isFinite(weight))) fail('displacement factors must be 0 or more');
        }
        return indexIn(
          coordinates,
          `u="${num(uvs![vertex * 2])}" v="${num(1 - uvs![vertex * 2 + 1])}" n="${normal}"${weight === 1 ? '' : ` f="${num(weight)}"`}`,
        );
      });
      corners.push(` d1="${keys[0]}" d2="${keys[1]}" d3="${keys[2]}"`);
    }
    const path = `3D/Textures/displacement${++heightMaps}.png`;
    context.file(path, picture);
    const map = id();
    context.group(
      `<d:displacement2d id="${map}" path="/${path}" channel="${channel}" tilestyleu="${u}" tilestylev="${v}" filter="${filter}"/>`,
    );
    const vectorsId = id();
    context.group(
      `<d:normvectorgroup id="${vectorsId}">${[...normals.keys()]
        .map((key) => {
          const [x, y, z] = key.split(' ');
          return `<d:normvector x="${x}" y="${y}" z="${z}"/>`;
        })
        .join('')}</d:normvectorgroup>`,
    );
    const group = id();
    context.group(
      `<d:disp2dgroup id="${group}" dispid="${map}" nid="${vectorsId}" height="${amplitude}" offset="${base}">${[
        ...coordinates.keys(),
      ]
        .map((key) => `<d:disp2dcoord ${key}/>`)
        .join('')}</d:disp2dgroup>`,
    );
    used.displacement = true;
    return { group, corners };
  };

  return {
    volume,
    levelSet,
    displacement,
    /** The namespaces and the required extensions of what was written. */
    declarations(): { namespaces: string; required: string[] } {
      const { volumetric, implicit, references, levelSet: level, displacement: moved } = used,
        // A level set changes the shape, and a function that names a mesh needs the volumetric extension's resource
        // order (its section 1.1): either way a reader must support it.
        needed = level || references;
      return {
        namespaces:
          (volumetric || level ? ' xmlns:v="http://schemas.3mf.io/3dmanufacturing/volumetric/2022/01"' : '') +
          (implicit ? ' xmlns:i="http://schemas.3mf.io/3dmanufacturing/implicit/2023/12"' : '') +
          (moved ? ' xmlns:d="http://schemas.3mf.io/3dmanufacturing/displacement/2023/10"' : '') +
          [...prefixes].map(([uri, prefix]) => ` xmlns:${prefix}="${escaped(uri)}"`).join(''),
        required: [...(needed ? ['v'] : []), ...(needed && implicit ? ['i'] : []), ...(moved ? ['d'] : [])],
      };
    },
  };
}
