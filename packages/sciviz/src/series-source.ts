import { fault, rangeError } from '../../shared/errors.js';
import { arrowBatches } from './table-arrow.js';
import { parquetBatches } from './table-parquet.js';
import { readCSV, tableLimits, type CSVOptions } from './table-read.js';
import type { ColumnarTable } from './table.js';

/** Immutable random access bytes. Reads return exactly length bytes or reject. */
export interface SeriesSource {
  readonly size: number;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}
/** Progressive decoding; memory limits apply per encoded/decoded block, not the entire remote file. */
export interface SeriesReadOptions extends CSVOptions {
  /** Default csv. */ readonly format?: 'csv' | 'arrow' | 'parquet';
  /** Network request size, default 1048576 bytes. */ readonly chunkBytes?: number;
}
/** Original rows in source order; offsets never refer to downsampled vertices. */
export interface SeriesChunk {
  readonly table: ColumnarTable;
  readonly rowOffset: number;
  readonly loadedBytes: number;
  readonly totalBytes: number;
}
const fail = (why: string): never => { throw fault('failed', `Series Range read ${why}; use an immutable source supporting HTTP byte ranges`, 'sciviz'); };
/** Open HTTP/S3-style signed URLs without downloading the file. Strong ETag (or Last-Modified) pins subsequent reads. */
export async function openSeriesSource(url: string | URL, options: { readonly signal?: AbortSignal; readonly headers?: HeadersInit } = {}): Promise<SeriesSource> {
  let total: number | undefined, validator: string | undefined;
  const read = async (offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> => {
    signal?.throwIfAborted(); options.signal?.throwIfAborted();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || (total !== undefined && offset + length > total)) throw rangeError('Keep series reads within the source byte bounds', 'sciviz');
    if (!length) return new Uint8Array();
    const headers = new Headers(options.headers); headers.set('Range', `bytes=${offset}-${offset + length - 1}`);
    if (validator) headers.set('If-Range', validator);
    const combined = options.signal && signal ? AbortSignal.any([options.signal, signal]) : signal ?? options.signal;
    const response = await fetch(url, { headers, signal: combined });
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    const expectedLength = total === undefined && match ? Math.min(length, Number(match[3])) : length;
    const etag = response.headers.get('etag'), current = etag && !etag.startsWith('W/') ? etag : response.headers.get('last-modified') ?? undefined;
    if (response.status !== 206 || !match || Number(match[1]) !== offset || Number(match[2]) !== offset + expectedLength - 1 || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) < offset + expectedLength || expectedLength < 1 || (total !== undefined && total !== Number(match[3])) || (validator !== undefined && current !== validator) || (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity')) {
      await response.body?.cancel(); fail('returned mismatched bounds, encoding, version or status');
    }
    total = Number(match![3]); validator = current;
    const reader = response.body?.getReader(); if (!reader) fail('has no body');
    const bytes = new Uint8Array(expectedLength); let at = 0;
    try {
      for (;;) { combined?.throwIfAborted(); const { value, done } = await reader!.read(); if (done) break; if (at + value.length > expectedLength) fail('exceeded its declared length'); bytes.set(value, at); at += value.length; }
    } finally { await reader!.cancel(); reader!.releaseLock(); }
    if (at !== expectedLength) fail('ended before its declared length');
    return bytes;
  };
  await read(0, 2, options.signal);
  return { size: total!, read };
}

/** Yield complete CSV records, Arrow record batches or Parquet row groups as soon as decoded. Cancellation/early return stops further requests. */
export async function* readSeries(source: SeriesSource, options: SeriesReadOptions = {}): AsyncGenerator<SeriesChunk> {
  const chunkBytes = options.chunkBytes ?? 1048576;
  if (!Number.isSafeInteger(source.size) || source.size < 0 || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw rangeError('Use a safe source size and positive integer chunkBytes', 'sciviz');
  tableLimits(options, 0);
  let loadedBytes = 0, rowOffset = 0;
  const read = async (at: number, length: number) => {
    options.signal?.throwIfAborted(); tableLimits(options, length);
    if (at < 0 || length < 0 || at + length > source.size) fail('exceeds source bounds');
    const bytes = new Uint8Array(length);
    for (let k = 0; k < length; k += chunkBytes) {
      options.signal?.throwIfAborted(); const count = Math.min(chunkBytes, length - k), part = await source.read(at + k, count, options.signal);
      if (part.length !== count) fail('returned a truncated block'); bytes.set(part, k); loadedBytes += count;
    }
    return bytes;
  };
  async function* csv(): AsyncGenerator<ColumnarTable> {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let record = '', header: string | undefined, quoted = false, skipLF = false, pending: string[] = [];
    const consume = (text: string) => {
      for (const ch of text) {
        if (skipLF) { skipLF = false; if (ch === '\n') continue; }
        if (ch === '"') quoted = !quoted;
        if (!quoted && (ch === '\r' || ch === '\n')) {
          if (header === undefined) header = record; else pending.push(record);
          record = ''; skipLF = ch === '\r';
        } else record += ch;
      }
      tableLimits(options, new TextEncoder().encode(record).length);
    };
    for (let at = 0; at < source.size; at += chunkBytes) {
      consume(decoder.decode(await read(at, Math.min(chunkBytes, source.size - at)), { stream: true }));
      if (pending.length) { const rows = pending; pending = []; yield readCSV(header + '\n' + rows.join('\n') + '\n', options); }
    }
    consume(decoder.decode());
    if (quoted) fail('contains an unterminated CSV record');
    if (record) { if (header === undefined) header = record; else pending.push(record); }
    if (pending.length || rowOffset === 0) yield readCSV((header ?? '') + '\n' + pending.join('\n') + (pending.length ? '\n' : ''), options);
  }
  const batches = options.format === 'parquet' ? parquetBatches(read, source.size, options) : options.format === 'arrow' ? arrowBatches(read, source.size, options) : csv();
  for await (const table of batches) {
    options.signal?.throwIfAborted(); tableLimits(options, 0, rowOffset + table.length);
    yield { table, rowOffset, loadedBytes, totalBytes: source.size }; rowOffset += table.length;
  }
}
