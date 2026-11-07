// MaterialX shading in USD: `.mtlx` files as layers and `outputs:mtlx:surface` networks as glTF PBR materials and node
// material graphs. Built from the MaterialX Specification and its Standard Nodes and Physically Based Shading Nodes
// documents, the published UsdMtlx page, Autodesk Standard Surface 1.0.1, OpenPBR Surface, the UsdPreviewSurface
// specification, Apple's published RealityKit node definitions and the Khronos glTF extension specifications. Where a
// layer's prims go was observed through OpenUSD's public API on real files; its source was not read.
import type { GLTFMaterial } from '../../shared/gltf.js';
import {
  materialXDocument,
  parseMaterialX,
  type MaterialXConversion,
  type MaterialXConvertOptions,
  type MaterialXDocument,
  type MaterialXInput,
  type MaterialXNode,
  type MaterialXNodeGraph,
} from '@margoengine/loaders/materialx';
import { LoaderError } from '@margoengine/loaders/common';
import { SRGBToLinear } from '@margoengine/math/color';
import type { Specs } from './crate.js';
import type { ExtensionHooks, ForeignLayer, SurfaceRead, USDExtension, USDImagePlacement, USDSurface } from './extension.js';
import type { USDAsset } from './index.js';
import { anchored } from './stage.js';

const ROOT = '/MaterialX';
/** A lookup that only knows its own keys: file text picks the key, so `constructor` must find nothing. */
const lookup = <T>(entries: Record<string, T>) => Object.assign(Object.create(null) as Record<string, T>, entries);
const USD_TYPES = lookup({
  float: 'float',
  integer: 'int',
  boolean: 'bool',
  color3: 'color3f',
  color4: 'color4f',
  vector2: 'float2',
  vector3: 'float3',
  vector4: 'float4',
  matrix33: 'matrix3d',
  matrix44: 'matrix4d',
  filename: 'asset',
  string: 'string',
});
const MTLX_TYPES = lookup(Object.fromEntries(Object.entries(USD_TYPES).map(([mtlx, usd]) => [usd, mtlx])));
/** Nodes that read as an image in a node material. */
const IMAGE_NODES = lookup({ RealityKitTexture2D: 'image', UsdUVTexture: 'image' });
/** Node kinds whose id names the shader alone, with no output type behind it. */
const SURFACE_IDS = new Set(['surface_unlit']);

/** A shader id for a node: what OpenUSD's own reader shows for the common cases. */
function shaderId(node: MaterialXNode): string {
  if (SURFACE_IDS.has(node.category)) return 'ND_' + node.category;
  return `ND_${node.category}_${node.type}`;
}

/** The specs of one MaterialX document, in the layout USD layers reference: `/MaterialX/Materials/<name>` and so on. */
function layerSpecs(doc: MaterialXDocument): Specs {
  const specs: Specs = Object.create(null) as Specs,
    prim = (path: string, typeName?: string) => {
      specs[path] ??= { specType: 6, fields: { specifier: 0, ...(typeName ? { typeName } : {}) } };
    },
    property = (path: string, fields: Record<string, unknown>) => {
      specs[path] = { specType: 1, fields };
    };
  specs['/'] = { specType: 7, fields: { defaultPrim: 'MaterialX' } };
  prim(ROOT);
  prim(ROOT + '/Materials');
  prim(ROOT + '/Shaders');
  prim(ROOT + '/NodeGraphs');
  const typed = (input: MaterialXInput) => USD_TYPES[input.type] ?? 'token';
  const authored = (input: MaterialXInput) => ({
    typeName: typed(input),
    ...(input.value === undefined ? {} : { default: input.value }),
    ...(input.colorspace && (input.type === 'filename' || /^color/.test(input.type)) ? { colorSpace: input.colorspace } : {}),
  });
  /** Writes a node at `path`. `where` finds the prim of what its inputs connect to. */
  const writeNode = (path: string, node: MaterialXNode, where: (input: MaterialXInput) => string | undefined) => {
    prim(path, 'Shader');
    property(path + '.info:id', { typeName: 'token', default: shaderId(node), variability: 1 });
    for (const input of Object.values(node.inputs)) {
      const target = where(input);
      property(`${path}.inputs:${input.name}`, target ? { typeName: typed(input), connectionPaths: [target] } : authored(input));
    }
  };
  /** Writes a node graph, with the top-level nodes its nodes read beside it under `outer`. */
  const writeGraph = (path: string, graph: MaterialXNodeGraph, outer: (name: string) => string) => {
    prim(path, 'NodeGraph');
    for (const input of Object.values(graph.inputs)) property(`${path}.inputs:${input.name}`, authored(input));
    const where = (input: MaterialXInput) => {
      if (input.interfacename !== undefined) return `${path}.inputs:${input.interfacename}`;
      if (input.nodename === undefined) return;
      const output = `.outputs:${input.output ?? 'out'}`;
      return (graph.nodes[input.nodename] ? `${path}/${input.nodename}` : outer(input.nodename)) + output;
    };
    for (const node of Object.values(graph.nodes)) writeNode(`${path}/${node.name}`, node, where);
    for (const output of Object.values(graph.outputs)) {
      const target = where(output);
      property(`${path}.outputs:${output.name}`, { typeName: typed(output), ...(target ? { connectionPaths: [target] } : {}) });
    }
  };
  /** Copies a shader or top-level node under `scope`, with everything it reads, and gives its prim. */
  const copy = (scope: string, node: MaterialXNode): string => {
    const path = `${scope}/${node.name}`;
    if (specs[path]) return path;
    const outerNode = (name: string) => copy(scope, doc.nodes[name] ?? missing(name));
    prim(path, 'Shader');
    writeNode(path, node, (input) => {
      if (input.nodegraph !== undefined) {
        const graph = doc.graphs[input.nodegraph] ?? missing(input.nodegraph),
          at = `${scope}/${graph.name}`;
        if (!specs[at]) writeGraph(at, graph, outerNode);
        return `${at}.outputs:${input.output ?? Object.keys(graph.outputs)[0]}`;
      }
      return input.nodename === undefined ? undefined : `${outerNode(input.nodename)}.outputs:${input.output ?? 'out'}`;
    });
    return path;
  };
  for (const graph of Object.values(doc.graphs)) writeGraph(`${ROOT}/NodeGraphs/${graph.name}`, graph, (name) => `${ROOT}/Shaders/${name}`);
  for (const node of Object.values(doc.nodes)) {
    if (node.category === 'surfacematerial') continue;
    prim(`${ROOT}/Shaders/${node.name}`, 'Shader');
    property(`${ROOT}/Shaders/${node.name}.info:id`, { typeName: 'token', default: shaderId(node), variability: 1 });
  }
  for (const { name, shader } of doc.materials) {
    const path = `${ROOT}/Materials/${name}`;
    prim(path, 'Material');
    if (!shader) continue;
    const at = copy(path, shader);
    property(`${path}.outputs:mtlx:surface`, { typeName: 'token', connectionPaths: [`${at}.outputs:surface`] });
    // A plain input lives on the material, where a USD layer can override it, and the shader reads it from there.
    for (const input of Object.values(shader.inputs)) {
      if (input.value === undefined) continue;
      property(`${path}.inputs:${input.name}`, authored(input));
      property(`${at}.inputs:${input.name}`, { typeName: typed(input), connectionPaths: [`${path}.inputs:${input.name}`] });
    }
  }
  return specs;
}
function missing(name: string): never {
  throw new LoaderError('MaterialX', 'syntax', `no node or node graph ${name}`);
}

/** Gives a document with no working colour space the one it was included under. */
function inherit(doc: MaterialXDocument, colorspace: string): void {
  const nodes = [...Object.values(doc.nodes), ...Object.values(doc.graphs).flatMap((graph) => Object.values(graph.nodes))];
  for (const node of nodes)
    for (const input of Object.values(node.inputs)) if (input.type === 'filename' || /^color/.test(input.type)) input.colorspace ??= colorspace;
}

/** A `.mtlx` file and what it includes, as one document. */
function readDocument({ id, data, file, issues }: ForeignLayer, seen = new Set<string>()): MaterialXDocument {
  seen.add(id);
  const doc = parseMaterialX(data);
  for (const href of doc.includes) {
    const at = anchored(id, href),
      bytes = seen.has(at) ? undefined : file(at);
    const other = bytes && readDocument({ id: at, data: bytes, file, issues }, seen);
    if (!other) continue;
    if (other.colorspace === undefined && doc.colorspace !== undefined) inherit(other, doc.colorspace);
    Object.assign(doc.nodes, other.nodes);
    Object.assign(doc.graphs, other.graphs);
    doc.materials.push(...other.materials);
  }
  return doc;
}

/** What an input comes to: numbers, or an image with what is known about reading it. */
interface Sampled {
  file: string;
  /** A channel of the image, or undefined for all of them. */
  channel?: number;
  /** What the image's value is multiplied by. */
  factor: number[];
  where: USDImagePlacement;
  uv?: string;
  /** The image's colour space, as authored. */
  space?: string;
  /** The `scale` of a `normalmap` it went through. */
  normalScale?: number;
}
type Reduced = number[] | Sampled | undefined;
const sampled = (value: Reduced): value is Sampled => value !== undefined && !Array.isArray(value);

const KINDS =
  /^(?:ND_)?(tiledimage|image|UsdUVTexture|UsdPrimvarReader|RealityKitTexture2D|constant|dot|convert|extract|multiply|add|subtract|mix|switch|separate[234]|combine[234]|texcoord|geompropvalue|normalmap)(?:_|$)/;
const WRAPS = lookup({
  periodic: 10497,
  repeat: 10497,
  clamp: 33071,
  clamp_to_edge: 33071,
  mirror: 33648,
  mirrored_repeat: 33648,
});
const CHANNELS = lookup({ r: 0, g: 1, b: 2, a: 3, x: 0, y: 1, z: 2, w: 3, outr: 0, outg: 1, outb: 2, outa: 3, outx: 0, outy: 1, outz: 2, outw: 3 });

/** The colour spaces read here. The working space is linear Rec.709; `data` and its alias `none` mean no conversion. */
const SRGB_SPACES = new Set(['srgb_texture', 'srgb_rec709_scene', 'sRGB']);
const LINEAR_SPACES = new Set(['lin_rec709', 'lin_rec709_scene', 'data', 'none', 'raw']);

/** Numbers of a value as a stage holds it: a number, a flag or a tuple. */
function numbers(value: unknown): number[] | undefined {
  if (typeof value === 'number') return [value];
  if (typeof value === 'boolean') return [value ? 1 : 0];
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const flat = Array.from(value as ArrayLike<unknown>).flat(2) as unknown[];
    return flat.every((x) => typeof x === 'number') ? (flat as number[]) : undefined;
  }
  return undefined;
}
/** Two values channel by channel: one of width 1 stands for all channels. */
const zip = (a: number[], b: number[], op: (x: number, y: number) => number) =>
  Array.from({ length: Math.max(a.length, b.length) }, (_, i) => op(a[a.length === 1 ? 0 : i] ?? 0, b[b.length === 1 ? 0 : i] ?? 0));

/** One bound material's network. */
class Network {
  private readonly busy = new Set<string>();
  constructor(
    private readonly read: SurfaceRead,
    readonly shader: string,
  ) {}

  /** The value of an attribute a connection ended on, or that an unset input takes from the material. */
  private plain(prim: string, name: string): number[] | undefined {
    const own = this.read.attr(prim, name),
      owner = own === undefined && prim === this.shader ? this.read.path : prim,
      list = numbers(own ?? this.read.attr(owner, name)),
      space = this.read.specs[`${owner}.${name}`]?.fields.colorSpace;
    if (!list || typeof space !== 'string' || LINEAR_SPACES.has(space)) return list;
    if (SRGB_SPACES.has(space)) return list.map((x, i) => (i < 3 ? SRGBToLinear(x) : x));
    this.read.soft(`colour space ${space} of ${owner}.${name} is not converted`);
    return list;
  }
  private text(prim: string, name: string): string | undefined {
    const target = this.read.connection(prim, name),
      value = target ? this.read.attr(target.slice(0, target.lastIndexOf('.')), target.slice(target.lastIndexOf('.') + 1)) : this.read.attr(prim, name);
    return typeof value === 'string' ? value : undefined;
  }
  /** An input of a prim, reduced. `slot` names it in what is listed. */
  value(prim: string, input: string, slot: string): Reduced {
    const name = 'inputs:' + input,
      target = this.read.connection(prim, name);
    if (!target) return this.plain(prim, name);
    const dot = target.lastIndexOf('.'),
      owner = target.slice(0, dot),
      property = target.slice(dot + 1),
      id = this.read.attr(owner, 'info:id');
    if (typeof id !== 'string') return this.plain(owner, property);
    if (this.busy.has(owner)) {
      this.read.soft(`${owner} is connected in a loop`);
      return undefined;
    }
    this.busy.add(owner);
    const result = this.node(owner, id, property.replace('outputs:', ''), slot);
    this.busy.delete(owner);
    return result;
  }
  private image(prim: string, kind: string, type: string, output: string, slot: string): Reduced {
    const file = this.text(prim, 'inputs:file');
    const fallback = () => numbers(this.read.attr(prim, kind === 'UsdUVTexture' ? 'inputs:fallback' : 'inputs:default')) ?? [0];
    if (!file) return fallback();
    if (!this.read.has(file)) {
      this.read.soft('missing texture ' + file);
      return fallback();
    }
    const wrap = (name: string, other: string) => {
      const mode = this.read.attr(prim, 'inputs:' + name) ?? this.read.attr(prim, 'inputs:' + other);
      if (mode === undefined) return WRAPS.periodic;
      if (typeof mode === 'string' && mode in WRAPS) return WRAPS[mode];
      this.read.soft(`address mode ${String(mode)} of ${prim} reads as clamp`);
      return WRAPS.clamp;
    };
    const where: USDImagePlacement = { wrapS: wrap('uaddressmode', 'wrapS'), wrapT: wrap('vaddressmode', 'wrapT') };
    if (kind === 'RealityKitTexture2D') {
      where.wrapS = wrap('u_wrap_mode', 'u_wrap_mode');
      where.wrapT = wrap('v_wrap_mode', 'v_wrap_mode');
    }
    if (kind === 'tiledimage') {
      const [su, sv] = this.plain(prim, 'inputs:uvtiling') ?? [1, 1],
        offset = this.plain(prim, 'inputs:uvoffset'),
        image = this.plain(prim, 'inputs:realworldimagesize'),
        tile = this.plain(prim, 'inputs:realworldtilesize');
      // The specification gives these inputs no formula, so nothing is made up for them.
      if (offset?.some(Boolean)) this.read.soft(`uvoffset of ${prim} is not applied`);
      if (image && tile && image.some((v, i) => v !== tile[i])) this.read.soft(`real world sizes of ${prim} are not applied`);
      if (su !== 1 || sv !== 1) where.transform = { offset: [0, 1 - sv], rotation: 0, scale: [su, sv] };
    }
    const source = kind === 'UsdUVTexture' ? this.read.attr(prim, 'inputs:sourceColorSpace') : undefined,
      space = source === undefined || source === 'auto' ? this.read.specs[`${prim}.inputs:file`]?.fields.colorSpace : source,
      single = type === 'float' || output in CHANNELS;
    const out: Sampled = { file, factor: [1], where };
    if (kind === 'UsdUVTexture') {
      // output = value * scale + bias. A normal map's 2 and -1 are how glTF reads it anyway.
      const scale = numbers(this.read.attr(prim, 'inputs:scale')),
        bias = numbers(this.read.attr(prim, 'inputs:bias')),
        decode = slot === 'normal' && scale?.[0] === 2 && bias?.[0] === -1;
      if (scale && !decode) out.factor = single ? [scale[CHANNELS[output] ?? 0]] : scale.slice(0, 3);
      if (bias?.some(Boolean) && !decode) this.read.soft(`bias of ${prim} has no PBR form`);
    }
    if (single) out.channel = CHANNELS[output] ?? 0;
    if (typeof space === 'string') out.space = space;
    const uv = this.uv(prim, kind === 'UsdUVTexture' ? 'st' : 'texcoord', slot);
    if (uv) out.uv = uv;
    return out;
  }
  /** The primvar an image reads, when its texture coordinates are connected to one. */
  private uv(prim: string, input: string, slot: string): string | undefined {
    const target = this.read.connection(prim, 'inputs:' + input);
    if (!target) return;
    const owner = target.slice(0, target.lastIndexOf('.')),
      kind = KINDS.exec(String(this.read.attr(owner, 'info:id')))?.[1];
    if (kind === 'texcoord') {
      const index = numbers(this.read.attr(owner, 'inputs:index'))?.[0] ?? 0;
      if (index) this.read.soft(`texcoord index ${index} of ${owner} reads as the first set`);
      return;
    }
    if (kind === 'geompropvalue') return this.text(owner, 'inputs:geomprop');
    if (kind === 'UsdPrimvarReader') return this.text(owner, 'inputs:varname');
    this.read.soft(`computed texture coordinates at ${owner} on ${slot} have no PBR form; materialGraph() can hold more`);
    return;
  }
  private node(prim: string, id: string, output: string, slot: string): Reduced {
    const kind = KINDS.exec(id)?.[1],
      type = id.split('_').at(-1) ?? '',
      arg = (name: string) => this.value(prim, name, slot),
      refuse = () => {
        this.read.soft(`${id} at ${prim} on ${slot} has no PBR form; materialGraph() can hold more`);
        return undefined;
      };
    switch (kind) {
      case 'image':
      case 'tiledimage':
      case 'UsdUVTexture':
      case 'RealityKitTexture2D':
        return this.image(prim, kind, type, output, slot);
      case 'constant':
        return arg('value');
      case 'dot':
      case 'convert':
        return arg('in');
      case 'normalmap': {
        const inner = arg('in'),
          scale = numbers(this.read.attr(prim, 'inputs:scale'))?.[0];
        if (sampled(inner) && scale !== undefined) inner.normalScale = scale;
        return inner;
      }
      case 'extract':
      case 'separate2':
      case 'separate3':
      case 'separate4': {
        const inner = arg('in'),
          index = kind === 'extract' ? (numbers(this.read.attr(prim, 'inputs:index'))?.[0] ?? 0) : (CHANNELS[output] ?? 0);
        if (Array.isArray(inner)) return [inner[index] ?? 0];
        if (sampled(inner) && inner.channel === undefined) return { ...inner, channel: index };
        return inner === undefined ? undefined : refuse();
      }
      case 'combine2':
      case 'combine3':
      case 'combine4': {
        const parts = ['in1', 'in2', 'in3', 'in4'].slice(0, Number(kind.at(-1))).map(arg);
        return parts.every(Array.isArray) ? parts.flat() : refuse();
      }
      case 'multiply':
      case 'add':
      case 'subtract': {
        const a = arg('in1') ?? [0],
          b = arg('in2') ?? [kind === 'multiply' ? 1 : 0];
        if (Array.isArray(a) && Array.isArray(b))
          return zip(a, b, kind === 'multiply' ? (x, y) => x * y : kind === 'add' ? (x, y) => x + y : (x, y) => x - y);
        if (kind !== 'multiply') {
          const [image, other] = sampled(a) ? [a, b] : [b as Sampled, a];
          return Array.isArray(other) && other.every((v) => v === 0) ? image : refuse();
        }
        const [image, other] = sampled(a) ? [a, b] : [b as Sampled, a];
        return Array.isArray(other) ? { ...image, factor: zip(image.factor, other, (x, y) => x * y) } : refuse();
      }
      case 'mix': {
        const amount = arg('mix') ?? [0];
        if (!Array.isArray(amount)) return refuse();
        if (amount[0] === 0) return arg('bg');
        if (amount[0] === 1) return arg('fg');
        const fg = arg('fg') ?? [0],
          bg = arg('bg') ?? [0];
        return Array.isArray(fg) && Array.isArray(bg) ? zip(bg, fg, (x, y) => x + (y - x) * amount[0]) : refuse();
      }
      case 'switch': {
        const which = arg('which') ?? [0];
        if (!Array.isArray(which)) return refuse();
        // By the specification the output comes from input floor(which) + 1, clamped to 1 to 10.
        return arg('in' + Math.min(10, Math.max(1, Math.floor(which[0]) + 1)));
      }
      default:
        return refuse();
    }
  }
}

/** The surface slots a shader kind fills, as input names with their published defaults. */
interface Slots {
  color: [string, number[]];
  weight?: [string, number];
  metal?: [string, number];
  roughness?: [string, number];
  normal?: string;
  emissive?: [string, number[]];
  emissiveWeight?: [string, number];
  /** Opacity, one channel or three. */
  opacity?: [string, number[]];
  threshold?: string;
  occlusion?: string;
  coat?: [string, number];
  coatRoughness?: [string, number];
  coatNormal?: string;
  coatColor?: string;
  specular?: [string, number];
  specularColor?: string;
  ior?: [string, number];
  transmission?: [string, number];
  transmissionColor?: string;
  sheen?: [string, number];
  sheenColor?: string;
  sheenRoughness?: [string, number];
  /** Thickness in nanometres, with what its unit is multiplied by to get there and its unset value. */
  filmThickness?: [string, number, number];
  filmWeight?: [string, number];
  filmIor?: [string, number];
  /** What a transmitted ray is tinted by at this depth; zero makes the colour a tint on the surface. */
  transmissionDepth?: string;
  /** The Standard Surface coat's darkening of the base and roughening of the specular layers. */
  coatAffect?: boolean;
  /** Inputs read for nothing, as they have no glTF form. Anything set among them is listed. */
  left?: string[];
}
const WHITE = [1, 1, 1];
const SHADERS = lookup<Slots>({
  standard_surface: {
    color: ['base_color', [0.8, 0.8, 0.8]],
    weight: ['base', 1],
    metal: ['metalness', 0],
    roughness: ['specular_roughness', 0.2],
    normal: 'normal',
    emissive: ['emission_color', WHITE],
    emissiveWeight: ['emission', 0],
    opacity: ['opacity', WHITE],
    coat: ['coat', 0],
    coatRoughness: ['coat_roughness', 0.1],
    coatNormal: 'coat_normal',
    coatColor: 'coat_color',
    specular: ['specular', 1],
    specularColor: 'specular_color',
    ior: ['specular_IOR', 1.5],
    transmission: ['transmission', 0],
    transmissionColor: 'transmission_color',
    sheen: ['sheen', 0],
    sheenColor: 'sheen_color',
    sheenRoughness: ['sheen_roughness', 0.3],
    filmThickness: ['thin_film_thickness', 1, 0],
    filmIor: ['thin_film_IOR', 1.5],
    transmissionDepth: 'transmission_depth',
    coatAffect: true,
    left: [
      'subsurface',
      'diffuse_roughness',
      'specular_anisotropy',
      'coat_anisotropy',
      'transmission_scatter',
      'transmission_dispersion',
      'transmission_extra_roughness',
      'thin_walled',
    ],
  },
  open_pbr_surface: {
    color: ['base_color', [0.8, 0.8, 0.8]],
    weight: ['base_weight', 1],
    metal: ['base_metalness', 0],
    roughness: ['specular_roughness', 0.3],
    normal: 'geometry_normal',
    emissive: ['emission_color', WHITE],
    opacity: ['geometry_opacity', [1]],
    coat: ['coat_weight', 0],
    coatRoughness: ['coat_roughness', 0],
    coatNormal: 'geometry_coat_normal',
    coatColor: 'coat_color',
    specular: ['specular_weight', 1],
    specularColor: 'specular_color',
    ior: ['specular_ior', 1.5],
    transmission: ['transmission_weight', 0],
    transmissionColor: 'transmission_color',
    sheen: ['fuzz_weight', 0],
    sheenColor: 'fuzz_color',
    sheenRoughness: ['fuzz_roughness', 0.5],
    filmThickness: ['thin_film_thickness', 1000, 0.5],
    filmWeight: ['thin_film_weight', 0],
    filmIor: ['thin_film_ior', 1.4],
    transmissionDepth: 'transmission_depth',
    left: [
      'subsurface_weight',
      'base_diffuse_roughness',
      'specular_roughness_anisotropy',
      'coat_roughness_anisotropy',
      'transmission_scatter',
      'transmission_dispersion_scale',
      'geometry_thin_walled',
    ],
  },
  UsdPreviewSurface: {
    color: ['diffuseColor', [0.18, 0.18, 0.18]],
    metal: ['metallic', 0],
    roughness: ['roughness', 0.5],
    normal: 'normal',
    emissive: ['emissiveColor', [0, 0, 0]],
    opacity: ['opacity', [1]],
    threshold: 'opacityThreshold',
    occlusion: 'occlusion',
    coat: ['clearcoat', 0],
    coatRoughness: ['clearcoatRoughness', 0.01],
    ior: ['ior', 1.5],
    left: ['displacement', 'useSpecularWorkflow'],
  },
  gltf_pbr: {
    color: ['base_color', WHITE],
    metal: ['metallic', 1],
    roughness: ['roughness', 1],
    normal: 'normal',
    emissive: ['emissive', [0, 0, 0]],
    emissiveWeight: ['emissive_strength', 1],
    opacity: ['alpha', [1]],
    occlusion: 'occlusion',
    coat: ['clearcoat', 0],
    coatRoughness: ['clearcoat_roughness', 0],
    coatNormal: 'clearcoat_normal',
    specular: ['specular', 1],
    specularColor: 'specular_color',
    transmission: ['transmission', 0],
    ior: ['ior', 1.5],
    filmThickness: ['iridescence_thickness', 1, 100],
    filmWeight: ['iridescence', 0],
    filmIor: ['iridescence_ior', 1.3],
    sheen: ['', 1],
    sheenColor: 'sheen_color',
    sheenRoughness: ['sheen_roughness', 0],
  },
  realitykit_pbr_surfaceshader: {
    color: ['baseColor', [0.18, 0.18, 0.18]],
    metal: ['metallic', 0],
    roughness: ['roughness', 0.5],
    normal: 'normal',
    emissive: ['emissiveColor', [0, 0, 0]],
    opacity: ['opacity', [1]],
    threshold: 'opacityThreshold',
    occlusion: 'ambientOcclusion',
    coat: ['clearcoat', 0],
    coatRoughness: ['clearcoatRoughness', 0.01],
    coatNormal: 'clearcoatNormal',
    left: ['specular'],
  },
});
const UNLIT = lookup<{ color: [string, number[]]; weight?: [string, number]; opacity: [string, number[]]; threshold?: string }>({
  surface_unlit: { color: ['emission_color', WHITE], weight: ['emission', 1], opacity: ['opacity', [1]] },
  realitykit_unlit_surfaceshader: { color: ['color', WHITE], opacity: ['opacity', [1]], threshold: 'opacityThreshold' },
});
/** The shader kind of an id: `ND_standard_surface_surfaceshader` is `standard_surface`. */
function shaderKind(id: string): string {
  const name = id.replace(/^ND_/, '');
  if (name in SHADERS || name in UNLIT) return name;
  return name.replace(/_surfaceshader(?:_\d+)?$/, '').replace(/_\d+(?:_\d+)*$/, '');
}

const uses = (read: SurfaceRead, name: string) => {
  const list = (read.document.extensionsUsed ??= []);
  if (!list.includes(name)) list.push(name);
};
const luminance = (value: number[]) => (value.length < 3 ? value[0] : (value[0] + value[1] + value[2]) / 3);
const fit = (value: number) => Math.min(1, Math.max(0, value));
const three = (value: number[]) => (value.length < 3 ? [value[0], value[0], value[0]] : value.slice(0, 3));

/** Writes a network as a glTF material, as far as glTF holds it. */
function surface(read: SurfaceRead): USDSurface | undefined {
  const target = read.connection(read.path, 'outputs:mtlx:surface');
  if (!target) return undefined;
  const shader = target.slice(0, target.lastIndexOf('.')),
    id = read.attr(shader, 'info:id'),
    kind = typeof id === 'string' ? shaderKind(id) : '';
  const network = new Network(read, shader),
    slots = SHADERS[kind],
    flat = UNLIT[kind];
  if (!slots && !flat) {
    read.soft(`unsupported surface shader ${String(id)} at ${shader}`);
    return undefined;
  }
  const get = (name: string | undefined, fallback?: number[]): Reduced => (name ? (network.value(shader, name, name) ?? fallback) : fallback),
    /** A constant, or what the slot falls back to when an image there cannot be used. */
    constant = (name: string, fallback: number) => {
      const value = get(name, [fallback]);
      if (Array.isArray(value)) return value[0];
      read.soft(`an image on ${name} has no place in the material`);
      return fallback;
    };
  const material: GLTFMaterial = { name: read.path, doubleSided: true, alphaMode: 'OPAQUE' },
    p: NonNullable<GLTFMaterial['pbrMetallicRoughness']> = (material.pbrMetallicRoughness = {}),
    extensions: Record<string, Record<string, unknown>> = {},
    uvs: string[] = [],
    /** A texture slot's entry. Each image here counts towards the primvar the mesh gives it. */
    texture = (image: Sampled, linearColor = false) => {
      if (image.uv) uvs.push(image.uv);
      return read.image({ path: image.file, ...(linearColor ? { linearColor } : {}) }, image.where);
    };
  /** The base colour, from any mix of constants and one image. */
  const base = (color: Reduced, opacity: number) => {
    if (sampled(color)) {
      // Each channel of a single channel image shows the same, which is what a grey image does; the rest cannot be read here.
      if (color.channel) read.soft(`channel ${color.channel} of ${color.file} reads as the image's colour`);
      // With no colour space anywhere above it an image is left to its file, which glTF reads as sRGB.
      const lit = color.space !== undefined && LINEAR_SPACES.has(color.space);
      if (color.space !== undefined && !lit && !SRGB_SPACES.has(color.space)) read.soft(`colour space ${color.space} of ${color.file} is not converted`);
      p.baseColorTexture = texture(color, lit);
      p.baseColorFactor = [...three(color.factor), opacity];
    } else p.baseColorFactor = [...three(color!).map(fit), opacity];
  };
  const seeThrough = (threshold: number) => {
    material.alphaMode = threshold > 0 ? 'MASK' : 'BLEND';
    if (threshold > 0) material.alphaCutoff = threshold;
  };
  /** Opacity as one number. */
  const alpha = (name: string, fallback: number[]) => {
    const value = get(name, fallback);
    if (Array.isArray(value)) return fit(luminance(value));
    read.soft(`an opacity image on ${name} is not read`);
    return 1;
  };
  if (flat) {
    const weight = flat.weight ? constant(...flat.weight) : 1,
      opacity = alpha(...flat.opacity),
      color = get(flat.color[0], flat.color[1]),
      threshold = flat.threshold ? constant(flat.threshold, 0) : 0;
    base(sampled(color) ? { ...color, factor: color.factor.map((x) => x * weight) } : three(color!).map((x) => x * weight), opacity);
    if (opacity < 1) seeThrough(threshold);
    uses(read, 'KHR_materials_unlit');
    extensions.KHR_materials_unlit = {};
    material.extensions = extensions;
    return { material, uv: uvs[0], network: networkOf(read, shader) };
  }
  const mode = kind === 'gltf_pbr' ? constant('alpha_mode', 0) : undefined,
    opacity = slots.opacity && mode !== 0 ? alpha(...slots.opacity) : 1,
    threshold = mode === undefined ? (slots.threshold ? constant(slots.threshold, 0) : 0) : mode === 1 ? constant('alpha_cutoff', 0.5) : 0,
    weight = slots.weight ? constant(...slots.weight) : 1,
    coat = slots.coat ? constant(...slots.coat) : 0,
    transmission = slots.transmission ? constant(...slots.transmission) : 0;
  let color = get(slots.color[0], slots.color[1])!;
  const times = (value: Reduced, by: number[]): Reduced =>
    sampled(value) ? { ...value, factor: zip(value.factor, by, (x, y) => x * y) } : zip(value!, by, (x, y) => x * y);
  color = times(color, [weight])!;
  // Standard Surface darkens the diffuse base by raising it to 1 + coat * coat_affect_color.
  const affect = slots.coatAffect ? constant('coat_affect_color', 0) : 0;
  if (affect > 0 && coat > 0) {
    if (Array.isArray(color)) color = color.map((x) => x ** (1 + coat * affect));
    else read.soft('coat_affect_color has no form on an image');
  }
  // A coat's colour tints all that lies under it: white with no coat, the colour under a full one.
  let coatTint = WHITE;
  if (slots.coatColor && coat > 0) {
    const tint = get(slots.coatColor);
    if (Array.isArray(tint)) {
      coatTint = three(tint).map((x) => 1 + (x - 1) * coat);
      color = times(color, coatTint)!;
    } else if (sampled(tint) && coat === 1 && !sampled(color)) color = times(tint, color)!;
    else if (tint) read.soft(`an image on ${slots.coatColor} is not read`);
  }
  // Transmission takes the place of the diffuse layer, and glTF tints what it transmits by the base colour. With a depth
  // the colour belongs to the medium instead, as Beer's law: a ray that crosses that depth comes out in that colour.
  const depth = slots.transmissionDepth && transmission > 0 ? constant(slots.transmissionDepth, 0) : 0;
  if (slots.transmissionColor && transmission > 0) {
    const tint = get(slots.transmissionColor, WHITE);
    if (!Array.isArray(tint)) read.soft(`an image on ${slots.transmissionColor} is not read`);
    else if (depth > 0) {
      uses(read, 'KHR_materials_volume');
      extensions.KHR_materials_volume = { thicknessFactor: depth, attenuationDistance: depth, attenuationColor: three(tint).map(fit) };
    } else if (Array.isArray(color)) color = zip(color, tint, (x, y) => x + (y - x) * transmission);
    else read.soft(`an image on ${slots.transmissionColor} is not read`);
  }
  base(color, opacity);
  if (mode === 1) seeThrough(threshold);
  else if (opacity < 1 || mode === 2) seeThrough(threshold);
  const coatRough = slots.coatAffect && coat > 0 ? constant('coat_affect_roughness', 0) * coat * constant(...slots.coatRoughness!) : 0;
  const rough = slots.roughness ? get(slots.roughness[0], [slots.roughness[1]]) : [1],
    metal = slots.metal ? get(slots.metal[0], [slots.metal[1]]) : [0];
  if (coatRough > 0 && Array.isArray(rough)) rough[0] += (1 - rough[0]) * coatRough;
  if (sampled(rough) || sampled(metal)) {
    const part = (value: Reduced) => (sampled(value) ? { path: value.file, channel: value.channel ?? 0 } : undefined),
      number = (value: Reduced) => (Array.isArray(value) ? fit(value[0]) : 1);
    if (sampled(rough) && sampled(metal) && JSON.stringify(rough.where) !== JSON.stringify(metal.where))
      read.soft('unsupported roughness and metallic textures with different transforms or wrap modes');
    p.metallicRoughnessTexture = read.image(
      { roughness: part(rough), metallic: part(metal), roughnessValue: number(rough), metallicValue: number(metal) },
      (sampled(rough) ? rough : (metal as Sampled)).where,
    );
    for (const image of [rough, metal]) if (sampled(image) && image.uv) uvs.push(image.uv);
    p.roughnessFactor = sampled(rough) ? fit(rough.factor[0]) : 1;
    p.metallicFactor = sampled(metal) ? fit(metal.factor[0]) : 1;
  } else {
    p.roughnessFactor = fit(rough![0]);
    p.metallicFactor = fit(metal![0]);
  }
  const normal = get(slots.normal);
  if (sampled(normal)) {
    material.normalTexture = texture(normal);
    if (normal.normalScale !== undefined) material.normalTexture.scale = normal.normalScale;
  }
  const occlusion = get(slots.occlusion);
  if (sampled(occlusion)) material.occlusionTexture = texture(occlusion);
  if (slots.emissive) {
    const light = get(slots.emissive[0], slots.emissive[1])!,
      strength = slots.emissiveWeight ? constant(...slots.emissiveWeight) : kind === 'open_pbr_surface' ? constant('emission_luminance', 0) / 1000 : 1;
    if (sampled(light)) {
      material.emissiveTexture = texture(light);
      material.emissiveFactor = three(zip(light.factor, [Math.min(1, strength)], (x, y) => x * y)) as [number, number, number];
    } else {
      const lit = three(light).map((x, i) => x * strength * coatTint[i]),
        most = Math.max(...lit);
      material.emissiveFactor = (most > 1 ? lit.map((x) => x / most) : lit) as [number, number, number];
      if (most > 1) {
        uses(read, 'KHR_materials_emissive_strength');
        extensions.KHR_materials_emissive_strength = { emissiveStrength: most };
      }
    }
  }
  if (coat > 0) {
    uses(read, 'KHR_materials_clearcoat');
    const roughness = get(slots.coatRoughness?.[0], [slots.coatRoughness?.[1] ?? 0]),
      layer: Record<string, unknown> = { clearcoatFactor: fit(coat) };
    if (sampled(roughness)) {
      layer.clearcoatRoughnessTexture = texture(roughness);
      layer.clearcoatRoughnessFactor = fit(roughness.factor[0]);
    } else layer.clearcoatRoughnessFactor = fit(roughness![0]);
    const under = get(slots.coatNormal);
    if (sampled(under)) layer.clearcoatNormalTexture = texture(under);
    extensions.KHR_materials_clearcoat = layer;
  }
  if (slots.ior) {
    const ior = constant(...slots.ior);
    if (ior !== 1.5) {
      uses(read, 'KHR_materials_ior');
      extensions.KHR_materials_ior = { ior };
    }
  }
  if (slots.specular) {
    const amount = constant(...slots.specular),
      tint = get(slots.specularColor, WHITE);
    if (sampled(tint)) read.soft(`an image on ${slots.specularColor} is not read`);
    const list = Array.isArray(tint) ? three(tint) : WHITE;
    if (amount !== 1 || list.some((x) => x !== 1)) {
      uses(read, 'KHR_materials_specular');
      extensions.KHR_materials_specular = { specularFactor: fit(amount), specularColorFactor: list };
    }
  }
  if (transmission > 0) {
    uses(read, 'KHR_materials_transmission');
    extensions.KHR_materials_transmission = { transmissionFactor: fit(transmission) };
  }
  if (slots.sheen) {
    const amount = slots.sheen[0] ? constant(...slots.sheen) : 1;
    if (amount > 0) {
      // gltf_pbr has no sheen weight: its sheen is on when its colour is, and that colour is black when unset.
      const tint = get(slots.sheenColor, slots.sheen[0] ? WHITE : [0, 0, 0]);
      if (sampled(tint)) read.soft(`an image on ${slots.sheenColor} is not read`);
      const sheenColorFactor = three(Array.isArray(tint) ? tint : WHITE).map((x) => fit(x * amount));
      if (sheenColorFactor.some(Boolean)) {
        uses(read, 'KHR_materials_sheen');
        extensions.KHR_materials_sheen = { sheenColorFactor, sheenRoughnessFactor: fit(constant(...slots.sheenRoughness!)) };
      }
    }
  }
  if (slots.filmThickness) {
    const [name, unit, unset] = slots.filmThickness,
      thickness = constant(name, unset) * unit,
      amount = slots.filmWeight ? constant(...slots.filmWeight) : 1;
    if (thickness > 0 && amount > 0) {
      uses(read, 'KHR_materials_iridescence');
      extensions.KHR_materials_iridescence = {
        iridescenceFactor: fit(amount),
        iridescenceIor: constant(...slots.filmIor!),
        iridescenceThicknessMaximum: thickness,
        iridescenceThicknessMinimum: thickness,
      };
    }
  }
  if (kind === 'gltf_pbr') {
    const thickness = constant('thickness', 0),
      distance = get('attenuation_distance'),
      tint = get('attenuation_color', WHITE),
      strength = constant('anisotropy_strength', 0),
      dispersion = constant('dispersion', 0);
    if (thickness > 0) {
      const volume: Record<string, unknown> = { thicknessFactor: thickness };
      if (Array.isArray(distance)) volume.attenuationDistance = distance[0];
      if (Array.isArray(tint)) volume.attenuationColor = three(tint).map(fit);
      uses(read, 'KHR_materials_volume');
      extensions.KHR_materials_volume = volume;
    }
    if (strength > 0) {
      uses(read, 'KHR_materials_anisotropy');
      extensions.KHR_materials_anisotropy = { anisotropyStrength: fit(strength), anisotropyRotation: constant('anisotropy_rotation', 0) };
    }
    if (dispersion > 0) {
      uses(read, 'KHR_materials_dispersion');
      extensions.KHR_materials_dispersion = { dispersion };
    }
  }
  for (const name of slots.left ?? []) {
    const value = get(name);
    if (value !== undefined && !(Array.isArray(value) && value.every((v) => v === 0)))
      read.soft(`${kind} input ${name} on ${read.path} has no glTF form`);
  }
  if (Object.keys(extensions).length) material.extensions = extensions;
  return { material, uv: uvs[0], network: networkOf(read, shader) };
}

/** The type a node gives, from its id: the last word that names a type, or what the node always gives. */
function outputType(id: string, category: string): string {
  if (category === 'extract' || /^separate/.test(category)) return 'float';
  if (category === 'normalmap') return 'vector3';
  const found = [...id.matchAll(/(?:^|_)(float|integer|boolean|color[34]|vector[234]|matrix33|matrix44|surfaceshader)/g)];
  return found.at(-1)?.[1] ?? 'surfaceshader';
}

/** What a network comes to for `materialGraph`: plain nodes, keyed by prim path, so it can cross to a worker. */
function networkOf(read: SurfaceRead, shader: string): SavedNetwork {
  const nodes = lookup<MaterialXNode>({}),
    visit = (path: string): void => {
      if (nodes[path]) return;
      const id = String(read.attr(path, 'info:id') ?? ''),
        category = shaderKind(id).replace(/_(?:color|vector)[234].*$|_(?:float|integer|boolean).*$/, ''),
        node: MaterialXNode = { category: IMAGE_NODES[category] ?? category, name: path, type: outputType(id, category), inputs: lookup({}) };
      nodes[path] = node;
      const prefix = path + '.inputs:';
      for (const key in read.specs) {
        if (!key.startsWith(prefix)) continue;
        const name = key.slice(prefix.length),
          fields = read.specs[key].fields,
          input: MaterialXInput = { name, type: MTLX_TYPES[fields.typeName as string] ?? '' },
          target = read.connection(path, 'inputs:' + name);
        if (typeof fields.colorSpace === 'string') input.colorspace = fields.colorSpace;
        const owner = target?.slice(0, target.lastIndexOf('.')),
          isNode = owner !== undefined && read.attr(owner, 'info:id') !== undefined;
        if (isNode) {
          input.nodename = owner;
          input.output = target!.slice(target!.indexOf('.outputs:') + 9);
          visit(owner);
        } else {
          const value = target ? read.attr(owner!, target.slice(target.lastIndexOf('.') + 1)) : read.attr(path, 'inputs:' + name),
            list = numbers(value);
          if (value === undefined) continue;
          input.value = typeof value === 'string' ? value : list?.length === 1 && !/^(?:color|vector)/.test(input.type) ? list[0] : list;
        }
        node.inputs[name] = input;
      }
    };
  visit(shader);
  return { shader, nodes };
}
/** A network as `surface` stores it on its material's `extras.materialX`. */
interface SavedNetwork {
  shader: string;
  nodes: Record<string, MaterialXNode>;
}

/** Options of `materialGraph`. */
export interface MaterialGraphOptions extends MaterialXConvertOptions {}

/**
 * A material's whole network as a node material graph, for `nodeMaterial()` or `installNodeMaterial()` of
 * `@margoengine/materials`. `material` is a material's index in the document or its prim path. Without `options.texture`
 * images are listed in `skipped`. Undefined for a material with no MaterialX network.
 */
export async function materialGraph(asset: USDAsset, material: number | string, options: MaterialGraphOptions = {}): Promise<MaterialXConversion | undefined> {
  const { materials = [] } = asset.document,
    found = typeof material === 'number' ? materials[material] : materials.find((item) => item.name === material),
    saved = (found?.extras as { materialX?: SavedNetwork } | undefined)?.materialX;
  if (!saved) return undefined;
  const doc = materialXDocument({
    nodes: Object.assign(Object.create(null) as Record<string, MaterialXNode>, saved.nodes),
    materials: [{ name: found!.name!, shader: saved.nodes[saved.shader] }],
  });
  return doc.toGraph(undefined, options);
}

/**
 * MaterialX shading for the USD readers: pass `extensions: [composition(), materialX()]`. `.mtlx` files open as layers,
 * and a material bound through `outputs:mtlx:surface` comes in as a glTF PBR material with its textures, as far as glTF
 * holds it, whatever else it offers. `materialGraph` gives the whole network as a node material.
 */
export function materialX(): USDExtension {
  const hook: ExtensionHooks = {
    name: 'materialx',
    layer(read) {
      if (!/\.mtlx(?:\]|$)/i.test(read.id)) return undefined;
      try {
        return layerSpecs(readDocument(read));
      } catch (error) {
        // As with any layer that cannot be opened: the stage opens without it, and says so.
        if (!(error instanceof LoaderError)) throw error;
        read.issues.push({ code: 'bad-layer', message: `${read.id}: ${error.message}` });
        return Object.create(null) as Specs;
      }
    },
    surface,
  };
  return hook;
}
