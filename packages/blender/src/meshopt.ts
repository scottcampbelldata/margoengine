import type { EngineKernel } from '@margoengine/core';
import type { PBRModel } from '@margoengine/gltf-pro/model';
import { meshoptDecodeVertexBuffer } from '@margoengine/decoders/meshopt';
import { readContainer, maxBytes, meshoptFlag, type MargoSection } from './container.js';
import { writeMargo } from './write-container.js';
import { decodeMargo, parseMargo, type MargoAsset, type MargoOptions } from './index.js';
import { readResponse } from '../../shared/loading.js';

function source(input: ArrayBuffer | ArrayBufferView) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : undefined;
  const flag = bytes && bytes.length >= 24 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20, true) : 0;
  return readContainer(input, flag === 1 ? 1 : flag === 2 ? 2 : meshoptFlag);
}
const invalid = (): never => { throw new TypeError('Invalid .margo meshopt section; re-compress the original asset with compressMargoMeshopt'); };
const plain = (s: MargoSection) => ({ type: s.type, flags: s.flags, bytes: s.bytes });

/** Expand lossless meshopt sections into an ordinary .margo, preserving every geometry byte and triangle index. */
export function expandMargoMeshopt(input: ArrayBuffer | ArrayBufferView, { signal }: { signal?: AbortSignal } = {}): Uint8Array<ArrayBuffer> {
  signal?.throwIfAborted();
  const container = source(input);
  if (container.flags !== meshoptFlag) return Uint8Array.from(new Uint8Array(container.buffer, container.base, container.length));
  const manifest = container.manifest as Record<string, unknown>;
  const original = manifest?._margoMeshopt;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || ![0, 1, 2].includes(original as number)) invalid();
  const plans = container.sections.slice(1).map(s => {
    if (s.type !== 9) return { section: s, size: s.bytes.length };
    if (s.bytes.length < 17) return invalid();
    const header = new DataView(s.bytes.buffer, s.bytes.byteOffset, 16);
    const type = header.getUint32(0, true), flags = header.getUint32(4, true), stride = header.getUint32(8, true), size = header.getUint32(12, true);
    if ((type !== 2 && type !== 3) || (type === 2 ? flags > 1 || stride !== (flags === 1 ? 24 : 80) || size % stride !== 0 || size / stride > 1_000_000 : flags < 1 || flags > 2 || stride !== (flags === 1 ? 2 : 4) || size % (stride * 3) !== 0) || size < stride * 3 || size > maxBytes) return invalid();
    return { section: s, size, type, flags, stride: type === 2 ? stride : 4 };
  });
  // Validate aggregate output before any decompression allocation, including alignment and manifest/table overhead.
  const overhead = 64 + container.sections.length * 16 + ((container.sections[0].bytes.length + 3) & ~3);
  if (plans.reduce((n,p)=>n+((p.size+3)&~3),overhead) > maxBytes) throw new RangeError('Expanded .margo exceeds 256 MiB; split the source scene');
  const sections = plans.map(p => {
    signal?.throwIfAborted();
    if (p.type === undefined) return plain(p.section);
    const count = Math.ceil(p.size / p.stride!), decoded = new Uint8Array(count * p.stride!);
    meshoptDecodeVertexBuffer(decoded, count, p.stride!, p.section.bytes.subarray(16));
    return { type: p.type, flags: p.flags!, bytes: decoded.subarray(0,p.size) };
  });
  const doc = { ...manifest }; delete doc._margoMeshopt;
  const bytes = writeMargo(doc, sections, original as number);
  source(bytes); // Revalidate native section types against the restored animated/shapes/static header.
  return bytes;
}

/** Losslessly compress geometry with the existing optional meshopt encoder. Never return a larger file. */
export async function compressMargoMeshopt(input: ArrayBuffer | ArrayBufferView, { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  const raw = expandMargoMeshopt(input, { signal }), container = source(raw);
  // Validate geometry with its existing owning reader, including animated, shape and KTX2 variants.
  if (container.flags === 1) (await import('./anim.js')).margoToGLTF(raw);
  else if (container.flags === 2) (await import('./curves.js')).decodeMargoCurves(raw);
  else (await import('./ktx2.js')).decodeMargoKTX2(raw);
  const doc = container.manifest as Record<string, unknown>;
  if (Object.hasOwn(doc, '_margoMeshopt')) return invalid();
  const { encodeVertexBuffer } = await import('@margoengine/exporters/meshopt');
  let changed = false;
  const sections = container.sections.slice(1).map(s => {
    signal?.throwIfAborted();
    if (s.type !== 2 && s.type !== 3) return plain(s);
    // Indices use a four-byte attribute stream, padded then trimmed, so even provoking-vertex order is exact.
    const stride = s.type === 2 ? s.stride : 4, count = Math.ceil(s.bytes.length / stride);
    const bytes = new Uint8Array(count * stride); bytes.set(s.bytes);
    const encoded = encodeVertexBuffer(bytes, count, stride);
    if (encoded.length + 16 >= s.bytes.length) return plain(s);
    const out = new Uint8Array(encoded.length + 16), header = new DataView(out.buffer);
    [s.type, s.flags, s.stride, s.bytes.length].forEach((v,i)=>header.setUint32(i*4,v,true));out.set(encoded,16);
    changed = true;
    return { type: 9, flags: 0, bytes: out };
  });
  if (!changed) return raw;
  const result = writeMargo({ ...doc, _margoMeshopt: container.flags }, sections, meshoptFlag);
  return result.length < raw.length ? result : raw;
}

/** Decode a static meshopt .margo into the same prepared geometry as decodeMargo. */
export function decodeMargoMeshopt(input: ArrayBuffer | ArrayBufferView, options: MargoOptions = {}): MargoAsset {
  return decodeMargo(expandMargoMeshopt(input), options);
}
/** Options shared by compressed .margo loaders. Supply a parser for animation, shapes, KTX2 or lightmaps. */
export interface MargoMeshoptOptions extends MargoOptions {
  signal?: AbortSignal;
  parse?: (engine: EngineKernel, input: ArrayBuffer | ArrayBufferView, options: MargoOptions & { signal?: AbortSignal }) => Promise<PBRModel>;
  fetch?: typeof fetch;
}
/** Expand bounded geometry then attach through parseMargo (or options.parse). */
export async function parseMargoMeshopt(engine: EngineKernel, input: ArrayBuffer | ArrayBufferView, options: MargoMeshoptOptions = {}): Promise<PBRModel> {
  return (options.parse ?? parseMargo)(engine, expandMargoMeshopt(input, options), options);
}
/** Fetch a compressed .margo with AbortSignal and the existing 256 MiB bound. */
export async function loadMargoMeshopt(engine: EngineKernel, url: string | URL, options: MargoMeshoptOptions = {}): Promise<PBRModel> {
  options.signal?.throwIfAborted();
  const target = new URL(url, globalThis.location?.href);
  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('Meshopt URL must use HTTP(S); read local bytes and call parseMargoMeshopt');
  const bytes = await readResponse(await (options.fetch ?? globalThis.fetch)(target, { signal: options.signal }), { maxBytes, signal: options.signal });
  return parseMargoMeshopt(engine, bytes, options);
}
