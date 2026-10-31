import { FLIP_MASK, GID_MASK, type PropertyValue, type Properties } from './index.js';

/** What went wrong in an import: bad text, a missing piece, something this importer does not read, a size limit. */
export type MapImportErrorCode = 'syntax' | 'truncated' | 'missing' | 'unsupported' | 'limit' | 'aborted';

/** Thrown by the Tiled and LDtk importers for malformed, truncated, oversized or unsupported input. The message names the fix. */
export class MapImportError extends Error {
  readonly format: string;
  readonly code: MapImportErrorCode;
  constructor(format: string, code: MapImportErrorCode, message: string) {
    super(`${format}: ${message}`);
    this.name = 'MapImportError';
    this.format = format;
    this.code = code;
  }
}

/** Cells per tile layer (4096 x 4096). */
export const MAX_TILES = 1 << 24;

/** A parsed JSON object. */
export type Obj = { readonly [key: string]: unknown };

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const num = (o: Obj, key: string, fallback = 0): number => {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};
export const str = (o: Obj, key: string): string | undefined => (typeof o[key] === 'string' ? (o[key] as string) : undefined);
export const list = (o: Obj, key: string): readonly unknown[] => (Array.isArray(o[key]) ? (o[key] as unknown[]) : []);

/** Keep the id bits and the three flip bits; drop Tiled's hex rotation bit. */
export const cleanGid = (value: number): number => (value & (GID_MASK | FLIP_MASK)) >>> 0;

/** Set an own property by name even when the name is `__proto__`. */
export function setOwn<T>(target: { [key: string]: T }, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Parse JSON text, or pass an object through. */
export function parseJson(format: string, input: unknown): Obj {
  let value = input;
  if (input instanceof Uint8Array) value = new TextDecoder().decode(input);
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new MapImportError(format, 'syntax', 'the text is not valid JSON; pass the file contents as saved by the editor.');
    }
  }
  if (!isObj(value)) throw new MapImportError(format, 'syntax', 'expected a JSON object at the top level.');
  return value;
}

export function throwIfAborted(format: string, signal?: AbortSignal): void {
  if (signal?.aborted) throw new MapImportError(format, 'aborted', 'the import was aborted by its signal.');
}

export type { PropertyValue, Properties };
