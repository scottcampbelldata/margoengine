// WOFF and WOFF2 web fonts to the OpenType (sfnt) bytes `parseTTF` reads. Clean room from W3C "WOFF File Format 1.0"
// (J. Kew, T. Leming, E. van Blokland, Recommendation, 13 December 2012, https://www.w3.org/TR/WOFF/), W3C "WOFF File
// Format 2.0" (V. Levantovsky, ed., Recommendation, 8 August 2024, https://www.w3.org/TR/WOFF2/) and the Microsoft
// OpenType specification's font file layout (https://learn.microsoft.com/en-us/typography/opentype/spec/otff). WOFF
// tables are zlib streams (RFC 1950); WOFF2 holds one Brotli stream (RFC 7932).
import { decodeBrotli } from '@margoengine/decoders/brotli';
import { inflateZlib } from '../../shared/inflate.js';
import { parseOpenType } from './font-opentype.js';
import type { OutlineFont } from './outline-font.js';
import { BinaryReader } from './sfnt-reader.js';
import type { TTFParseOptions } from './ttf.js';
import { toBytes, type BinaryInput } from './util.js';
import { read255, rebuildGlyf, rebuildHmtx, woffError } from './woff-glyf.js';

/** Options of `decodeWOFF`. */
export interface WOFFOptions {
  /** Most bytes the tables may decompress to, and the rebuilt font may hold. Default 268435456 (256 MiB). */
  maxBytes?: number;
}

/** WOFF2 section 4.1, "Known Table Tags", in index order (four characters each). */
const KNOWN_TAGS =
  'cmapheadhheahmtxmaxpnameOS/2postcvt fpgmglyflocaprepCFF VORGEBDTEBLCgasphdmxkernLTSHPCLTVDMXvheavmtxBASEGDEFGPOSGSUBEBSCJSTFMATHCBDTCBLCCOLRCPALSVG sbixacntavarbdatblocbslncvarfdscfeatfmtxfvargvarhstyjustlcarmortmorxopbdproptrakZapfSilfGlatGlocFeatSill';
/** Tables one file, and table references all fonts of a collection, may list. */
const MAX_TABLES = 4096;
const MAX_REFERENCES = 65536;
const TTCF = 0x74746366;

interface Table {
  tag: string;
  data: Uint8Array;
}
interface Face {
  flavor: number;
  tables: Table[];
}

const pad = (length: number): number => Math.ceil(length / 4) * 4;

/** Sum of the big-endian 32-bit words of `bytes`, zero padded (OpenType table checksums). */
function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i] * (1 << (8 * (3 - (i & 3))))) >>> 0;
  return sum;
}

/** Writes one font, or a `ttcf` collection, with table checksums; a table object shared by fonts is stored once. */
function writeSfnt(faces: Face[], collection: boolean, limit: number): Uint8Array {
  let size = collection ? 12 + faces.length * 4 : 0;
  const directories = faces.map((face) => {
    const at = size;
    size += 12 + face.tables.length * 16;
    return at;
  });
  const placed = new Map<Table, number>();
  for (const face of faces)
    for (const table of face.tables)
      if (!placed.has(table)) {
        placed.set(table, size);
        size += pad(table.data.length);
      }
  if (size > limit) woffError(`the decoded font is ${size} bytes, past maxBytes (${limit})`, 'limit');
  const out = new Uint8Array(size),
    view = new DataView(out.buffer),
    sums = new Map<Table, number>();
  for (const [table, offset] of placed) {
    out.set(table.data, offset);
    // 'head' is summed, and stored, with checkSumAdjustment 0.
    if (table.tag === 'head' && table.data.length >= 12) view.setUint32(offset + 8, 0);
    sums.set(table, checksum(out.subarray(offset, offset + table.data.length)));
  }
  if (collection) {
    view.setUint32(0, TTCF);
    view.setUint32(4, 0x00010000);
    view.setUint32(8, faces.length);
  }
  faces.forEach((face, f) => {
    const at = directories[f],
      count = face.tables.length,
      power = 31 - Math.clz32(count);
    if (collection) view.setUint32(12 + f * 4, at);
    view.setUint32(at, face.flavor);
    view.setUint16(at + 4, count);
    view.setUint16(at + 6, 16 << power);
    view.setUint16(at + 8, power);
    view.setUint16(at + 10, count * 16 - (16 << power));
    [...face.tables]
      .sort((a, b) => (a.tag < b.tag ? -1 : 1))
      .forEach((table, i) => {
        const record = at + 12 + i * 16;
        for (let c = 0; c < 4; c++) out[record + c] = table.tag.charCodeAt(c);
        view.setUint32(record + 4, sums.get(table)!);
        view.setUint32(record + 8, placed.get(table)!);
        view.setUint32(record + 12, table.data.length);
      });
  });
  if (!collection) {
    const head = faces[0].tables.find((table) => table.tag === 'head');
    if (head && head.data.length >= 12) view.setUint32(placed.get(head)! + 8, (0xb1b0afba - checksum(out)) >>> 0);
  }
  return out;
}

function decodeVersion1(r: BinaryReader, limit: number): Uint8Array {
  const flavor = r.u32(),
    length = r.u32(),
    count = r.u16();
  r.u16();
  const total = r.u32();
  if (length !== r.length) woffError(`the header gives ${length} bytes but the file holds ${r.length}`, 'truncated');
  if (count < 1 || count > MAX_TABLES) woffError(`the font lists ${count} tables (1 to ${MAX_TABLES})`, 'limit');
  r.seek(44);
  const entries = Array.from({ length: count }, () => ({
    tag: r.tag(),
    offset: r.u32(),
    packed: r.u32(),
    size: r.u32(),
    sum: r.u32(),
  }));
  let size = 12 + count * 16;
  for (const entry of entries) size += pad(entry.size);
  if (size > limit) woffError(`the tables need ${size} bytes, past maxBytes (${limit})`, 'limit');
  if (size !== total) woffError(`totalSfntSize is ${total} but the tables need ${size} bytes`);
  const tags = new Set<string>();
  const tables = entries.map(({ tag, offset, packed, size }): Table => {
    if (tags.has(tag)) woffError(`table '${tag}' is listed twice`);
    tags.add(tag);
    if (packed > size) woffError(`table '${tag}' is larger compressed than decompressed`, 'range');
    const stored = r.slice(offset, packed).bytes;
    if (packed === size) return { tag, data: stored };
    try {
      return { tag, data: inflateZlib(stored, size) };
    } catch (error) {
      return woffError(`table '${tag}' does not inflate to its ${size} bytes`, 'header', error);
    }
  });
  return writeSfnt([{ flavor, tables }], false, limit);
}

/** UIntBase128: base-128 big endian, at most five bytes and 32 bits, without leading zeros. */
function base128(r: BinaryReader): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = r.u8();
    if (i === 0 && byte === 0x80) break;
    value = value * 128 + (byte & 127);
    if (value > 0xffffffff) break;
    if (!(byte & 128)) return value;
  }
  return woffError('a UIntBase128 length is malformed');
}

function decodeVersion2(r: BinaryReader, limit: number): Uint8Array {
  const flavor = r.u32(),
    length = r.u32(),
    count = r.u16();
  r.u16();
  r.u32();
  const compressed = r.u32();
  if (length !== r.length) woffError(`the header gives ${length} bytes but the file holds ${r.length}`, 'truncated');
  if (count < 1 || count > MAX_TABLES) woffError(`the font lists ${count} tables (1 to ${MAX_TABLES})`, 'limit');
  r.seek(48);
  let total = 0;
  const entries = Array.from({ length: count }, () => {
    const flags = r.u8(),
      known = flags & 63,
      tag = known === 63 ? r.tag() : KNOWN_TAGS.slice(known * 4, known * 4 + 4),
      version = flags >> 6,
      outline = tag === 'glyf' || tag === 'loca',
      transformed = version !== (outline ? 3 : 0),
      original = base128(r);
    if (transformed && !(outline ? version === 0 : tag === 'hmtx' && version === 1))
      woffError(`table '${tag}' uses transform version ${version}, which WOFF2 does not define`, 'unsupported');
    const size = transformed ? base128(r) : original;
    if (tag === 'loca' && transformed && size !== 0) woffError("the transformed 'loca' table is not empty");
    total += size;
    if (total > limit) woffError(`the tables decompress past maxBytes (${limit})`, 'limit');
    return { tag, transformed, size };
  });
  const collection = flavor === TTCF,
    faces: { flavor: number; indices: number[] }[] = [];
  if (collection) {
    r.u32();
    const fonts = read255(r);
    let references = 0;
    if (!fonts) woffError('the collection holds no font');
    for (let f = 0; f < fonts; f++) {
      const tables = read255(r),
        face = r.u32();
      references += tables;
      if (!tables || references > MAX_REFERENCES)
        woffError(`the collection lists no table, or more than ${MAX_REFERENCES} table references`, 'limit');
      const indices = Array.from({ length: tables }, () => read255(r));
      if (indices.some((i) => i >= count)) woffError('a collection font refers to a missing table', 'range');
      faces.push({ flavor: face, indices });
    }
  } else faces.push({ flavor, indices: entries.map((_, i) => i) });
  const packed = r.slice(r.pos, compressed).bytes;
  let stream: Uint8Array;
  try {
    stream = decodeBrotli(packed, { maxBytes: total });
  } catch (error) {
    return woffError('the Brotli table data does not decompress to its declared size', 'header', error);
  }
  if (stream.length !== total) woffError(`the table data is ${stream.length} bytes, not the declared ${total}`);
  let at = 0;
  const raw = entries.map((entry) => ({ ...entry, data: stream.subarray(at, (at += entry.size)) }));
  const done = new Map<number, Table>(),
    outlines = new Map<number, { loca: number; format: number }>(),
    heads = new Map<string, Table>();
  // Rebuilt tables count against the limit as they are made: many small transforms may each grow large.
  let rebuilt = 0;
  const spend = (bytes: number) => {
    if ((rebuilt += bytes) > limit) woffError(`the rebuilt tables pass maxBytes (${limit})`, 'limit');
  };
  const table = (i: number): Table => {
    let t = done.get(i);
    if (!t) done.set(i, (t = { tag: raw[i].tag, data: raw[i].data }));
    return t;
  };
  const built = faces.map((face): Face => {
    const byTag = new Map<string, number>();
    for (const i of face.indices) {
      if (byTag.has(raw[i].tag)) woffError(`table '${raw[i].tag}' is listed twice`);
      byTag.set(raw[i].tag, i);
    }
    const glyf = byTag.get('glyf'),
      loca = byTag.get('loca');
    let format: number | undefined;
    if ((glyf !== undefined && raw[glyf].transformed) || (loca !== undefined && raw[loca].transformed)) {
      if (glyf === undefined || loca === undefined || !raw[glyf].transformed || !raw[loca].transformed)
        woffError("'glyf' and 'loca' must be transformed together");
      let pair = outlines.get(glyf);
      if (!pair) {
        const result = rebuildGlyf(raw[glyf].data, limit - rebuilt);
        spend(result.glyf.length + result.loca.length);
        done.set(glyf, { tag: 'glyf', data: result.glyf });
        done.set(loca, { tag: 'loca', data: result.loca });
        outlines.set(glyf, (pair = { loca, format: result.format }));
      }
      if (pair.loca !== loca) woffError("one 'glyf' table is paired with two 'loca' tables");
      format = pair.format;
    }
    const tables = face.indices.map((i): Table => {
      const { tag, transformed } = raw[i];
      if (tag === 'hmtx' && transformed && !done.has(i)) {
        const hhea = byTag.get('hhea'),
          maxp = byTag.get('maxp'),
          head = byTag.get('head');
        if (hhea === undefined || maxp === undefined || head === undefined || glyf === undefined || loca === undefined)
          woffError("a transformed 'hmtx' needs 'head', 'hhea', 'maxp', 'glyf' and 'loca'");
        const metrics = new BinaryReader(raw[hhea].data),
          glyphs = new BinaryReader(raw[maxp].data),
          header = new BinaryReader(raw[head].data);
        metrics.seek(34);
        glyphs.seek(4);
        header.seek(50);
        const data = rebuildHmtx(
            raw[i].data,
            metrics.u16(),
            glyphs.u16(),
            table(glyf).data,
            table(loca).data,
            format ?? header.u16(),
          );
        spend(data.length);
        done.set(i, { tag, data });
      }
      // 'head' records which 'loca' format the font uses; the rebuild may have had to widen it.
      if (tag === 'head' && format !== undefined) {
        const key = `${i}|${format}`;
        let head = heads.get(key);
        if (!head) {
          if (raw[i].data.length < 54) woffError("the 'head' table is shorter than 54 bytes", 'truncated');
          const data = raw[i].data.slice();
          data[50] = 0;
          data[51] = format;
          heads.set(key, (head = { tag, data }));
        }
        return head;
      }
      return table(i);
    });
    return { flavor: face.flavor, tables };
  });
  return writeSfnt(built, collection, limit);
}

/**
 * Decodes a WOFF or WOFF2 web font (`.woff`, `.woff2`) to the OpenType bytes it holds (a `.ttf`, `.otf` or, for a
 * WOFF2 collection, `.ttc`), ready for `parseTTF`, `parseOpenType` or any other font reader. Synchronous.
 * ```ts
 * const sfnt = decodeWOFF(await (await fetch('/fonts/Inter.woff2')).arrayBuffer());
 * ```
 * @throws LoaderError `'header'` for another or a damaged file, `'truncated'`, `'range'`, `'unsupported'` for an
 * unknown WOFF2 transform, and `'limit'` past `maxBytes`.
 */
export function decodeWOFF(input: BinaryInput, options: WOFFOptions = {}): Uint8Array {
  const limit = options.maxBytes ?? 2 ** 28;
  if (!(limit > 0)) woffError(`maxBytes is ${limit}; give a positive number of bytes`, 'range');
  const r = new BinaryReader(toBytes(input, 'WOFF'));
  const signature = r.length >= 48 ? r.u32() : 0;
  if (signature === 0x774f4646) return decodeVersion1(r, limit);
  if (signature === 0x774f4632) return decodeVersion2(r, limit);
  return woffError("not a web font (the file does not start with 'wOFF' or 'wOF2'); read .ttf and .otf with parseTTF");
}

/**
 * Parses a WOFF or WOFF2 font into an `OutlineFont`: `decodeWOFF`, then `parseOpenType` (TrueType, CFF and CFF2
 * outlines, variable instances and `.ttc` fonts by `fontIndex`).
 */
export function parseWOFF(input: BinaryInput, options: TTFParseOptions & WOFFOptions = {}): OutlineFont {
  return parseOpenType(decodeWOFF(input, options), options);
}
