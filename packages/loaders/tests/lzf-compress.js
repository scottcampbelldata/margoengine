// Test-side LZF encoder, written from the format description (control byte below 32: literal run of C + 1 bytes;
// otherwise a back reference with a 3-bit length field, an optional extra length byte when the field is 7, and a
// 13-bit distance stored minus one). It exists so the PCD tests can write `binary_compressed` bodies; it is not
// shipped. Matches are found with hash chains: every position is filed under a hash of its next three bytes, and
// each chain is walked a bounded number of steps to pick the longest match inside the window.

const WINDOW = 8192; // farthest distance a reference can express (13 bits, biased by one)
const MIN_MATCH = 3;
const MAX_MATCH = 264; // length field 7 + extra byte 255, plus the bias of 2
const MAX_LITERAL = 32;
const HASH_BITS = 15;
const CHAIN_STEPS = 24;

/**
 * Compresses `input` to an LZF stream that `decompressLZF(stream, input.length)` restores exactly.
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
export function lzfCompress(input) {
  const n = input.length;
  const out = [];
  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const chain = new Int32Array(Math.max(n, 1));
  let pending = 0; // start of literals not yet written

  const key = (p) =>
    (Math.imul((input[p] << 16) | (input[p + 1] << 8) | input[p + 2], 0x9e3779b1) >>> (32 - HASH_BITS)) &
    ((1 << HASH_BITS) - 1);
  const file = (p) => {
    if (p + MIN_MATCH > n) return;
    const k = key(p);
    chain[p] = head[k];
    head[k] = p;
  };
  const flushLiterals = (end) => {
    while (pending < end) {
      const count = Math.min(MAX_LITERAL, end - pending);
      out.push(count - 1);
      for (let j = 0; j < count; j++) out.push(input[pending + j]);
      pending += count;
    }
  };

  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + MIN_MATCH <= n) {
      const limit = Math.min(MAX_MATCH, n - i);
      let cand = head[key(i)];
      for (let step = 0; step < CHAIN_STEPS && cand >= 0 && i - cand <= WINDOW; step++) {
        let len = 0;
        while (len < limit && input[cand + len] === input[i + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = i - cand;
          if (len === limit) break;
        }
        cand = chain[cand];
      }
    }

    if (bestLen < MIN_MATCH) {
      file(i);
      i++;
      continue;
    }

    flushLiterals(i);
    const field = bestLen - 2;
    const off = bestDist - 1;
    if (field < 7) {
      out.push((field << 5) | (off >> 8));
    } else {
      out.push((7 << 5) | (off >> 8), field - 7);
    }
    out.push(off & 0xff);
    for (let j = 0; j < bestLen; j++) file(i + j);
    i += bestLen;
    pending = i;
  }
  flushLiterals(n);
  return Uint8Array.from(out);
}
