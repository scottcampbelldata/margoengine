import { rangeError } from '../../shared/errors.js';
import { decodeLZ4 } from './cloud-codecs.js';

const rotate = (n: number, bits: number) => (n << bits) | (n >>> (32 - bits));
const primes = [0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f, 0x165667b1];
// xxHash32's public arithmetic specification, seeded for LZ4BlockOutputStream.
function checksum(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    seed = 0x9747b28c;
  let at = 0,
    sum: number;
  if (bytes.length >= 16) {
    const lanes = [seed + primes[0] + primes[1], seed + primes[1], seed, seed - primes[0]];
    while (at + 16 <= bytes.length) {
      for (let lane = 0; lane < 4; lane++, at += 4)
        lanes[lane] = Math.imul(rotate(lanes[lane] + Math.imul(view.getUint32(at, true), primes[1]), 13), primes[0]);
    }
    sum = lanes.reduce((n, value, lane) => n + rotate(value, [1, 7, 12, 18][lane]), 0);
  } else sum = seed + primes[4];
  sum += bytes.length;
  while (at + 4 <= bytes.length) {
    sum = Math.imul(rotate(sum + Math.imul(view.getUint32(at, true), primes[2]), 17), primes[3]);
    at += 4;
  }
  while (at < bytes.length) sum = Math.imul(rotate(sum + Math.imul(bytes[at++], primes[4]), 11), primes[0]);
  sum = Math.imul(sum ^ (sum >>> 15), primes[1]);
  sum = Math.imul(sum ^ (sum >>> 13), primes[2]);
  return (sum ^ (sum >>> 16)) & 0xfffffff;
}

/** N5's Java block stream is distinct from numcodecs and standard LZ4 frames. */
export function decodeN5LZ4(input: Uint8Array, max: number): Uint8Array {
  const corrupt = () => rangeError('N5 LZ4 block stream is damaged; check its lengths and checksum', 'sciviz');
  const v = new DataView(input.buffer, input.byteOffset, input.byteLength),
    parts: Uint8Array[] = [];
  let p = 0,
    size = 0;
  while (p + 21 <= input.length) {
    if (new TextDecoder().decode(input.subarray(p, p + 8)) !== 'LZ4Block') throw corrupt();
    const token = input[p + 8],
      encoded = v.getUint32(p + 9, true),
      decoded = v.getUint32(p + 13, true),
      hash = v.getUint32(p + 17, true);
    p += 21;
    if ((token & 0xf0) !== 0x10 && (token & 0xf0) !== 0x20) throw corrupt();
    if (!encoded && !decoded) {
      if (hash || p !== input.length || (token & 0xf0) !== 0x10) throw corrupt();
      const out = new Uint8Array(size);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      return out;
    }
    if (
      !encoded ||
      !decoded ||
      decoded > 2 ** (10 + (token & 15)) ||
      p + encoded > input.length ||
      size + decoded > max
    )
      throw corrupt();
    const payload = input.subarray(p, p + encoded),
      part = (token & 0xf0) === 0x10 ? payload : decodeLZ4(payload, decoded);
    if (part.length !== decoded || checksum(part) !== hash) throw corrupt();
    parts.push(part);
    size += decoded;
    p += encoded;
  }
  throw corrupt();
}
