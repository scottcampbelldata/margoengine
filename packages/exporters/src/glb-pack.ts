// The GLB-to-GLB passes (Draco, KTX2, meshopt, optimize) edit a split file's JSON and write it back here: new data joins
// the BIN chunk, buffer views nothing reads any more leave it, and every reference to a view is renumbered.
import type { GLBParts } from './glb.js';

/** A glTF JSON object as the passes read it: open-ended, because the file is the caller's. */
// biome-ignore lint/suspicious/noExplicitAny: glTF JSON is open-ended and read defensively field by field
export type JSONObject = Record<string, any>;

/** Data waiting to join the BIN chunk, keyed by the index of the buffer view that will hold it. */
export type NewViews = Map<number, Uint8Array>;

/** Adds a buffer view for `data`, which {@link packGLB} writes into the BIN chunk, and returns its index. */
export function addView(json: JSONObject, views: NewViews, data: Uint8Array, fields: JSONObject = {}): number {
  json.bufferViews ??= [];
  const index = json.bufferViews.length;
  json.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: data.length, ...fields });
  views.set(index, data);
  return index;
}

/** Adds `name` to the file's `extensionsUsed` and, when `required`, to `extensionsRequired`. */
export function useExtension(json: JSONObject, name: string, required: boolean): void {
  json.extensionsUsed ??= [];
  if (!json.extensionsUsed.includes(name)) json.extensionsUsed.push(name);
  if (!required) return;
  json.extensionsRequired ??= [];
  if (!json.extensionsRequired.includes(name)) json.extensionsRequired.push(name);
}

/** Calls `visit` on every object in `value` with a `bufferView` property, whatever object or extension holds it. */
function eachViewReference(value: unknown, visit: (holder: JSONObject) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) eachViewReference(item, visit);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const holder = value as JSONObject;
  if (Number.isSafeInteger(holder.bufferView)) visit(holder);
  for (const key of Object.keys(holder)) eachViewReference(holder[key], visit);
}

const aligned = (n: number): number => (n + 3) & ~3;

/** The file's JSON without the `bufferViews` array, whose entries are what the references point at. */
function withoutViews(json: JSONObject): JSONObject {
  const { bufferViews: _, ...rest } = json;
  return rest;
}

/**
 * Writes the BIN chunk again: every buffer view something still reads, in order, with the data in `views` in place.
 * Views of other buffers stay as they are. A view's meshopt stream, when it lies in buffer 0, moves with it, and `views`
 * holds the stream itself for a view that has one.
 */
export function packGLB(parts: GLBParts, views: NewViews = new Map()): GLBParts {
  const json = parts.json as JSONObject,
    old: JSONObject[] = json.bufferViews ?? [],
    used = new Set<number>();
  eachViewReference(withoutViews(json), (holder) => used.add(holder.bufferView));
  const renumbered = new Map<number, number>(),
    kept: JSONObject[] = [];
  for (let i = 0; i < old.length; i++) {
    if (!used.has(i)) continue;
    renumbered.set(i, kept.length);
    kept.push(old[i]);
  }
  const ranges: { source: Uint8Array; holder: JSONObject }[] = [],
    from = (holder: JSONObject): Uint8Array => {
      const start = holder.byteOffset ?? 0;
      return parts.bin!.subarray(start, start + holder.byteLength);
    };
  for (const [index] of renumbered) {
    const view = old[index],
      fresh = views.get(index),
      meshopt = view.extensions?.EXT_meshopt_compression;
    if (meshopt?.buffer === 0) ranges.push({ source: fresh ?? from(meshopt), holder: meshopt });
    else if (fresh) ranges.push({ source: fresh, holder: view });
    if (!fresh && view.buffer === 0) ranges.push({ source: from(view), holder: view });
  }
  let length = 0;
  for (const { source } of ranges) length = aligned(length) + source.length;
  const bin = new Uint8Array(aligned(length));
  length = 0;
  for (const { source, holder } of ranges) {
    length = aligned(length);
    bin.set(source, length);
    holder.byteOffset = length;
    length += source.length;
  }
  eachViewReference(withoutViews(json), (holder) => {
    holder.bufferView = renumbered.get(holder.bufferView);
  });
  if (kept.length) json.bufferViews = kept;
  else delete json.bufferViews;
  if (json.buffers?.[0]) json.buffers[0].byteLength = length;
  return { json, bin: length ? bin : null, chunks: parts.chunks };
}
