// The glTF container shared by the scene writer (gltf.ts) and the model writer (model.ts): one binary buffer of
// 4-byte-aligned bufferViews, accessors with exact Float32 bounds, and GLB / .gltf packaging. No engine imports.

export interface GLTFJsonResult {
  /** The glTF document object. */
  json: Record<string, unknown>;
  /** The document as JSON text, ready to save as `.gltf`. */
  text: string;
  /** The separate buffer when `embed` is false and there is binary data, else null. */
  bin: Uint8Array | null;
  /** The URI the document uses for `bin`, else null. */
  binUri: string | null;
}

export const FLOAT = 5126,
  ARRAY_BUFFER = 34962,
  ELEMENT_ARRAY_BUFFER = 34963;
// No prototype: accessor types come from the source file ("constructor" must not resolve to a function).
const widths: Record<string, number> = Object.assign(Object.create(null), {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
});
const arrays: Record<
  number,
  {
    new (n: number): Uint8Array | Uint16Array | Uint32Array | Float32Array;
    from(values: ArrayLike<number>): Uint8Array | Uint16Array | Uint32Array | Float32Array;
  }
> = Object.assign(Object.create(null), { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array });
// Stable key order: asset first, buffers last.
const order = [
  'asset',
  'extensionsUsed',
  'extensionsRequired',
  'scene',
  'scenes',
  'nodes',
  'meshes',
  'skins',
  'animations',
  'materials',
  'textures',
  'images',
  'samplers',
  'accessors',
  'bufferViews',
  'buffers',
];

/** @internal A glTF document under construction and its binary buffer. */
export class Bin {
  readonly parts: Uint8Array[] = [];
  length = 0;
  readonly json: Record<string, any> = {};

  list(key: string, value: unknown): number {
    (this.json[key] ??= []).push(value);
    return this.json[key].length - 1;
  }

  /** Appends bytes on a 4-byte boundary and returns a bufferView index. */
  view(bytes: Uint8Array, target?: number): number {
    const byteOffset = this.length;
    this.parts.push(bytes);
    this.length += bytes.length;
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const view: Record<string, number> = { buffer: 0, byteOffset, byteLength: bytes.length };
    if (target) view.target = target;
    return this.list('bufferViews', view);
  }

  /** Writes `values` (converted to `componentType` when not already that array type) as a tightly packed accessor; `bounds` adds exact min/max. */
  accessor(values: ArrayLike<number>, type: string, componentType = FLOAT, target?: number, bounds = false): number {
    const Type = arrays[componentType],
      size = widths[type];
    const data = values instanceof Type ? values : Type.from(values as ArrayLike<number>);
    const accessor: Record<string, unknown> = {
      bufferView: this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(), target),
      componentType,
      count: data.length / size,
      type,
    };
    if (bounds) {
      const min = new Array(size).fill(Infinity),
        max = new Array(size).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {
        const c = i % size;
        if (data[i] < min[c]) min[c] = data[i];
        if (data[i] > max[c]) max[c] = data[i];
      }
      accessor.min = min.map((v) => (v === 0 ? 0 : v));
      accessor.max = max.map((v) => (v === 0 ? 0 : v));
    }
    return this.list('accessors', accessor);
  }

  /** Puts the top-level keys in a stable order and records the buffer length. */
  finish(): void {
    if (this.length) this.json.buffers = [{ byteLength: this.length }];
    const sorted: Record<string, any> = {};
    for (const key of order) if (this.json[key] !== undefined) sorted[key] = this.json[key];
    for (const key of Object.keys(this.json)) delete this.json[key];
    Object.assign(this.json, sorted);
  }

  /** Binary glTF: 12-byte header, a space-padded JSON chunk and a zero-padded BIN chunk. */
  glb(): Uint8Array {
    const text = new TextEncoder().encode(JSON.stringify(this.json)),
      jsonLength = Math.ceil(text.length / 4) * 4;
    const binLength = this.length,
      total = 12 + 8 + jsonLength + (binLength ? 8 + binLength : 0);
    const out = new Uint8Array(total),
      view = new DataView(out.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, 0x4e4f534a, true);
    out.set(text, 20);
    out.fill(0x20, 20 + text.length, 20 + jsonLength);
    if (binLength) {
      const at = 20 + jsonLength;
      view.setUint32(at, binLength, true);
      view.setUint32(at + 4, 0x004e4942, true);
      let offset = at + 8;
      for (const part of this.parts) {
        out.set(part, offset);
        offset += part.length;
      }
    }
    return out;
  }

  /** `.gltf` JSON with the buffer as a base64 data URI (`embed`) or returned as a separate file named `binUri`. */
  gltf(embed = true, binUri = 'scene.bin'): GLTFJsonResult {
    if (typeof embed !== 'boolean') throw new TypeError('embed must be boolean');
    if (typeof binUri !== 'string' || !binUri || /^[a-z][a-z0-9+.-]*:/i.test(binUri) || /[#?\\]/.test(binUri))
      throw new TypeError('binUri must be a relative file name');
    const json = this.json;
    let bin: Uint8Array | null = null,
      uri: string | null = null;
    if (this.length) {
      const data = new Uint8Array(this.length);
      let offset = 0;
      for (const part of this.parts) {
        data.set(part, offset);
        offset += part.length;
      }
      if (embed) json.buffers[0].uri = `data:application/octet-stream;base64,${base64(data)}`;
      else {
        bin = data;
        uri = encodeURI(binUri);
        json.buffers[0].uri = uri;
      }
    }
    return { json, text: JSON.stringify(json), bin, binUri: uri };
  }
}

const alphabet = Uint8Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', (c) =>
  c.charCodeAt(0),
);
/** @internal Base64 without btoa or Buffer, so it runs anywhere. Encodes to ASCII bytes, then decodes them in 1 MiB pieces. */
export function base64(bytes: Uint8Array): string {
  const length = bytes.length,
    whole = length - (length % 3),
    codes = new Uint8Array(Math.ceil(length / 3) * 4),
    decoder = new TextDecoder(),
    out: string[] = [];
  let i = 0,
    o = 0;
  for (; i < whole; i += 3, o += 4) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    codes[o] = alphabet[n >> 18];
    codes[o + 1] = alphabet[(n >> 12) & 63];
    codes[o + 2] = alphabet[(n >> 6) & 63];
    codes[o + 3] = alphabet[n & 63];
  }
  if (i < length) {
    const pair = i + 1 < length,
      n = (bytes[i] << 16) | (pair ? bytes[i + 1] << 8 : 0);
    codes[o] = alphabet[n >> 18];
    codes[o + 1] = alphabet[(n >> 12) & 63];
    codes[o + 2] = pair ? alphabet[(n >> 6) & 63] : 61;
    codes[o + 3] = 61;
  }
  for (let at = 0; at < codes.length; at += 1 << 20) out.push(decoder.decode(codes.subarray(at, at + (1 << 20))));
  return out.join('');
}
