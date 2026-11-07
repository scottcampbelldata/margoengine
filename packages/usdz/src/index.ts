import type { EngineKernel } from '@margoengine/core';
import { parseGLTF, type PBRModel } from '@margoengine/gltf-pro/model';
import {
  readZipDirectory,
  readZipEntry,
  fetchBytes,
  computeVertexNormals,
  type BinaryInput,
  LoaderError,
} from '@margoengine/loaders/common';
import { readUSDA, type USDPrim, type USDValue } from '@margoengine/loaders/usd';
import { parseCrate, type Specs, type TimeSamples } from './crate.js';
import type { ExtensionHooks, SceneMesh, USDExtension, USDIssue } from './extension.js';
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
  /** Optional parts of the import, from this package's entries, such as `composition()` of `/compose`. */
  extensions?: readonly USDExtension[];
}
export type { USDExtension, USDIssue };
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
  /** GeomSubsets with a material of their own: each is a primitive of the mesh. `material` above covers the faces left. */
  subsets?: USDMeshSubset[];
}
/** The faces of a mesh under one GeomSubset. */
export interface USDMeshSubset {
  /** The subset's prim path. */
  path: string;
  /** Triangle corner indices into the mesh's vertex streams. */
  indices: Uint32Array;
  /** Index into `document.materials`. */
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
/** The hook of each extension that has `name`. */
const hooks = (options: USDOptions) => (options.extensions ?? []) as readonly ExtensionHooks[];
function parseLayer(
  input: string | BinaryInput,
  options: USDOptions,
  id: string,
  entries: Map<string, Uint8Array>,
  issues: USDIssue[],
): Specs {
  const limits = budget(options),
    data = typeof input === 'string' ? new TextEncoder().encode(input) : bytes(input);
  if (data.length > limits.maxBytes) fail('layer exceeds byte budget');
  const composer = hooks(options).find((hook) => hook.compose);
  if (composer)
    return composer.compose!({
      id,
      data,
      entries,
      maxBytes: limits.maxBytes,
      maxDepth: limits.maxDepth,
      issues,
      signal: options.signal,
    });
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
    // readUSDA composes internal references (`references = </Path>`), so only those pass.
    if (
      /\b(?:references(?!\s*=\s*<)|payload|subLayers|inherits|specializes|variantSet|timeSamples|instanceable)\b/.test(text)
    )
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
/** A rotation of `degrees` about axis 0, 1 or 2. */
function axisRotation(axis: number, degrees: number): number[] {
  const a = (axis + 1) % 3,
    b = (axis + 2) % 3,
    rad = (degrees * Math.PI) / 180,
    c = Math.cos(rad),
    s = Math.sin(rad),
    m = identity();
  m[a * 4 + a] = c;
  m[b * 4 + b] = c;
  m[a * 4 + b] = s;
  m[b * 4 + a] = -s;
  return m;
}
/** The matrix of one xformOp, by the UsdGeomXformOp schema. `kind` is the op's type, such as `rotateZXY`. */
function opMatrix(kind: string, value: unknown): number[] {
  const op = identity();
  if (kind === 'transform') {
    const matrix = numeric(value, 16);
    for (let i = 0; i < 16; i++) op[i] = matrix[i];
    if (op[3] || op[7] || op[11] || op[15] !== 1) fail('non-affine transform');
  } else if (kind === 'translate') {
    const v = numeric(value, 3);
    for (let i = 0; i < 3; i++) op[12 + i] = v[i];
  } else if (kind === 'scale') {
    const v = numeric(value, 3);
    for (let i = 0; i < 3; i++) op[i * 5] = v[i];
  } else if (kind === 'orient') {
    const [w, x, y, z] = Array.from(numeric(value, 4)),
      n = Math.hypot(w, x, y, z) || 1,
      [qw, qx, qy, qz] = [w / n, x / n, y / n, z / n];
    op[0] = 1 - 2 * (qy * qy + qz * qz);
    op[1] = 2 * (qx * qy + qw * qz);
    op[2] = 2 * (qx * qz - qw * qy);
    op[4] = 2 * (qx * qy - qw * qz);
    op[5] = 1 - 2 * (qx * qx + qz * qz);
    op[6] = 2 * (qy * qz + qw * qx);
    op[8] = 2 * (qx * qz + qw * qy);
    op[9] = 2 * (qy * qz - qw * qx);
    op[10] = 1 - 2 * (qx * qx + qy * qy);
  } else if (/^rotate[XYZ]$/.test(kind)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('expected numeric stream');
    return axisRotation('XYZ'.indexOf(kind[6]), value);
  } else if (/^rotate[XYZ]{3}$/.test(kind)) {
    // The name lists the axes in the order they turn; the value is always the X, Y and Z angles.
    const angles = numeric(value, 3);
    let rotation = identity();
    for (const letter of kind.slice(6)) {
      const axis = 'XYZ'.indexOf(letter);
      rotation = multiply(axisRotation(axis, angles[axis]), rotation);
    }
    return rotation;
  } else fail('unsupported transform ' + kind);
  return op;
}
/** An affine matrix's inverse; an op that cannot be inverted is the identity's, as nothing can be undone. */
function invert(m: number[]): number[] {
  const [a, b, c, , d, e, f, , g, h, i] = m,
    co = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d],
    det = a * co[0] + b * co[3] + c * co[6];
  if (!det) fail('singular transform');
  const out = identity();
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) out[col * 4 + row] = co[col * 3 + row] / det;
  for (let row = 0; row < 3; row++)
    out[12 + row] = -(out[row] * m[12] + out[4 + row] * m[13] + out[8 + row] * m[14]);
  return out;
}
/** The token of `xformOpOrder` that stops a prim inheriting its parent's transform. */
const RESET = '!resetXformStack!';
/** The ops that place a prim: everything up to the last reset is ignored, by the UsdGeomXformable schema. */
const counted = (order: string[]) => order.slice(order.lastIndexOf(RESET) + 1);
/** A prim's local matrix from its ordered ops. `get` reads an op's value at the time wanted. */
function compose(order: unknown, get: (name: string) => unknown): number[] {
  if (order === undefined) return identity();
  if (!Array.isArray(order) || order.some((op) => typeof op !== 'string')) fail('invalid xformOpOrder');
  let out = identity();
  for (const entry of counted(order as string[])) {
    const inverse = entry.startsWith('!invert!'),
      name = inverse ? entry.slice(8) : entry,
      value = get(name);
    if (!name.startsWith('xformOp:')) fail('unsupported transform ' + name);
    // An op with no value has no effect, as a stage reads it.
    if (value === undefined) continue;
    const op = opMatrix(name.split(':')[1], value);
    out = multiply(out, inverse ? invert(op) : op);
  }
  return out;
}
/** True for the value of a `normal3f[]`, or another vector list, and not of a single vector or a list of numbers. */
const normalList = (value: unknown, type: unknown) =>
  Array.isArray(value) && value.length % 3 === 0 && typeof type === 'string' && /3[fdh]\[\]$/.test(type);
/** A parsed USD scene: typed mesh streams plus a glTF document ready for `create()`. Parse with `parseUSDA`, `parseUSDC` or `parseUSDZ`. */
export class USDAsset {
  constructor(
    readonly document: GLTFDocument,
    readonly buffers: ArrayBufferView[],
    readonly meshes: USDMesh[],
    private readonly sources: ImageSource[],
    private readonly entries: Map<string, Uint8Array>,
    /** What the import had to leave out, such as a layer it could not open. Empty for a clean file. */
    readonly issues: USDIssue[] = [],
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
/** Builds the asset from a composed spec map, whose asset paths are already ids of `entries`. */
export function assetFromSpecs(
  specs: Specs,
  entries: Map<string, Uint8Array>,
  options: USDOptions,
  issues: USDIssue[] = [],
): USDAsset {
  return asset(specs, entries, undefined, options, issues);
}
function asset(
  specs: Specs,
  entries: Map<string, Uint8Array>,
  root: string | undefined,
  options: USDOptions,
  issues: USDIssue[],
): USDAsset {
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
  /** A property at the stage's first time: its first sample when it has samples, else its default. */
  const attrs = (path: string, name: string): unknown => {
    const fields = specs[path + '.' + name]?.fields;
    const samples = fields?.timeSamples as TimeSamples | undefined;
    return samples?.times.length ? (samples.values[0] ?? undefined) : fields?.default;
  };
  /** Composed files open with what can be read: a part that cannot be is left out and listed. A single static layer is refused whole, as before. */
  const composed = root === undefined,
    soft = (message: string) => {
      if (!composed) fail(message);
      if (!issues.some((i) => i.message === message)) issues.push({ code: 'unsupported', message });
    };
  const firstPath = (value: unknown): string | undefined => {
    if (value === undefined) return;
    if (!Array.isArray(value) || (value.length && typeof value[0] !== 'string')) fail('invalid relationship target');
    return (value as string[])[0];
  };
  /** The shader output an input is fed from, through any Material or NodeGraph interface on the way. */
  const connection = (path: string, name: string): string | undefined => {
    let target = firstPath(specs[path + '.' + name]?.fields.connectionPaths);
    for (let hops = 0; target && hops < 32; hops++) {
      const dot = target.lastIndexOf('.'),
        prim = target.slice(0, dot),
        next = firstPath(specs[target]?.fields.connectionPaths);
      if (attrs(prim, 'info:id') !== undefined || !next) return target;
      target = next;
    }
    return target;
  };
  /** An input's value, read through an interface a connection leads to. */
  const input = (path: string, name: string): unknown => {
    const target = connection(path, name);
    if (!target) return attrs(path, name);
    const dot = target.lastIndexOf('.');
    return attrs(target.slice(0, dot), target.slice(dot + 1));
  };
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
    if (attrs(shader, 'info:id') !== 'UsdUVTexture') {
      if (attrs(shader, 'info:id') !== undefined && !/^UsdPrimvarReader/.test(String(attrs(shader, 'info:id'))))
        soft('unsupported texture shader ' + String(attrs(shader, 'info:id')));
      else if (!composed) fail('unsupported texture shader');
      return;
    }
    const file = input(shader, 'inputs:file');
    if (typeof file !== 'string') {
      soft('missing texture asset');
      return;
    }
    if (composed && !entries.has(file)) {
      soft('missing texture ' + file);
      return;
    }
    const channel = target.split('.outputs:')[1],
      index = 'rgba'.indexOf(channel);
    if (index < 0 && channel !== 'rgb') {
      soft('unsupported texture channel');
      return;
    }
    return {
      path: root === undefined ? file : pathName(file, root),
      channel: Math.max(0, index),
      placement: placement(shader),
    };
  };
  /**
   * The fallback of the UsdPrimvarReader feeding `name`, when one does. Only the display primvars mean anything to a
   * glTF material; a reader of any other primvar is refused, as a general shader graph is.
   */
  const display = (path: string, name: string, varname: string, width: number): number[] | undefined => {
    const shader = connection(path, name)?.split('.outputs:')[0];
    if (!shader || attrs(shader, 'info:id') !== `UsdPrimvarReader_float${width === 1 ? '' : width}`) return;
    if (input(shader, 'inputs:varname') !== varname) {
      soft('unsupported primvar reader on ' + name);
      return;
    }
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
    // Per material: the fallback colour and opacity of the display primvars it reads, and the primvar its maps sample.
    displays = new Map<number, { color?: number[]; opacity?: number[]; uv?: string }>();
  /** The primvar a texture reads, through its UsdTransform2d when it has one. */
  const uvPrimvar = (shader: string): string | undefined => {
    let node = connection(shader, 'inputs:st')?.split('.outputs:')[0];
    if (node && attrs(node, 'info:id') === 'UsdTransform2d') node = connection(node, 'inputs:in')?.split('.outputs:')[0];
    const name = node && input(node, 'inputs:varname');
    return typeof name === 'string' ? name : undefined;
  };
  function material(path: string): number {
    let binding: string | undefined;
    // The nearest binding wins, unless one above it says it is stronger than what is below it.
    for (let owner = path; owner; owner = owner.slice(0, owner.lastIndexOf('/'))) {
      const rel = specs[owner + '.material:binding']?.fields,
        target = firstPath(rel?.targetPaths);
      // A target that is no prim of the stage binds nothing, as a stage reads it.
      if (target && (!composed || specs[target]) && (!binding || rel?.bindMaterialAs === 'strongerThanDescendants'))
        binding = target;
    }
    let shader = binding ? connection(binding, 'outputs:surface')?.split('.outputs:')[0] : undefined;
    if (binding && !shader) {
      soft('unresolved material binding');
      shader = undefined;
    }
    if (shader && attrs(shader, 'info:id') !== 'UsdPreviewSurface') {
      soft(`unsupported surface shader ${String(attrs(shader, 'info:id'))} at ${shader}`);
      shader = undefined;
    }
    // A mesh with no material shows its display colour, so its colour stream needs a white base.
    const painted = !binding && specs[path + '.primvars:displayColor'] !== undefined;
    const key = shader ?? binding ?? (painted ? '#display' : '');
    if (materialIds.has(key)) return materialIds.get(key)!;
    // A factor outside 0 to 1 is refused in a static layer; a composed file keeps the nearest value it can use.
    const factor = (value: unknown) =>
      composed && typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : scalar(value);
    const rgb = numeric(shader ? (input(shader, 'inputs:diffuseColor') ?? [0.18, 0.18, 0.18]) : [0.7, 0.7, 0.7], 3),
      opacity = factor(shader ? (input(shader, 'inputs:opacity') ?? 1) : 1),
      roughness = factor(shader ? (input(shader, 'inputs:roughness') ?? 0.5) : 0.5),
      metallic = factor(shader ? (input(shader, 'inputs:metallic') ?? 0) : 0),
      threshold = factor(shader ? (input(shader, 'inputs:opacityThreshold') ?? 0) : 0),
      color = shader ? display(shader, 'inputs:diffuseColor', 'displayColor', 3) : painted ? [0.5, 0.5, 0.5] : undefined,
      vertexOpacity = shader ? display(shader, 'inputs:opacity', 'displayOpacity', 1) : undefined;
    const p: NonNullable<GLTFMaterial['pbrMetallicRoughness']> = {
        baseColorFactor: [factor(rgb[0]), factor(rgb[1]), factor(rgb[2]), opacity],
        roughnessFactor: roughness,
        metallicFactor: metallic,
      },
      definition: GLTFMaterial = {
        pbrMetallicRoughness: p,
        doubleSided: true,
        ...(binding ? { name: binding } : {}),
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
        if (alpha.path !== diffuse?.path || alpha.channel !== 3) soft('unsupported opacity texture');
        else seeThrough();
      }
      if (normal) definition.normalTexture = image({ path: normal.path }, normal.placement);
      if (rough || metal) {
        // One packed glTF texture: both maps must be sampled the same way.
        if (rough && metal && JSON.stringify(rough.placement) !== JSON.stringify(metal.placement))
          soft('unsupported roughness and metallic textures with different transforms or wrap modes');
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
    const mapped = shader && ['inputs:diffuseColor', 'inputs:normal', 'inputs:roughness', 'inputs:metallic'].map((name) => connection(shader!, name)?.split('.outputs:')[0]).find((node) => node && attrs(node, 'info:id') === 'UsdUVTexture');
    displays.set(id, { color, opacity: vertexOpacity, uv: mapped ? uvPrimvar(mapped) : undefined });
    return id;
  }
  function accessor(data: Float32Array | Uint32Array | Uint16Array | Uint8Array, type: string): number {
    const buffer = buffers.length;
    buffers.push(data);
    doc.buffers.push({ byteLength: data.byteLength });
    const view = doc.bufferViews.length;
    doc.bufferViews.push({ buffer, byteLength: data.byteLength });
    const index = doc.accessors.length;
    doc.accessors.push({
      bufferView: view,
      componentType: data instanceof Uint32Array ? 5125 : data instanceof Uint16Array ? 5123 : data instanceof Uint8Array ? 5121 : 5126,
      count: data.length / (type === 'MAT4' ? 16 : type === 'VEC4' ? 4 : type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1),
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
    unit = metadata.metersPerUnit ?? 0.01;
  let axis = metadata.upAxis ?? 'Y';
  if (composed && axis !== 'Y' && axis !== 'Z') {
    soft('unsupported up axis ' + String(axis));
    axis = 'Y';
  }
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
  const nodeIds = new Map<string, number>([['/', 0]]),
    purposes = new Map<string, string>(),
    subsetsOf = new Map<string, string[]>(),
    detached = new Set<string>();
  for (const path in specs)
    if (specs[path].specType === 6 && specs[path].fields.typeName === 'GeomSubset') {
      const owner = path.slice(0, path.lastIndexOf('/')),
        list = subsetsOf.get(owner);
      if (list) list.push(path);
      else subsetsOf.set(owner, [path]);
    }
  const scenes = hooks(options).filter((hook) => hook.scene),
    shaper = hooks(options).find((hook) => hook.shape),
    sceneMeshes: SceneMesh[] = [],
    opOrder = (path: string): unknown => attrs(path, 'xformOpOrder') ?? specs[path].fields.xformOpOrder,
    transform = (path: string, get: (name: string) => unknown) => compose(opOrder(path), get),
    /** True for a prim an extension will show after its first sample. */
    shownLater = (path: string) =>
      scenes.some((hook) => hook.showsLater) &&
      (specs[path + '.visibility']?.fields.timeSamples as TimeSamples | undefined)?.values.some((v) => v !== 'invisible');
  let totalVertices = 0,
    totalTriangles = 0,
    polygonWork = 0;
  for (const [path, spec] of Object.entries(specs).sort(([a], [b]) => a.split('/').length - b.split('/').length))
    if (path !== '/' && spec.specType === 6) {
      options.signal?.throwIfAborted();
      const parent = path.slice(0, path.lastIndexOf('/')) || '/',
        parentId = nodeIds.get(parent);
      if (parentId === undefined) continue;
      if (spec.fields.active === false || (attrs(path, 'visibility') === 'invisible' && !shownLater(path))) continue;
      const type = spec.fields.typeName;
      // Shading prims and subsets are read through what uses them; they place nothing in the scene.
      if (type === 'Material' || type === 'Shader' || type === 'NodeGraph' || type === 'GeomSubset') continue;
      const node: GLTFNode & { children: number[] } = {
          name: path.split('/').at(-1),
          matrix: transform(path, (name) => attrs(path, name)),
          children: [],
        },
        id = doc.nodes.length;
      doc.nodes.push(node);
      // A reset leaves the parent's transform behind, moving or not, so the node hangs from the stage's own node.
      const resets = (opOrder(path) as string[] | undefined)?.includes(RESET);
      doc.nodes[resets ? 0 : parentId].children!.push(id);
      if (resets) {
        node.extras = { usdPath: path };
        detached.add(path);
      }
      nodeIds.set(path, id);
      // Purpose comes down from the nearest prim that authors one. Guides and proxies are not part of the render.
      const purpose = (attrs(path, 'purpose') as string | undefined) ?? 'default',
        inherited = purpose === 'default' ? (purposes.get(parent) ?? 'default') : purpose;
      purposes.set(path, inherited);
      if (type !== 'Mesh' || inherited === 'guide' || inherited === 'proxy') continue;
      if (
        !shaper &&
        ((attrs(path, 'subdivisionScheme') ?? 'catmullClark') !== 'none' ||
          (attrs(path, 'holeIndices') as ArrayLike<number> | undefined)?.length)
      )
        soft('subdivision and hole faces are unsupported');
      // A mesh with no points draws nothing; a stage skips it too.
      if (composed && !(attrs(path, 'points') as ArrayLike<number> | undefined)?.length) continue;
      let points = numeric(attrs(path, 'points')),
        counts = numeric(attrs(path, 'faceVertexCounts')),
        faces = numeric(attrs(path, 'faceVertexIndices'));
      if (points.length % 3) fail('invalid points');
      let triangles = 0,
        corners = 0;
      for (let i = 0; i < counts.length; i++) {
        const count = counts[i];
        if (!Number.isSafeInteger(count) || count < 0 || (count < 3 && !composed)) fail('invalid face count');
        corners += count;
      }
      if (corners !== faces.length) fail('topology counts mismatch');
      for (let i = 0; i < faces.length; i++)
        if (!Number.isSafeInteger(faces[i]) || faces[i] < 0 || faces[i] >= points.length / 3)
          fail('face index outside points');
      const orientation = attrs(path, 'orientation') ?? 'rightHanded';
      if (typeof orientation !== 'string' || !['leftHanded', 'rightHanded'].includes(orientation))
        fail('invalid orientation');
      const faceCount = counts.length,
        shape = shaper?.shape!({
          specs,
          path,
          points,
          counts,
          faces,
          flip: orientation === 'leftHanded',
          maxTriangles: limits.maxTriangles,
          value: (name) => attrs(path, name),
          attr: attrs,
          soft,
        });
      if (shape) ({ points, counts, faces } = shape);
      for (let i = 0; i < counts.length; i++) if (counts[i] >= 3) triangles += counts[i] - 2;
      totalVertices += triangles * 3;
      totalTriangles += triangles;
      if (totalVertices > limits.maxVertices || totalTriangles > limits.maxTriangles) fail('geometry exceeds limit');
      /** A stream of the authored mesh, as one value per corner of the new faces. */
      const reshaped = (stream: ArrayLike<number>, width: number, property: string, indices?: ArrayLike<number>) =>
        shape!.corners(stream, width, indices, specs[path + '.' + property]?.fields.interpolation as string | undefined);
      // A normals primvar beats the normals attribute. What is not a list of vectors is no normals at all.
      const normalName = specs[path + '.primvars:normals'] ? 'primvars:normals' : 'normals',
        normalAttribute = attrs(path, normalName),
        normalValue = composed && !normalList(normalAttribute, specs[path + '.' + normalName]?.fields.typeName) ? undefined : normalAttribute,
        authoredNormalIndices = attrs(path, normalName + ':indices') as ArrayLike<number> | undefined,
        normalIndices = shape ? undefined : authoredNormalIndices,
        materialId = material(path),
        reads = displays.get(materialId)!,
        uvName = [reads.uv, 'st', 'UVMap', 'uv', 'st0', 'st_0', 'map1'].find((name) => name && specs[path + '.primvars:' + name]),
        uvValue = uvName ? attrs(path, 'primvars:' + uvName) : undefined,
        authoredNormal = normalValue === undefined ? undefined : numeric(normalValue),
        // A subdivided mesh has normals of its own, as the schema says.
        normal = shape?.normals ?? (shape && authoredNormal ? reshaped(authoredNormal, 3, normalName, authoredNormalIndices) : authoredNormal),
        uvProperty = 'primvars:' + uvName,
        authoredUV = uvValue === undefined ? undefined : numeric(uvValue),
        authoredUVIndices = attrs(path, uvProperty + ':indices') as ArrayLike<number> | undefined,
        uv = shape && authoredUV ? reshaped(authoredUV, 2, uvProperty, authoredUVIndices) : authoredUV,
        uvIndices = shape ? undefined : authoredUVIndices,
        positions = new Float32Array(triangles * 9),
        normals = new Float32Array(triangles * 9),
        uvs = uv ? new Float32Array(triangles * 6) : undefined,
        indices = new Uint32Array(triangles * 3),
        vertexOf = scenes.length ? new Uint32Array(triangles * 3) : undefined,
        firstTriangle = new Uint32Array(faceCount + 1),
        colors = reads.color || reads.opacity ? new Float32Array(triangles * 12) : undefined,
        shaped = (stream: DisplayStream, width: number, property: string): DisplayStream =>
          shape ? { values: reshaped(stream.values, width, property, stream.indices) } : stream,
        tint = reads.color && shaped(displayStream(path, 'displayColor', reads.color, 3), 3, 'primvars:displayColor'),
        fade = reads.opacity && shaped(displayStream(path, 'displayOpacity', reads.opacity, 1), 1, 'primvars:displayOpacity');
      const sample = (
        stream: ArrayLike<number>,
        width: number,
        corner: number,
        vertex: number,
        face: number,
        property: string,
      ): number => {
        if (shape) return corner;
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
        at = 0,
        reached = 0;
      for (let f = 0; f < counts.length; f++) {
        const count = counts[f],
          own = shape ? shape.face[f] : f;
        // Faces that were left out own no triangles.
        while (reached <= own) firstTriangle[reached++] = at / 3;
        // shortcut: triangles and convex planar polygons, tessellate concave polygons before loading.
        if (count > 3 && !composed && !shape) {
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
              const n = normalIndices
                ? normalIndices[sample(normalIndices, 1, corner, vertex, f, normalName)]
                : sample(normal, 3, corner, vertex, f, normalName);
              if (n * 3 + 2 >= normal.length) fail('normal index outside stream');
              for (let d = 0; d < 3; d++) normals[at * 3 + d] = normal[n * 3 + d];
            }
            if (uv && uvs) {
              const u = uvIndices
                ? uvIndices[sample(uvIndices, 1, corner, vertex, f, uvProperty)]
                : sample(uv, 2, corner, vertex, f, uvProperty);
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
            if (vertexOf) vertexOf[at] = vertex;
            at++;
          }
        cursor += count;
      }
      while (reached <= faceCount) firstTriangle[reached++] = at / 3;
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
      // Each subset with a material is a primitive of its own, over the same vertex streams. A face belongs to the
      // first subset that lists it; the faces left keep the mesh's material.
      const taken = new Uint8Array(faceCount),
        subsets: USDMeshSubset[] = [];
      for (const subset of subsetsOf.get(path) ?? []) {
        if ((attrs(subset, 'elementType') ?? 'face') !== 'face') continue;
        if (!specs[subset + '.material:binding'] && attrs(subset, 'familyName') !== 'materialBind') continue;
        const list: number[] = [];
        for (const face of Array.from(numeric(attrs(subset, 'indices') ?? []))) {
          if (!Number.isSafeInteger(face) || face < 0 || face >= faceCount) fail('subset face outside mesh');
          if (taken[face]) continue;
          taken[face] = 1;
          for (let t = firstTriangle[face] * 3; t < firstTriangle[face + 1] * 3; t++) list.push(t);
        }
        if (list.length) subsets.push({ path: subset, indices: Uint32Array.from(list), material: material(subset) });
      }
      let rest = indices;
      if (subsets.length) {
        const left: number[] = [];
        for (let face = 0; face < faceCount; face++)
          if (!taken[face]) for (let t = firstTriangle[face] * 3; t < firstTriangle[face + 1] * 3; t++) left.push(t);
        rest = Uint32Array.from(left);
      }
      const primitives = subsets.map((subset) => ({
        attributes,
        indices: accessor(subset.indices, 'SCALAR'),
        material: subset.material,
      }));
      if (rest.length) primitives.push({ attributes, indices: accessor(rest, 'SCALAR'), material: materialId });
      const mesh = doc.meshes.length;
      doc.meshes.push({ primitives });
      node.mesh = mesh;
      if (vertexOf) sceneMeshes.push({ path, node: id, mesh, vertexOf, shape });
      meshes.push({
        path,
        positions,
        normals,
        uvs,
        colors,
        indices,
        material: materialId,
        ...(subsets.length ? { subsets } : {}),
      });
    }
  for (const hook of scenes)
    hook.scene!({
      specs,
      document: doc,
      nodes: nodeIds,
      meshes: sceneMeshes,
      accessor,
      opOrder: (path) => {
        const order = path === '/' ? undefined : opOrder(path);
        return Array.isArray(order) ? counted(order as string[]) : undefined;
      },
      transform,
      detached,
      soft,
    });
  for (const source of sources)
    for (const name of [source.path, source.roughness?.path, source.metallic?.path])
      if (name && !entries.has(name)) fail('missing texture ' + name);
  // A stage of cameras or lights alone is something to open; the entries that read them have run by now.
  if (!meshes.length && !doc.nodes.some((node) => node.camera !== undefined || node.extensions?.KHR_lights_punctual))
    fail('no renderable meshes');
  return new USDAsset(doc, buffers, meshes, sources, entries, issues);
}
function read(input: string | BinaryInput, entries: Map<string, Uint8Array>, id: string, options: USDOptions): USDAsset {
  const issues: USDIssue[] = [],
    specs = parseLayer(input, options, id, entries, issues);
  return asset(specs, entries, hooks(options).some((hook) => hook.compose) ? undefined : id, options, issues);
}
/** Parses a USDA (text) layer, as a string or UTF-8 bytes. Throws `LoaderError` (format `USD`) for malformed or unsupported input. */
export function parseUSDA(input: string | BinaryInput, options: USDOptions = {}): USDAsset {
  return read(input, new Map(), 'scene.usda', options);
}
/** Parses a binary USDC (Crate 0.4 to 0.12) layer. Throws `LoaderError` (format `USD`) for malformed or unsupported input. */
export function parseUSDC(input: BinaryInput, options: USDOptions = {}): USDAsset {
  const data = bytes(input);
  if (new TextDecoder().decode(data.subarray(0, 8)) !== 'PXR-USDC') fail('expected Crate magic');
  return read(data, new Map(), 'scene.usdc', options);
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
  return read(entries.get(name)!, entries, name, options);
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
