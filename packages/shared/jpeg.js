// JPEG reading, from ITU-T T.81 (ISO/IEC 10918-1): Huffman coded baseline, extended sequential and progressive DCT files
// of 8 or 12 bits, and the lossless process (Annex H) of 2 to 16 bits, to RGBA8 pixels or full-precision samples. Plain
// code, so it runs the same in Node and in a worker, where a browser's image decoder is not the same on every machine.
// Huffman codes are looked up by their first bits (the table method compared by Moffat and Turpin, "On the Implementation
// of Minimum-Redundancy Prefix Codes", IEEE Transactions on Communications, 1997,
// https://people.eng.unimelb.edu.au/ammoffat/abstracts/mt97ieeecomm.html), with the length-by-length search of T.81
// F.2.2.3 for the longer ones.
import { margoError } from './errors.js';
const refuse = (problem) => margoError('failed', `JPEG: ${problem}; pass a complete JPEG file`);
const unsupported = (problem) => margoError('unsupported', `JPEG: ${problem}`);
/** Zigzag position to natural position in an 8 x 8 block (T.81 figure 5). */
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
]);
/** Bits looked up at once; a longer code is searched length by length. */
const PEEK = 9;
function huffman(counts, values) {
  const first = new Int32Array(17),
    index = new Int32Array(17),
    last = new Int32Array(17).fill(-1),
    // For the next PEEK bits: the code's length times 256 plus its symbol, or -1 when no code that short matches.
    fast = new Int16Array(1 << PEEK).fill(-1);
  let code = 0,
    at = 0;
  for (let length = 1; length <= 16; length++) {
    first[length] = code;
    index[length] = at;
    if (counts[length - 1]) {
      code += counts[length - 1];
      at += counts[length - 1];
      last[length] = code - 1;
      if (code > 2 ** length) throw refuse('a Huffman table is over-subscribed');
      if (length <= PEEK)
        for (let c = first[length]; c < code; c++) {
          const entry = (length << 8) | values[index[length] + c - first[length]];
          fast.fill(entry, c << (PEEK - length), (c + 1) << (PEEK - length));
        }
    }
    code <<= 1;
  }
  return { values, first, index, last, fast };
}
class Bits {
  constructor(bytes, at) {
    this.bytes = bytes;
    this.buffer = 0;
    this.count = 0;
    /** A marker met in the data: bits past it read as zero, and the scan loop stops at it. */
    this.marker = 0;
    /** Zero bytes read past the data. The bit buffer may read 3 past a scan's true end; more means the data is short. */
    this.padded = 0;
    this.at = at;
  }
  fill() {
    const { bytes } = this;
    while (this.count <= 16) {
      let byte = 0;
      if (!this.marker) {
        if (this.at >= bytes.length) this.marker = 0xd9;
        else {
          byte = bytes[this.at++];
          if (byte === 0xff) {
            let next = bytes[this.at];
            while (next === 0xff) next = bytes[++this.at];
            if (next === 0) this.at++;
            else {
              // A file that ends on 0xFF ends the data there too.
              this.marker = next ?? 0xd9;
              this.at--;
            }
          }
        }
      }
      if (this.marker) {
        if (++this.padded > 3) throw refuse('a scan has less data than its frame needs');
        byte = 0;
      }
      this.buffer = (this.buffer << 8) | byte;
      this.count += 8;
    }
  }
  bit() {
    if (!this.count) this.fill();
    this.count--;
    return (this.buffer >>> this.count) & 1;
  }
  take(length) {
    if (!length) return 0;
    if (this.count < length) this.fill();
    this.count -= length;
    return (this.buffer >>> this.count) & ((1 << length) - 1);
  }
  /** The signed value of `length` bits (T.81 F.2.2.1, EXTEND). */
  signed(length) {
    if (!length) return 0;
    const value = this.take(length);
    return value < 1 << (length - 1) ? value - (1 << length) + 1 : value;
  }
  decode(table) {
    if (!table) throw refuse('a scan names a Huffman table the file does not define');
    // At least 16 bits, the longest code.
    if (this.count < 16) this.fill();
    const hit = table.fast[(this.buffer >>> (this.count - PEEK)) & ((1 << PEEK) - 1)];
    if (hit >= 0) {
      this.count -= hit >> 8;
      return hit & 255;
    }
    for (let length = PEEK + 1; length <= 16; length++) {
      const code = (this.buffer >>> (this.count - length)) & ((1 << length) - 1);
      if (table.last[length] >= 0 && code <= table.last[length] && code >= table.first[length]) {
        this.count -= length;
        return table.values[table.index[length] + code - table.first[length]];
      }
    }
    throw refuse('a Huffman code in a scan is not in its table');
  }
  /** Drops the bits left in the byte buffer, at a restart or the end of a scan. */
  reset() {
    this.buffer = 0;
    this.count = 0;
    this.marker = 0;
    this.padded = 0;
  }
}
/** Basis of the inverse DCT: `BASIS[x * 8 + u]` = C(u) / 2 * cos((2x + 1) u pi / 16) (T.81 A.3.3). */
const BASIS = /* @__PURE__ */ (() => {
  const basis = new Float64Array(64);
  for (let x = 0; x < 8; x++)
    for (let u = 0; u < 8; u++)
      basis[x * 8 + u] = (u ? 1 : Math.SQRT1_2) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return basis;
})();
/**
 * Dequantizes block `source` of `coefficients`, inverts the DCT, shifts the level back up by half the sample range (T.81
 * A.3.1) and writes samples of 0 to `max` into the plane.
 */
function inverseDCT(coefficients, source, quant, plane, stride, at, rows, max) {
  // Half the range, plus one half so that storing, which cuts the fraction off, rounds.
  const level = (max + 1) / 2 + 0.5;
  // Rows first. A row with only its DC term is flat, which most rows of a smooth block are.
  for (let v = 0; v < 8; v++) {
    const base = source + v * 8,
      q = v * 8,
      c0 = coefficients[base] * quant[q];
    let flat = true;
    for (let u = 1; u < 8; u++)
      if (coefficients[base + u]) {
        flat = false;
        break;
      }
    if (flat) {
      rows.fill(c0 * BASIS[0], q, q + 8);
      continue;
    }
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) sum += coefficients[base + u] * quant[q + u] * BASIS[x * 8 + u];
      rows[q + x] = sum;
    }
  }
  for (let x = 0; x < 8; x++)
    for (let y = 0; y < 8; y++) {
      let sum = level;
      for (let v = 0; v < 8; v++) sum += rows[v * 8 + x] * BASIS[y * 8 + v];
      plane[at + y * stride + x] = sum < 0 ? 0 : sum >= max + 1 ? max : sum;
    }
}
/** Decodes one block of a sequential scan. */
function sequentialBlock(bits, component, block) {
  const data = component.coefficients,
    t = bits.decode(component.dc);
  if (t > component.maxDC) throw refuse('a DC difference is out of range');
  component.previous += bits.signed(t);
  data[block] = component.previous;
  for (let k = 1; k < 64; ) {
    const rs = bits.decode(component.ac),
      size = rs & 15,
      run = rs >> 4;
    if (!size) {
      if (run < 15) break;
      k += 16;
      continue;
    }
    k += run;
    if (k > 63) throw refuse('an AC run passes the end of its block');
    data[block + ZIGZAG[k++]] = bits.signed(size);
  }
}
function progressiveDCFirst(bits, component, block, { low }) {
  const t = bits.decode(component.dc);
  if (t > component.maxDC) throw refuse('a DC difference is out of range');
  component.previous += bits.signed(t);
  component.coefficients[block] = component.previous * (1 << low);
}
function progressiveDCRefine(bits, component, block, { low }) {
  component.coefficients[block] |= bits.bit() << low;
}
function progressiveACFirst(bits, component, block, scan) {
  if (scan.run > 0) {
    scan.run--;
    return;
  }
  const data = component.coefficients;
  for (let k = scan.start; k <= scan.end; ) {
    const rs = bits.decode(component.ac),
      size = rs & 15,
      run = rs >> 4;
    if (!size) {
      if (run < 15) {
        scan.run = (1 << run) + bits.take(run) - 1;
        break;
      }
      k += 16;
      continue;
    }
    k += run;
    if (k > 63) throw refuse('an AC run passes the end of its block');
    data[block + ZIGZAG[k++]] = bits.signed(size) * (1 << scan.low);
  }
}
function progressiveACRefine(bits, component, block, scan) {
  const data = component.coefficients,
    plus = 1 << scan.low,
    minus = -plus;
  /** Adds a correction bit to a coefficient that is already nonzero (T.81 G.1.2.3). */
  const refine = (at) => {
    if (bits.bit()) data[at] += data[at] >= 0 ? plus : minus;
  };
  let k = scan.start;
  if (!scan.run)
    for (; k <= scan.end; k++) {
      const rs = bits.decode(component.ac),
        size = rs & 15;
      let run = rs >> 4,
        value = 0;
      if (!size) {
        if (run < 15) {
          scan.run = (1 << run) + bits.take(run);
          break;
        }
      } else {
        if (size !== 1) throw refuse('a refinement scan holds a coefficient larger than one bit');
        value = bits.bit() ? plus : minus;
      }
      for (; k <= scan.end; k++) {
        const at = block + ZIGZAG[k];
        if (data[at]) refine(at);
        else {
          if (!run) break;
          run--;
        }
      }
      if (value && k <= scan.end) data[block + ZIGZAG[k]] = value;
    }
  if (scan.run > 0) {
    for (; k <= scan.end; k++) {
      const at = block + ZIGZAG[k];
      if (data[at]) refine(at);
    }
    scan.run--;
  }
}
/** Reads the scan at `at` and returns where it ends. */
function readScan(bytes, at, components, mcusWide, mcusHigh, interval, progressive, scan) {
  const bits = new Bits(bytes, at),
    single = components.length === 1,
    total = single ? components[0].scanWide * components[0].scanHigh : mcusWide * mcusHigh,
    read = !progressive
      ? (b, c, block) => sequentialBlock(b, c, block)
      : scan.start === 0
        ? scan.high
          ? progressiveDCRefine
          : progressiveDCFirst
        : scan.high
          ? progressiveACRefine
          : progressiveACFirst;
  const restart = () => {
    for (const component of components) component.previous = 0;
    scan.run = 0;
  };
  restart();
  for (let mcu = 0; mcu < total; ) {
    const stop = interval ? Math.min(total, mcu + interval) : total;
    for (; mcu < stop; mcu++) {
      if (single) {
        const [component] = components,
          column = mcu % component.scanWide,
          row = (mcu / component.scanWide) | 0;
        read(bits, component, (row * component.blocksWide + column) * 64, scan);
      } else {
        const column = mcu % mcusWide,
          row = (mcu / mcusWide) | 0;
        for (const component of components)
          for (let v = 0; v < component.v; v++)
            for (let h = 0; h < component.h; h++)
              read(
                bits,
                component,
                ((row * component.v + v) * component.blocksWide + column * component.h + h) * 64,
                scan,
              );
      }
    }
    if (mcu >= total) break;
    nextInterval(bits, bytes);
    restart();
  }
  return scanEnd(bytes, bits.at);
}
/** A restart interval ended: moves `bits` past the next RSTn marker. */
function nextInterval(bits, bytes) {
  bits.reset();
  while (
    bits.at + 1 < bytes.length &&
    !(bytes[bits.at] === 0xff && bytes[bits.at + 1] >= 0xd0 && bytes[bits.at + 1] <= 0xd7)
  )
    bits.at++;
  if (bits.at + 1 >= bytes.length) throw refuse('the file ends before a restart marker');
  bits.at += 2;
}
/** The entropy coded data ends at the next marker that is not a stuffed zero or a restart. */
function scanEnd(bytes, from) {
  let end = from;
  while (end + 1 < bytes.length) {
    if (
      bytes[end] === 0xff &&
      bytes[end + 1] !== 0 &&
      bytes[end + 1] !== 0xff &&
      !(bytes[end + 1] >= 0xd0 && bytes[end + 1] <= 0xd7)
    )
      return end;
    end++;
  }
  return bytes.length;
}
/**
 * Turns one line of differences into samples (T.81 H.1.2.1): each is its prediction plus its difference, modulo 2^16. The
 * first line of a scan or restart interval predicts its first sample as `initial` and the others from the left; later
 * lines predict their first sample from above and the others by the scan's selection value (Table H.1, where Ra is the
 * sample to the left, Rb the one above and Rc the one above and to the left).
 */
function reconstruct(plane, at, stride, differences, from, width, predictor, first, initial) {
  const shift = from - at,
    end = at + width,
    selected = first ? 1 : predictor;
  let left = (differences[from] + (first ? initial : plane[at - stride])) & 0xffff;
  plane[at] = left;
  if (selected === 1) for (let i = at + 1; i < end; i++) plane[i] = left = (left + differences[i + shift]) & 0xffff;
  else if (selected === 2) for (let i = at + 1; i < end; i++) plane[i] = plane[i - stride] + differences[i + shift];
  else if (selected === 3) for (let i = at + 1; i < end; i++) plane[i] = plane[i - stride - 1] + differences[i + shift];
  else if (selected === 4)
    for (let i = at + 1; i < end; i++)
      plane[i] = left = (left + plane[i - stride] - plane[i - stride - 1] + differences[i + shift]) & 0xffff;
  else if (selected === 5)
    for (let i = at + 1; i < end; i++)
      plane[i] = left = (left + ((plane[i - stride] - plane[i - stride - 1]) >> 1) + differences[i + shift]) & 0xffff;
  else if (selected === 6)
    for (let i = at + 1; i < end; i++)
      plane[i] = left = (plane[i - stride] + ((left - plane[i - stride - 1]) >> 1) + differences[i + shift]) & 0xffff;
  else
    for (let i = at + 1; i < end; i++)
      plane[i] = left = (((left + plane[i - stride]) >> 1) + differences[i + shift]) & 0xffff;
}
/** One difference (T.81 H.1.2.2): its category by Huffman code, then that many bits. Category 16 is 32768, with none. */
function difference(bits, table) {
  const category = bits.decode(table);
  if (category < 16) return bits.signed(category);
  if (category > 16) throw refuse('a lossless difference is out of range');
  return 32768;
}
/**
 * Reads the lossless scan at `at` into its components' sample planes and returns where it ends. A data unit is one
 * sample, so an interleaved MCU holds h x v samples of each component.
 */
function readLosslessScan(bytes, at, components, mcusWide, mcusHigh, interval, precision, scan) {
  const { start: predictor, low: transform } = scan;
  if (predictor < 1 || predictor > 7 || scan.end || scan.high || transform >= precision)
    throw refuse('a lossless scan header is damaged');
  const bits = new Bits(bytes, at),
    single = components.length === 1,
    across = single ? components[0].scanWide : mcusWide,
    down = single ? components[0].scanHigh : mcusHigh,
    // An interleaved MCU row holds v lines of each component; a single component's holds one.
    layout = components.map((component) => {
      const h = single ? 1 : component.h,
        v = single ? 1 : component.v,
        width = across * h;
      component.transform = transform;
      component.scanned = true;
      return { component, h, v, width, differences: new Int32Array(width * v) };
    }),
    initial = 1 << (precision - transform - 1);
  // T.81 H.1.1: a lossless restart interval holds whole MCU rows.
  if (interval % across) throw refuse('a lossless restart interval is not a whole number of lines');
  const every = interval ? interval / across : down;
  for (let row = 0; row < down; row++) {
    if (row && row % every === 0) nextInterval(bits, bytes);
    if (single) {
      const [{ differences, component }] = layout,
        table = component.dc;
      for (let x = 0; x < across; x++) differences[x] = difference(bits, table);
    } else
      for (let mcu = 0; mcu < across; mcu++)
        for (const { component, h, v, width, differences } of layout)
          for (let j = 0; j < v; j++)
            for (let i = 0; i < h; i++) differences[j * width + mcu * h + i] = difference(bits, component.dc);
    // Bits taken from past the end of the data are zeros the file does not hold.
    if (bits.count < bits.padded * 8) throw refuse('a scan has less data than its frame needs');
    for (const { component, v, width, differences } of layout)
      for (let j = 0; j < v; j++)
        reconstruct(
          component.samples,
          (row * v + j) * component.stride,
          component.stride,
          differences,
          j * width,
          width,
          predictor,
          j === 0 && row % every === 0,
          initial,
        );
  }
  return scanEnd(bytes, bits.at);
}
/** Component `index` of an image, at full size: each sample read from the plane by linear filtering at its centre. */
function sampler(plane, stride, component, maxH, maxV, width, height) {
  if (component.h === maxH && component.v === maxV) return (x, y) => plane[y * stride + x];
  const scaleX = component.h / maxH,
    scaleY = component.v / maxV,
    lastX = Math.ceil((width * component.h) / maxH) - 1,
    lastY = Math.ceil((height * component.v) / maxV) - 1;
  return (x, y) => {
    const u = Math.min(Math.max((x + 0.5) * scaleX - 0.5, 0), lastX),
      v = Math.min(Math.max((y + 0.5) * scaleY - 0.5, 0), lastY),
      x0 = u | 0,
      y0 = v | 0,
      x1 = Math.min(x0 + 1, lastX),
      y1 = Math.min(y0 + 1, lastY),
      fx = u - x0,
      fy = v - y0,
      top = plane[y0 * stride + x0] * (1 - fx) + plane[y0 * stride + x1] * fx,
      bottom = plane[y1 * stride + x0] * (1 - fx) + plane[y1 * stride + x1] * fx;
    return top * (1 - fy) + bottom * fy;
  };
}
const clamp = (value) => (value <= 0 ? 0 : value >= 255 ? 255 : (value + 0.5) | 0);
/** The sample precisions each frame marker, SOF0 to SOF3, takes (T.81 Table B.2). */
const PRECISIONS = [[8], [8, 12], [8, 12], [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]];
/**
 * Decodes JPEG bytes to their components without colour conversion: one sampler per component, in frame order, that
 * reads the component at full image size (subsampled components filtered up linearly, centred as JFIF places them), in
 * the file's own sample range, 0 to 2^precision - 1. `counts` lists the component counts accepted. Adobe APP14
 * transform is reported, not applied.
 */
export function decodeJPEGComponents(bytes, options = {}, counts = [1, 3]) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decodeJPEG needs the file as a Uint8Array');
  const { maxPixels = 2 ** 26 } = options;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw refuse('the file does not start with an SOI marker');
  const quant = [],
    dcTables = [],
    acTables = [],
    rows = new Float64Array(64);
  let width = 0,
    height = 0,
    components = [],
    maxH = 1,
    maxV = 1,
    mcusWide = 0,
    mcusHigh = 0,
    interval = 0,
    progressive = false,
    lossless = false,
    precision = 8,
    jfif = false,
    adobeTransform = -1,
    scans = 0,
    at = 2;
  const u16 = (i) => (bytes[i] << 8) | bytes[i + 1];
  for (;;) {
    while (at < bytes.length && bytes[at] !== 0xff) at++;
    while (at < bytes.length && bytes[at] === 0xff) at++;
    if (at >= bytes.length) {
      if (scans) break;
      throw refuse('the file has no image data');
    }
    const marker = bytes[at++];
    if (marker === 0xd9) break;
    if (marker === 0 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (at + 2 > bytes.length) throw refuse('the file ends inside a marker');
    const length = u16(at),
      end = at + length;
    if (length < 2 || end > bytes.length) throw refuse('a marker segment runs past the end of the file');
    let p = at + 2;
    if (marker === 0xdb) {
      while (p < end) {
        const info = bytes[p++],
          wide = info >> 4,
          table = new Uint16Array(64);
        if ((info & 15) > 3 || p + (wide ? 128 : 64) > end) throw refuse('a quantization table is damaged');
        for (let i = 0; i < 64; i++) {
          table[ZIGZAG[i]] = wide ? u16(p) : bytes[p];
          p += wide ? 2 : 1;
        }
        quant[info & 15] = table;
      }
    } else if (marker === 0xc4) {
      while (p < end) {
        const info = bytes[p++],
          counts = bytes.subarray(p, p + 16);
        p += 16;
        let total = 0;
        for (const count of counts) total += count;
        if (p + total > end || total > 256 || (info & 15) > 3 || info >> 4 > 1)
          throw refuse('a Huffman table is damaged');
        (info >> 4 ? acTables : dcTables)[info & 15] = huffman(counts, bytes.subarray(p, p + total));
        p += total;
      }
    } else if (marker >= 0xc0 && marker <= 0xc3) {
      if (components.length) throw refuse('the file has two frame headers');
      progressive = marker === 0xc2;
      lossless = marker === 0xc3;
      precision = bytes[p];
      if (!PRECISIONS[marker - 0xc0].includes(precision))
        throw unsupported(
          `${precision}-bit samples are not read in this kind of file: baseline holds 8 bits, extended and progressive 8 or 12, lossless 2 to 16`,
        );
      height = u16(p + 1);
      width = u16(p + 3);
      const count = bytes[p + 5];
      if (width && !height)
        throw unsupported('a frame that gives its height in a DNL marker is not read; re-encode the image');
      if (!width || !height) throw refuse('the frame has no size');
      if (width * height > maxPixels)
        throw new RangeError(`JPEG is ${width} x ${height}, over maxPixels ${maxPixels}; raise maxPixels`);
      if (!counts.includes(count))
        throw margoError('unsupported', `JPEG: ${count} components are not read; convert the image to RGB or grey`);
      if (p + 6 + count * 3 > end) throw refuse('the frame header is damaged');
      for (let i = 0; i < count; i++) {
        const base = p + 6 + i * 3,
          h = bytes[base + 1] >> 4,
          v = bytes[base + 1] & 15;
        if (h < 1 || h > 4 || v < 1 || v > 4) throw refuse('a sampling factor is out of range');
        components.push({
          id: bytes[base],
          h,
          v,
          quant: bytes[base + 2],
          blocksWide: 0,
          blocksHigh: 0,
          scanWide: 0,
          scanHigh: 0,
          // DCT frames keep coefficients; lossless frames keep samples, `stride` to a line.
          coefficients: new Int16Array(0),
          samples: new Uint16Array(0),
          stride: 0,
          transform: 0,
          scanned: false,
          // The largest DC difference category (T.81 F.1.2.1.2 and F.1.5.1).
          maxDC: precision === 8 ? 11 : 15,
          dc: undefined,
          ac: undefined,
          previous: 0,
        });
        maxH = Math.max(maxH, h);
        maxV = Math.max(maxV, v);
      }
      // A data unit is an 8 x 8 block of DCT coefficients, or one lossless sample.
      const unit = lossless ? 1 : 8;
      mcusWide = Math.ceil(width / (unit * maxH));
      mcusHigh = Math.ceil(height / (unit * maxV));
      for (const component of components) {
        component.blocksWide = mcusWide * component.h;
        component.blocksHigh = mcusHigh * component.v;
        component.scanWide = Math.ceil(Math.ceil((width * component.h) / maxH) / unit);
        component.scanHigh = Math.ceil(Math.ceil((height * component.v) / maxV) / unit);
        component.stride = component.blocksWide * unit;
        if (lossless) component.samples = new Uint16Array(component.stride * component.blocksHigh);
        else component.coefficients = new Int16Array(component.blocksWide * component.blocksHigh * 64);
      }
    } else if (marker >= 0xc9 && marker <= 0xcf) {
      throw unsupported('arithmetic coded files are not read; re-encode with Huffman coding');
    } else if ((marker >= 0xc5 && marker <= 0xc7) || marker === 0xde) {
      throw unsupported(
        'hierarchical (differential) files are not read; re-encode as baseline, progressive or lossless',
      );
    } else if (marker === 0xdd) {
      interval = u16(p);
    } else if (marker === 0xe0 && length >= 7 && String.fromCharCode(...bytes.subarray(p, p + 4)) === 'JFIF') {
      jfif = true;
    } else if (marker === 0xee && length >= 14 && String.fromCharCode(...bytes.subarray(p, p + 5)) === 'Adobe') {
      adobeTransform = bytes[p + 11];
    } else if (marker === 0xda) {
      if (!components.length) throw refuse('a scan comes before the frame header');
      const count = bytes[p++],
        active = [];
      if (p + count * 2 + 3 > end) throw refuse('a scan header is damaged');
      for (let i = 0; i < count; i++) {
        const component = components.find(({ id }) => id === bytes[p]);
        if (!component) throw refuse('a scan names a component the frame does not have');
        component.dc = dcTables[bytes[p + 1] >> 4];
        component.ac = acTables[bytes[p + 1] & 15];
        active.push(component);
        p += 2;
      }
      const scan = {
        start: bytes[p],
        end: bytes[p + 1],
        high: bytes[p + 2] >> 4,
        low: bytes[p + 2] & 15,
        run: 0,
      };
      // Lossless scans reuse these fields (predictor, 0, 0, point transform), which readLosslessScan checks.
      if (!active.length || (!lossless && (scan.start > scan.end || scan.end > 63)))
        throw refuse('a scan header is damaged');
      at = lossless
        ? readLosslessScan(bytes, end, active, mcusWide, mcusHigh, interval, precision, scan)
        : readScan(bytes, end, active, mcusWide, mcusHigh, interval, progressive, scan);
      scans++;
      continue;
    }
    at = end;
  }
  if (!scans) throw refuse('the file has no scan');
  const max = 2 ** precision - 1,
    Plane = precision > 8 ? Uint16Array : Uint8Array;
  const planes = components.map((component) => {
    const { stride, samples, transform } = component;
    if (lossless) {
      if (!component.scanned) throw refuse('a component has no scan');
      // The point transform divided the samples before they were coded (T.81 A.4).
      if (transform) for (let i = 0; i < samples.length; i++) samples[i] <<= transform;
      return sampler(samples, stride, component, maxH, maxV, width, height);
    }
    const table = quant[component.quant];
    if (!table) throw refuse('a component names a quantization table the file does not define');
    const plane = new Plane(stride * component.blocksHigh * 8);
    for (let row = 0; row < component.blocksHigh; row++)
      for (let column = 0; column < component.blocksWide; column++)
        inverseDCT(
          component.coefficients,
          (row * component.blocksWide + column) * 64,
          table,
          plane,
          stride,
          row * 8 * stride + column * 8,
          rows,
          max,
        );
    return sampler(plane, stride, component, maxH, maxV, width, height);
  });
  const ids = components.map(({ id }) => id);
  return { width, height, precision, lossless, ids, jfif, adobeTransform, planes };
}
/**
 * Decodes JPEG bytes to their samples at the file's precision, interleaved in raster order with the components in frame
 * order: bytes for up to 8 bits, 16-bit words above. No colour conversion; subsampled components are filtered up to full
 * size and rounded. Up to four components are read. A lossless file comes out exactly as it was encoded.
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError when the image is larger than `maxPixels`.
 * @throws MargoError `failed` for a damaged or cut short file, and `unsupported` for arithmetic coding, hierarchical
 * files, a precision its process does not allow and more than four components.
 */
export function decodeJPEGSamples(bytes, options = {}) {
  const frame = decodeJPEGComponents(bytes, options, [1, 2, 3, 4]),
    { width, height, precision, lossless, ids, adobeTransform, planes } = frame,
    components = planes.length,
    data = new (precision > 8 ? Uint16Array : Uint8Array)(width * height * components);
  for (let c = 0; c < components; c++) {
    const plane = planes[c];
    for (let y = 0, out = c; y < height; y++)
      for (let x = 0; x < width; x++, out += components) data[out] = plane(x, y) + 0.5;
  }
  return { width, height, components, precision, lossless, ids, adobeTransform, data };
}
/**
 * Decodes JPEG bytes to RGBA8 pixels. Grey images expand to RGB, and YCbCr converts as JFIF says; an Adobe marker saying
 * the file holds plain RGB is honoured. A lossless file holds plain RGB unless a JFIF or Adobe marker says YCbCr. Samples
 * of other than 8 bits scale to 0-255 after conversion. Subsampled chroma is filtered up linearly, as JFIF places it. EXIF
 * orientation and colour profiles are ignored: samples come out as stored.
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError when the image is larger than `maxPixels`.
 * @throws MargoError `failed` for a damaged or cut short file, and `unsupported` for arithmetic coding, hierarchical
 * files, a precision its process does not allow and four-component CMYK files.
 */
export function decodeJPEG(bytes, options = {}) {
  const frame = decodeJPEGComponents(bytes, options),
    { width, height, precision, lossless, ids, jfif, adobeTransform, planes } = frame,
    data = new Uint8Array(width * height * 4),
    [first, second, third] = planes,
    scale = 255 / (2 ** precision - 1),
    centre = 2 ** (precision - 1),
    named = ids[0] === 82 && ids[1] === 71 && ids[2] === 66,
    // Three components are YCbCr unless an Adobe marker or the component names say RGB. Lossless coding is used to keep
    // the stored colours, so there the file has to say that it converted them.
    rgb = planes.length === 3 && (adobeTransform === 0 || (adobeTransform < 0 && (named || (lossless && !jfif))));
  for (let y = 0, out = 0; y < height; y++)
    for (let x = 0; x < width; x++, out += 4) {
      const a = first(x, y);
      if (planes.length === 1) data[out] = data[out + 1] = data[out + 2] = clamp(a * scale);
      else if (rgb) {
        data[out] = clamp(a * scale);
        data[out + 1] = clamp(second(x, y) * scale);
        data[out + 2] = clamp(third(x, y) * scale);
      } else {
        const cb = second(x, y) - centre,
          cr = third(x, y) - centre;
        data[out] = clamp((a + 1.402 * cr) * scale);
        data[out + 1] = clamp((a - 0.344136 * cb - 0.714136 * cr) * scale);
        data[out + 2] = clamp((a + 1.772 * cb) * scale);
      }
      data[out + 3] = 255;
    }
  return { width, height, data };
}
