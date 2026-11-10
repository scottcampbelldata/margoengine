import { pngParts } from '../../shared/png.js';
import { crc32 } from '../../shared/crc32.js';
import { rangeError, fault } from '../../shared/errors.js';
import type { MediaTile } from './media-tiles.js';
const utf8 = (s: string) => new TextEncoder().encode(s);
const chunk = (name: string, data: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(data.length + 12),
    view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(utf8(name), 4);
  out.set(data, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, -4)));
  return out;
};

/** @internal PNG scanlines are emitted one tile strip at a time, with bounded raw memory. */
export async function tiledPNG(
  tiles: AsyncIterable<MediaTile>,
  width: number,
  height: number,
  dpi: number,
  maxBytes: number,
  provenance?: string,
): Promise<Blob> {
  const rows = async function* () {
    let strip: Uint8Array<ArrayBuffer> | undefined,
      y = 0,
      x = 0,
      stripHeight = 0;
    for await (const tile of tiles) {
      if (tile.y !== y || tile.x !== x)
        throw fault('state', 'Image tiles must cover rows in order without gaps', 'sciviz');
      if (!strip) {
        stripHeight = tile.height;
        const bytes = (width * 4 + 1) * stripHeight;
        if (!Number.isSafeInteger(bytes) || bytes > maxBytes)
          throw rangeError('PNG strip exceeds maxBytes; reduce tileSize', 'sciviz');
        strip = new Uint8Array(bytes);
      }
      if (tile.height !== stripHeight || x + tile.width > width || tile.pixels.length !== tile.width * tile.height * 4)
        throw fault('state', 'Invalid tile dimensions', 'sciviz');
      for (let row = 0; row < tile.height; row++)
        strip.set(
          tile.pixels.subarray(row * tile.width * 4, (row + 1) * tile.width * 4),
          row * (width * 4 + 1) + 1 + x * 4,
        );
      x += tile.width;
      if (x === width) {
        yield strip;
        strip = undefined;
        x = 0;
        y += stripHeight;
      }
    }
    if (x || y !== height) throw fault('state', 'Image tiles did not cover the complete image', 'sciviz');
  };
  const iterator = rows();
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return();
    },
  });
  const compressed: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    for await (const bytes of source.pipeThrough(new CompressionStream('deflate'))) {
      length += bytes.length;
      if (length > maxBytes) throw rangeError('Compressed PNG exceeds maxBytes', 'sciviz');
      compressed.push(bytes);
    }
  } finally {
    await iterator.return();
  }
  const zlib = new Uint8Array(length);
  let offset = 0;
  for (const part of compressed) {
    zlib.set(part, offset);
    offset += part.length;
  }
  const parts = pngParts(width, height, 6, zlib),
    physical = new Uint8Array(9),
    view = new DataView(physical.buffer);
  view.setUint32(0, Math.round(dpi / 0.0254));
  view.setUint32(4, Math.round(dpi / 0.0254));
  physical[8] = 1;
  parts.splice(2, 0, chunk('pHYs', physical));
  if (provenance) parts.splice(3, 0, chunk('iTXt', utf8(`MargoProvenance\0\0\0\0\0${provenance}`)));
  return new Blob(parts, { type: 'image/png' });
}

const riffChunk = (name: string, data: Uint8Array): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(8 + data.length + (data.length % 2));
  bytes.set(utf8(name));
  new DataView(bytes.buffer).setUint32(4, data.length, true);
  bytes.set(data, 8);
  return bytes;
};
/** @internal WebP metadata uses standard EXIF resolution and XMP; existing alpha and codec chunks stay byte-for-byte. */
export async function webpMetadata(
  blob: Blob,
  width: number,
  height: number,
  dpi: number,
  provenance?: string,
): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer()),
    input = new DataView(bytes.buffer);
  if (
    new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF' ||
    new TextDecoder().decode(bytes.subarray(8, 12)) !== 'WEBP'
  )
    throw fault('unsupported', 'This browser cannot encode WebP', 'sciviz');
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let flags = 0;
  for (let p = 12; p + 8 <= bytes.length; ) {
    const name = new TextDecoder().decode(bytes.subarray(p, p + 4)),
      size = input.getUint32(p + 4, true),
      end = p + 8 + size + (size % 2);
    if (end > bytes.length) throw fault('failed', 'Browser returned an incomplete WebP file', 'sciviz');
    if (name === 'VP8X') flags = bytes[p + 8];
    else if (name !== 'EXIF' && name !== 'XMP ') {
      parts.push(bytes.slice(p, end));
      if (name === 'ALPH' || (name === 'VP8L' && bytes[p + 12] & 0x10)) flags |= 0x10;
    }
    p = end;
  }
  const extended = new Uint8Array(10);
  extended[0] = flags | 0x08 | (provenance ? 0x04 : 0);
  for (let i = 0; i < 3; i++) {
    extended[4 + i] = (width - 1) >>> (8 * i);
    extended[7 + i] = (height - 1) >>> (8 * i);
  }
  const tiff = new Uint8Array(66),
    t = new DataView(tiff.buffer);
  tiff.set([73, 73, 42, 0, 8, 0, 0, 0]);
  t.setUint16(8, 3, true);
  for (let i = 0; i < 3; i++) {
    const p = 10 + i * 12;
    t.setUint16(p, [282, 283, 296][i], true);
    t.setUint16(p + 2, i === 2 ? 3 : 5, true);
    t.setUint32(p + 4, 1, true);
    t.setUint32(p + 8, i === 2 ? 2 : 50 + i * 8, true);
  }
  for (const p of [50, 58]) {
    t.setUint32(p, Math.round(dpi * 1000), true);
    t.setUint32(p + 4, 1000, true);
  }
  parts.unshift(riffChunk('VP8X', extended));
  parts.push(riffChunk('EXIF', tiff));
  if (provenance) {
    const escaped = provenance.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    parts.push(
      riffChunk(
        'XMP ',
        utf8(
          `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:margo="https://margoengine.com/provenance/" margo:record="${escaped}"/></rdf:RDF></x:xmpmeta>`,
        ),
      ),
    );
  }
  const header = new Uint8Array(12);
  header.set(utf8('RIFF'));
  header.set(utf8('WEBP'), 8);
  new DataView(header.buffer).setUint32(4, 4 + parts.reduce((n, p) => n + p.length, 0), true);
  return new Blob([header, ...parts], { type: 'image/webp' });
}

/** @internal Classic ZIP with UTF-8 names, stored image entries and an optional JSON sidecar. */
export function mediaZIP(files: readonly { name: string; bytes: Uint8Array<ArrayBuffer> }[]): Blob {
  if (files.length > 65535) throw rangeError('ZIP exceeds 65535 entries', 'sciviz');
  const local: Uint8Array<ArrayBuffer>[] = [],
    central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    const encoded = utf8(name);
    if (encoded.length > 65535 || offset + bytes.length + 30 + encoded.length > 0xffffffff)
      throw rangeError('Image sequence exceeds classic ZIP limits', 'sciviz');
    const header = new Uint8Array(30 + encoded.length),
      view = new DataView(header.buffer),
      crc = crc32(bytes);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x800, true);
    view.setUint16(12, 33, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, bytes.length, true);
    view.setUint32(22, bytes.length, true);
    view.setUint16(26, encoded.length, true);
    header.set(encoded, 30);
    const directory = new Uint8Array(46 + encoded.length),
      d = new DataView(directory.buffer);
    d.setUint32(0, 0x02014b50, true);
    d.setUint16(4, 20, true);
    directory.set(header.subarray(4, 28), 6);
    d.setUint32(42, offset, true);
    directory.set(encoded, 46);
    local.push(header, bytes);
    central.push(directory);
    offset += header.length + bytes.length;
  }
  const length = central.reduce((n, c) => n + c.length, 0);
  if (offset + length + 22 > 0xffffffff) throw rangeError('Image sequence exceeds classic ZIP limits', 'sciviz');
  const end = new Uint8Array(22),
    view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, length, true);
  view.setUint32(16, offset, true);
  return new Blob([...local, ...central, end], { type: 'application/zip' });
}
