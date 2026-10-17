// Helpers for the part 1 fuzz targets (targets-formats.js, launch gate 11a): seeds built from the repo's glTF, .margo,
// KTX2, Draco and meshopt files, GLB packing, format-aware byte mutations (known length/offset/count fields) and
// structure-aware glTF JSON mutations. Every helper draws only from the harness PRNG, so input i of seed s is fixed.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { concat } from './harness.js';

export const root = resolve(import.meta.dirname, '../..');
export const read = (path) => new Uint8Array(readFileSync(join(root, path)));
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
/** Every file in a directory matching `pattern`, sorted by name. */
export const files = (dir, pattern) =>
  readdirSync(join(root, dir))
    .filter((f) => pattern.test(f))
    .sort()
    .map((f) => read(`${dir}/${f}`));
/** A valid 1x1 RGBA PNG: texture bytes in the seeds are swapped for it so the fuzzer spends its time in the parsers. */
export const png = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

export const dist = (path) => pathToFileURL(join(root, 'packages', path)).href;

// --- headless loading (Node has no GPU and no image decoder) ---------------------------------------------------------
let headlessEngine;
/**
 * One engine per fuzz child, as tests/support/pbr-snapshot.js: PBRModel GPU setup is a no-op and createImageBitmap
 * answers like a browser would: a PNG has its IHDR size, a JPEG or WebP 4x4, anything else rejects with a DOMException.
 */
export function headless() {
  headlessEngine ??= (async () => {
    const [{ Engine, TransformStore }, { PBRModel }] = await Promise.all([
      import(dist('core/dist/extension.js')),
      import(dist('gltf-pro/dist/index.js')),
    ]);
    PBRModel.prototype.setup = () => {};
    globalThis.createImageBitmap = imageBitmap;
    return new Engine({ width: 64, height: 64, clientWidth: 64, clientHeight: 64 }, await TransformStore.create(4096), {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
  })();
  return headlessEngine;
}
export async function imageBitmap(source) {
  const b = source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : new Uint8Array(0),
    v = new DataView(b.buffer),
    isPNG = b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
    isJPEG = b[0] === 0xff && b[1] === 0xd8,
    isWebP = b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  if (!isPNG && !isJPEG && !isWebP)
    throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
  // close() is not enumerable, so the stub structured-clones like a transferred bitmap.
  return Object.defineProperty({ width: isPNG ? v.getUint32(16) : 4, height: isPNG ? v.getUint32(20) : 4 }, 'close', {
    value() {},
  });
}
/**
 * A parsed PBR model is safe to draw: whole 20-float vertices, every index in range, every value finite. Odd but
 * finite data a hostile file declares (a COLOR_0 of 2, a short tangent) only renders oddly, so it is not a finding;
 * pre-packed geometry (.margo) is held to validatePreparedGeometry by the loader itself.
 */
export function checkModel(model) {
  for (const p of [...model.primitives, ...model.pointsAndLines]) {
    const count = p.vertices.length / 20;
    if (p.vertices.length % 20 || p.indices.some((i) => i >= count)) throw new Error('GARBAGE: index out of range');
    if (p.vertices.some((x) => !Number.isFinite(x))) throw new Error('GARBAGE: non-finite vertex');
  }
  return model.primitives.map((p) => [p.vertices, p.indices]);
}

// --- structured inputs ------------------------------------------------------------------------------------------
// Targets that need more than bytes (a meshopt count and stride, a server mode, a transcode target) read them from
// an 8-byte prefix, so a saved input replays and minimizes like any other and byte mutations reach the options too.
export const PARAMS = 8;
export const withParams = (params, body) =>
  concat(
    Uint8Array.from({ length: PARAMS }, (_, i) => params[i] ?? 0),
    body,
  );
export const splitParams = (bytes) => {
  const head = new Uint8Array(PARAMS);
  head.set(bytes.subarray(0, PARAMS));
  return { params: head, view: new DataView(head.buffer), body: bytes.subarray(PARAMS) };
};

/** FNV-1a of the input: picks the inputs that also run the neighbour check, without drawing from the PRNG. */
export function hash(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
  return h >>> 0;
}
/** The same bytes at offset 8 of a larger buffer full of junk: a parser that ignores byteOffset reads the junk. */
export function displaced(bytes) {
  const out = new Uint8Array(bytes.length + 16).fill(0xa5);
  out.set(bytes, 8);
  return out.subarray(8, 8 + bytes.length);
}
/** A digest of a parser result (typed arrays hashed, objects walked to depth 6), to compare two runs. */
export function digest(value, out = [], depth = 0) {
  if (depth > 6 || out.length > 1e6) return out;
  if (ArrayBuffer.isView(value))
    out.push(
      value.constructor.name,
      value.byteLength,
      hash(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    );
  else if (value && typeof value === 'object')
    for (const key of Object.keys(value).sort()) {
      out.push(key);
      digest(value[key], out, depth + 1);
    }
  else out.push(String(value));
  return out;
}

// --- byte mutations ---------------------------------------------------------------------------------------------
const U32 = [
  0, 1, 2, 3, 4, 7, 8, 0x7f, 0x80, 0xff, 0x100, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff,
];
const F32 = [Number.NaN, Infinity, -Infinity, -0, 1e38, -1e38, 1e-45, 3.4028234e38];

/** One byte-level mutation. `fields`: offsets of the format's length/offset/count fields; `donors`: other seeds. */
export function mutateBytes(r, input, { fields = [], donors = [] } = {}) {
  let out = new Uint8Array(input);
  const n = out.length,
    at = () => r.int(Math.max(1, n)),
    u32 = () => r.int(2 ** 32),
    put = (offset, value) => {
      if (offset >= 0 && offset + 4 <= out.length)
        new DataView(out.buffer).setUint32(offset, value >>> 0, r.chance(0.85));
    };
  switch (r.int(14)) {
    case 0: // bit flips
      for (let k = 1 + r.int(8); k--; ) if (n) out[at()] ^= 1 << r.int(8);
      break;
    case 1: // interesting bytes
      for (let k = 1 + r.int(4); k--; ) if (n) out[at()] = r.pick([0, 1, 0x7f, 0x80, 0xfe, 0xff]);
      break;
    case 2: // random bytes
      for (let k = 1 + r.int(16); k--; ) if (n) out[at()] = r.int(256);
      break;
    case 3: // truncation, often right at a header or field boundary
      out = out.slice(0, r.chance(0.5) && fields.length ? r.pick(fields) + r.int(8) : at());
      break;
    case 4: // a known length/offset/count field corrupted
    case 5:
      if (fields.length) {
        const f = r.pick(fields),
          old = f + 4 <= n ? new DataView(out.buffer).getUint32(f, true) : 0;
        put(f, r.pick([...U32, n, n + 1, n - 1, n + 4, old + 1, old - 1, old * 2, old + 0x10000, u32()]));
        break;
      }
      put(r.chance(0.5) ? at() & ~3 : at(), r.pick([...U32, n, n + 1, u32()]));
      break;
    case 6: // an interesting uint32 anywhere (4-aligned half the time)
      put(r.chance(0.5) ? at() & ~3 : at(), r.pick([...U32, n, n + 1, u32()]));
      break;
    case 7: // NaN, Infinity and huge floats into float data
      if (n >= 4) new DataView(out.buffer).setFloat32(r.int(n - 3) & ~3, r.pick(F32), true);
      break;
    case 8: {
      const a = at();
      out = concat(out.subarray(0, a), out.subarray(Math.min(n, a + 1 + r.int(64))));
      break;
    }
    case 9: {
      const a = at(),
        k = 1 + r.int(r.chance(0.1) ? 4096 : 32),
        fill = r.chance(0.5) ? r.int(256) : -1;
      out = concat(
        out.subarray(0, a),
        Uint8Array.from({ length: k }, () => (fill < 0 ? r.int(256) : fill)),
        out.subarray(a),
      );
      break;
    }
    case 10: {
      // a block copied over another: overlapping structures, repeated headers
      const a = at(),
        b = at(),
        k = Math.min(1 + r.int(64), n - a, n - b);
      if (k > 0) out.copyWithin(b, a, a + k);
      break;
    }
    case 11: {
      const donor = donors.length ? r.pick(donors) : input;
      out = concat(out.subarray(0, at()), donor.subarray(r.int(donor.length)));
      break;
    }
    case 12:
      out = concat(
        out,
        Uint8Array.from({ length: 1 + r.int(64) }, () => (r.chance(0.5) ? 0 : r.int(256))),
      );
      break;
    default:
      out.fill(0, at(), at());
  }
  return out;
}
/** One to three (sometimes up to eight) stacked byte mutations. */
export function mutateBytesN(r, input, options) {
  let out = input;
  for (let k = 1 + r.int(r.chance(0.2) ? 8 : 3); k--; ) out = mutateBytes(r, out, options);
  return out;
}

// --- GLB ----------------------------------------------------------------------------------------------------------
/** {doc, bin} from known-good GLB bytes. */
export function fromGLB(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    jsonLength = view.getUint32(12, true),
    doc = JSON.parse(decoder.decode(bytes.subarray(20, 20 + jsonLength))),
    at = 20 + jsonLength,
    bin = at + 8 <= bytes.length ? bytes.subarray(at + 8, at + 8 + view.getUint32(at, true)) : undefined;
  return { doc, bin };
}
/** GLB bytes from a document and an optional BIN chunk; `json` overrides the JSON text. */
export function toGLB(doc, bin, json = JSON.stringify(doc)) {
  const text = encoder.encode(json),
    jsonLength = (text.length + 3) & ~3,
    binLength = bin ? (bin.length + 3) & ~3 : 0,
    out = new Uint8Array(20 + jsonLength + (bin ? 8 + binLength : 0)),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(text, 20);
  if (bin) {
    view.setUint32(20 + jsonLength, binLength, true);
    view.setUint32(24 + jsonLength, 0x004e4942, true);
    out.set(bin, 28 + jsonLength);
  }
  return out;
}
/** Offsets of the GLB version, total length and chunk headers. */
export function glbFields(bytes) {
  if (bytes.length < 20 || bytes[0] !== 0x67) return [];
  const json = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
  return [4, 8, 12, 16, 20 + json, 24 + json].filter((f) => f + 4 <= bytes.length);
}

// One BIN for every bufferView of a single-buffer model; image views become the 1x1 PNG, external images a data URI.
function slim(doc, buffers) {
  const imageViews = new Set((doc.images ?? []).map((i) => i.bufferView).filter((v) => v !== undefined)),
    parts = [];
  for (const image of doc.images ?? [])
    if (image.uri !== undefined) {
      image.uri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
      image.mimeType = 'image/png';
    }
  if ((doc.buffers ?? []).length > 1) return { doc, buffers };
  let length = 0;
  for (const [i, view] of (doc.bufferViews ?? []).entries()) {
    const source = buffers[view.buffer ?? 0],
      bytes = imageViews.has(i) ? png : source.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    view.byteOffset = length;
    view.byteLength = bytes.length;
    if (imageViews.has(i)) for (const image of doc.images) if (image.bufferView === i) image.mimeType = 'image/png';
    parts.push(bytes, new Uint8Array(-bytes.length & 3));
    length += bytes.length + (-bytes.length & 3);
  }
  if (doc.buffers?.length) doc.buffers[0] = { byteLength: Math.max(1, length) };
  return { doc, bin: length ? concat(...parts) : undefined };
}

let gltfCache;
/** glTF seeds: every Khronos sample model and package fixture whose slimmed GLB is at most `maxBytes`. */
export function gltfSeeds(maxBytes = 768 * 1024) {
  if (gltfCache) return gltfCache.filter((s) => s.length <= maxBytes);
  const paths = [];
  for (const dir of ['examples/assets/khronos', 'packages/decoders/tests/fixtures', 'tests/fixtures/basic-scene'])
    if (existsSync(join(root, dir)))
      for (const entry of readdirSync(join(root, dir), { recursive: true }))
        if (/\.(glb|gltf)$/i.test(entry)) paths.push(`${dir}/${entry}`.replaceAll('\\', '/'));
  gltfCache = [];
  for (const path of paths.sort()) {
    try {
      let doc,
        buffers = [];
      if (path.endsWith('.glb')) {
        const parsed = fromGLB(read(path));
        doc = parsed.doc;
        if (parsed.bin) buffers = [parsed.bin];
      } else {
        doc = JSON.parse(decoder.decode(read(path)));
        for (const b of doc.buffers ?? []) {
          buffers.push(
            b.uri.startsWith('data:')
              ? new Uint8Array(Buffer.from(b.uri.slice(b.uri.indexOf(',') + 1), 'base64'))
              : read(`${dirname(path)}/${decodeURIComponent(b.uri)}`),
          );
          delete b.uri;
        }
      }
      if (buffers.reduce((n, b) => n + b.length, 0) > 64 << 20) continue;
      const s = slim(doc, buffers);
      if (s.buffers)
        s.doc.buffers.forEach((b, i) => {
          b.uri = `data:application/octet-stream;base64,${Buffer.from(s.buffers[i]).toString('base64')}`;
        });
      gltfCache.push(s.buffers ? encoder.encode(JSON.stringify(s.doc)) : toGLB(s.doc, s.bin));
    } catch {
      // a model this slimming cannot repack (external files missing in a sparse checkout) is not a seed
    }
  }
  return gltfCache.filter((s) => s.length <= maxBytes);
}

/** The light loader reads static triangles: strip what it rejects so its seeds start out valid. */
export function lightSeeds(seeds) {
  return seeds.flatMap((bytes) => {
    if (bytes[0] !== 0x67) return [];
    const { doc, bin } = fromGLB(bytes);
    for (const key of ['materials', 'textures', 'images', 'samplers', 'skins', 'animations', 'extensionsRequired'])
      delete doc[key];
    for (const key of ['extensionsUsed', 'extensions']) delete doc[key];
    for (const n of doc.nodes ?? []) for (const key of ['skin', 'camera', 'extensions', 'weights']) delete n[key];
    for (const m of doc.meshes ?? [])
      for (const p of m.primitives ?? []) {
        for (const key of ['material', 'targets', 'extensions']) delete p[key];
        for (const k of Object.keys(p.attributes ?? {})) if (k !== 'POSITION' && k !== 'NORMAL') delete p.attributes[k];
      }
    return [toGLB(doc, bin)];
  });
}

/** A textured quad GLB whose base colour is a KHR_texture_basisu KTX2 image (the gltf-pro KTX2 path). */
export function ktx2GLB(ktx2, { fallback = false } = {}) {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices = new Uint16Array([0, 1, 2, 0, 2, 3]),
    parts = [new Uint8Array(positions.buffer), new Uint8Array(uvs.buffer), new Uint8Array(indices.buffer), ktx2];
  const views = [];
  let length = 0;
  for (const p of parts) {
    views.push({ buffer: 0, byteOffset: length, byteLength: p.length });
    length += p.length + (-p.length & 3);
  }
  const bin = concat(...parts.flatMap((p) => [p, new Uint8Array(-p.length & 3)]));
  const doc = {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_texture_basisu'],
    ...(fallback ? {} : { extensionsRequired: ['KHR_texture_basisu'] }),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ ...(fallback ? { source: 1 } : {}), extensions: { KHR_texture_basisu: { source: 0 } } }],
    images: [
      { bufferView: 3, mimeType: 'image/ktx2' },
      ...(fallback ? [{ uri: `data:image/png;base64,${Buffer.from(png).toString('base64')}` }] : []),
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  return toGLB(doc, bin);
}

/** A .margo file with its scene JSON (section 1) replaced by `json`; later section offsets and the length follow. */
export function margoWithScene(bytes, json) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset = view.getUint32(68, true),
    size = view.getUint32(72, true),
    padded = (json.length + 3) & ~3,
    tail = bytes.subarray((offset + size + 3) & ~3),
    out = new Uint8Array(offset + padded + tail.length),
    o = new DataView(out.buffer);
  out.set(bytes.subarray(0, offset));
  out.set(json, offset);
  out.set(tail, offset + padded);
  o.setUint32(8, out.length, true);
  o.setUint32(72, json.length, true);
  for (let i = 1; i < view.getUint32(12, true); i++)
    o.setUint32(68 + i * 16, view.getUint32(68 + i * 16, true) + padded - ((size + 3) & ~3), true);
  return out;
}

// --- structure-aware glTF JSON mutations ----------------------------------------------------------------------------
const HOSTILE = [-1, 0, 1, 2, 3, 4, 255, 65535, 65536, 2 ** 31 - 1, 2 ** 31, 2 ** 32, 2 ** 32 + 1, 2 ** 53, -(2 ** 53)];
HOSTILE.push(1e308, -1e308, 0.5, -0.5, 5e-324, '1', '', null, true, false);
const hostile = (r) => r.pick([...HOSTILE, [], {}, [0], [null], { index: 0 }]);
const TOP = ['nodes', 'meshes', 'accessors', 'bufferViews', 'buffers', 'materials', 'textures', 'images', 'samplers'];
TOP.push('scenes', 'cameras', 'skins', 'animations');

function paths(value, path = [], out = [], depth = 0) {
  if (depth > 12 || out.length > 4000) return out;
  out.push(path);
  if (value && typeof value === 'object')
    for (const key of Object.keys(value)) paths(value[key], [...path, key], out, depth + 1);
  return out;
}
const get = (doc, path) => path.reduce((v, k) => v?.[k], doc);
function set(doc, path, value) {
  if (!path.length) return value;
  const parent = get(doc, path.slice(0, -1));
  if (parent && typeof parent === 'object') parent[path[path.length - 1]] = value;
  return doc;
}
const nested = (depth, leaf) => {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
};
// Extension payloads gltf-pro reads, with hostile members, so any seed reaches the extension parsers.
const extensionPayloads = (r) => ({
  KHR_texture_transform: {
    offset: r.pick([[0, 0], [Number.NaN], 'x', [1e39, 0]]),
    rotation: r.pick([0, 1e308, '1']),
    scale: [1, 1],
    texCoord: r.pick([0, 1, 2, -1, 1e9]),
  },
  KHR_texture_basisu: { source: r.pick([0, 1, -1, 99, '0', null]) },
  KHR_materials_clearcoat: { clearcoatFactor: r.pick([0, 1, 2, -1]), clearcoatTexture: { index: r.pick([0, 99, -1]) } },
  KHR_materials_transmission: { transmissionFactor: r.pick([0, 0.5, 1, 7]) },
  KHR_materials_volume: { thicknessFactor: r.pick([0, 1, -1]), attenuationDistance: r.pick([0, 1, -1, 1e-320]) },
  KHR_materials_sheen: { sheenColorFactor: r.pick([[1, 1, 1], [1, 1], null]) },
  KHR_materials_specular: {
    specularColorFactor: r.pick([
      [1, 1, 1],
      [-1, 0, 0],
    ]),
    specularFactor: r.pick([0, 2]),
  },
  KHR_materials_ior: { ior: r.pick([1.5, 0, -1, 1e308]) },
  KHR_materials_emissive_strength: { emissiveStrength: r.pick([1, -1, 1e308]) },
  KHR_materials_iridescence: {
    iridescenceFactor: r.pick([1, 0, -1]),
    iridescenceThicknessMinimum: r.pick([100, -1]),
    iridescenceThicknessTexture: { index: r.pick([0, 1e6]) },
  },
  KHR_materials_anisotropy: {
    anisotropyStrength: r.pick([1, 0, 2]),
    anisotropyRotation: r.pick([0, 1e308]),
    anisotropyTexture: { index: r.pick([0, -2]) },
  },
  KHR_materials_diffuse_transmission: {
    diffuseTransmissionFactor: r.pick([1, 0.5, 9]),
    diffuseTransmissionColorFactor: r.pick([[1, 1, 1], [2]]),
  },
  KHR_materials_dispersion: { dispersion: r.pick([0, 1, -1, 1e308, '1']) },
  KHR_materials_variants: {
    mappings: r.pick([[{ material: 0, variants: [0] }], [{ material: 99, variants: [5] }], 'x', [null]]),
  },
  KHR_lights_punctual: { light: r.pick([0, 1, 99, -1]) },
  EXT_mesh_gpu_instancing: {
    attributes: r.pick([{ TRANSLATION: 0 }, { ROTATION: 1, SCALE: 2 }, { TRANSLATION: 999 }, {}, null]),
  },
  KHR_draco_mesh_compression: { bufferView: r.pick([0, 1, 99]), attributes: { POSITION: r.pick([0, 1, -1]) } },
  EXT_meshopt_compression: {
    buffer: 0,
    byteOffset: r.pick([0, 4, 1e9]),
    byteLength: r.pick([4, 64, 1e9]),
    byteStride: r.pick([2, 4, 12, 0, 300]),
    count: r.pick([1, 3, 2 ** 31]),
    mode: r.pick(['ATTRIBUTES', 'TRIANGLES', 'INDICES', 'x']),
    filter: r.pick(['NONE', 'OCTAHEDRAL', 'QUATERNION', 'EXPONENTIAL', 'COLOR', 'Z']),
  },
});

/** One structure-aware mutation of a glTF document (in place; returns the document or its replacement). */
export function mutateDoc(r, doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const path = r.pick(paths(doc));
  switch (r.int(16)) {
    case 0:
    case 1:
    case 2: // a hostile value at a random path
      return set(doc, path, hostile(r));
    case 3: {
      // off by one, sign flip, width overflow
      const v = get(doc, path);
      return set(
        doc,
        path,
        typeof v === 'number' ? r.pick([v + 1, v - 1, -v, v * 2 ** 16, v + 2 ** 32, v / 3]) : hostile(r),
      );
    }
    case 4: // a key or array element removed
      if (path.length) {
        const parent = get(doc, path.slice(0, -1)),
          key = path[path.length - 1];
        if (Array.isArray(parent)) parent.splice(+key, 1);
        else if (parent) delete parent[key];
      }
      return doc;
    case 5: {
      // cyclic or shared node graph
      const nodes = doc.nodes;
      if (Array.isArray(nodes) && nodes.length) {
        const i = r.int(nodes.length),
          j = r.int(nodes.length);
        if (nodes[i] && typeof nodes[i] === 'object')
          nodes[i].children = r.pick([[i], [j], [i, j], [j, j], [0], [nodes.length]]);
        if (r.chance(0.5) && nodes[j] && typeof nodes[j] === 'object') nodes[j].children = [i];
      }
      return doc;
    }
    case 6: {
      // accessor and buffer view geometry: huge counts, bad strides, overlapping or out-of-range views, sparse data
      const accessors = doc.accessors,
        views = doc.bufferViews,
        nViews = Array.isArray(views) ? views.length : 0;
      if (Array.isArray(accessors) && accessors.length) {
        const a = accessors[r.int(accessors.length)];
        if (a && typeof a === 'object') {
          const which = r.int(7);
          if (which === 0) a.count = r.pick([0, 2 ** 31, 2 ** 32, 1e9, 1_000_001, 3]);
          else if (which === 1) a.byteOffset = r.pick([1, 2, 3, 2 ** 31, -4]);
          else if (which === 2) a.bufferView = r.pick([0, nViews, -1, accessors.indexOf(a)]);
          else if (which === 3) a.componentType = r.pick([5120, 5121, 5122, 5123, 5125, 5126, 5124, 0]);
          else if (which === 4) a.type = r.pick(['SCALAR', 'VEC2', 'VEC3', 'VEC4', 'MAT2', 'MAT4', 'X']);
          else if (which === 5) a.normalized = r.pick([true, false, 1, 'yes']);
          else
            a.sparse = {
              count: r.pick([1, 2, a.count ?? 1, 2 ** 31]),
              indices: {
                bufferView: r.int(nViews + 1),
                componentType: r.pick([5121, 5123, 5125, 5126]),
                byteOffset: r.pick([0, 1, 1e9]),
              },
              values: { bufferView: r.int(nViews + 1), byteOffset: r.pick([0, 2, 1e9]) },
            };
        }
      }
      if (nViews) {
        const v = views[r.int(nViews)],
          w = views[r.int(nViews)];
        if (v && typeof v === 'object' && w && typeof w === 'object') {
          const which = r.int(4);
          if (which === 0) v.byteStride = r.pick([1, 2, 3, 4, 252, 253, 256, 0, 2 ** 31]);
          else if (which === 1) v.byteOffset = r.pick([w.byteOffset ?? 0, (w.byteOffset ?? 0) + 1, 2 ** 32, -1]);
          else if (which === 2) v.byteLength = r.pick([0, 1, 2 ** 31, (w.byteLength ?? 0) * 4]);
          else v.buffer = r.pick([0, 1, 99, -1]);
        }
      }
      return doc;
    }
    case 7: {
      // a reference out of range in a random definition
      const list = doc[r.pick(TOP)];
      if (Array.isArray(list) && list.length) {
        const item = list[r.int(list.length)],
          ref = r.pick([
            'mesh',
            'material',
            'source',
            'sampler',
            'camera',
            'skin',
            'indices',
            'bufferView',
            'node',
            'input',
            'output',
          ]);
        if (item && typeof item === 'object') item[ref] = r.pick([list.length, -1, 2 ** 32, 0.5, '0']);
      }
      return doc;
    }
    case 8: // a top-level list of the wrong type
      return set(doc, [r.pick(TOP)], r.pick([{}, 'x', 7, null, [null], [[]], [1]]));
    case 9: // deep nesting in extras or an extension
      return set(
        doc,
        r.pick([['extras'], ['nodes', 0, 'extras'], ['materials', 0, 'extras'], ['extensions', 'X']]),
        nested(r.pick([64, 1000, 20000]), r.pick([0, {}])),
      );
    case 10: // giant strings
      return set(
        doc,
        r.pick([
          ['nodes', 0, 'name'],
          ['asset', 'generator'],
          ['meshes', 0, 'name'],
          ['images', 0, 'uri'],
        ]),
        'A'.repeat(r.pick([1 << 10, 1 << 20, 1 << 23])),
      );
    case 11: {
      // a hostile extension payload on a material, node, primitive or texture
      const payload = extensionPayloads(r),
        name = r.pick(Object.keys(payload)),
        holders = [
          doc.materials?.[0],
          doc.nodes?.[0],
          doc.meshes?.[0]?.primitives?.[0],
          doc.textures?.[0],
          doc.materials?.[0]?.pbrMetallicRoughness?.baseColorTexture,
        ].filter((x) => x && typeof x === 'object');
      if (holders.length) {
        const h = r.pick(holders);
        h.extensions = {
          ...(h.extensions && typeof h.extensions === 'object' ? h.extensions : {}),
          [name]: payload[name],
        };
      }
      if (r.chance(0.3)) doc.extensionsUsed = [...(Array.isArray(doc.extensionsUsed) ? doc.extensionsUsed : []), name];
      if (r.chance(0.2)) doc.extensionsRequired = [name];
      if (name === 'KHR_lights_punctual' && r.chance(0.7))
        doc.extensions = {
          ...doc.extensions,
          KHR_lights_punctual: {
            lights: r.pick([
              [{ type: 'spot', spot: { innerConeAngle: 1, outerConeAngle: 0.5 } }],
              [{ type: 'point', range: 0 }],
              [null],
              'x',
            ]),
          },
        };
      if (name === 'KHR_materials_variants' && r.chance(0.7))
        doc.extensions = {
          ...doc.extensions,
          KHR_materials_variants: { variants: r.pick([[{ name: 'a' }], [{}], [null], 'x']) },
        };
      return doc;
    }
    case 12: {
      // a definition repeated: shared definitions, repeated primitives
      const list = doc[r.pick(TOP)];
      if (Array.isArray(list) && list.length && list.length < 1e5)
        list.push(...Array.from({ length: r.pick([1, 2, 1000]) }, () => list[r.int(list.length)]));
      return doc;
    }
    case 13: {
      const p = doc.meshes?.[0]?.primitives?.[0];
      if (p && typeof p === 'object') p.mode = r.pick([0, 1, 2, 3, 4, 5, 6, 7, -1, 1.5]);
      return doc;
    }
    case 14: {
      const node = Array.isArray(doc.nodes) ? doc.nodes[r.int(doc.nodes.length)] : undefined;
      if (node && typeof node === 'object')
        node[r.pick(['matrix', 'translation', 'rotation', 'scale', 'weights'])] = r.pick([
          [0, 0, 0],
          [1, 1, 1, 1],
          Array(16).fill(0),
          [...Array(15).fill(0), 1],
          [Number.NaN],
          'x',
          [1e39, 0, 0],
          Array(17).fill(1),
        ]);
      return doc;
    }
    default:
      return set(
        doc,
        r.pick([['asset', 'version'], ['scene'], ['scenes', 0, 'nodes'], ['asset']]),
        r.pick([...HOSTILE, '1.0', '2.0', '3.0']),
      );
  }
}

/** A mutated glTF: the JSON tree and BIN re-serialised after 1-6 structural mutations, or raw byte mutations. */
export function mutateGLTF(r, seeds) {
  const seed = r.pick(seeds);
  if (r.chance(0.25)) return mutateBytesN(r, seed, { fields: glbFields(seed), donors: seeds });
  const glb = seed[0] === 0x67;
  let doc, bin;
  if (glb) ({ doc, bin } = fromGLB(seed));
  else doc = JSON.parse(decoder.decode(seed));
  for (let k = 1 + r.int(r.chance(0.3) ? 6 : 2); k--; ) doc = mutateDoc(r, doc) ?? doc;
  if (bin && r.chance(0.3)) bin = mutateBytesN(r, bin, {});
  let bytes;
  try {
    let json = JSON.stringify(doc);
    // Nesting deeper than JSON.stringify (or any recursive reader) handles, written as text.
    if (r.chance(0.03) && json?.startsWith('{')) {
      const depth = r.pick([300, 5000, 100000]);
      json = `{"extras":${'['.repeat(depth)}${']'.repeat(depth)},${json.slice(1)}`;
    }
    bytes = glb ? toGLB(doc, bin, json) : encoder.encode(json);
  } catch {
    bytes = seed; // a mutation the serialiser refuses falls back to the seed
  }
  if (bytes.length > 64 << 20) bytes = seed;
  return r.chance(0.15) ? mutateBytesN(r, bytes, { fields: glbFields(bytes), donors: seeds }) : bytes;
}
