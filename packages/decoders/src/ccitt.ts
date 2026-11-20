// CCITT bilevel decoding for TIFF Compression 2, 3 and 4, written from ITU-T Recommendation T.4 (07/2003) sections
// 4.1 and 4.2 (one- and two-dimensional coding, the uncompressed mode of Table 5), ITU-T T.6 (11/1988) section 2 and
// the TIFF 6.0 adaptations (Sections 10 and 11: byte-aligned rows for Compression 2, T4Options, EOFB). Each strip or
// tile is a separate encoding. Output is packed rows, first pixel in the high bit, 1 for a black run.
import { decodeFailed } from './errors.js';

const corrupt = (problem: string): Error =>
  decodeFailed(`TIFF CCITT data ${problem}; pass the complete bytes of a valid TIFF file`);

// Terminating codes for runs 0 to 63, then make-up codes 64 to 1728 (T.4 Tables 2 and 3), white then black.
const WHITE =
  '00110101 000111 0111 1000 1011 1100 1110 1111 10011 10100 00111 01000 001000 000011 110100 110101 101010 101011 0100111 0001100 0001000 0010111 0000011 0000100 0101000 0101011 0010011 0100100 0011000 00000010 00000011 00011010 00011011 00010010 00010011 00010100 00010101 00010110 00010111 00101000 00101001 00101010 00101011 00101100 00101101 00000100 00000101 00001010 00001011 01010010 01010011 01010100 01010101 00100100 00100101 01011000 01011001 01011010 01011011 01001010 01001011 00110010 00110011 00110100 11011 10010 010111 0110111 00110110 00110111 01100100 01100101 01101000 01100111 011001100 011001101 011010010 011010011 011010100 011010101 011010110 011010111 011011000 011011001 011011010 011011011 010011000 010011001 010011010 011000 010011011';
const BLACK =
  '0000110111 010 11 10 011 0011 0010 00011 000101 000100 0000100 0000101 0000111 00000100 00000111 000011000 0000010111 0000011000 0000001000 00001100111 00001101000 00001101100 00000110111 00000101000 00000010111 00000011000 000011001010 000011001011 000011001100 000011001101 000001101000 000001101001 000001101010 000001101011 000011010010 000011010011 000011010100 000011010101 000011010110 000011010111 000001101100 000001101101 000011011010 000011011011 000001010100 000001010101 000001010110 000001010111 000001100100 000001100101 000001010010 000001010011 000000100100 000000110111 000000111000 000000100111 000000101000 000001011000 000001011001 000000101011 000000101100 000001011010 000001100110 000001100111 0000001111 000011001000 000011001001 000001011011 000000110011 000000110100 000000110101 0000001101100 0000001101101 0000001001010 0000001001011 0000001001100 0000001001101 0000001110010 0000001110011 0000001110100 0000001110101 0000001110110 0000001110111 0000001010010 0000001010011 0000001010100 0000001010101 0000001011010 0000001011011 0000001100100 0000001100101';
// Make-up codes 1792 to 2560 shared by both colours (T.4 Table 3), then the one-dimensional entrance to uncompressed
// mode (Table 5).
const SHARED =
  '00000001000 00000001100 00000001101 000000010010 000000010011 000000010100 000000010101 000000010110 000000010111 000000011100 000000011101 000000011110 000000011111 000000001111';
const UNCOMPRESSED = 1 << 16;
// Two-dimensional modes (T.4 Table 4, T.6 Table 1): pass, horizontal, V(0), VR(1..3), VL(1..3), the extension that
// enters uncompressed mode (xxx = 111), and EOL.
const MODES = '0001 001 1 011 000011 0000011 010 000010 0000010 0000001111 000000000001';
const PASS = 0,
  HORIZONTAL = 1,
  EXTENSION = 9,
  EOL = 10;
/** Vertical mode offsets a1 - b1, by mode number. */
const VERTICAL = [0, 0, 0, 1, 2, 3, -1, -2, -3];

/** A binary code tree: node n's children at 2n and 2n + 1; a positive entry is a node, ~value a leaf, 0 no code. */
function codeTree(codes: string[], values: (k: number) => number): Int32Array {
  const nodes = [0, 0];
  codes.forEach((code, k) => {
    let n = 0;
    for (let i = 0; i < code.length; i++) {
      const slot = n * 2 + +code[i];
      if (i === code.length - 1) nodes[slot] = ~values(k);
      else {
        if (!nodes[slot]) nodes[slot] = nodes.push(0, 0) / 2 - 1;
        n = nodes[slot];
      }
    }
  });
  return Int32Array.from(nodes);
}
const runValue = (k: number) => (k < 64 ? k : (k - 63) * 64);
const sharedValue = (k: number) => (k < 13 ? 1792 + k * 64 : UNCOMPRESSED);
let trees: Int32Array[] | undefined;
/** White run, black run and mode trees, built on first use. */
const codeTrees = (): Int32Array[] =>
  (trees ??= [
    codeTree([...WHITE.split(' '), ...SHARED.split(' ')], (k) => (k < 91 ? runValue(k) : sharedValue(k - 91))),
    codeTree([...BLACK.split(' '), ...SHARED.split(' ')], (k) => (k < 91 ? runValue(k) : sharedValue(k - 91))),
    codeTree(MODES.split(' '), (k) => k),
  ]);

/** Options of one CCITT segment. */
export interface CCITTOptions {
  /** 2: Modified Huffman (TIFF Section 10); 3: T.4 (Section 11, T4Options); 4: T.6. */
  compression: 2 | 3 | 4;
  /** T4Options bit 0: lines after an EOL + 0 are coded two-dimensionally. */
  twoDimensional?: boolean;
}

/** Decodes one strip or tile of `width` x `rows` pixels into packed rows of `ceil(width / 8)` bytes. */
export function decodeCCITT(src: Uint8Array, width: number, rows: number, options: CCITTOptions): Uint8Array {
  const [white, black, modes] = codeTrees(),
    rowBytes = Math.ceil(width / 8),
    out = new Uint8Array(rowBytes * rows),
    end = src.length * 8,
    { compression } = options,
    twoD = compression === 3 && !!options.twoDimensional;
  let pos = 0,
    // The reference line's changing elements, then sentinels at the imaginary element after the line (T.4 4.2.1.3.4).
    ref: number[] = [width, width, width],
    cur: number[] = [];
  const bit = () => {
    if (pos >= end) throw corrupt('ends before its last row');
    return (src[pos >> 3] >> (7 - (pos++ & 7))) & 1;
  };
  const code = (tree: Int32Array) => {
    for (let n = 0; ; ) {
      const next = tree[n * 2 + bit()];
      if (next < 0) return ~next;
      if (!next) throw corrupt('holds a code that T.4 and T.6 do not define');
      n = next;
    }
  };
  /** Zero bits ahead of the read position, up to the next 1 or the end. */
  const zerosAhead = () => {
    let p = pos;
    while (p < end && !((src[p >> 3] >> (7 - (p & 7))) & 1)) p++;
    return p - pos;
  };
  /** Adds a changing element; two at one position cancel (a run of length 0). */
  const change = (at: number) => {
    if (cur.length && cur[cur.length - 1] === at) cur.pop();
    else cur.push(at);
  };
  /** One run of `color`: make-up codes, then the terminating code. Returns UNCOMPRESSED on that entrance code. */
  const run = (color: number) => {
    for (let total = 0; ; ) {
      const value = code(color ? black : white);
      if (value === UNCOMPRESSED) {
        if (total) throw corrupt('enters uncompressed mode inside a run');
        return value;
      }
      total += value;
      if (value < 64) return total;
    }
  };
  /**
   * Uncompressed mode (T.4 Table 5) from pixel `at`: k <= 4 zeros then 1 are k white pixels and a black one, five zeros
   * then 1 are five white pixels, and 6 + k zeros, 1 and a tag bit end the mode after k white pixels, the tag bit
   * giving the colour of the next run. Returns the next pixel; `color` is set to the tag.
   */
  let color = 0;
  const uncompressed = (at: number) => {
    const pixel = (black: number) => {
      if (at >= width) throw corrupt('has an uncompressed run past the end of its row');
      if ((cur.length & 1) !== black) change(at);
      at++;
    };
    for (;;) {
      let zeros = 0;
      while (!bit()) if (++zeros > 10) throw corrupt('has a damaged uncompressed-mode code');
      if (zeros > 5) {
        for (let i = 0; i < zeros - 6; i++) pixel(0);
        color = bit();
        if ((cur.length & 1) !== color && at < width) change(at);
        return at;
      }
      for (let i = 0; i < zeros; i++) pixel(0);
      if (zeros < 5) pixel(1);
    }
  };
  /** A one-dimensional line (T.4 4.1): runs alternate from white until they cover the row. */
  const line1D = () => {
    color = 0;
    for (let at = 0; at < width; ) {
      const length = run(color);
      if (length === UNCOMPRESSED) {
        at = uncompressed(at);
        continue;
      }
      at += length;
      if (at > width) throw corrupt('has runs longer than its row');
      change(at);
      color ^= 1;
    }
  };
  /** A two-dimensional line (T.4 4.2.1.3, T.6 2.2). Returns false at an EOFB (or RTC) before the line's first code. */
  const line2D = (): boolean => {
    color = 0;
    for (let a0 = -1, first = 0; a0 < width; ) {
      while (ref[first] <= a0) first++;
      // b1: the first changing element right of a0 whose new colour is the opposite of a0's (even entries turn black).
      const b = first + ((first & 1) ^ color),
        b1 = ref[b],
        b2 = ref[b + 1],
        mode = code(modes),
        start = a0 < 0 ? 0 : a0;
      if (mode === EOL) {
        if (a0 < 0 && !cur.length) return false;
        throw corrupt('ends a row early');
      }
      if (mode === PASS) {
        if (b2 >= width) throw corrupt('has a pass mode past the end of its row');
        a0 = b2;
      } else if (mode === HORIZONTAL) {
        const one = run(color),
          two = one === UNCOMPRESSED ? one : run(color ^ 1);
        if (two === UNCOMPRESSED) throw corrupt('enters uncompressed mode inside horizontal mode');
        const a1 = start + one,
          a2 = a1 + two;
        if (a2 > width) throw corrupt('has runs longer than its row');
        change(a1);
        change(a2);
        a0 = a2;
      } else if (mode === EXTENSION) {
        a0 = uncompressed(start);
      } else {
        const a1 = b1 + VERTICAL[mode];
        if (a1 < start || (a0 >= 0 && a1 === a0) || a1 > width) throw corrupt('has a vertical mode outside its row');
        change(a1);
        a0 = a1;
        color ^= 1;
      }
    }
    return true;
  };
  for (let row = 0; row < rows; row++) {
    cur = [];
    let done = false;
    if (compression === 4) done = !line2D();
    else if (compression === 2) {
      line1D();
      pos = (pos + 7) & ~7;
    } else {
      // T.4: an optional EOL (fill zeros, then 000000000001), then a tag bit when two-dimensional coding is on. A
      // second EOL straight after is the RTC that ends the page.
      let oneD = !twoD || row === 0;
      if (zerosAhead() >= 11) {
        pos += zerosAhead() + 1;
        if (twoD) oneD = !!bit();
        if (pos >= end || zerosAhead() >= 11) done = true;
      }
      if (!done) {
        if (oneD) line1D();
        else if (!line2D()) done = true;
      }
    }
    // A page ended early: TIFF 6.0 Section 11 reads the missing rows as white.
    if (done) break;
    const base = row * rowBytes;
    for (let k = 0; k < cur.length; k += 2)
      for (let x = cur[k], stop = Math.min(k + 1 < cur.length ? cur[k + 1] : width, width); x < stop; x++)
        out[base + (x >> 3)] |= 0x80 >> (x & 7);
    ref = [...cur, width, width, width];
  }
  return out;
}
