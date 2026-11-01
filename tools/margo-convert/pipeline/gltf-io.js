// @ts-check
// glTF model reader and writer for margo-convert's optimiser. `readModel` turns a GLB or a .gltf with external files
// into one in-memory Model (JSON, mesh data as typed arrays, image bytes); `writeModel` serialises a Model to a fresh
// GLB with de-duplicated buffer views and, on request, EXT_meshopt_compression. Built on @margoengine/exporters'
// GLB split/join and accessor reader and @margoengine/decoders' meshopt decoder.
import { createHash } from 'node:crypto';
import { joinGLB, readAccessor, splitGLB } from '@margoengine/exporters';
import { meshoptDecodeGltfBuffer } from '@margoengine/decoders/meshopt';
import { encodeTriangles, encodeVertexBuffer } from './meshopt-encode.js';

/**
 * One accessor's data: tightly packed components in the accessor's component type.
 * @typedef {object} Attr
 * @property {Int8Array|Uint8Array|Int16Array|Uint16Array|Uint32Array|Float32Array} values
 * @property {number} width components per element
 * @property {number} componentType glTF component type (5120 to 5126)
 * @property {boolean} normalized
 * @property {string} type glTF accessor type, 'VEC3' and so on
 */

/**
 * A primitive's mesh data, kept on the primitive as `$geo` while a model is in memory.
 * @typedef {object} Geo
 * @property {Record<string, Attr>} attributes
 * @property {Attr|null} indices
 * @property {Record<string, Attr>[]} targets
 */

/**
 * @typedef {object} ModelImage
 * @property {Uint8Array} bytes
 * @property {string} mimeType
 */

/**
 * @typedef {object} Model
 * @property {any} json glTF JSON without `buffers`, `bufferViews` and `accessors`; primitives carry `$geo`
 * @property {ModelImage[]} images bytes of `json.images`, same order
 * @property {(index: number) => Attr} accessor reads an accessor of the source file that is not mesh data
 * @property {string[]} notes things the reader changed or could not handle
 */

export const TYPES = /** @type {Record<number, string>} */ ({
  1: 'SCALAR',
  2: 'VEC2',
  3: 'VEC3',
  4: 'VEC4',
  16: 'MAT4',
});
const COMPONENT_BYTES = /** @type {Record<number, number>} */ ({
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
});
const MAGIC = 0x46546c67;
const MESHOPT = 'EXT_meshopt_compression';

/** Extensions whose data reaches outside what the optimiser rewrites; a file using one is passed through untouched. */
const UNSAFE = [
  'KHR_draco_mesh_compression',
  'KHR_animation_pointer',
  'EXT_structural_metadata',
  'EXT_mesh_features',
  'EXT_primitive_compression',
  'KHR_gaussian_splatting',
  'KHR_audio_emitter',
  'KHR_implicit_shapes',
  'KHR_physics_rigid_bodies',
];

/** Error for a file the optimiser will not rewrite; the caller passes the original bytes through. */
export class Unsupported extends Error {}

const MIME = /** @type {Record<string, string>} */ ({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  ktx2: 'image/ktx2',
  gif: 'image/gif',
});

/** @param {string} uri @returns {Uint8Array|null} */
export function dataUri(uri) {
  const match = /^data:[^,]*?(;base64)?,/.exec(uri);
  if (!match) return null;
  const body = uri.slice(match[0].length);
  return match[1] ? new Uint8Array(Buffer.from(body, 'base64')) : new Uint8Array(Buffer.from(decodeURIComponent(body)));
}

/**
 * Reads a GLB or a .gltf (with its external buffers and images through `resolve`) into a {@link Model}.
 * @param {Uint8Array} bytes
 * @param {(uri: string) => Uint8Array} [resolve] reads a relative file for a .gltf
 * @returns {Model}
 */
export function readModel(bytes, resolve) {
  const isGLB = bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === MAGIC;
  /** @type {any} */ let json;
  /** @type {Uint8Array[]} */ let buffers = [];
  if (isGLB) {
    const parts = splitGLB(bytes);
    json = parts.json;
    buffers = [parts.bin ?? new Uint8Array(0)];
  } else {
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (cause) {
      throw new TypeError('not a GLB or glTF JSON file', { cause });
    }
    if (json?.asset?.version !== '2.0') throw new TypeError('not a glTF 2.0 document');
  }
  const read = (/** @type {string} */ uri) => {
    const inline = dataUri(uri);
    if (inline) return inline;
    if (!resolve) throw new Unsupported(`external file ${uri} needs a folder to read it from`);
    return resolve(decodeURIComponent(uri));
  };
  for (const name of [...(json.extensionsRequired ?? []), ...(json.extensionsUsed ?? [])])
    if (UNSAFE.includes(name)) throw new Unsupported(`uses ${name}, which margo-convert does not rewrite`);
  for (const [i, def] of (json.buffers ?? []).entries()) {
    if (def.extensions?.[MESHOPT]?.fallback) {
      buffers[i] = new Uint8Array(0);
      continue;
    }
    if (def.uri !== undefined) buffers[i] = read(def.uri);
    else if (!buffers[i]) throw new TypeError(`buffer ${i} has no data`);
    buffers[i] = buffers[i].subarray(0, def.byteLength);
  }

  // One buffer: decode meshopt views, copy every view to a 4-byte aligned place in a single BIN chunk.
  /** @type {{at: number, bytes: Uint8Array}[]} */ const chunks = [];
  let length = 0;
  const views = (json.bufferViews ?? []).map((/** @type {any} */ view) => {
    const ext = view.extensions?.[MESHOPT] ?? view.extensions?.KHR_meshopt_compression;
    /** @type {Uint8Array} */ let data;
    let stride = view.byteStride;
    if (ext) {
      const source = buffers[ext.buffer].subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
      data = meshoptDecodeGltfBuffer(source, ext.count, ext.byteStride, ext.mode, ext.filter ?? 'NONE');
      if (ext.mode === 'ATTRIBUTES') stride = ext.byteStride;
    } else {
      const buffer = buffers[view.buffer];
      if (!buffer) throw new TypeError('buffer view without data');
      data = buffer.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    }
    length = (length + 3) & ~3;
    chunks.push({ at: length, bytes: data });
    const out = { buffer: 0, byteOffset: length, byteLength: data.length, ...(stride ? { byteStride: stride } : {}) };
    length += data.length;
    return out;
  });
  const bin = new Uint8Array((length + 3) & ~3);
  for (const { at, bytes: data } of chunks) bin.set(data, at);

  // Images become bytes held by the model; their views stay in the BIN and are simply never referenced again.
  const notes = /** @type {string[]} */ ([]);
  /** @type {ModelImage[]} */
  const images = (json.images ?? []).map((/** @type {any} */ image, /** @type {number} */ i) => {
    /** @type {Uint8Array} */ let data;
    if (image.bufferView !== undefined) {
      const v = views[image.bufferView];
      data = bin.slice(v.byteOffset, v.byteOffset + v.byteLength);
    } else if (image.uri !== undefined) data = new Uint8Array(read(image.uri));
    else throw new TypeError(`image ${i} has no data`);
    const ext = typeof image.uri === 'string' ? (image.uri.split('?')[0].split('.').pop() ?? '').toLowerCase() : '';
    const mimeType = image.mimeType ?? MIME[ext] ?? sniffImage(data);
    delete image.uri;
    delete image.bufferView;
    return { bytes: data, mimeType };
  });
  for (const image of json.images ?? []) delete image.mimeType;

  const parts = {
    json: {
      accessors: json.accessors ?? [],
      bufferViews: views,
      buffers: [{ byteLength: bin.length }],
      asset: { version: '2.0' },
    },
    bin,
    chunks: [],
  };
  /** @type {Map<number, Attr>} */ const cache = new Map();
  const accessor = (/** @type {number} */ index) => {
    let attr = cache.get(index);
    if (!attr) {
      const a = readAccessor(/** @type {any} */ (parts), index);
      attr = {
        values: a.values,
        width: a.width,
        componentType: a.componentType,
        normalized: a.normalized,
        type: parts.json.accessors[index].type,
      };
      cache.set(index, attr);
    }
    return attr;
  };

  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      /** @type {Geo} */
      const geo = { attributes: {}, indices: null, targets: [] };
      for (const [name, index] of Object.entries(prim.attributes ?? {}))
        geo.attributes[name] = accessor(/** @type {number} */ (index));
      if (prim.indices !== undefined) geo.indices = accessor(prim.indices);
      for (const target of prim.targets ?? []) {
        /** @type {Record<string, Attr>} */ const t = {};
        for (const [name, index] of Object.entries(target)) t[name] = accessor(/** @type {number} */ (index));
        geo.targets.push(t);
      }
      delete prim.attributes;
      delete prim.indices;
      delete prim.targets;
      prim.$geo = geo;
    }
  }
  delete json.buffers;
  delete json.bufferViews;
  delete json.accessors;
  // Compressed or quantised input is read as stored; note the extension names are rewritten on output.
  json.extensionsUsed = (json.extensionsUsed ?? []).filter(
    (/** @type {string} */ n) => n !== MESHOPT && n !== 'KHR_meshopt_compression',
  );
  json.extensionsRequired = (json.extensionsRequired ?? []).filter(
    (/** @type {string} */ n) => n !== MESHOPT && n !== 'KHR_meshopt_compression',
  );
  return { json, images, accessor, notes };
}

/** @param {Uint8Array} b @returns {string} */
function sniffImage(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
  if (b[0] === 0xab && b[1] === 0x4b && b[2] === 0x54 && b[3] === 0x58) return 'image/ktx2';
  return 'application/octet-stream';
}

/** @param {Attr} attr @returns {number} */
export const countOf = (attr) => attr.values.length / attr.width;

/**
 * Writer for the BIN chunk and its views and accessors.
 */
class Builder {
  /** @param {boolean} meshopt */
  constructor(meshopt) {
    this.meshopt = meshopt;
    /** @type {Uint8Array[]} */ this.parts = [];
    this.length = 0;
    this.fallback = 0;
    /** @type {any[]} */ this.views = [];
    /** @type {any[]} */ this.accessors = [];
    /** @type {Map<string, number>} */ this.viewCache = new Map();
    /** @type {Map<string, number>} */ this.accessorCache = new Map();
    this.compressed = 0;
    this.quantized = false;
  }

  /** @param {Uint8Array} bytes @returns {number} offset */
  place(bytes) {
    const at = (this.length + 3) & ~3;
    if (at > this.length) this.parts.push(new Uint8Array(at - this.length));
    this.parts.push(bytes);
    this.length = at + bytes.length;
    return at;
  }

  /**
   * @param {Uint8Array} bytes
   * @param {{stride?: number, target?: number, mode?: 'ATTRIBUTES'|'TRIANGLES', count?: number, size?: number, encoded?: Uint8Array}} [opts]
   * @returns {number} buffer view index
   */
  view(bytes, opts = {}) {
    const key = `${createHash('sha1').update(bytes).digest('hex')}|${opts.stride ?? 0}|${opts.target ?? 0}|${opts.mode ?? ''}`;
    const cached = this.viewCache.get(key);
    if (cached !== undefined) return cached;
    /** @type {any} */ let view;
    const encoded =
      this.meshopt && opts.mode
        ? (opts.encoded ??
          (opts.mode === 'ATTRIBUTES'
            ? encodeVertexBuffer(bytes, /** @type {number} */ (opts.count), /** @type {number} */ (opts.size))
            : null))
        : null;
    if (encoded && encoded.length + 4 < bytes.length) {
      const at = this.place(encoded);
      this.fallback = (this.fallback + 3) & ~3;
      view = {
        buffer: 1,
        byteOffset: this.fallback,
        byteLength: bytes.length,
        ...(opts.stride ? { byteStride: opts.stride } : {}),
        ...(opts.target ? { target: opts.target } : {}),
        extensions: {
          [MESHOPT]: {
            buffer: 0,
            byteOffset: at,
            byteLength: encoded.length,
            byteStride: opts.size,
            count: opts.count,
            mode: opts.mode,
          },
        },
      };
      this.fallback += bytes.length;
      this.compressed++;
    } else {
      view = {
        buffer: 0,
        byteOffset: this.place(bytes),
        byteLength: bytes.length,
        ...(opts.stride ? { byteStride: opts.stride } : {}),
        ...(opts.target ? { target: opts.target } : {}),
      };
    }
    this.views.push(view);
    this.viewCache.set(key, this.views.length - 1);
    return this.views.length - 1;
  }

  /**
   * Adds an accessor for `attr`. Vertex attributes are padded to 4-byte elements and may be meshopt compressed;
   * indices use the smallest unsigned type; everything else is packed tight.
   * @param {Attr} attr
   * @param {{kind: 'vertex'|'index'|'other', bounds?: boolean, compress?: boolean}} opts
   * @returns {number}
   */
  accessor(attr, opts) {
    const count = countOf(attr),
      size = COMPONENT_BYTES[attr.componentType];
    /** @type {Uint8Array} */ let bytes;
    /** @type {number} */ let stride = 0;
    let componentType = attr.componentType;
    const type = attr.type || TYPES[attr.width];
    let values = attr.values;
    if (opts.kind === 'index') {
      let max = 0;
      for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
      componentType = max < 65535 ? 5123 : 5125;
      values = componentType === 5123 ? Uint16Array.from(values) : Uint32Array.from(values);
    }
    if (opts.kind === 'vertex') {
      const element = attr.width * size;
      stride = (element + 3) & ~3;
      if (stride === element) bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
      else {
        bytes = new Uint8Array(count * stride);
        const src = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
        for (let i = 0; i < count; i++) bytes.set(src.subarray(i * element, (i + 1) * element), i * stride);
      }
    } else bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    const compressible =
      opts.kind === 'vertex'
        ? stride <= 256
        : opts.kind === 'other' && attr.componentType === 5126 && attr.width <= 16 && count >= 16;
    const mode = opts.compress && compressible ? 'ATTRIBUTES' : undefined;
    const viewIndex = this.view(bytes, {
      stride: opts.kind === 'vertex' ? stride : undefined,
      target: opts.kind === 'vertex' ? 34962 : opts.kind === 'index' ? 34963 : undefined,
      mode,
      count,
      size: opts.kind === 'vertex' ? stride : attr.width * size,
    });
    const key = `${viewIndex}|${type}|${componentType}|${attr.normalized}|${count}`;
    const cached = this.accessorCache.get(key);
    if (cached !== undefined) return cached;
    /** @type {any} */
    const def = { bufferView: viewIndex, componentType, count, type, ...(attr.normalized ? { normalized: true } : {}) };
    if (opts.bounds) {
      const w = attr.width,
        min = Array(w).fill(Infinity),
        max = Array(w).fill(-Infinity);
      for (let i = 0; i < count; i++)
        for (let k = 0; k < w; k++) {
          const v = values[i * w + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      def.min = min;
      def.max = max;
    }
    this.accessors.push(def);
    this.accessorCache.set(key, this.accessors.length - 1);
    return this.accessors.length - 1;
  }
}

/**
 * A triangle list without the triangles that repeat a vertex (they have no area and the meshopt codec cannot code them).
 * @param {ArrayLike<number>} indices @returns {ArrayLike<number>}
 */
export function withoutDegenerate(indices) {
  let bad = 0;
  for (let i = 0; i < indices.length; i += 3)
    if (indices[i] === indices[i + 1] || indices[i + 1] === indices[i + 2] || indices[i] === indices[i + 2]) bad++;
  if (!bad) return indices;
  const out = new Uint32Array(indices.length - bad * 3);
  let n = 0;
  for (let i = 0; i < indices.length; i += 3) {
    if (indices[i] === indices[i + 1] || indices[i + 1] === indices[i + 2] || indices[i] === indices[i + 2]) continue;
    out[n++] = indices[i];
    out[n++] = indices[i + 1];
    out[n++] = indices[i + 2];
  }
  return out;
}

/**
 * Reorders the elements of `attr` so element `old` moves to `remap[old]`.
 * @param {Attr} attr @param {Uint32Array} remap @returns {Attr}
 */
export function reorder(attr, remap) {
  const w = attr.width,
    out = new /** @type {any} */ (attr.values.constructor)(attr.values.length);
  for (let v = 0; v < remap.length; v++) for (let k = 0; k < w; k++) out[remap[v] * w + k] = attr.values[v * w + k];
  return { ...attr, values: out };
}

/**
 * Serialises a model to a GLB.
 * @param {Model} model
 * @param {{meshopt?: boolean, generator?: string}} [options] `meshopt` compresses vertex data and triangles with EXT_meshopt_compression
 * @returns {{glb: Uint8Array, compressedViews: number}}
 */
export function writeModel(model, options = {}) {
  const b = new Builder(options.meshopt === true);
  const json = { ...model.json };
  // Accessors outside mesh data (animation, skins, instancing) are re-emitted once and referenced by their new index.
  /** @type {Map<number, number>} */ const aux = new Map();
  const auxIndex = (/** @type {number} */ old, /** @type {boolean} */ bounds) => {
    let index = aux.get(old);
    if (index === undefined) {
      index = b.accessor(model.accessor(old), { kind: 'other', bounds, compress: false });
      aux.set(old, index);
    }
    return index;
  };
  json.meshes = (json.meshes ?? []).map((/** @type {any} */ mesh) => ({
    ...mesh,
    primitives: mesh.primitives.map((/** @type {any} */ prim) => {
      const { $geo, ...rest } = prim;
      /** @type {Geo} */
      let geo = $geo;
      /** @type {Uint8Array|null} */ let encodedIndices = null;
      if (b.meshopt && (rest.mode ?? 4) === 4 && geo.indices) {
        const vertices = countOf(geo.attributes.POSITION ?? Object.values(geo.attributes)[0]);
        const encoded = encodeTriangles(withoutDegenerate(geo.indices.values), vertices);
        const attributes = /** @type {Record<string, Attr>} */ ({});
        for (const [name, attr] of Object.entries(geo.attributes)) attributes[name] = reorder(attr, encoded.remap);
        const targets = geo.targets.map((t) =>
          Object.fromEntries(Object.entries(t).map(([n, a]) => [n, reorder(a, encoded.remap)])),
        );
        geo = { attributes, targets, indices: { ...geo.indices, values: encoded.indices } };
        encodedIndices = encoded.bytes;
      }
      const attributes = /** @type {Record<string, number>} */ ({});
      for (const [name, attr] of Object.entries(geo.attributes)) {
        attributes[name] = b.accessor(attr, { kind: 'vertex', bounds: name === 'POSITION', compress: true });
        if (attr.componentType !== 5126 && (name === 'POSITION' || name === 'NORMAL' || name === 'TANGENT'))
          b.quantized = true;
      }
      const out = { ...rest, attributes };
      if (geo.indices) {
        const indexAttr = geo.indices;
        const encoded = encodedIndices;
        if (encoded) {
          const vertices = countOf(geo.attributes.POSITION ?? Object.values(geo.attributes)[0]);
          const small = vertices <= 65535;
          const raw = small ? Uint16Array.from(indexAttr.values) : Uint32Array.from(indexAttr.values);
          const bytes = new Uint8Array(raw.buffer);
          const view = b.view(bytes, {
            target: 34963,
            mode: 'TRIANGLES',
            count: indexAttr.values.length,
            size: small ? 2 : 4,
            encoded,
          });
          const key = `${view}|SCALAR|${small ? 5123 : 5125}|false|${indexAttr.values.length}`;
          let accessor = b.accessorCache.get(key);
          if (accessor === undefined) {
            b.accessors.push({
              bufferView: view,
              componentType: small ? 5123 : 5125,
              count: indexAttr.values.length,
              type: 'SCALAR',
            });
            accessor = b.accessors.length - 1;
            b.accessorCache.set(key, accessor);
          }
          out.indices = accessor;
        } else out.indices = b.accessor(indexAttr, { kind: 'index', compress: false });
      }
      if (geo.targets.length)
        out.targets = geo.targets.map((t) =>
          Object.fromEntries(
            Object.entries(t).map(([n, a]) => [
              n,
              b.accessor(a, { kind: 'vertex', bounds: n === 'POSITION', compress: false }),
            ]),
          ),
        );
      return out;
    }),
  }));
  for (const animation of json.animations ?? [])
    for (const sampler of animation.samplers ?? []) {
      sampler.input = auxIndex(sampler.input, true);
      sampler.output = auxIndex(sampler.output, false);
    }
  for (const skin of json.skins ?? [])
    if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = auxIndex(skin.inverseBindMatrices, false);
  for (const node of json.nodes ?? []) {
    const instancing = node.extensions?.EXT_mesh_gpu_instancing;
    if (instancing)
      instancing.attributes = Object.fromEntries(
        Object.entries(instancing.attributes).map(([n, i]) => [n, auxIndex(/** @type {number} */ (i), false)]),
      );
  }

  /** @type {number[]} */ const imageViews = [];
  json.images = (json.images ?? []).map((/** @type {any} */ image, /** @type {number} */ i) => {
    const data = model.images[i];
    imageViews[i] = b.view(data.bytes, {});
    return { ...image, mimeType: data.mimeType, bufferView: imageViews[i] };
  });
  if (!json.images.length) delete json.images;

  for (const view of b.views) if (view.buffer === 0 && view.byteStride === undefined) delete view.byteStride;
  const generator = options.generator ?? 'margo-convert';
  json.asset = { ...json.asset, generator };
  json.accessors = b.accessors;
  json.bufferViews = b.views;
  const bin = new Uint8Array((b.length + 3) & ~3);
  let at = 0;
  for (const part of b.parts) {
    bin.set(part, at);
    at += part.length;
  }
  json.buffers = [{ byteLength: bin.length }];
  /** @type {string[]} */ const used = (json.extensionsUsed ?? []).filter(
    (/** @type {string} */ n) => n !== 'KHR_mesh_quantization',
  );
  /** @type {string[]} */ const required = (json.extensionsRequired ?? []).filter(
    (/** @type {string} */ n) => n !== 'KHR_mesh_quantization',
  );
  if (b.quantized || (json.extensionsUsed ?? []).includes('KHR_mesh_quantization')) {
    if (b.quantized) {
      used.push('KHR_mesh_quantization');
      required.push('KHR_mesh_quantization');
    } else used.push('KHR_mesh_quantization');
  }
  if (b.compressed) {
    json.buffers.push({ byteLength: (b.fallback + 3) & ~3, extensions: { [MESHOPT]: { fallback: true } } });
    used.push(MESHOPT);
    required.push(MESHOPT);
  }
  if (used.length) json.extensionsUsed = [...new Set(used)];
  else delete json.extensionsUsed;
  if (required.length) json.extensionsRequired = [...new Set(required)];
  else delete json.extensionsRequired;
  return { glb: joinGLB({ json, bin, chunks: [] }), compressedViews: b.compressed };
}
