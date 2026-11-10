import { crc32 } from '../../shared/crc32.js';
import { PNG_SIGNATURE } from '../../shared/png.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { FigureProvenance } from './provenance.js';
import { parseXMLDocument, type XMLDocumentTree, type XMLElement } from '../../shared/xml-document.js';
import { markupText } from './markup.js';

const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });
const keyword = 'MargoProvenance';
const namespace = 'urn:margoengine:provenance:1';
/** Bounds for container parsing, metadata inflation and cancellation. */
export interface ProvenanceIOOptions {
  /** Default 256 MiB for the input container and for inflated metadata. */
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}
function bound(options: ProvenanceIOOptions): number {
  const n = options.maxBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(n) || n < 1) throw rangeError('maxBytes must be a positive safe integer', 'sciviz');
  options.signal?.throwIfAborted();
  return n;
}
function chunk(kind: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(data.length + 12),
    view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(encoder.encode(kind), 4);
  result.set(data, 8);
  view.setUint32(data.length + 8, crc32(result.subarray(4, data.length + 8)));
  return result;
}
function chunks(bytes: Uint8Array): { kind: string; bytes: Uint8Array; data: Uint8Array }[] {
  if (bytes.length < 20 || PNG_SIGNATURE.some((n, i) => bytes[i] !== n))
    throw typeError('Expected a PNG signature; supply a PNG file', 'sciviz');
  const out = [],
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8,
    ended = false;
  while (at < bytes.length) {
    if (bytes.length - at < 12) throw typeError('Truncated PNG chunk; supply the complete file', 'sciviz');
    const length = view.getUint32(at),
      end = at + length + 12;
    if (end > bytes.length || length > 0x7fffffff)
      throw typeError('Invalid PNG chunk length; supply a valid PNG', 'sciviz');
    const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (crc32(bytes.subarray(at + 4, end - 4)) !== view.getUint32(end - 4))
      throw fault('failed', 'PNG CRC mismatch; supply an intact PNG', 'sciviz');
    if ((!out.length && (kind !== 'IHDR' || length !== 13)) || ended)
      throw typeError('Invalid PNG chunk order; supply a valid PNG', 'sciviz');
    out.push({ kind, bytes: bytes.subarray(at, end), data: bytes.subarray(at + 8, end - 4) });
    if (kind === 'IEND') {
      if (length !== 0 || !out.some((part) => part.kind === 'IDAT'))
        throw typeError('Invalid PNG end; supply a complete PNG', 'sciviz');
      ended = true;
    }
    at = end;
  }
  if (!ended) throw typeError('PNG is missing IEND; supply the complete file', 'sciviz');
  return out;
}
async function bytesOf(input: Blob | Uint8Array, options: ProvenanceIOOptions): Promise<Uint8Array> {
  const max = bound(options);
  if ((input instanceof Blob ? input.size : input.byteLength) > max)
    throw rangeError('PNG exceeds maxBytes; raise the explicit bound', 'sciviz');
  const result = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input;
  options.signal?.throwIfAborted();
  return result;
}
async function transform(
  bytes: Uint8Array,
  compress: boolean,
  options: ProvenanceIOOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([Uint8Array.from(bytes)])
    .stream()
    .pipeThrough(compress ? new CompressionStream('deflate') : new DecompressionStream('deflate'));
  const reader = stream.getReader(),
    parts = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel(options.signal?.reason);
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      options.signal?.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > bound(options))
        throw rangeError('Provenance exceeds maxBytes; reduce data or raise the explicit bound', 'sciviz');
      parts.push(value);
    }
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    await reader.cancel();
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function ownText(data: Uint8Array): boolean {
  const zero = data.indexOf(0);
  return zero > 0 && decoder.decode(data.subarray(0, zero)) === keyword;
}
/** Add or replace a compressed UTF-8 iTXt record. Every original image chunk remains byte-for-byte intact. */
export async function embedPNGProvenance(
  input: Blob | Uint8Array,
  record: FigureProvenance,
  options: ProvenanceIOOptions = {},
): Promise<Blob> {
  const parts = chunks(await bytesOf(input, options));
  const json = encoder.encode(JSON.stringify(record));
  if (json.length > bound(options))
    throw rangeError('Provenance exceeds maxBytes; reduce the spec or raise the bound', 'sciviz');
  const compressed = await transform(json, true, options),
    header = encoder.encode(keyword + '\0\x01\0\0\0');
  const payload = new Uint8Array(header.length + compressed.length);
  payload.set(header);
  payload.set(compressed, header.length);
  const out: BlobPart[] = [Uint8Array.from(PNG_SIGNATURE)];
  for (const part of parts) {
    if (part.kind === 'iTXt' && ownText(part.data)) continue;
    if (part.kind === 'IEND') out.push(chunk('iTXt', payload));
    out.push(Uint8Array.from(part.bytes));
  }
  return new Blob(out, { type: 'image/png' });
}
/** Read Margo's iTXt record with CRC and inflation bounds; undefined means no record. */
export async function readPNGProvenance(
  input: Blob | Uint8Array,
  options: ProvenanceIOOptions = {},
): Promise<FigureProvenance | undefined> {
  const matches = chunks(await bytesOf(input, options)).filter((part) => part.kind === 'iTXt' && ownText(part.data));
  if (matches.length > 1) throw typeError('Duplicate PNG provenance; supply an unambiguous export', 'sciviz');
  if (!matches.length) return;
  const data = matches[0].data,
    zero = data.indexOf(0),
    flag = data[zero + 1],
    method = data[zero + 2];
  const language = data.indexOf(0, zero + 3),
    translated = data.indexOf(0, language + 1);
  if (language < 0 || translated < 0 || ![0, 1].includes(flag) || (flag === 1 && method !== 0))
    throw typeError('Invalid PNG provenance text; supply a valid iTXt chunk', 'sciviz');
  const text = data.subarray(translated + 1),
    bytes = flag ? await transform(text, false, options) : text;
  if (bytes.length > bound(options))
    throw rangeError('Provenance exceeds maxBytes; raise the explicit bound', 'sciviz');
  return JSON.parse(decoder.decode(bytes)) as FigureProvenance;
}
const svgNamespace = 'http://www.w3.org/2000/svg';
function parseSVG(svg: string): XMLDocumentTree {
  const document = parseXMLDocument(svg, {
    fail: (reason) => {
      throw typeError(`Expected valid SVG XML (${reason}); supply an SVG document`, 'sciviz');
    },
  });
  if (document.documentElement.localName !== 'svg')
    throw typeError('Expected valid SVG XML; supply an SVG document', 'sciviz');
  return document;
}
/** Put a UTF-8 JSON record inside namespaced SVG metadata, replacing only Margo's previous record. */
export function embedSVGProvenance(svg: string, record: FigureProvenance): string {
  const document = parseSVG(svg),
    root = document.documentElement,
    previous = document.getElementsByTagNameNS(namespace, 'provenance');
  // Cut earlier records, and a bare metadata element they leave empty, out of the source text. Everything else stays
  // byte for byte, and no file text is ever parsed as HTML or placed in a live document.
  const cuts = previous
    .map((element) => {
      const parent = element.parentElement!;
      const emptied =
        parent !== root &&
        parent.localName === 'metadata' &&
        !parent.attributes.length &&
        parent.childNodes.every((n) => previous.includes(n as XMLElement));
      return emptied ? parent : element;
    })
    .sort((a, b) => a.start - b.start)
    .filter((element, i, all) => !all.slice(0, i).some((outer) => element.start < outer.end));
  let body = svg;
  for (const element of cuts.reverse()) body = body.slice(0, element.start) + body.slice(element.end);
  const metadata = markupText([
    {
      tag: 'metadata',
      attributes: root.prefix === null && root.namespaceURI === svgNamespace ? undefined : { xmlns: svgNamespace },
      children: [
        {
          tag: 'margo:provenance',
          attributes: { 'xmlns:margo': namespace, type: 'application/json' },
          children: [JSON.stringify(record)],
        },
      ],
    },
  ]);
  const at = root.contentStart;
  if (root.end === at)
    // A self-closing root: open it, add the metadata and close it.
    return `${body.slice(0, body.lastIndexOf('/', at))}>${metadata}</${root.tagName}>${body.slice(at)}`;
  return body.slice(0, at) + metadata + body.slice(at);
}
/** Read only the namespaced Margo metadata; unrelated application metadata is retained. */
export function readSVGProvenance(svg: string): FigureProvenance | undefined {
  const elements = parseSVG(svg).getElementsByTagNameNS(namespace, 'provenance');
  if (elements.length > 1) throw typeError('Duplicate SVG provenance; supply an unambiguous export', 'sciviz');
  return elements.length ? (JSON.parse(elements[0].textContent!) as FigureProvenance) : undefined;
}
