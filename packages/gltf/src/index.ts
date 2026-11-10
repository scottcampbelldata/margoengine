import { engineRuntime } from '@margoengine/core/extension';
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import { Geometry, PbrMaterial, type Engine, type Mesh } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { splitTRS } from '@margoengine/math/quat';
import { readResponse } from '../../shared/loading.js';
import { checkCount, countLimit } from '../../shared/limits.js';
import { parseJSON } from '../../shared/json.js';
import { rejectLFSPointer } from '../../shared/lfs.js';
import { assetURL, checkRedirect } from '../../shared/asset-url.js';
import { GLB_BIN, checkBinChunk, glbChunks, isGLB } from '../../shared/glb.js';
import { entry, integer, readAccessor } from './accessor.js';

const limit = 64 * 1024 * 1024;
import type { GLTFBuffer, GLTFDocument as Document, GLTFNode, GLTFPrimitive } from '../../shared/gltf.js';
const isObject = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value);
// Malformed UTF-8 or JSON is a named error, not the TextDecoder's TypeError or JSON.parse's SyntaxError.
function text(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new TypeError(
      'Invalid glTF JSON: not UTF-8; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
    );
  }
}
function json(source: string): Document {
  try {
    return parseJSON<Document>(source);
  } catch (error) {
    throw new TypeError(
      `Invalid glTF JSON: ${(error as Error).message}; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator`,
    );
  }
}
function bytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  return input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}
function container(input: string | object | ArrayBuffer | ArrayBufferView): { doc: Document; binary?: Uint8Array } {
  if (typeof input === 'string') {
    rejectLFSPointer(input, 'The glTF input');
    if (input.length > limit || new TextEncoder().encode(input).length > limit)
      throw new RangeError('glTF JSON exceeds 64 MiB; load a smaller file or split it');
    return { doc: json(input) };
  }
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) return { doc: input as Document };
  const data = bytes(input);
  rejectLFSPointer(data, 'The glTF input');
  if (data.length > limit) throw new RangeError('GLB exceeds 64 MiB; load a smaller file or split it');
  const chunks = glbChunks(data);
  const doc = json(text(chunks[0].data)),
    binary = chunks[1]?.type === GLB_BIN ? chunks[1].data : undefined,
    first = doc.buffers?.[0];
  // Buffer 0 without a uri is the BIN chunk.
  if (binary && first && typeof first === 'object' && first.uri === undefined)
    checkBinChunk(binary.length, first.byteLength);
  return { doc, binary };
}
function embedded(uri: string): Uint8Array {
  const match = /^data:application\/(?:octet-stream|gltf-buffer);base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
  if (!match || match[1].length > (limit * 4) / 3 + 4)
    throw new TypeError('Invalid glTF data URI; use a base64 data URI');
  let decoded: string;
  try {
    decoded = atob(match[1]); // throws on a bad length or misplaced padding the pattern lets through
  } catch {
    throw new TypeError('Invalid glTF data URI; use a base64 data URI');
  }
  return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
}
function validate(doc: Document, maxNodes: number | undefined, extensions: readonly GLTFExtension[]): void {
  const nodeLimit = countLimit('maxNodes', maxNodes);
  if (!doc || doc.asset?.version !== '2.0') throw new TypeError('Expected glTF 2.0');
  for (const field of [
    'buffers',
    'bufferViews',
    'accessors',
    'meshes',
    'nodes',
    'scenes',
    'materials',
    'skins',
    'animations',
    'extensionsRequired',
  ])
    if (doc[field] !== undefined && !Array.isArray(doc[field])) throw new TypeError(`glTF ${field} must be an array`);
  // Every definition is an object, so later reads of its members never meet null or a number.
  for (const field of ['buffers', 'bufferViews', 'accessors', 'meshes', 'nodes', 'scenes', 'materials']) {
    const list: unknown = doc[field];
    if (Array.isArray(list) && !list.every(isObject))
      throw new TypeError(
        `Invalid glTF ${field} entry; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator`,
      );
  }
  if (
    doc.extensionsRequired?.some((name) => !extensions.some((extension) => extension.handles.includes(name))) ||
    doc.skins?.length ||
    doc.animations?.length
  )
    throw new MargoError(
      'unsupported',
      'Minimal glTF supports static uncompressed models; required extensions, skins and animations are unsupported; load it with @margoengine/gltf-pro',
    );
  checkCount('Too many glTF nodes', doc.nodes?.length ?? 0, nodeLimit, 'maxNodes');
}
function transform(mesh: Mesh, node: GLTFNode): void {
  if (node.matrix !== undefined) {
    if (
      node.translation !== undefined ||
      node.rotation !== undefined ||
      node.scale !== undefined ||
      !Array.isArray(node.matrix) ||
      node.matrix.length !== 16 ||
      node.matrix.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(Math.fround(v)))
    )
      throw new TypeError(
        'Invalid glTF matrix; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
      );
    const m = node.matrix;
    if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) throw new TypeError('glTF matrix must be affine');
    const trs = splitTRS(m);
    if (!trs.ok)
      throw trs.reason === 'singular'
        ? new RangeError('Singular glTF matrix')
        : new Error('Sheared glTF matrices are unsupported');
    mesh.setPosition(trs.position).setScale(trs.scale).setQuaternion(trs.rotation);
  } else {
    mesh
      .setPosition((node.translation ?? [0, 0, 0]) as [number, number, number])
      .setScale((node.scale ?? [1, 1, 1]) as [number, number, number])
      .setQuaternion(node.rotation ?? [0, 0, 0, 1]);
  }
}

/** A parsed glTF scene: the root mesh handle, every mesh and node handle, and dispose() to release them. */
export interface Model {
  root: MeshHandle;
  meshes: readonly MeshHandle[];
  nodes: readonly MeshHandle[];
  dispose(): void;
}
/** A file on its way through the loader. An extension may replace `doc` and `buffers`, never change what they hold. */
export interface GLTFFile {
  doc: Document;
  /** Buffer data, in document order. */
  buffers: readonly Uint8Array[];
  /** The `maxNodes` option, if set. */
  maxNodes?: number;
  /** Fetches a URI found in the file, under `loadGLTF`'s rules. Absent when the file came from memory. */
  fetch?(uri: string): Promise<Uint8Array>;
}
/** What the loader made of a file, for `GLTFExtension.finish`. */
export interface GLTFBuilt {
  engine: Engine;
  /** Each primitive in the file. `expanded` holds the source vertex of each geometry vertex when normals were generated. */
  primitives: readonly { geometry: Geometry; source: GLTFPrimitive; expanded?: Uint32Array }[];
  /** The mesh of each node by node index; empty where a node is not in the loaded scene. */
  nodes: readonly (MeshHandle | undefined)[];
}
/**
 * One optional feature of the light loader, passed in `GLTFOptions.extensions`. Each lives in its own entry, so a file
 * that needs none of them costs none of their bytes.
 */
export interface GLTFExtension {
  /** The glTF extension names this one implements: `extensionsRequired` may list them. */
  readonly handles: readonly string[];
  /** Accept scenes without renderable meshes, for data-only imports. Default false. */
  readonly allowEmptyScene?: boolean;
  /** Reads vertex attribute `semantic` from accessor `id`, as float xyz; undefined leaves it to the loader. */
  attribute?(file: GLTFFile, semantic: string, id: number): Float32Array | undefined;
  /** Asynchronous work before anything is built. An extension with `load` needs `parseGLTFAsync` or `loadGLTF`. */
  load?(file: GLTFFile, signal?: AbortSignal): Promise<void>;
  /** Runs after every `load`, before the loader reads the document. */
  read?(file: GLTFFile): void;
  /** Runs on the finished model; may wrap `model.dispose`. A throw rolls the model back. */
  finish?(model: Model, file: GLTFFile, built: GLTFBuilt): void;
}
/** Options for parseGLTF and loadGLTF. */
export interface GLTFOptions {
  /** Optional features from the `@margoengine/gltf/*` entries, for example `[quantized]`. Default none. */
  extensions?: readonly GLTFExtension[];
  /** Most glTF nodes the file may have, each one a core mesh (default 100,000; up to core's 8,388,608 entities). */
  maxNodes?: number;
  /**
   * URL prefixes (for example `https://cdn.example.com/models/`) that buffer URIs inside the file may point to besides
   * the file's own directory, matched on a path-segment boundary. Default none: absolute, cross-origin and
   * `../`-escaping URIs throw a TypeError, and so does a redirect that ends outside these places.
   */
  allowedURLs?: readonly string[];
}
// A buffer only an extension's data stands in for, such as a meshopt fallback: the file loads without its bytes.
const stands = (def: GLTFBuffer, extensions: readonly GLTFExtension[]): boolean =>
  extensions.some((extension) =>
    extension.handles.some((name) => (def.extensions?.[name] as { fallback?: unknown } | undefined)?.fallback === true),
  );
function open(
  input: string | object | ArrayBuffer | ArrayBufferView,
  suppliedBuffers: Array<ArrayBuffer | ArrayBufferView>,
  { maxNodes, extensions = [] }: GLTFOptions,
): GLTFFile {
  const { doc, binary } = container(input);
  validate(doc, maxNodes, extensions);
  let total = 0;
  const buffers = (doc.buffers ?? []).map((def, i) => {
    const length = integer(def.byteLength, 'buffer length', 1);
    if (stands(def, extensions)) return new Uint8Array();
    const data = suppliedBuffers[i]
      ? bytes(suppliedBuffers[i])
      : def.uri
        ? embedded(def.uri)
        : i === 0
          ? binary
          : undefined;
    if (!data || length > data.length)
      throw new RangeError('Truncated glTF buffer; download the file again, it is incomplete');
    total += data.length;
    if (total > limit) throw new RangeError('glTF buffers exceed 64 MiB; load a smaller file or split it');
    return data.subarray(0, length);
  });
  return { doc, buffers, maxNodes };
}
function build(instance: EngineKernel, file: GLTFFile, { maxNodes, extensions = [] }: GLTFOptions): Model {
  const engine = engineRuntime(instance);
  for (const extension of extensions) extension.read?.(file);
  const { doc } = file;
  if (extensions.length) validate(doc, maxNodes, extensions);
  let vertices = 0;
  const attribute = (semantic: string, id: unknown): Float32Array => {
    for (const extension of extensions) {
      const values = extension.attribute?.(file, semantic, integer(id, 'accessor'));
      if (values) return values;
    }
    return readAccessor(
      file,
      id,
      3,
      (a) => !a.normalized && a.type === 'VEC3' && a.componentType === 5126,
    ) as Float32Array;
  };
  const materials = (doc.materials ?? []).map((m) => {
    const p = m.pbrMetallicRoughness ?? {},
      color = p.baseColorFactor ?? [1, 1, 1, 1];
    if (
      (m.alphaMode ?? 'OPAQUE') !== 'OPAQUE' ||
      !Array.isArray(color) ||
      color.length !== 4 ||
      color[3] !== 1 ||
      (m.emissiveFactor !== undefined &&
        (!Array.isArray(m.emissiveFactor) || m.emissiveFactor.some((v: number) => v !== 0))) ||
      m.extensions ||
      [p.baseColorTexture, p.metallicRoughnessTexture, m.normalTexture, m.occlusionTexture, m.emissiveTexture].some(
        Boolean,
      )
    )
      throw new MargoError(
        'unsupported',
        'Minimal PBR supports opaque constant colors; add @margoengine/gltf/textured for a base colour map or MASK; other maps, emission and transparency require @margoengine/gltf-pro',
      );
    return new PbrMaterial({
      color: color.slice(0, 3),
      roughness: p.roughnessFactor ?? 1,
      metalness: p.metallicFactor ?? 1,
      doubleSided: m.doubleSided ?? false,
    });
  });
  const definitions = (doc.meshes ?? []).map((mesh) => {
    if (!Array.isArray(mesh.primitives) || !mesh.primitives.length || !mesh.primitives.every(isObject))
      throw new TypeError(
        'Missing glTF primitives; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
      );
    return mesh.primitives.map((p) => {
      if (
        (p.mode ?? 4) !== 4 ||
        p.targets ||
        p.extensions ||
        Object.keys(p.attributes ?? {}).some((key) => /^(COLOR|JOINTS|WEIGHTS)_/.test(key))
      )
        throw new MargoError(
          'unsupported',
          'Minimal glTF requires rigid triangles without vertex colors; load it with @margoengine/gltf-pro',
        );
      let positions = attribute('POSITION', p.attributes?.POSITION),
        normals = p.attributes?.NORMAL === undefined ? null : attribute('NORMAL', p.attributes.NORMAL);
      let indices =
        p.indices === undefined
          ? Uint32Array.from({ length: positions.length / 3 }, (_, i) => i)
          : (readAccessor(
              file,
              p.indices,
              1,
              (a) => !a.normalized && a.type === 'SCALAR' && [5121, 5123, 5125].includes(a.componentType),
              true,
            ) as Uint32Array);
      if (indices.length % 3) throw new RangeError('Indices must contain complete triangles');
      const expanded = normals ? undefined : indices;
      vertices += normals ? positions.length / 3 : indices.length;
      if (vertices > 1_000_000)
        throw new MargoError(
          'unsupported',
          'glTF exceeds one million vertices, the limit of the light loader; load it with @margoengine/gltf-pro, or split it',
        );
      if (!normals) {
        const expanded = new Float32Array(indices.length * 3);
        normals = new Float32Array(expanded.length);
        for (let i = 0, limit = positions.length / 3; i < indices.length; i++) {
          const v = indices[i];
          if (v >= limit) throw new RangeError('Index exceeds vertices; load a smaller file or split it');
          expanded[i * 3] = positions[v * 3];
          expanded[i * 3 + 1] = positions[v * 3 + 1];
          expanded[i * 3 + 2] = positions[v * 3 + 2];
        }
        for (let i = 0; i < expanded.length; i += 9) {
          const a = expanded,
            ux = a[i + 3] - a[i],
            uy = a[i + 4] - a[i + 1],
            uz = a[i + 5] - a[i + 2],
            vx = a[i + 6] - a[i],
            vy = a[i + 7] - a[i + 1],
            vz = a[i + 8] - a[i + 2],
            nx = uy * vz - uz * vy,
            ny = uz * vx - ux * vz,
            nz = ux * vy - uy * vx;
          for (let j = i; j < i + 9; j += 3) {
            normals[j] = nx;
            normals[j + 1] = ny;
            normals[j + 2] = nz;
          }
        }
        positions = expanded;
        indices = new Uint32Array(expanded.length / 3);
        for (let i = 0; i < indices.length; i++) indices[i] = i;
      }
      const material =
        p.material === undefined
          ? new PbrMaterial({ color: [1, 1, 1], roughness: 1, metalness: 1, doubleSided: false })
          : materials[integer(p.material, 'material reference')];
      if (!material) throw new TypeError('Missing material; point the primitive at an existing material index');
      return { geometry: new Geometry(positions, normals, indices), material, source: p, expanded };
    });
  });
  const nodes = doc.nodes ?? [],
    parents = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((node: GLTFNode, id: number) => {
    if (!node || node.skin !== undefined || node.camera !== undefined || node.extensions)
      throw new MargoError(
        'unsupported',
        'Unsupported glTF node; add @margoengine/gltf/instancing for EXT_mesh_gpu_instancing or @margoengine/gltf/scene-data for cameras and lights, or load it with @margoengine/gltf-pro',
      );
    if (node.children !== undefined && !Array.isArray(node.children))
      throw new TypeError(
        'Invalid glTF children; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
      );
    for (const child of node.children ?? []) {
      const index = integer(child, 'child reference');
      if (index >= nodes.length || parents[index] !== -1 || index === id)
        throw new TypeError('Invalid glTF hierarchy; give each node one parent and valid child indices');
      parents[index] = id;
    }
  });
  for (let id = 0; id < nodes.length; id++) {
    let depth = 0;
    for (let current = id; current !== -1; current = parents[current])
      if (++depth > 62)
        throw new RangeError(
          'glTF hierarchy cycle or depth limit; remove the cycle or flatten the nodes to 62 levels or fewer',
        );
  }
  const roots = doc.scenes
    ? (entry(doc.scenes, doc.scene ?? 0, 'scene').nodes ?? [])
    : nodes.map((_: unknown, i: number) => i).filter((i: number) => parents[i] === -1);
  if (!Array.isArray(roots) || new Set(roots).size !== roots.length)
    throw new TypeError(
      'Invalid glTF scene roots; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
    );
  const created: Mesh[] = [],
    renderable: Mesh[] = [],
    imported: Mesh[] = [],
    handles: Mesh[] = [];
  let model: Model | undefined;
  try {
    const root = engine.createMesh();
    created.push(root);
    const stack = roots.map((id: unknown) => ({ id: integer(id, 'root'), parent: root }));
    while (stack.length) {
      const { id, parent } = stack.pop()!,
        node = entry(nodes, id, 'node');
      if (parent === root && parents[id] !== -1)
        throw new TypeError('Scene root has a parent; list only top-level nodes in the scene');
      const mesh = engine.createMesh(parent);
      created.push(mesh);
      imported.push(mesh);
      handles[id] = mesh;
      mesh.name = typeof node.name === 'string' ? node.name : '';
      transform(mesh, node);
      if (node.mesh !== undefined) {
        const primitives = definitions[integer(node.mesh, 'mesh reference')];
        if (!primitives) throw new TypeError('Missing glTF mesh; point the node at an existing mesh index');
        for (const p of primitives) {
          const child = engine.createMesh(mesh);
          created.push(child);
          child.setGeometry(p.geometry).setMaterial(p.material);
          renderable.push(child);
        }
      }
      for (const child of node.children ?? []) stack.push({ id: child, parent: mesh });
    }
    if (!renderable.length && !extensions.some((extension) => extension.allowEmptyScene))
      throw new MargoError('failed', 'glTF contains no renderable meshes; add a mesh with triangle primitives');
    const release = () => {
      for (let i = created.length - 1; i >= 0; i--) created[i].dispose();
    };
    model = { root, meshes: renderable, nodes: imported, dispose: release };
    for (const extension of extensions)
      extension.finish?.(model, file, { engine, primitives: definitions.flat(), nodes: handles });
    return model;
  } catch (error) {
    if (model) model.dispose();
    else for (let i = created.length - 1; i >= 0; i--) created[i].dispose();
    throw error;
  }
}
async function finishLoad(
  instance: EngineKernel,
  file: GLTFFile,
  options: GLTFOptions,
  signal: AbortSignal | undefined,
): Promise<Model> {
  for (const extension of options.extensions ?? []) {
    await extension.load?.(file, signal);
    signal?.throwIfAborted();
  }
  return build(instance, file, options);
}

/**
 * Parses glTF JSON, an object or GLB bytes into core meshes, one per node. Rejects absolute, cross-origin and `../` buffer URIs unless allowed. @throws TypeError for a malformed file; RangeError over the size limits.
 */
export function parseGLTF(
  instance: EngineKernel,
  input: string | object | ArrayBuffer | ArrayBufferView,
  suppliedBuffers: Array<ArrayBuffer | ArrayBufferView> = [],
  options: GLTFOptions = {},
): Model {
  if (options.extensions?.some((extension) => extension.load))
    throw new MargoError('unsupported', 'This glTF extension loads asynchronously; use parseGLTFAsync or loadGLTF');
  return build(instance, open(input, suppliedBuffers, options), options);
}
/** parseGLTF for extensions with asynchronous work, such as `textured`. Aborts with `signal`. */
export async function parseGLTFAsync(
  instance: EngineKernel,
  input: string | object | ArrayBuffer | ArrayBufferView,
  suppliedBuffers: Array<ArrayBuffer | ArrayBufferView> = [],
  { signal, ...options }: GLTFOptions & { signal?: AbortSignal } = {},
): Promise<Model> {
  signal?.throwIfAborted();
  return finishLoad(instance, open(input, suppliedBuffers, options), options, signal);
}

/**
 * Fetches a .gltf or .glb over HTTP(S), and its external buffers relative to it, through `fetch` (default
 * `globalThis.fetch`; for example an AssetCache's or a LoadingManager's `fetch`), then parses it like parseGLTF.
 */
export async function loadGLTF(
  engine: EngineKernel,
  url: string | URL,
  {
    signal,
    maxNodes,
    allowedURLs,
    extensions = [],
    fetch: get = globalThis.fetch,
  }: GLTFOptions & { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<Model> {
  signal?.throwIfAborted();
  let base = new URL(url, globalThis.location?.href),
    total = 0;
  async function fetchBytes(target: URL, root = false) {
    if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('glTF URL must use HTTP(S)');
    const response = await get(target, { signal });
    if (root && response.url) base = new URL(response.url);
    else if (!root) checkRedirect(response, base, allowedURLs, 'glTF buffer');
    const data = await readResponse(response, { maxBytes: limit - total, signal, label: 'glTF download' });
    // Root, buffers and images: a pointer from a clone without Git LFS would fail later as bad JSON or a short buffer.
    rejectLFSPointer(data, target.href);
    total += data.byteLength;
    return data;
  }
  const data = await fetchBytes(base, true),
    glb = isGLB(data),
    { doc, binary } = container(glb ? data : text(data));
  validate(doc, maxNodes, extensions);
  const buffers = [];
  for (const def of doc.buffers ?? []) {
    if (!def.uri || stands(def, extensions)) buffers.push(binary ?? new Uint8Array());
    else if (typeof def.uri === 'string' && def.uri.startsWith('data:')) {
      const data = embedded(def.uri);
      total += data.length;
      if (total > limit) throw new RangeError('glTF exceeds download limit; load a smaller file or split it');
      buffers.push(data);
    } else buffers.push(await fetchBytes(assetURL(def.uri, base, allowedURLs, 'glTF buffer')));
  }
  signal?.throwIfAborted();
  const options = { maxNodes, extensions },
    file = open(doc, buffers, options);
  file.fetch = (uri) => fetchBytes(assetURL(uri, base, allowedURLs, 'glTF image'));
  return finishLoad(engine, file, options, signal);
}
