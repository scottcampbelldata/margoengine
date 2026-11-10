// Clean-room LZ4 frame/block reader from Yann Collet's public format and xxHash specifications.
import { fault, rangeError } from '../../shared/errors.js';

/** Limits and external dictionary for LZ4 decoding. */
export interface LZ4Options {
  /** Maximum combined decoded bytes, default 268435456 (256 MiB). */
  maxOutputSize?: number;
  /** Cancellation before decoding and between frame blocks. */
  signal?: AbortSignal;
  /** Optional external dictionary; only its final 65536 bytes are retained. */
  dictionary?: Uint8Array;
  /** Expected dictionary identifier, when the frame declares one. Default: accept its identifier. */
  dictionaryId?: number;
}

const invalid = (why: string): Error => fault('failed', `LZ4 ${why}; supply a complete valid LZ4 stream`);
const rot = (v: number, n: number): number => (v << n) | (v >>> (32 - n));
const P1 = 0x9e3779b1,
  P2 = 0x85ebca77,
  P3 = 0xc2b2ae3d,
  P4 = 0x27d4eb2f,
  P5 = 0x165667b1;

function digest(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const round = (v: number, at: number): number => Math.imul(rot(v + Math.imul(view.getUint32(at, true), P2), 13), P1);
  let at = 0,
    sum = P5;
  if (bytes.length >= 16) {
    let a = (P1 + P2) | 0,
      b = P2 | 0,
      c = 0,
      d = -P1;
    while (at + 16 <= bytes.length) {
      a = round(a, at);
      b = round(b, at + 4);
      c = round(c, at + 8);
      d = round(d, at + 12);
      at += 16;
    }
    sum = rot(a, 1) + rot(b, 7) + rot(c, 12) + rot(d, 18);
  }
  sum += bytes.length;
  while (at + 4 <= bytes.length) {
    sum = Math.imul(rot(sum + Math.imul(view.getUint32(at, true), P3), 17), P4);
    at += 4;
  }
  while (at < bytes.length) sum = Math.imul(rot(sum + Math.imul(bytes[at++], P5), 11), P1);
  sum = Math.imul(sum ^ (sum >>> 15), P2);
  sum = Math.imul(sum ^ (sum >>> 13), P3);
  return (sum ^ (sum >>> 16)) >>> 0;
}

function limits(options: LZ4Options): number {
  const max = options.maxOutputSize ?? 2 ** 28;
  if (!Number.isSafeInteger(max) || max < 0 || max > 0x7fffffff)
    throw rangeError('LZ4 maxOutputSize must be an integer from 0 to 2147483647', 'limits');
  if (options.dictionary !== undefined && !(options.dictionary instanceof Uint8Array))
    throw new TypeError('LZ4 dictionary must be a Uint8Array; pass dictionary bytes');
  if (
    options.dictionaryId !== undefined &&
    (!Number.isInteger(options.dictionaryId) || options.dictionaryId < 0 || options.dictionaryId > 0xffffffff)
  )
    throw rangeError('LZ4 dictionaryId must be an unsigned 32-bit integer', 'limits');
  options.signal?.throwIfAborted();
  return max;
}

function unpack(packed: Uint8Array, maximum: number, history: Uint8Array): Uint8Array {
  const output = new Uint8Array(history.length + maximum);
  output.set(history);
  let cursor = 0,
    write = history.length;
  const length = (n: number): number => {
    if (n === 15) {
      let byte: number;
      do {
        if (cursor >= packed.length) throw invalid('length is truncated');
        byte = packed[cursor++];
        n += byte;
        if (n > maximum)
          throw rangeError('LZ4 block exceeds the decoded limit; raise maxOutputSize for trusted data', 'limits');
      } while (byte === 255);
    }
    return n;
  };
  if (!packed.length) throw invalid('block is empty');
  while (cursor < packed.length) {
    const token = packed[cursor++],
      literals = length(token >>> 4);
    if (literals > packed.length - cursor) throw invalid('literal bytes are truncated');
    if (literals > output.length - write)
      throw rangeError('LZ4 literals exceed the decoded limit; raise maxOutputSize for trusted data', 'limits');
    output.set(packed.subarray(cursor, cursor + literals), write);
    cursor += literals;
    write += literals;
    if (cursor === packed.length) return output.slice(history.length, write);
    if (cursor + 2 > packed.length) throw invalid('match offset is truncated');
    const distance = packed[cursor] | (packed[cursor + 1] << 8);
    cursor += 2;
    if (!distance || distance > write) throw invalid('match offset is outside the decoded history');
    const count = length(token & 15) + 4;
    if (count > output.length - write)
      throw rangeError('LZ4 match exceeds the decoded limit; raise maxOutputSize for trusted data', 'limits');
    const stop = write + count;
    while (write < stop) {
      output[write] = output[write - distance];
      write++;
    }
  }
  throw invalid('block is missing its final literal sequence');
}

const empty = new Uint8Array(0);
const dictionaryOf = (options: LZ4Options): Uint8Array => options.dictionary?.slice(-65536) ?? empty;
function join(parts: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}

/**
 * Decodes a bare LZ4 block with its externally supplied decoded byte count.
 * @throws TypeError for non-byte input; RangeError for invalid limits; MargoError `failed` for corrupt data or a size mismatch.
 */
export function decodeLZ4Block(input: Uint8Array, decodedSize: number, options: LZ4Options = {}): Uint8Array {
  const max = limits(options);
  if (!(input instanceof Uint8Array)) throw new TypeError('LZ4 input must be a Uint8Array; pass compressed bytes');
  if (!Number.isSafeInteger(decodedSize) || decodedSize < 0 || decodedSize > max)
    throw rangeError('LZ4 decodedSize exceeds maxOutputSize; pass a valid decoded byte count', 'limits');
  const decoded = unpack(input, decodedSize, dictionaryOf(options));
  if (decoded.length !== decodedSize) throw invalid('decoded size does not match decodedSize');
  return decoded;
}

/**
 * Decodes complete LZ4 streams: concatenated standard/legacy frames, skippable metadata,
 * independent/linked blocks, external dictionaries, and all header/block/content checksums.
 * Returns all decoded bytes. Yields between blocks after 8 MiB or 128 blocks so cancellation can run.
 * @throws TypeError for non-byte input; RangeError for invalid limits or excessive output; MargoError `failed` for corrupt data or a wrong dictionary ID, `unsupported` for a missing dictionary.
 */
export async function decodeLZ4(input: Uint8Array, options: LZ4Options = {}): Promise<Uint8Array> {
  const max = limits(options);
  if (!(input instanceof Uint8Array)) throw new TypeError('LZ4 input must be a Uint8Array; pass compressed bytes');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength),
    parts: Uint8Array[] = [];
  let position = 0,
    total = 0,
    blocks = 0,
    sinceYield = 0;
  const need = (count: number): void => {
    if (count > input.length - position) throw invalid('frame is truncated');
  };
  const word = (): number => {
    need(4);
    const value = view.getUint32(position, true);
    position += 4;
    return value;
  };
  const isMagic = (value: number): boolean =>
    value === 0x184d2204 || value === 0x184c2102 || value >>> 4 === 0x0184d2a5;
  if (!input.length) throw invalid('stream is empty');
  while (position < input.length) {
    options.signal?.throwIfAborted();
    const magic = word();
    if (magic >>> 4 === 0x0184d2a5) {
      const size = word();
      need(size);
      position += size;
      continue;
    }
    const legacy = magic === 0x184c2102;
    if (!legacy && magic !== 0x184d2204) throw invalid('frame magic is invalid');
    const dict = dictionaryOf(options),
      frame: Uint8Array[] = [];
    let history = dict,
      independent = true,
      blockChecksum = false,
      contentChecksum = false,
      declared: number | undefined;
    let blockMax = 8 << 20,
      frameSize = 0;
    if (!legacy) {
      need(3);
      const descriptor = position,
        flags = input[position++],
        bd = input[position++],
        code = (bd >>> 4) & 7;
      if (flags >>> 6 !== 1 || flags & 2 || bd & 0x8f || code < 4 || code > 7)
        throw invalid('frame descriptor is invalid');
      independent = !!(flags & 32);
      blockChecksum = !!(flags & 16);
      contentChecksum = !!(flags & 4);
      blockMax = 2 ** (8 + 2 * code);
      if (flags & 8) {
        need(8);
        const value = view.getBigUint64(position, true);
        position += 8;
        if (value > BigInt(max - total))
          throw rangeError('LZ4 content exceeds maxOutputSize; raise it for trusted data', 'limits');
        declared = Number(value);
      }
      if (flags & 1) {
        const id = word();
        if (!options.dictionary)
          throw fault('unsupported', 'LZ4 frame requires a dictionary; pass dictionary bytes and dictionaryId');
        if (options.dictionaryId !== undefined && options.dictionaryId !== id)
          throw invalid('dictionary identifier does not match dictionaryId');
      }
      need(1);
      if (input[position++] !== ((digest(input.subarray(descriptor, position - 1)) >>> 8) & 255))
        throw invalid('header checksum failed');
    }
    while (position < input.length || !legacy) {
      options.signal?.throwIfAborted();
      if (legacy && input.length - position >= 4 && isMagic(view.getUint32(position, true))) break;
      const header = word();
      if (!header) break;
      const stored = !legacy && !!(header & 0x80000000),
        size = legacy ? header : header & 0x7fffffff;
      if (size > (legacy ? blockMax + Math.floor(blockMax / 255) + 16 : blockMax))
        throw invalid('packed block is larger than the declared block maximum');
      need(size);
      const packed = input.subarray(position, position + size);
      position += size;
      if (blockChecksum && word() !== digest(packed)) throw invalid('block checksum failed');
      const remaining = max - total - frameSize;
      if (stored && size > remaining)
        throw rangeError('LZ4 stored block exceeds maxOutputSize; raise it for trusted data', 'limits');
      const decoded = stored
        ? packed.slice()
        : unpack(packed, Math.min(blockMax, remaining), independent ? dict : history);
      frame.push(decoded);
      frameSize += decoded.length;
      if (!independent)
        history =
          decoded.length >= 65536
            ? decoded.slice(-65536)
            : join(
                [history.slice(Math.max(0, history.length + decoded.length - 65536)), decoded],
                Math.min(65536, history.length + decoded.length),
              );
      sinceYield += decoded.length;
      if (++blocks % 128 === 0 || sinceYield >= 8 << 20) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        sinceYield = 0;
      }
    }
    const bytes = join(frame, frameSize);
    if (declared !== undefined && declared !== frameSize) throw invalid('content size does not match the descriptor');
    if (contentChecksum && word() !== digest(bytes)) throw invalid('content checksum failed');
    parts.push(bytes);
    total += frameSize;
  }
  options.signal?.throwIfAborted();
  return join(parts, total);
}
