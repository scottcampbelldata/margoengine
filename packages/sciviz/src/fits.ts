import { decodeBzip2 } from '@margoengine/decoders/bzip2';
import { rangeError } from '../../shared/errors.js';
import { scientificBytes } from './scientific-bytes.js';
import { fitsWCS, type FITSHeader, type FITSWCS } from './fits-wcs.js';
import type { FileInput, FileOptions } from './file-source.js';
import type { ScientificImage } from './scientific-image.js';
export { fitsWCS, type FITSWCS, type FITSHeader } from './fits-wcs.js';
export { imageGrid as fitsGrid, imageVolume as volumeFromFITS } from './scientific-image.js';
export type { ScientificGrid } from './scientific-image.js';

/** FITS physical samples. Unscaled signed 64-bit integers remain exact BigInts. */
export type FITSValues = Float64Array | BigInt64Array;
/** One primary or IMAGE HDU with physical sample values and selectable volume frames. */
export interface FITSImage {
  readonly kind: 'image';
  readonly header: FITSHeader;
  readonly cards: readonly string[];
  readonly axes: readonly number[];
  readonly data: FITSValues;
  readonly wcs: FITSWCS;
  /** Select higher-axis frame, zero based. BigInt conversion is explicit when forming a renderable grid. */
  image(frame?: number): ScientificImage;
}
/** A scalar, string, vector or interleaved complex binary table cell. */
export type FITSCell = number | bigint | boolean | string | null | readonly (number | bigint | boolean | null)[];
/** Binary table columns retain vector/complex/variable-length cells, units, dimensions and nulls. */
export interface FITSColumn {
  readonly name: string;
  readonly format: string;
  readonly unit: string;
  readonly dimensions: readonly number[];
  readonly values: readonly FITSCell[];
}
/** A binary table HDU, with its rows and typed semantic column metadata. */
export interface FITSTable {
  readonly kind: 'table';
  readonly header: FITSHeader;
  readonly cards: readonly string[];
  readonly rows: number;
  readonly columns: readonly FITSColumn[];
}
/** FITS HDUs in on-disk order, including an empty primary HDU. */
export interface FITSFile {
  readonly hdus: readonly (FITSImage | FITSTable)[];
}
/** Bounded loading and world-coordinate selection. */
export interface FITSOptions extends FileOptions {
  /** Alternate WCS letter. Default primary. */
  readonly alternateWCS?: string;
}
const bad = (s: string): never => {
  throw rangeError(`FITS: ${s}; check the FITS 4.0 source file`, 'sciviz');
};
const text = (b: Uint8Array) => new TextDecoder('ascii').decode(b);
const integer = (n: unknown, name: string): number => {
  const v = Number(n);
  if (!Number.isSafeInteger(v) || v < 0) bad(`invalid ${name}`);
  return v;
};

/** Parses all primary and IMAGE/BINTABLE extensions, physical scaling and WCS. No implicit decompression. */
export function parseFITS(bytes: Uint8Array, options: FITSOptions = {}): FITSFile {
  options.signal?.throwIfAborted();
  if (!(bytes instanceof Uint8Array) || bytes.length < 2880 || bytes.length > (options.maxBytes ?? 64 * 1024 * 1024))
    bad('invalid bytes or maxBytes');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    hdus: (FITSImage | FITSTable)[] = [];
  let at = 0;
  const need = (p: number, n: number) => {
    if (!Number.isSafeInteger(p + n) || p < 0 || n < 0 || p + n > bytes.length) bad('truncated data');
  };
  while (at < bytes.length && bytes[at] !== 0 && bytes[at] !== 32) {
    options.signal?.throwIfAborted();
    const header: Record<string, string | number | boolean> = Object.create(null),
      cards: string[] = [];
    let ended = false;
    while (!ended) {
      need(at, 80);
      const card = text(bytes.subarray(at, at + 80)),
        key = card.slice(0, 8).trim();
      at += 80;
      cards.push(card);
      if (key === 'END') {
        ended = true;
        continue;
      }
      // COMMENT, HISTORY and blank keywords are commentary even with '=' in column 9 (FITS 4.0 section 4.4.2.4).
      if (card[8] !== '=' || key === 'COMMENT' || key === 'HISTORY' || key === '') continue;
      const value = card.slice(10).trimStart();
      if (value[0] === "'") {
        let s = '',
          i = 1;
        for (; i < value.length; i++) {
          if (value[i] === "'") {
            if (value[i + 1] === "'") {
              s += "'";
              i++;
            } else break;
          } else s += value[i];
        }
        if (i === value.length) bad('unterminated header string');
        header[key] = s.trimEnd();
      } else {
        const token = value.split('/')[0].trim();
        // A blank value field is an undefined value (FITS 4.0 section 4.2.1): the keyword reads as absent.
        if (token === '') continue;
        // A complex value "(re, im)" keeps its text: no image or table keyword this reader uses is complex.
        if (token[0] === '(') {
          if (!/^\(\s*[^,()]+,\s*[^,()]+\)$/.test(token)) bad(`invalid header ${key}`);
          header[key] = token;
        } else if (token === 'T' || token === 'F') header[key] = token === 'T';
        else {
          const n = Number(token.replace(/[dD]/, 'E'));
          if (!Number.isFinite(n)) bad(`invalid header ${key}`);
          header[key] = n;
        }
      }
    }
    at = Math.ceil(at / 2880) * 2880;
    if (!hdus.length && header.SIMPLE !== true) bad('primary SIMPLE keyword missing');
    const rank = integer(header.NAXIS, 'NAXIS');
    if (rank > 99) bad('axis count exceeds 99');
    const axes = Array.from({ length: rank }, (_, i) => integer(header[`NAXIS${i + 1}`], `NAXIS${i + 1}`)),
      bitpix = Number(header.BITPIX),
      bpp = Math.abs(bitpix) / 8;
    if (![8, 16, 32, 64, -32, -64].includes(bitpix) || axes.length > 99) bad('invalid BITPIX or axis count');
    const count = axes.length ? axes.reduce((a, b) => a * b, 1) : 0,
      groups = integer(header.GCOUNT ?? 1, 'GCOUNT'),
      extra = integer(header.PCOUNT ?? 0, 'PCOUNT'),
      size = bpp * groups * (count + extra),
      start = at;
    need(start, size);
    const read = (p: number, code: string): number | bigint =>
      code === 'B'
        ? view.getUint8(p)
        : code === 'I'
          ? view.getInt16(p)
          : code === 'J'
            ? view.getInt32(p)
            : code === 'K'
              ? view.getBigInt64(p)
              : code === 'E'
                ? view.getFloat32(p)
                : view.getFloat64(p);
    if (header.XTENSION === 'BINTABLE') {
      if (bitpix !== 8 || axes.length !== 2) bad('binary table layout');
      const rows = axes[1],
        rowBytes = axes[0],
        columns: FITSColumn[] = [],
        heap = start + integer(header.THEAP ?? rows * rowBytes, 'THEAP');
      if (heap < start + rows * rowBytes || heap > start + size) bad('heap offset');
      // Zero-width rows take no bytes, so bound the row count as if each row took one: every row becomes cells.
      if (rows > (options.maxBytes ?? 64 * 1024 * 1024)) bad('binary table rows exceed maxBytes');
      let offset = 0;
      for (let f = 1; f <= integer(header.TFIELDS, 'TFIELDS'); f++) {
        const format = String(header[`TFORM${f}`] ?? ''),
          match = /^(\d*)([LXBIJKAEDCMPQ])([LXBIJKAEDCM])?(?:\((\d*)\))?$/.exec(format);
        if (!match) bad(`TFORM ${format}`);
        const repeat = integer(match![1] || 1, 'repeat'),
          code = match![2],
          variable = code === 'P' || code === 'Q',
          element = variable ? match![3] : code;
        if (!element) bad('variable descriptor element missing');
        const sizes: Record<string, number> = {
          L: 1,
          X: 1 / 8,
          B: 1,
          I: 2,
          J: 4,
          K: 8,
          A: 1,
          E: 4,
          D: 8,
          C: 8,
          M: 16,
          P: 8,
          Q: 16,
        };
        const width = Math.ceil(repeat * sizes[code]);
        if (offset + width > rowBytes) bad('table columns exceed row');
        const scale = Number(header[`TSCAL${f}`] ?? 1),
          zero = Number(header[`TZERO${f}`] ?? 0),
          nullValue = header[`TNULL${f}`];
        const decode = (p: number, n: number, c: string): FITSCell => {
          need(p, Math.ceil(n * sizes[c]));
          if (c === 'A')
            return text(bytes.subarray(p, p + n))
              .split('\0')[0]
              .trimEnd();
          const out: (number | bigint | boolean | null)[] = [];
          for (let j = 0; j < n; j++) {
            if (c === 'L') {
              const v = bytes[p + j];
              out.push(v === 84 ? true : v === 70 ? false : null);
            } else if (c === 'X') out.push(Boolean(bytes[p + (j >> 3)] & (128 >> (j & 7))));
            else
              for (let part = 0; part < (c === 'C' || c === 'M' ? 2 : 1); part++) {
                const scalar = c === 'C' ? 'E' : c === 'M' ? 'D' : c,
                  step = sizes[scalar],
                  v = read(p + j * sizes[c] + part * step, scalar);
                out.push(
                  nullValue !== undefined && String(v) === String(nullValue)
                    ? null
                    : typeof v === 'bigint' && scale === 1 && zero === 0
                      ? v
                      : Number(v) * scale + zero,
                );
              }
          }
          return out.length === 1 ? out[0] : out;
        };
        const values: FITSCell[] = [];
        for (let row = 0; row < rows; row++) {
          if (!(row & 4095)) options.signal?.throwIfAborted();
          const p = start + row * rowBytes + offset;
          if (variable) {
            const combined: (number | bigint | boolean | null)[] = [];
            if (repeat !== 1) bad('multiple variable descriptors per cell');
            const n = integer(code === 'P' ? view.getInt32(p) : view.getBigInt64(p), 'heap count'),
              off = integer(code === 'P' ? view.getInt32(p + 4) : view.getBigInt64(p + 8), 'heap offset');
            if (heap + off + Math.ceil(n * sizes[element!]) > start + size) bad('variable array exceeds heap');
            const cell = decode(heap + off, n, element!);
            if (typeof cell === 'string') values.push(cell);
            else {
              if (Array.isArray(cell)) combined.push(...cell);
              else if (cell !== null || n) combined.push(cell as number | bigint | boolean | null);
              values.push(combined);
            }
          } else values.push(decode(p, repeat, code));
        }
        columns.push({
          name: String(header[`TTYPE${f}`] ?? `column${f}`),
          format,
          unit: String(header[`TUNIT${f}`] ?? ''),
          dimensions:
            String(header[`TDIM${f}`] ?? '')
              .match(/\d+/g)
              ?.map(Number) ?? [],
          values,
        });
        offset += width;
      }
      hdus.push({ kind: 'table', header, cards, rows, columns });
    } else if (!header.XTENSION || header.XTENSION === 'IMAGE') {
      if (groups !== 1 || extra !== 0 || header.GROUPS === true) bad('random groups are not an image');
      const scale = Number(header.BSCALE ?? 1),
        zero = Number(header.BZERO ?? 0),
        exact = bitpix === 64 && scale === 1 && zero === 0 && header.BLANK === undefined,
        data = exact ? new BigInt64Array(count) : new Float64Array(count);
      const codes: Record<number, string> = { 8: 'B', 16: 'I', 32: 'J', 64: 'K', [-32]: 'E', [-64]: 'D' };
      for (let i = 0; i < count; i++) {
        if (!(i & 65535)) options.signal?.throwIfAborted();
        const v = read(start + i * bpp, codes[bitpix]);
        if (exact) (data as BigInt64Array)[i] = v as bigint;
        else
          (data as Float64Array)[i] =
            bitpix > 0 && header.BLANK !== undefined && String(v) === String(header.BLANK)
              ? NaN
              : Number(v) * scale + zero;
      }
      const wcs = fitsWCS(header, axes.length, options.alternateWCS);
      hdus.push({
        kind: 'image',
        header,
        cards,
        axes,
        data,
        wcs,
        image(frame = 0) {
          const dims: [number, number, number] = [axes[0] ?? 0, axes[1] ?? 1, axes[2] ?? 1],
            voxels = dims[0] * dims[1] * dims[2],
            frames = axes.slice(3).reduce((a, b) => a * b, 1);
          if (!Number.isInteger(frame) || frame < 0 || frame >= frames) bad('image frame outside higher axes');
          const indices: number[] = [];
          let t = frame;
          for (const n of axes.slice(3)) {
            indices.push(t % n);
            t = Math.floor(t / n);
          }
          const values = Float64Array.from(data.subarray(frame * voxels, (frame + 1) * voxels) as Float64Array, Number);
          return { data: values, dims, world: (p) => wcs.world([...p.slice(0, 3), ...indices]) };
        },
      });
    } else bad(`unsupported extension ${header.XTENSION}`);
    at = start + Math.ceil(size / 2880) * 2880;
  }
  if (!hdus.length) bad('primary SIMPLE keyword missing');
  return { hdus };
}
/** Loads FITS, optionally bzip2 or gzip wrapped, with a bounded decoded size. */
export async function readFITS(input: FileInput, options: FITSOptions = {}): Promise<FITSFile> {
  let bytes = await scientificBytes(input, options);
  const max = options.maxBytes ?? 64 * 1024 * 1024;
  if (bytes[0] === 66 && bytes[1] === 90) bytes = decodeBzip2(bytes, { maxBytes: max });
  return parseFITS(bytes, options);
}
