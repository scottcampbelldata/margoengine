// MaterialX documents: nodes, node graphs, surface materials and looks, and the conversion to a node material graph.
import type { MaterialGraph, NormalMapNode, ValueNode } from '@margoengine/materials';
import { SRGBToLinear } from '@margoengine/math/color';
import { LoaderError } from './types.js';
import { throwIfAborted, toText, type BinaryInput } from './util.js';
import { readXMLTree, type XMLElement } from './xml.js';

const F = 'MaterialX';
const MAX_DEPTH = 256;

/** One input of a node: a value, or a connection to a node, a node graph output or a graph interface input. */
export interface MaterialXInput {
  name: string;
  type: string;
  /** The `value` attribute parsed by `type`: a number, boolean, string or array of numbers. */
  value?: number | boolean | string | number[];
  nodename?: string;
  nodegraph?: string;
  output?: string;
  interfacename?: string;
  /** This input's `colorspace`, else the nearest one above it in the document. */
  colorspace?: string;
  /** The `fileprefix` in force here, already joined to a `filename` value. */
  fileprefix?: string;
}

/** One node: a surface shader, an image, a maths operation. */
export interface MaterialXNode {
  /** The element name, such as `standard_surface`. */
  category: string;
  name: string;
  type: string;
  /** Inputs by name. Null prototype. */
  inputs: Record<string, MaterialXInput>;
}

/** A `nodegraph`: nodes, its named outputs and the inputs it takes from outside. */
export interface MaterialXNodeGraph {
  name: string;
  /** Nodes by name. Null prototype. */
  nodes: Record<string, MaterialXNode>;
  /** Outputs by name. Null prototype. */
  outputs: Record<string, MaterialXInput>;
  /** Interface inputs by name. Null prototype. */
  inputs: Record<string, MaterialXInput>;
}

/** A `surfacematerial` node with its surface shader found. */
export interface MaterialXMaterial {
  name: string;
  /** The connected surface shader, or null when it is missing or inside a graph this reader cannot follow. */
  shader: MaterialXNode | null;
}

/** A `materialassign` of a `look`. */
export interface MaterialXAssignment {
  look: string;
  material: string;
  geom?: string;
  collection?: string;
}

/** A request for one image of {@link MaterialXConvertOptions.texture}. */
export interface MaterialXTextureRequest {
  /** The path as written, with its `fileprefix`. */
  file: string;
  /** The node's output type: `float`, `color3`, `vector3` and so on. */
  type: string;
  /** `srgb_texture` or `srgb_rec709_scene` means upload as sRGB. Absent means linear data. */
  colorspace?: string;
  /** The node's `uaddressmode`, `vaddressmode` and `filtertype` values, when set. */
  addressU?: string;
  addressV?: string;
  filter?: string;
}

/** A texture of a node material: caller-owned, as `@margoengine/materials` takes it. */
export interface MaterialXTexture {
  view: GPUTextureView;
  sampler?: GPUSampler;
}

/** Options of {@link MaterialXDocument.toGraph}. */
export interface MaterialXConvertOptions {
  /** Loads one image. Each file, colour space and type is asked for once. Without this hook, image inputs are skipped. */
  texture?: (request: MaterialXTextureRequest) => MaterialXTexture | Promise<MaterialXTexture>;
  signal?: AbortSignal;
}

/** Something of the document that the node material could not hold. */
export interface MaterialXSkip {
  /** The shader input, such as `emission`. */
  input: string;
  /** Why, in words. */
  reason: string;
}

/** What {@link MaterialXDocument.toGraph} returns. Pass `graph` to `nodeMaterial()` or `installNodeMaterial()`. */
export interface MaterialXConversion {
  graph: MaterialGraph;
  /** What did not convert. The input keeps its value, or the shader's default. Empty when all of it converted. */
  skipped: MaterialXSkip[];
}

/** What {@link parseMaterialX} returns. */
export interface MaterialXDocument {
  /** The `version` attribute, such as `1.39`. */
  version: string;
  /** The document's `colorspace`, when set. */
  colorspace?: string;
  /** Top-level nodes by name. Null prototype. */
  nodes: Record<string, MaterialXNode>;
  /** Node graphs by name. Null prototype. */
  graphs: Record<string, MaterialXNodeGraph>;
  materials: MaterialXMaterial[];
  assignments: MaterialXAssignment[];
  /** `xi:include` targets, which this reader does not follow. */
  includes: string[];
  /** Converts one material, by name or the first by default, to a node material graph. */
  toGraph(material?: string, options?: MaterialXConvertOptions): Promise<MaterialXConversion>;
}

const COUNTS: Record<string, number> = {
  color3: 3,
  color4: 4,
  vector2: 2,
  vector3: 3,
  vector4: 4,
  matrix33: 9,
  matrix44: 16,
};

function parseValue(text: string, type: string): MaterialXInput['value'] {
  if (type === 'float' || type === 'integer') {
    const value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value)) throw new LoaderError(F, 'syntax', `bad ${type} "${text}"`);
    return value;
  }
  if (type === 'boolean') {
    if (text !== 'true' && text !== 'false') throw new LoaderError(F, 'syntax', `bad boolean "${text}"`);
    return text === 'true';
  }
  if (!Object.hasOwn(COUNTS, type)) return text;
  const count = COUNTS[type];
  // The specification separates with commas, and real files also write `0.5 0.5`, which OpenUSD reads.
  const values = text
    .trim()
    .split(/\s*,\s*|\s+/)
    .map((part) => Number(part));
  if (values.length !== count || values.some((value) => !Number.isFinite(value)))
    throw new LoaderError(F, 'syntax', `bad ${type} "${text}"`);
  return values;
}

/** What is inherited down the element tree. */
interface Scope {
  colorspace?: string;
  fileprefix?: string;
}

function scoped(element: XMLElement, scope: Scope): Scope {
  const { colorspace, fileprefix } = element.attributes;
  return {
    colorspace: colorspace ?? scope.colorspace,
    fileprefix: fileprefix === undefined ? scope.fileprefix : (scope.fileprefix ?? '') + fileprefix,
  };
}

function readInput(element: XMLElement, scope: Scope): MaterialXInput {
  const { name, type, value, nodename, nodegraph, output, interfacename } = element.attributes,
    here = scoped(element, scope);
  if (!name) throw new LoaderError(F, 'syntax', `<${element.name}> has no name`);
  const input: MaterialXInput = { name, type: type ?? '' };
  if (value !== undefined) {
    input.value = parseValue(value, input.type);
    if (input.type === 'filename' && here.fileprefix) input.value = here.fileprefix + value;
  }
  if (nodename !== undefined) input.nodename = nodename;
  if (nodegraph !== undefined) input.nodegraph = nodegraph;
  if (output !== undefined) input.output = output;
  if (interfacename !== undefined) input.interfacename = interfacename;
  if (here.colorspace !== undefined) input.colorspace = here.colorspace;
  if (here.fileprefix !== undefined) input.fileprefix = here.fileprefix;
  return input;
}

const table = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

function readNode(element: XMLElement, scope: Scope): MaterialXNode {
  const { name, type } = element.attributes,
    here = scoped(element, scope);
  if (!name) throw new LoaderError(F, 'syntax', `<${element.name}> has no name`);
  const inputs = table<MaterialXInput>();
  for (const child of element.children)
    if (child.name === 'input' || child.name === 'token') {
      const input = readInput(child, here);
      inputs[input.name] = input;
    }
  return { category: element.name, name, type: type ?? '', inputs };
}

/** Elements of a document that are not nodes. */
const NOT_NODES = new Set([
  'nodedef',
  'implementation',
  'typedef',
  'unit',
  'unitdef',
  'unittypedef',
  'geominfo',
  'geompropdef',
  'collection',
  'variantset',
  'propertyset',
  'propertysetassign',
  'attributedef',
  'targetdef',
  'token',
  'input',
  'output',
  'look',
  'lookgroup',
  'backdrop',
  'nodegraph',
  'include',
  'material',
]);

function readGraph(element: XMLElement, scope: Scope): MaterialXNodeGraph {
  const { name } = element.attributes,
    here = scoped(element, scope);
  if (!name) throw new LoaderError(F, 'syntax', '<nodegraph> has no name');
  const graph: MaterialXNodeGraph = {
    name,
    nodes: table<MaterialXNode>(),
    outputs: table<MaterialXInput>(),
    inputs: table<MaterialXInput>(),
  };
  for (const child of element.children) {
    if (child.name === 'output') {
      const output = readInput(child, here);
      graph.outputs[output.name] = output;
    } else if (child.name === 'input') {
      const input = readInput(child, here);
      graph.inputs[input.name] = input;
    } else if (!NOT_NODES.has(child.name)) {
      const node = readNode(child, here);
      graph.nodes[node.name] = node;
    }
  }
  return graph;
}

/** The inputs of a surface shader that map to node material slots, with the shader's own default for each. */
interface SurfaceMap {
  color: readonly [string, readonly [number, number, number]];
  /** Multiplies `color`, when the shader has one. */
  weight?: readonly [string, number];
  metal: readonly [string, number];
  roughness: readonly [string, number];
  normal: string;
  coat: readonly [string, number];
  coatRoughness: readonly [string, number];
  transmission: readonly [string, number];
  ior: readonly [string, number];
}

// Defaults from each shader's published definition.
const SURFACES: Record<string, SurfaceMap> = {
  standard_surface: {
    color: ['base_color', [0.8, 0.8, 0.8]],
    weight: ['base', 1],
    metal: ['metalness', 0],
    roughness: ['specular_roughness', 0.2],
    normal: 'normal',
    coat: ['coat', 0],
    coatRoughness: ['coat_roughness', 0.1],
    transmission: ['transmission', 0],
    ior: ['specular_IOR', 1.5],
  },
  open_pbr_surface: {
    color: ['base_color', [0.8, 0.8, 0.8]],
    weight: ['base_weight', 1],
    metal: ['base_metalness', 0],
    roughness: ['specular_roughness', 0.3],
    normal: 'geometry_normal',
    coat: ['coat_weight', 0],
    coatRoughness: ['coat_roughness', 0],
    transmission: ['transmission_weight', 0],
    ior: ['specular_ior', 1.5],
  },
  gltf_pbr: {
    color: ['base_color', [1, 1, 1]],
    metal: ['metallic', 1],
    roughness: ['roughness', 1],
    normal: 'normal',
    coat: ['clearcoat', 0],
    coatRoughness: ['clearcoat_roughness', 0],
    transmission: ['transmission', 0],
    ior: ['ior', 1.5],
  },
  realitykit_pbr_surfaceshader: {
    color: ['baseColor', [0.18, 0.18, 0.18]],
    metal: ['metallic', 0],
    roughness: ['roughness', 0.5],
    normal: 'normal',
    coat: ['clearcoat', 0],
    coatRoughness: ['clearcoatRoughness', 0.01],
    transmission: ['transmission', 0],
    ior: ['ior', 1.5],
  },
  UsdPreviewSurface: {
    color: ['diffuseColor', [0.18, 0.18, 0.18]],
    metal: ['metallic', 0],
    roughness: ['roughness', 0.5],
    normal: 'normal',
    coat: ['clearcoat', 0],
    coatRoughness: ['clearcoatRoughness', 0.01],
    transmission: ['transmission', 0],
    ior: ['ior', 1.5],
  },
};

/** Inputs that change nothing here: they carry no look, or the graph already behaves that way. */
const IGNORED = new Set([
  'tangent',
  'geometry_tangent',
  'geometry_coat_tangent',
  'coat_normal',
  'geometry_coat_normal',
]);

/** The node material colour space of a constant: `linear`, `srgb`, or null for one that cannot be converted here. */
function constantSpace(colorspace: string | undefined): 'linear' | 'srgb' | null {
  if (colorspace === undefined || colorspace === '' || /^(?:lin_rec709(?:_scene)?|none|data)$/.test(colorspace))
    return 'linear';
  return colorspace === 'srgb_texture' || colorspace === 'srgb_rec709_scene' ? 'srgb' : null;
}

/** One conversion of one material: follows connections, shares nodes, and notes what it drops. */
class Converter {
  readonly skipped: MaterialXSkip[] = [];
  private readonly done = new Map<MaterialXNode, ValueNode | null>();
  private readonly images = new Map<string, Promise<MaterialXTexture>>();
  private readonly path = new Set<MaterialXNode>();

  constructor(
    readonly doc: MaterialXDocument,
    readonly options: MaterialXConvertOptions,
  ) {}

  skip(input: string, reason: string): void {
    if (!this.skipped.some((item) => item.input === input && item.reason === reason))
      this.skipped.push({ input, reason });
  }

  /** What an input is connected to: the node, and the graph it lives in. Null for a plain value. */
  private follow(
    input: MaterialXInput,
    graph: MaterialXNodeGraph | null,
    depth = 0,
  ): { node: MaterialXNode | null; graph: MaterialXNodeGraph | null; value?: MaterialXInput } {
    if (depth > MAX_DEPTH) throw new LoaderError(F, 'range', `input ${input.name} is connected in a loop`);
    if (input.interfacename !== undefined) {
      const outer = graph?.inputs[input.interfacename];
      if (!outer) throw new LoaderError(F, 'syntax', `no interface input ${input.interfacename}`);
      return this.follow(outer, null, depth + 1);
    }
    if (input.nodegraph !== undefined) {
      const target = this.doc.graphs[input.nodegraph];
      if (!target) throw new LoaderError(F, 'syntax', `no node graph ${input.nodegraph}`);
      const outputs = Object.values(target.outputs),
        output = input.output === undefined ? outputs[0] : target.outputs[input.output];
      if (!output) throw new LoaderError(F, 'syntax', `no output ${input.output} in ${input.nodegraph}`);
      return this.follow(output, target, depth + 1);
    }
    if (input.nodename !== undefined) {
      const node = graph?.nodes[input.nodename] ?? this.doc.nodes[input.nodename];
      if (!node) throw new LoaderError(F, 'syntax', `no node ${input.nodename}`);
      return { node, graph: graph?.nodes[input.nodename] ? graph : null };
    }
    return { node: null, graph, value: input };
  }

  /** A constant input as a node: numbers to `scalar`, colours and vectors to `color`. */
  private constant(input: MaterialXInput, slot: string): ValueNode | null {
    const { value } = input;
    if (typeof value === 'number') return { type: 'scalar', value };
    if (!Array.isArray(value)) return null;
    let [r = 0, g = 0, b = 0, a = 1] = value;
    if (input.type === 'color3' || input.type === 'color4') {
      const space = constantSpace(input.colorspace);
      if (!space) this.skip(slot, `colour space ${input.colorspace} is not converted; the value is read as linear`);
      if (space === 'srgb') [r, g, b] = [SRGBToLinear(r), SRGBToLinear(g), SRGBToLinear(b)];
    } else if (value.length < 4) a = 1;
    return { type: 'color', value: [r, g, b, a] };
  }

  /** An input of a node inside the conversion; a missing one takes `fallback`. */
  private async operand(
    node: MaterialXNode,
    name: string,
    graph: MaterialXNodeGraph | null,
    slot: string,
    fallback: number,
  ): Promise<ValueNode | null> {
    const input = node.inputs[name];
    return input ? this.value(input, graph, slot) : { type: 'scalar', value: fallback };
  }

  private async image(node: MaterialXNode, slot: string): Promise<ValueNode | null> {
    const file = node.inputs.file,
      hook = this.options.texture;
    if (typeof file?.value !== 'string' || file.value === '') {
      this.skip(slot, `image ${node.name} names no file`);
      return null;
    }
    if (!hook) {
      this.skip(slot, `image ${file.value} needs options.texture`);
      return null;
    }
    const scale = node.inputs.uvtiling?.value,
      offset = node.inputs.uvoffset?.value;
    if (Array.isArray(scale) && scale.some((v) => v !== 1)) this.skip(slot, `uvtiling of ${node.name} is not applied`);
    if (Array.isArray(offset) && offset.some((v) => v !== 0))
      this.skip(slot, `uvoffset of ${node.name} is not applied`);
    const text = (name: string): string | undefined => {
        const { value } = node.inputs[name] ?? {};
        return typeof value === 'string' ? value : undefined;
      },
      colorspace = file.colorspace,
      request: MaterialXTextureRequest = { file: file.value, type: node.type };
    if (colorspace) request.colorspace = colorspace;
    const addressU = text('uaddressmode'),
      addressV = text('vaddressmode'),
      filter = text('filtertype');
    if (addressU) request.addressU = addressU;
    if (addressV) request.addressV = addressV;
    if (filter) request.filter = filter;
    const id = `${node.type}\n${colorspace ?? ''}\n${file.value}`;
    let texture = this.images.get(id);
    if (!texture) {
      texture = Promise.resolve(hook(request));
      this.images.set(id, texture);
    }
    return { type: 'texture', texture: await texture };
  }

  private async build(node: MaterialXNode, graph: MaterialXNodeGraph | null, slot: string): Promise<ValueNode | null> {
    const both = async (first: string, second: string, fallback: number): Promise<[ValueNode, ValueNode] | null> => {
      const a = await this.operand(node, first, graph, slot, fallback),
        b = await this.operand(node, second, graph, slot, fallback);
      return a && b ? [a, b] : null;
    };
    switch (node.category) {
      case 'image':
      case 'tiledimage':
      case 'gltf_image':
        return this.image(node, slot);
      case 'constant':
      case 'dot':
      case 'convert': {
        const name = node.category === 'constant' ? 'value' : 'in',
          input = node.inputs[name];
        return input ? this.value(input, graph, slot) : null;
      }
      case 'add': {
        const pair = await both('in1', 'in2', 0);
        return pair && { type: 'add', a: pair[0], b: pair[1] };
      }
      case 'multiply': {
        const pair = await both('in1', 'in2', 1);
        return pair && { type: 'mul', a: pair[0], b: pair[1] };
      }
      case 'subtract': {
        const pair = await both('in1', 'in2', 0);
        return pair && { type: 'add', a: pair[0], b: { type: 'mul', a: pair[1], b: { type: 'scalar', value: -1 } } };
      }
      case 'mix': {
        // Foreground over background by the mix factor, so factor 1 gives `fg`.
        const back = await this.operand(node, 'bg', graph, slot, 0),
          front = await this.operand(node, 'fg', graph, slot, 0),
          factor = await this.operand(node, 'mix', graph, slot, 0);
        return back && front && factor && { type: 'mix', a: back, b: front, factor };
      }
      default:
        this.skip(slot, `node ${node.category} has no node material form`);
        return null;
    }
  }

  /** An input as a value node, or null with a note when it cannot be one. */
  async value(input: MaterialXInput, graph: MaterialXNodeGraph | null, slot: string): Promise<ValueNode | null> {
    throwIfAborted(this.options.signal, F);
    const found = this.follow(input, graph);
    if (!found.node) return this.constant(found.value!, slot);
    const { node } = found;
    if (this.done.has(node)) return this.done.get(node)!;
    if (this.path.has(node)) throw new LoaderError(F, 'range', `node ${node.name} is connected in a loop`);
    if (this.path.size >= MAX_DEPTH) throw new LoaderError(F, 'range', 'node connections run too deep');
    this.path.add(node);
    const built = await this.build(node, found.graph, slot);
    this.path.delete(node);
    this.done.set(node, built);
    return built;
  }

  async normal(input: MaterialXInput, slot: string): Promise<NormalMapNode | null> {
    const found = this.follow(input, null);
    if (!found.node) return null;
    const { node, graph } = found;
    if (node.category !== 'normalmap') {
      this.skip(slot, `a normal from ${node.category} is not converted; connect a normalmap node`);
      return null;
    }
    const map = node.inputs.in;
    if (!map) return null;
    const texture = await this.value(map, graph, slot),
      scale = node.inputs.scale;
    if (!texture) return null;
    const result: NormalMapNode = { type: 'normalMap', texture };
    if (scale) {
      const amount = await this.value(scale, graph, slot);
      if (amount) result.scale = amount;
    }
    return result;
  }

  /** A shader input, or its default when it is unset or would not convert. */
  async slot(shader: MaterialXNode, [name, fallback]: readonly [string, number]): Promise<ValueNode> {
    const input = shader.inputs[name];
    return (input && (await this.value(input, null, name))) ?? { type: 'scalar', value: fallback };
  }

  /** True when the input is unset or still a constant equal to `off`, so its lobe adds nothing. */
  isOff(shader: MaterialXNode, name: string, off: number): boolean {
    const input = shader.inputs[name];
    if (!input) return true;
    const connected = input.nodename ?? input.nodegraph ?? input.interfacename;
    return connected === undefined && (input.value === undefined || input.value === off);
  }
}

async function convert(
  doc: MaterialXDocument,
  material: MaterialXMaterial,
  options: MaterialXConvertOptions,
): Promise<MaterialXConversion> {
  const { shader } = material;
  if (!shader) throw new LoaderError(F, 'syntax', `material ${material.name} has no surface shader`);
  const map = Object.hasOwn(SURFACES, shader.category) ? SURFACES[shader.category] : undefined;
  if (!map) throw new LoaderError(F, 'unsupported', `surface shader ${shader.category} is not converted`);
  const converter = new Converter(doc, options),
    [colorName, colorFallback] = map.color,
    colorInput = shader.inputs[colorName];
  let color: ValueNode = (colorInput && (await converter.value(colorInput, null, colorName))) ?? {
    type: 'color',
    value: [...colorFallback, 1],
  };
  if (map.weight && !converter.isOff(shader, map.weight[0], map.weight[1]))
    color = { type: 'mul', a: color, b: await converter.slot(shader, map.weight) };
  const emit: Extract<MaterialGraph['nodes'][number], { type: 'emit' }> = {
    type: 'emit',
    color,
    metalRough: {
      type: 'metalRough',
      roughness: await converter.slot(shader, map.roughness),
      metal: await converter.slot(shader, map.metal),
    },
  };
  const normal = shader.inputs[map.normal];
  if (normal) {
    const node = await converter.normal(normal, map.normal);
    if (node) emit.normal = node;
  }
  if (!converter.isOff(shader, map.coat[0], 0))
    emit.clearcoat = {
      type: 'clearcoat',
      factor: await converter.slot(shader, map.coat),
      roughness: await converter.slot(shader, map.coatRoughness),
    };
  if (!converter.isOff(shader, map.transmission[0], 0))
    emit.transmission = {
      type: 'transmission',
      factor: await converter.slot(shader, map.transmission),
      ior: await converter.slot(shader, map.ior),
    };
  const known = new Set([
    colorName,
    map.weight?.[0],
    map.metal[0],
    map.roughness[0],
    map.normal,
    map.coat[0],
    map.coatRoughness[0],
    map.transmission[0],
    map.ior[0],
  ]);
  for (const name of Object.keys(shader.inputs))
    if (!known.has(name) && !IGNORED.has(name))
      converter.skip(name, `${shader.category} input has no node material slot`);
  return { graph: { nodes: [emit] }, skipped: converter.skipped };
}

/**
 * Reads a MaterialX document (1.38 and later): its nodes, node graphs, surface materials and looks. `toGraph` turns a
 * `standard_surface`, `open_pbr_surface`, `gltf_pbr` or `UsdPreviewSurface` material into the object graph that
 * `nodeMaterial()` of `@margoengine/materials` takes.
 *
 * @throws LoaderError code `header` when the root is not `<materialx>`, `syntax` for a bad value or a missing name,
 * `unsupported` for a document of 1.37 or before.
 */
export function parseMaterialX(input: BinaryInput | string): MaterialXDocument {
  const root = readXMLTree(toText(input, F), F).children[0];
  if (root?.name !== 'materialx')
    throw new LoaderError(F, 'header', `root element is <${root?.name}>, not <materialx>`);
  const scope = scoped(root, {}),
    nodes = table<MaterialXNode>(),
    graphs = table<MaterialXNodeGraph>(),
    assignments: MaterialXAssignment[] = [],
    includes: string[] = [];
  for (const element of root.children) {
    const { name } = element;
    if (name === 'material')
      throw new LoaderError(
        F,
        'unsupported',
        'a <material> element is the form of 1.37 and before; upgrade the document',
      );
    if (name === 'nodegraph') {
      const graph = readGraph(element, scope);
      graphs[graph.name] = graph;
    } else if (name === 'include') {
      if (element.attributes.href) includes.push(element.attributes.href);
    } else if (name === 'look') {
      for (const child of element.children)
        if (child.name === 'materialassign') {
          const { material, geom, collection } = child.attributes,
            assignment: MaterialXAssignment = { look: element.attributes.name ?? '', material: material ?? '' };
          if (geom !== undefined) assignment.geom = geom;
          if (collection !== undefined) assignment.collection = collection;
          assignments.push(assignment);
        }
    } else if (!NOT_NODES.has(name)) {
      const node = readNode(element, scope);
      nodes[node.name] = node;
    }
  }
  const surface = (node: MaterialXNode): MaterialXNode | null => {
    const input = node.inputs.surfaceshader;
    if (input?.nodename !== undefined) return nodes[input.nodename] ?? null;
    if (input?.nodegraph !== undefined) {
      const graph = graphs[input.nodegraph],
        output = graph && (input.output === undefined ? Object.values(graph.outputs)[0] : graph.outputs[input.output]);
      return (output?.nodename !== undefined && graph?.nodes[output.nodename]) || null;
    }
    return null;
  };
  const materials = Object.values(nodes)
    .filter((node) => node.category === 'surfacematerial')
    .map((node) => ({ name: node.name, shader: surface(node) }));
  const doc = materialXDocument({ version: root.attributes.version ?? '', nodes, graphs, materials, assignments, includes });
  if (root.attributes.colorspace !== undefined) doc.colorspace = root.attributes.colorspace;
  return doc;
}

/** A document from parts, for a network that came from elsewhere, such as a USD stage. `nodes` have a null prototype. */
export function materialXDocument(
  parts: Partial<Omit<MaterialXDocument, 'toGraph'>> & Pick<MaterialXDocument, 'nodes' | 'materials'>,
): MaterialXDocument {
  const { materials } = parts,
    doc: MaterialXDocument = {
      version: '',
      graphs: table<MaterialXNodeGraph>(),
      assignments: [],
      includes: [],
      ...parts,
      toGraph(name, options = {}) {
        const material = name === undefined ? materials[0] : materials.find((item) => item.name === name);
        if (!material) return Promise.reject(new LoaderError(F, 'range', `no material ${name ?? 'in the document'}`));
        return convert(doc, material, options);
      },
    };
  return doc;
}
