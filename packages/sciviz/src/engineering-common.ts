import { rangeError } from '../../shared/errors.js';
import { byteLimit, fileSource, readBytes, type FileInput, type FileOptions } from './file-source.js';
import type { DataSetCell, DataSetOptions } from './datasets.js';
import type { ElementShape } from './datasets-elements.js';

export function engineeringError(message: string): never {
  throw rangeError(`Engineering reader: ${message}; check the source file and options`, 'sciviz');
}
/** Shared bounded loading, companion-resource resolution and dataset normalization options. */
export interface EngineeringOptions extends Omit<FileOptions, 'signal'>, DataSetOptions {
  /** Exact relative resource names for in-memory cases, or an asynchronous resource resolver. */
  readonly files?: Readonly<Record<string, FileInput>>;
  readonly resolve?: (name: string, signal?: AbortSignal) => Promise<FileInput>;
  readonly baseURL?: string | URL;
  /** Preferred scalar array. Default: first one-component point or cell array. */
  readonly scalar?: string;
}
export async function resource(name: string, input: FileInput, options: EngineeringOptions): Promise<FileInput> {
  options.signal?.throwIfAborted();
  if (options.files && Object.hasOwn(options.files, name)) return options.files[name];
  if (options.resolve) return options.resolve(name, options.signal);
  const base = options.baseURL ?? (typeof input === 'string' || input instanceof URL ? input : undefined);
  if (!base) engineeringError(`resource ${name} needs files, resolve or baseURL`);
  return new URL(name, base);
}
export async function whole(input: FileInput, options: FileOptions): Promise<Uint8Array> {
  const max = byteLimit(options.maxBytes);
  return readBytes(fileSource(input, max), 0, max, max, options.signal);
}
export const decodeText = (b: Uint8Array) => new TextDecoder().decode(b);
export function numbers(s: string): number[] {
  if (!s.trim()) return [];
  return s
    .trim()
    .split(/\s+/)
    .map((t) => {
      const n = Number(t.replace(/[dD]/, 'e'));
      if (!Number.isFinite(n)) engineeringError(`invalid number ${t}`);
      return n;
    });
}
export function scalar(
  arrays: Readonly<Record<string, ArrayLike<number>>>,
  tuples: number,
  name?: string,
): ArrayLike<number> | undefined {
  if (name) {
    const a = arrays[name];
    if (a?.length === tuples) return a;
    return undefined;
  }
  return Object.values(arrays).find((a) => a.length === tuples);
}
/** Linear and serendipity cells use the published common corner/edge conventions. */
export function element(shape: ElementShape | 'point' | 'polygon', ids: readonly number[]): DataSetCell {
  const linear: Record<string, [number, number]> = {
    point: [1, 1],
    curve: [3, 2],
    triangle: [5, 3],
    quad: [9, 4],
    tetra: [10, 4],
    pyramid: [14, 5],
    wedge: [13, 6],
    hex: [12, 8],
    polygon: [7, ids.length],
  };
  if (ids.length === linear[shape][1]) return { type: linear[shape][0], ids };
  const quadratic: Record<string, number> = {
    curve: 3,
    triangle: 6,
    quad: 8,
    tetra: 10,
    pyramid: 13,
    wedge: 15,
    hex: 20,
  };
  if (ids.length === quadratic[shape]) return { type: 'quadratic', shape: shape as ElementShape, ids };
  const complete: Record<string, number> = { quad: 9, wedge: 18, hex: 27 };
  if (ids.length === complete[shape]) return { type: 'lagrange', shape: shape as ElementShape, order: 2, ids };
  return engineeringError(`unsupported ${shape} node count ${ids.length}`);
}
