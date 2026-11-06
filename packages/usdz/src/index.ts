import type { EngineKernel } from '@margoengine/core';
import { parseGLTF, type PBRModel } from '@margoengine/gltf-pro';
import {
  readZipDirectory,
  readZipEntry,
  fetchBytes,
  computeVertexNormals,
  type BinaryInput,
  LoaderError,
} from '@margoengine/loaders/common';
import { readUSDA, type USDPrim, type USDValue } from '@margoengine/loaders/usd';
import { parseCrate, type Specs } from './crate.js';
import type { GLTFDocument, GLTFMaterial, GLTFNode } from '../../shared/gltf.js';
import { multiplyMatrices } from '@margoengine/math/mat4';

/** Parse limits and loading hooks for the USD readers. Every limit is checked while parsing; a breach throws a `LoaderError` with code `limit`. */
export interface USDOptions {
  /** `fetch` used by `loadUSDZ`. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Largest layer or archive, in bytes, before and after expansion. Default 64 MiB. */
  maxBytes?: number;
  /** Most vertices after face expansion. Default 1,000,000. */
  maxVertices?: number;
  /** Most triangles after triangulation. Default 1,000,000. */
  maxTriangles?: number;
  /** Deepest prim hierarchy, 1 to 64. Default 32. */
  maxDepth?: number;
  /** Aborts parsing, fetching and texture decoding. */
  signal?: AbortSignal;
}
/** One triangulated mesh from the layer, in the stage's units and up axis (glTF: metres, Y up). */
export interface USDMesh {
  /** Prim path in the layer, e.g. `/Root/Chair`. */
  path: string;
  /** Vertex positions, three floats each. */
  positions: Float32Array;
  /** Vertex normals, three floats each; authored, or computed when the layer has none. */
  normals: Float32Array;
  /**
   * USD `st` texture coordinates as authored (origin at the image's bottom left, t up), two floats per vertex, when
   * authored. The glTF `document` holds them as uvs (s, 1 - t).
   */
  uvs?: Float32Array;
  /**
   * Linear vertex colors, four floats per vertex, when the bound material reads `displayColor` or `displayOpacity`
   * through a UsdPrimvarReader. The glTF `document` holds them as COLOR_0.
   */
  colors?: Float32Array;
  /** Triangle corner indices into the vertex streams. */
  indices: Uint32Array;
  /** Index into `document.materials`; a mesh with no binding gets a neutral grey one. */
  material: number;
}
type ImageSource = {
  path?: string;
  roughness?: { path: string; channel: number };
  metallic?: { path: string; channel: number };
  roughnessValue?: number;
  metallicValue?: number;
};
type USDDocument = Required<
  Pick<
    GLTFDocument,
    | 'asset'
    | 'buffers'
    | 'bufferViews'
    | 'accessors'
    | 'nodes'
    | 'meshes'
    | 'materials'
    | 'images'
    | 'textures'
    | 'scenes'
    | 'scene'
  >
> &
  Pick<GLTFDocument, 'samplers' | 'extensionsUsed'>;
/** glTF sampler wrap modes for UsdUVTexture's `wrapS`/`wrapT`; `black` and `useMetadata` keep glTF's default (repeat). */
const WRAP: Record<string, number> = { repeat: 10497, mirror: 33648, clamp: 33071 };
/** Where a texture is sampled: KHR_texture_transform values (glTF uv space, v down) and glTF wrap modes. */
interface Placement {
  transform?: { offset: [number, number]; rotation: number; scale: [number, number] };
  wrapS: number;
  wrapT: number;
}
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function fail(message: string): never {
  // Malformed input is a LoaderError, like every other loader; the code is taken from the wording.
  const code = /unsupported|reset transform|non-affine/.test(message)
    ? 'unsupported'
    : /limit|budget|exceeds|too many/.test(message)
      ? 'limit'
      : 'syntax';
  throw new LoaderError('USD', code, message);
}
function budget(options: USDOptions) {
  const values = {
    maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
    maxVertices: options.maxVertices ?? 1_000_000,
    maxTriangles: options.maxTriangles ?? 1_000_000,
    maxDepth: options.maxDepth ?? 32,
  };
  for (const value of Object.values(values)) if (!Number.isSafeInteger(value) || value < 1) fail('invalid parse limit');
  if (values.maxDepth > 64) fail('maxDepth exceeds 64');
  options.signal?.throwIfAborted();
  return values;
}
function bytes(input: BinaryInput): Uint8Array {
  return input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}
/** A display primvar's values and, when authored, its index stream. */
interface DisplayStream {
  values: ArrayLike<number>;
  indices?: ArrayLike<number>;
}
function numeric(value: unknown, size?: number): ArrayLike<number> {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) fail('expected numeric stream');
  const stream = value as ArrayLike<number>;
  if (size !== undefined && stream.length !== size) fail('invalid numeric stream length');
  for (let i = 0; i < stream.length; i++)
    if (typeof stream[i] !== 'number' || !Number.isFinite(Math.fround(stream[i]))) fail('non-finite numeric stream');
  return stream;
}
function scalar(value: unknown, min = 0, max = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    fail('invalid material factor');
  return value;
}
function pathName(name: string, base = ''): string {
  if (!name || /[\\\x00]|^[a-z]+:|^\//i.test(name)) fail('external or unsafe asset path');
  const parts = base.split('/').slice(0, -1);
  for (const part of name.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) fail('asset path escapes archive');
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}
/** USDA prim tree (shared tokenizer from @margoengine/loaders) to the same spec map the Crate reader produces. */
function asciiSpecs(text: string, maxDepth: number, signal?: AbortSignal): Specs {
  const layer = readUSDA(text, { maxDepth, signal, assets: true, skipOver: true });
  const plain = (v: USDValue): unknown =>
    Array.isArray(v)
      ? v.every((e) => typeof e === 'number' || Array.isArray(e))
        ? (v as unknown[]).flat(Infinity)
        : v.map(plain)
      : v && typeof v === 'object'
        ? 'asset' in v
          ? v.asset
          : v.path
        : v;
  const paths = (v: USDValue) => (Array.isArray(v) ? v : [v]).map(plain).filter((p) => typeof p === 'string');
  const specs: Specs = {
    '/': { specType: 7, fields: Object.fromEntries([...layer.metadata].map(([k, v]) => [k, plain(v)])) },
  };
  const visit = (prim: USDPrim) => {
    specs[prim.path] = {
      specType: 6,
      fields: { typeName: prim.type, ...Object.fromEntries([...prim.metadata].map(([k, v]) => [k, plain(v)])) },
    };
    // Null-prototype fields: the Object.assign below copies file metadata keys, and `__proto__` must stay a plain key.
    const property = (name: string) =>
      (specs[prim.path + '.' + name] ??= { specType: 1, fields: Object.create(null) }).fields;
    for (const [key, v] of prim.attrs) {
      if (key.endsWith('.connect')) property(key.slice(0, -8)).connectionPaths = paths(v);
      else if (
        v &&
        typeof v === 'object' &&
        ('path' in v || (Array.isArray(v) && v.length && v.every((e) => e && typeof e === 'object' && 'path' in e)))
      )
        property(key).targetPaths = paths(v);
      else property(key).default = plain(v);
    }
    for (const [key, meta] of prim.properties)
      Object.assign(
        property(key.replace(/\.connect$/, '')),
        Object.fromEntries([...meta].map(([k, v]) => [k, plain(v)])),
      );
    prim.children.forEach(visit);
  };
  layer.roots.forEach(visit);
  return specs;
}
function parseLayer(input: string | BinaryInput, options: USDOptions): Specs {
  const limits = budget(options),
    data = typeof input === 'string' ? new TextEncoder().encode(input) : bytes(input);
  if (data.length > limits.maxBytes) fail('layer exceeds byte budget');
  let specs: Specs;
  if (new TextDecoder().decode(data.subarray(0, 8)) === 'PXR-USDC') {
    if (data.length < 88) fail('truncated Crate bootstrap');
    const offset = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(16, true);
    if (offset > BigInt(data.length - 8)) fail('Crate TOC outside layer');
    specs = parseCrate(data, limits.maxBytes, limits.maxDepth);
  } else {
    let text = '';
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      fail('USDA layer is not UTF-8 text');
    }
    if (!text.startsWith('#usda 1.0')) fail('expected USDA or USDC');
    if (/\b(?:references|payload|subLayers|inherits|specializes|variantSet|timeSamples|instanceable)\b/.test(text))
      fail('composition and animation are unsupported');
    specs = asciiSpecs(text, limits.maxDepth, options.signal);
  }
  for (const [path, spec] of Object.entries(specs)) {
    if (path.split('/').length > limits.maxDepth + 2) fail('hierarchy exceeds depth limit');
    if (spec.fields.references || spec.fields.payload || spec.fields.timeSamples)
      fail('composition and animation are unsupported');
  }
  return specs;
}
const multiply = (a: number[], b: number[]): number[] => multiplyMatrices(a, b, new Array<number>(16));
function compose(path: string, specs: Specs): number[] {
  const order = specs[path + '.xformOpOrder']?.fields.default ?? specs[path]?.fields.xformOpOrder ?? [];
  if (!Array.isArray(order) || order.some((op) => typeof op !== 'string')) fail('invalid xformOpOrder');
  const get = (name: string) => specs[path + '.' + name]?.fields.default;
  let out = identity();
  for (const name of order) {
    const value = get(name),
      op = identity();
    if (name === '!resetXformStack!') fail('reset transform stacks are unsupported');
    if (name === 'xformOp:transform') {
      const matrix = numeric(value, 16);
      for (let i = 0; i < 16; i++) op[i] = matrix[i];
      if (op[3] || op[7] || op[11] || op[15] !== 1) fail('non-affine transform');
    } else if (name === 'xformOp:translate') {
      const v = numeric(value, 3);
      for (let i = 0; i < 3; i++) op[12 + i] = v[i];
    } else if (name === 'xformOp:scale') {
      const v = numeric(value, 3);
      for (let i = 0; i < 3; i++) {
        if (!v[i]) fail('singular transform');
        op[i * 5] = v[i];
      }
    } else if (name === 'xformOp:rotateXYZ') {
      const angles = numeric(value, 3);
      let rotation = identity();
      for (let axis = 0; axis < 3; axis++) {
        const a = (axis + 1) % 3,
          b = (axis + 2) % 3,
          rad = (angles[axis] * Math.PI) / 180,
          c = Math.cos(rad),
          s = Math.sin(rad),
          m = identity();
        m[a * 4 + a] = c;
        m[b * 4 + b] = c;
        m[a * 4 + b] = s;
        m[b * 4 + a] = -s;
        rotation = multiply(m, rotation);
      }
      out = multiply(out, rotation);
      continue;
    } else fail('unsupported transform ' + name);
    out = multiply(out, op);
  }
  return out;
}
/** A parsed USD scene: typed mesh streams plus a glTF document ready for `create()`. Parse with `parseUSDA`, `parseUSDC` or `parseUSDZ`. */
export class USDAsset {
  constructor(
    readonly document: GLTFDocument,
    readonly buffers: ArrayBufferView[],
    readonly meshes: USDMesh[],
    private readonly sources: ImageSource[],
    private readonly entries: Map<string, Uint8Array>,
  ) {}
  /** Attaches the scene to `engine` as a PBR model; texture ownership passes to the model. Pass `signal` to cancel texture decoding. */
  async create(engine: EngineKernel, { signal }: { signal?: AbortSignal } = {}): Promise<PBRModel> {
    const images = await this.images({ signal });
    try {
      signal?.throwIfAborted();
      return parseGLTF(engine, this.document, this.buffers, images);
    } catch (error) {
      for (const image of images) image.close();
      throw error;
    }
  }
  /** Decodes the scene's textures to `ImageBitmap`s in document order. The caller closes them unless they are passed to `create`. */
  async images({ signal }: { signal?: AbortSignal } = {}): Promise<ImageBitmap[]> {
    const images: ImageBitmap[] = [];
    const decode = async (path: string) => {
      signal?.throwIfAborted();
      const data = this.entries.get(path);
      if (!data) fail('missing texture ' + path);
      return createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>]));
    };
    try {
      for (const source of this.sources) {
        signal?.throwIfAborted();
        if (source.path) images.push(await decode(source.path));
        else {
          const rough = source.roughness ? await decode(source.roughness.path) : undefined;
          let metal: ImageBitmap | undefined;
          try {
            metal = source.metallic ? await decode(source.metallic.path) : undefined;
            const width = rough?.width ?? metal!.width,
              height = rough?.height ?? metal!.height;
            if (metal && (metal.width !== width || metal.height !== height))
              fail('metallic and roughness texture sizes differ');
            const canvas = new OffscreenCanvas(width, height),
              context = canvas.getContext('2d')!;
            if (rough) context.drawImage(rough, 0, 0);
            const r = rough ? context.getImageData(0, 0, width, height).data : undefined;
            context.clearRect(0, 0, width, height);
            if (metal) context.drawImage(metal, 0, 0);
            const m = metal ? context.getImageData(0, 0, width, height).data : undefined,
              packed = context.createImageData(width, height);
            for (let i = 0; i < packed.data.length; i += 4) {
              packed.data[i] = 255;
              packed.data[i + 1] = r
                ? r[i + source.roughness!.channel]
                : Math.round((source.roughnessValue ?? 0.5) * 255);
              packed.data[i + 2] = m ? m[i + source.metallic!.channel] : Math.round((source.metallicValue ?? 0) * 255);
              packed.data[i + 3] = 255;
            }
            context.putImageData(packed, 0, 0);
            images.push(await createImageBitmap(canvas));
          } finally {
            rough?.close();
            metal?.close();
          }
        }
      }
      signal?.throwIfAborted();
      return images;
    } catch (error) {
      for (const image of images) image.close();
      throw error;
    }
  }
}
function asset(specs: Specs, entries: Map<string, Uint8Array>, root: string, options: USDOptions): USDAsset {
  const limits = budget(options),
    buffers: ArrayBufferView[] = [],
    meshes: USDMesh[] = [],
    sources: ImageSource[] = [],
    doc: USDDocument = {
      asset: { version: '2.0' },
      buffers: [],
      bufferViews: [],
      accessors: [],
      nodes: [],
      meshes: [],
      materials: [],
      images: [],
      textures: [],
      scenes: [{ nodes: [0] }],
      scene: 0,
    };
  const attrs = (path: string, name: string) => specs[path + '.' + name]?.fields.default;
  const firstPath = (value: unknown): string | undefined => {
    if (value === undefined) return;
    if (!Array.isArray(value) || (value.length && typeof value[0] !== 'string')) fail('invalid relationship target');
    return (value as string[])[0];
  };
  const connection = (path: string, name: string) => firstPath(specs[path + '.' + name]?.fields.connectionPaths);
  /**
   * A UsdUVTexture's wrap modes and, when its `st` comes through a UsdTransform2d, that transform as
   * KHR_texture_transform. UsdTransform2d (UsdPreviewSurface spec) maps st to scale, then a counter-clockwise rotation
   * in degrees (t up), then translation. The document's uvs are (s, 1 - t), so the glTF transform keeps the angle's
   * sign (in radians) and its offset is (tx - sin(r) sy, 1 - cos(r) sy - ty): the inverse of exportUSDZ's mapping.
   */
  const placement = (shader: string): Placement => {
    const wrap = (name: string) => {
      const mode = attrs(shader, name);
      return typeof mode === 'string' && mode in WRAP ? WRAP[mode] : WRAP.repeat;
    };
    const result: Placement = { wrapS: wrap('inputs:wrapS'), wrapT: wrap('inputs:wrapT') },
      node = connection(shader, 'inputs:st')?.split('.outputs:')[0];
    if (node && attrs(node, 'info:id') === 'UsdTransform2d') {
      const degrees = attrs(node, 'inputs:rotation') ?? 0;
      if (typeof degrees !== 'number' || !Number.isFinite(degrees)) fail('invalid texture rotation');
      const scale = numeric(attrs(node, 'inputs:scale') ?? [1, 1], 2),
        translation = numeric(attrs(node, 'inputs:translation') ?? [0, 0], 2),
        rotation = (degrees * Math.PI) / 180,
        c = Math.cos(rotation),
        s = Math.sin(rotation);
      result.transform = {
        offset: [translation[0] - s * scale[1], 1 - c * scale[1] - translation[1]],
        rotation,
        scale: [scale[0], scale[1]],
      };
    }
    return result;
  };
  const texture = (path: string, name: string): { path: string; channel: number; placement: Placement } | undefined => {
    const target = connection(path, name);
    if (!target) return;
    const shader = target.split('.outputs:')[0];
    if (attrs(shader, 'info:id') !== 'UsdUVTexture') fail('unsupported texture shader');
    const file = attrs(shader, 'inputs:file');
    if (typeof file !== 'string') fail('missing texture asset');
    const channel = target.split('.outputs:')[1],
      index = 'rgba'.indexOf(channel);
    if (index < 0 && channel !== 'rgb') fail('unsupported texture channel');
    return { path: pathName(file, root), channel: Math.max(0, index), placement: placement(shader) };
  };
  /**
   * The fallback of the UsdPrimvarReader feeding `name`, when one does. Only the display primvars mean anything to a
   * glTF material; a reader of any other primvar is refused, as a general shader graph is.
   */
  const display = (path: string, name: string, varname: string, width: number): number[] | undefined => {
    const shader = connection(path, name)?.split('.outputs:')[0];
    if (!shader || attrs(shader, 'info:id') !== `UsdPrimvarReader_float${width === 1 ? '' : width}`) return;
    if (attrs(shader, 'inputs:varname') !== varname) fail('unsupported primvar reader on ' + name);
    const fallback = attrs(shader, 'inputs:fallback');
    if (fallback === undefined) return new Array<number>(width).fill(0);
    return width === 1 ? [scalar(fallback)] : Array.from(numeric(fallback, width));
  };
  /** A texture for `source` and its glTF texture info, with the sampler and KHR_texture_transform `where` needs. */
  const image = (source: ImageSource, where: Placement): { index: number; extensions?: Record<string, unknown> } => {
    const index = sources.length;
    sources.push(source);
    doc.images.push({});
    let sampler: number | undefined;
    if (where.wrapS !== WRAP.repeat || where.wrapT !== WRAP.repeat) {
      doc.samplers ??= [];
      sampler = doc.samplers.push({ wrapS: where.wrapS, wrapT: where.wrapT }) - 1;
    }
    doc.textures.push(sampler === undefined ? { source: index } : { source: index, sampler });
    if (!where.transform) return { index };
    doc.extensionsUsed ??= [];
    if (!doc.extensionsUsed.includes('KHR_texture_transform')) doc.extensionsUsed.push('KHR_texture_transform');
    return { index, extensions: { KHR_texture_transform: where.transform } };
  };
  const materialIds = new Map<string, number>(),
    // Per material: the fallback colour and opacity of the display primvars it reads.
    displays = new Map<number, { color?: number[]; opacity?: number[] }>();
  function material(path: string): number {
    let binding: string | undefined;
    for (let owner = path; owner && !binding; owner = owner.slice(0, owner.lastIndexOf('/')))
      binding = firstPath(specs[owner + '.material:binding']?.fields.targetPaths);
    const shader = binding ? connection(binding, 'outputs:surface')?.split('.outputs:')[0] : undefined;
    if (binding && !shader) fail('unresolved material binding');
    if (shader && attrs(shader, 'info:id') !== 'UsdPreviewSurface') fail('unsupported surface shader');
    const key = shader ?? '';
    if (materialIds.has(key)) return materialIds.get(key)!;
    const rgb = numeric(shader ? (attrs(shader, 'inputs:diffuseColor') ?? [0.18, 0.18, 0.18]) : [0.7, 0.7, 0.7], 3),
      opacity = scalar(shader ? (attrs(shader, 'inputs:opacity') ?? 1) : 1),
      roughness = scalar(shader ? (attrs(shader, 'inputs:roughness') ?? 0.5) : 0.5),
      metallic = scalar(shader ? (attrs(shader, 'inputs:metallic') ?? 0) : 0),
      threshold = scalar(shader ? (attrs(shader, 'inputs:opacityThreshold') ?? 0) : 0),
      color = shader ? display(shader, 'inputs:diffuseColor', 'displayColor', 3) : undefined,
      vertexOpacity = shader ? display(shader, 'inputs:opacity', 'displayOpacity', 1) : undefined;
    const p: NonNullable<GLTFMaterial['pbrMetallicRoughness']> = {
        baseColorFactor: [scalar(rgb[0]), scalar(rgb[1]), scalar(rgb[2]), opacity],
        roughnessFactor: roughness,
        metallicFactor: metallic,
      },
      definition: GLTFMaterial = {
        pbrMetallicRoughness: p,
        doubleSided: true,
      },
      /** glTF's alpha mode for a surface that is not opaque: USD cuts it out at a threshold above 0, else blends. */
      seeThrough = () => {
        definition.alphaMode = threshold > 0 ? 'MASK' : 'BLEND';
        if (threshold > 0) definition.alphaCutoff = threshold;
      };
    definition.alphaMode = 'OPAQUE';
    if (opacity < 1 || vertexOpacity) seeThrough();
    if (color) p.baseColorFactor = [1, 1, 1, opacity];
    if (shader) {
      const diffuse = color ? undefined : texture(shader, 'inputs:diffuseColor'),
        alpha = vertexOpacity ? undefined : texture(shader, 'inputs:opacity'),
        normal = texture(shader, 'inputs:normal'),
        rough = texture(shader, 'inputs:roughness'),
        metal = texture(shader, 'inputs:metallic');
      if (diffuse) {
        p.baseColorFactor = [1, 1, 1, opacity];
        p.baseColorTexture = image({ path: diffuse.path }, diffuse.placement);
      }
      // glTF holds opacity in the base colour's alpha, so an opacity map has to be that texture's own.
      if (alpha) {
        if (alpha.path !== diffuse?.path || alpha.channel !== 3) fail('unsupported opacity texture');
        seeThrough();
      }
      if (normal) definition.normalTexture = image({ path: normal.path }, normal.placement);
      if (rough || metal) {
        // One packed glTF texture: both maps must be sampled the same way.
        if (rough && metal && JSON.stringify(rough.placement) !== JSON.stringify(metal.placement))
          fail('unsupported roughness and metallic textures with different transforms or wrap modes');
        p.metallicRoughnessTexture = image(
          {
            roughness: rough && { path: rough.path, channel: rough.channel },
            metallic: metal && { path: metal.path, channel: metal.channel },
            roughnessValue: roughness,
            metallicValue: metallic,
          },
          (rough ?? metal)!.placement,
        );
        p.roughnessFactor = 1;
        p.metallicFactor = 1;
      }
    }
    const id = doc.materials.length;
    doc.materials.push(definition);
    materialIds.set(key, id);
    displays.set(id, { color, opacity: vertexOpacity });
    return id;
  }
  function accessor(data: Float32Array | Uint32Array, type: string): number {
    const buffer = buffers.length;
    buffers.push(data);
    doc.buffers.push({ byteLength: data.byteLength });
    const view = doc.bufferViews.length;
    doc.bufferViews.push({ buffer, byteLength: data.byteLength });
    const index = doc.accessors.length;
    doc.accessors.push({
      bufferView: view,
      componentType: data instanceof Uint32Array ? 5125 : 5126,
      count: data.length / (type === 'VEC4' ? 4 : type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1),
      type,
    });
    return index;
  }
  /** The mesh's display primvar, or the reader's fallback as one constant value when the mesh authors none. */
  const displayStream = (path: string, name: string, fallback: number[], width: number): DisplayStream => {
    const value = attrs(path, 'primvars:' + name);
    return value === undefined
      ? { values: fallback }
      : {
          values: numeric(value),
          indices: attrs(path, 'primvars:' + name + ':indices') as ArrayLike<number> | undefined,
        };
  };
  const metadata = specs['/']?.fields ?? {},
    unit = metadata.metersPerUnit ?? 0.01,
    axis = metadata.upAxis ?? 'Y';
  if (
    typeof unit !== 'number' ||
    !Number.isFinite(unit) ||
    unit <= 0 ||
    typeof axis !== 'string' ||
    !['Y', 'Z'].includes(axis)
  )
    fail('invalid units or up axis');
  const base = identity();
  base[0] = unit;
  base[5] = axis === 'Y' ? unit : 0;
  base[10] = axis === 'Y' ? unit : 0;
  if (axis === 'Z') {
    base[6] = -unit;
    base[9] = unit;
  }
  doc.nodes.push({ name: 'USD', matrix: base, children: [] });
  const nodeIds = new Map<string, number>([['/', 0]]);
  let totalVertices = 0,
    totalTriangles = 0,
    polygonWork = 0;
  for (const [path, spec] of Object.entries(specs).sort(([a], [b]) => a.split('/').length - b.split('/').length))
    if (path !== '/' && spec.specType === 6) {
      options.signal?.throwIfAborted();
      const parent = path.slice(0, path.lastIndexOf('/')) || '/',
        parentId = nodeIds.get(parent);
      if (parentId === undefined) continue;
      if (spec.fields.active === false || attrs(path, 'visibility') === 'invisible') continue;
      const node: GLTFNode & { children: number[] } = {
          name: path.split('/').at(-1),
          matrix: compose(path, specs),
          children: [],
        },
        id = doc.nodes.length;
      doc.nodes.push(node);
      doc.nodes[parentId].children!.push(id);
      nodeIds.set(path, id);
      if (spec.fields.typeName !== 'Mesh') continue;
      if (
        (attrs(path, 'subdivisionScheme') ?? 'catmullClark') !== 'none' ||
        (attrs(path, 'holeIndices') as ArrayLike<number> | undefined)?.length
      )
        fail('subdivision and hole faces are unsupported');
      const points = numeric(attrs(path, 'points')),
        counts = numeric(attrs(path, 'faceVertexCounts')),
        faces = numeric(attrs(path, 'faceVertexIndices'));
      if (points.length % 3) fail('invalid points');
      let triangles = 0,
        corners = 0;
      for (let i = 0; i < counts.length; i++) {
        const count = counts[i];
        if (!Number.isSafeInteger(count) || count < 3) fail('invalid face count');
        triangles += count - 2;
        corners += count;
      }
      if (corners !== faces.length) fail('topology counts mismatch');
      totalVertices += triangles * 3;
      totalTriangles += triangles;
      if (totalVertices > limits.maxVertices || totalTriangles > limits.maxTriangles) fail('geometry exceeds limit');
      for (let i = 0; i < faces.length; i++)
        if (!Number.isSafeInteger(faces[i]) || faces[i] < 0 || faces[i] >= points.length / 3)
          fail('face index outside points');
      const normalValue = attrs(path, 'normals'),
        uvValue = attrs(path, 'primvars:st'),
        normal = normalValue === undefined ? undefined : numeric(normalValue),
        uv = uvValue === undefined ? undefined : numeric(uvValue),
        uvIndices = attrs(path, 'primvars:st:indices') as ArrayLike<number> | undefined,
        positions = new Float32Array(triangles * 9),
        normals = new Float32Array(triangles * 9),
        uvs = uv ? new Float32Array(triangles * 6) : undefined,
        indices = new Uint32Array(triangles * 3),
        materialId = material(path),
        reads = displays.get(materialId)!,
        colors = reads.color || reads.opacity ? new Float32Array(triangles * 12) : undefined,
        tint = reads.color && displayStream(path, 'displayColor', reads.color, 3),
        fade = reads.opacity && displayStream(path, 'displayOpacity', reads.opacity, 1);
      const sample = (
        stream: ArrayLike<number>,
        width: number,
        corner: number,
        vertex: number,
        face: number,
        property: string,
      ): number => {
        const interpolation = specs[path + '.' + property]?.fields.interpolation;
        if (interpolation === 'constant') return 0;
        if (interpolation === 'uniform') return face;
        if (interpolation === 'faceVarying') return corner;
        if (interpolation === 'vertex' || interpolation === 'varying') return vertex;
        if (stream.length === (points.length / 3) * width) return vertex;
        if (stream.length === corners * width) return corner;
        if (stream.length === width) return 0;
        return fail('unsupported stream interpolation');
      };
      let cursor = 0,
        at = 0;
      const orientation = attrs(path, 'orientation') ?? 'rightHanded';
      if (typeof orientation !== 'string' || !['leftHanded', 'rightHanded'].includes(orientation))
        fail('invalid orientation');
      for (let f = 0; f < counts.length; f++) {
        const count = counts[f];
        // shortcut: triangles and convex planar polygons, tessellate concave polygons before loading.
        if (count > 3) {
          if (count > 1024) fail('polygon exceeds validation limit');
          if ((polygonWork += count * count) > 10_000_000) fail('polygon validation work exceeds limit');
          const a = faces[cursor] * 3,
            b = faces[cursor + 1] * 3,
            c = faces[cursor + 2] * 3,
            ux = points[b] - points[a],
            uy = points[b + 1] - points[a + 1],
            uz = points[b + 2] - points[a + 2],
            vx = points[c] - points[a],
            vy = points[c + 1] - points[a + 1],
            vz = points[c + 2] - points[a + 2],
            nx = uy * vz - uz * vy,
            ny = uz * vx - ux * vz,
            nz = ux * vy - uy * vx,
            len = Math.hypot(nx, ny, nz);
          if (!len) fail('degenerate polygon');
          for (let k = 0; k < count; k++) {
            const p = faces[cursor + k] * 3,
              q = faces[cursor + ((k + 1) % count)] * 3,
              ex = points[q] - points[p],
              ey = points[q + 1] - points[p + 1],
              ez = points[q + 2] - points[p + 2];
            for (let j = 0; j < count; j++) {
              const r = faces[cursor + j] * 3,
                dx = points[r] - points[p],
                dy = points[r + 1] - points[p + 1],
                dz = points[r + 2] - points[p + 2];
              if (
                Math.abs(
                  nx * (points[r] - points[a]) +
                    ny * (points[r + 1] - points[a + 1]) +
                    nz * (points[r + 2] - points[a + 2]),
                ) >
                  len * 1e-5 ||
                nx * (ey * dz - ez * dy) + ny * (ez * dx - ex * dz) + nz * (ex * dy - ey * dx) < -len * 1e-10
              )
                fail('concave or non-planar polygon');
            }
          }
        }
        for (let k = 1; k < count - 1; k++)
          for (let t = 0; t < 3; t++) {
            const corner =
                cursor + (t === 0 ? 0 : orientation === 'leftHanded' ? (t === 1 ? k + 1 : k) : t === 1 ? k : k + 1),
              vertex = faces[corner];
            for (let d = 0; d < 3; d++) positions[at * 3 + d] = points[vertex * 3 + d];
            if (normal) {
              const n = sample(normal, 3, corner, vertex, f, 'normals');
              if (n * 3 + 2 >= normal.length) fail('normal index outside stream');
              for (let d = 0; d < 3; d++) normals[at * 3 + d] = normal[n * 3 + d];
            }
            if (uv && uvs) {
              const u = uvIndices
                ? uvIndices[sample(uvIndices, 1, corner, vertex, f, 'primvars:st')]
                : sample(uv, 2, corner, vertex, f, 'primvars:st');
              if (!Number.isSafeInteger(u) || u < 0 || u * 2 + 1 >= uv.length) fail('UV index outside stream');
              uvs[at * 2] = uv[u * 2];
              uvs[at * 2 + 1] = uv[u * 2 + 1];
            }
            if (colors) {
              const entry = (stream: DisplayStream, width: number, property: string): number => {
                const i = stream.indices
                  ? stream.indices[sample(stream.indices, 1, corner, vertex, f, property)]
                  : sample(stream.values, width, corner, vertex, f, property);
                if (!Number.isSafeInteger(i) || i < 0 || i * width + width > stream.values.length)
                  fail('display primvar index outside stream');
                return i * width;
              };
              colors.fill(1, at * 4, at * 4 + 4);
              if (tint) {
                const i = entry(tint, 3, 'primvars:displayColor');
                for (let d = 0; d < 3; d++) colors[at * 4 + d] = tint.values[i + d];
              }
              if (fade) colors[at * 4 + 3] = fade.values[entry(fade, 1, 'primvars:displayOpacity')];
            }
            indices[at] = at;
            at++;
          }
        cursor += count;
      }
      if (!normal) normals.set(computeVertexNormals(positions, indices));
      const attributes: Record<string, number> = {
        POSITION: accessor(positions, 'VEC3'),
        NORMAL: accessor(normals, 'VEC3'),
      };
      if (colors) attributes.COLOR_0 = accessor(colors, 'VEC4');
      // USD st has its origin at the image's bottom left (t up); glTF uvs at its top left (v down): v = 1 - t.
      if (uvs)
        attributes.TEXCOORD_0 = accessor(
          Float32Array.from(uvs, (x, i) => (i % 2 ? 1 - x : x)),
          'VEC2',
        );
      const mesh = doc.meshes.length;
      doc.meshes.push({
        primitives: [
          {
            attributes,
            indices: accessor(indices, 'SCALAR'),
            material: materialId,
          },
        ],
      });
      node.mesh = mesh;
      meshes.push({
        path,
        positions,
        normals,
        uvs,
        colors,
        indices,
        material: materialId,
      });
    }
  if (!meshes.length) fail('no renderable meshes');
  for (const source of sources)
    for (const name of [source.path, source.roughness?.path, source.metallic?.path])
      if (name && !entries.has(name)) fail('missing texture ' + name);
  return new USDAsset(doc, buffers, meshes, sources, entries);
}
/** Parses a USDA (text) layer, as a string or UTF-8 bytes. Throws `LoaderError` (format `USD`) for malformed or unsupported input. */
export function parseUSDA(input: string | BinaryInput, options: USDOptions = {}): USDAsset {
  return asset(parseLayer(input, options), new Map(), 'scene.usda', options);
}
/** Parses a binary USDC (Crate 0.4 to 0.12) layer. Throws `LoaderError` (format `USD`) for malformed or unsupported input. */
export function parseUSDC(input: BinaryInput, options: USDOptions = {}): USDAsset {
  const data = bytes(input);
  if (new TextDecoder().decode(data.subarray(0, 8)) !== 'PXR-USDC') fail('expected Crate magic');
  return asset(parseLayer(data, options), new Map(), 'scene.usdc', options);
}
/** Parses a USDZ archive: the first entry is the root layer and its textures are read from the archive. Throws `LoaderError` (format `USD`) for malformed input. */
export async function parseUSDZ(input: BinaryInput, options: USDOptions = {}): Promise<USDAsset> {
  const limits = budget(options),
    data = bytes(input);
  if (data.length > limits.maxBytes) fail('archive exceeds byte budget');
  const directory = readZipDirectory(data, { maxEntries: 1000 }),
    entries = new Map<string, Uint8Array>();
  let total = 0;
  for (const entry of directory) {
    options.signal?.throwIfAborted();
    total += entry.size;
    if (total > limits.maxBytes) fail('expanded archive exceeds byte budget');
    const name = pathName(entry.name);
    if (entries.has(name)) fail('duplicate archive path');
    entries.set(
      name,
      await readZipEntry(data, entry, {
        maxEntryBytes: limits.maxBytes,
        signal: options.signal,
      }),
    );
  }
  const root = directory.reduce<(typeof directory)[number] | undefined>(
    (first, entry) => (!first || entry.headerOffset < first.headerOffset ? entry : first),
    undefined,
  );
  if (!root || !/\.(usd|usda|usdc)$/i.test(root.name)) fail('first archive entry must be the root USD layer');
  const name = pathName(root.name);
  return asset(parseLayer(entries.get(name)!, options), entries, name, options);
}
/** Fetches a `.usdz` with a streaming byte limit, parses it and attaches it to `engine`. Pass `signal` to cancel. Returns the PBR model; call `destroy()` to free it. */
export async function loadUSDZ(engine: EngineKernel, url: string | URL, options: USDOptions = {}): Promise<PBRModel> {
  const limits = budget(options),
    data = await fetchBytes(url, {
      maxBytes: limits.maxBytes,
      signal: options.signal,
      fetch: options.fetch,
    });
  return (await parseUSDZ(data, options)).create(engine, options);
}
