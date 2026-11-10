// Container layout from public format descriptions and black-box KSplat writer/getter queries; no rival source read.
import { MargoError } from '@margoengine/math/errors';
import { type SplatData, validateSplats } from './data.js';
import { type GaussianAttributes, attributesFromSplats, splatsFromAttributes } from './ply.js';

const C0 = 0.2820947918;
function bytesOf(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('Pass an ArrayBuffer or typed array containing the complete splat file');
}
function attributes(count: number, degree = 0): GaussianAttributes {
  if (!Number.isInteger(count) || count < 1 || count > 3_000_000)
    throw new RangeError('Use a capture with 1 to 3,000,000 splats');
  return {
    count,
    positions: new Float32Array(count * 3),
    logScales: new Float32Array(count * 3),
    rotations: new Float32Array(count * 4),
    dc: new Float32Array(count * 3),
    alphas: new Float32Array(count),
    ...(degree ? { rest: new Float32Array(count * ((degree + 1) ** 2 - 1) * 3) } : {}),
  };
}
function half(bits: number): number {
  const sign = bits & 32768 ? -1 : 1,
    exponent = (bits >>> 10) & 31,
    mantissa = bits & 1023;
  return (
    sign *
    (exponent === 0
      ? mantissa * 2 ** -24
      : exponent === 31
        ? mantissa
          ? NaN
          : Infinity
        : (1 + mantissa / 1024) * 2 ** (exponent - 15))
  );
}

/**
 * Reads complete KSplat version 0.1 captures, compression 0 (float32), 1 (half) and 2 (half plus byte SH).
 * Supports multiple sections, full and partial spatial buckets, section capacities and SH degrees 0 to 2.
 * A mixed-degree file is promoted to its largest degree with zero missing higher bands.
 * @throws RangeError for incomplete or inconsistent headers, counts, bucket tables or attributes.
 */
export function parseKsplat(input: ArrayBuffer | ArrayBufferView): SplatData {
  const bytes = bytesOf(input),
    v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4096 || bytes[0] !== 0 || bytes[1] !== 1)
    throw new RangeError('Expected a complete KSplat version 0.1 file; re-export this capture');
  const maximum = v.getUint32(4, true),
    sections = v.getUint32(8, true),
    count = v.getUint32(16, true),
    level = v.getUint16(20, true);
  if (
    maximum < sections ||
    sections < 1 ||
    4096 + maximum * 1024 > bytes.length ||
    level > 2 ||
    v.getUint32(12, true) < count
  )
    throw new RangeError('KSplat section table or compression level is invalid; check the complete file');
  const descriptors: {
    header: number;
    count: number;
    capacity: number;
    degree: number;
    stride: number;
    size: number;
    bucketSize: number;
    buckets: number;
    full: number;
    partial: number;
    block: number;
    range: number;
    bucketBytes: number;
  }[] = [];
  let degree = 0,
    summed = 0;
  for (let s = 0; s < sections; s++) {
    const h = 4096 + s * 1024,
      n = v.getUint32(h, true),
      capacity = v.getUint32(h + 4, true),
      d = v.getUint16(h + 40, true);
    if (n > capacity || capacity > 3_000_000 || d > 2)
      throw new RangeError('Invalid KSplat section capacity or SH degree; re-export the capture');
    degree = Math.max(degree, d);
    summed += n;
    const stride = (level ? 24 : 44) + ((d + 1) ** 2 - 1) * 3 * (level === 0 ? 4 : level === 1 ? 2 : 1);
    descriptors.push({
      header: h,
      count: n,
      capacity,
      degree: d,
      stride,
      size: v.getUint32(h + 28, true),
      bucketSize: v.getUint32(h + 8, true),
      buckets: v.getUint32(h + 12, true),
      full: v.getUint32(h + 32, true),
      partial: v.getUint32(h + 36, true),
      block: v.getFloat32(h + 16, true),
      range: v.getUint32(h + 24, true) || 32767,
      bucketBytes: v.getUint16(h + 20, true),
    });
  }
  if (summed !== count)
    throw new RangeError('KSplat section counts disagree with its header; download the complete capture');
  const raw = attributes(count, degree),
    rest = (degree + 1) ** 2 - 1;
  const minSH = v.getFloat32(36, true),
    maxSH = v.getFloat32(40, true);
  if (level === 2 && (!Number.isFinite(minSH) || !Number.isFinite(maxSH) || minSH > maxSH))
    throw new RangeError('KSplat SH range is invalid; re-export the capture');
  let base = 4096 + maximum * 1024,
    out = 0;
  for (const s of descriptors) {
    const metadata = s.partial * 4,
      bucketBase = base + metadata,
      dataBase = bucketBase + s.buckets * s.bucketBytes;
    if (base + s.size > bytes.length || dataBase + s.capacity * s.stride > base + s.size || s.size < 1)
      throw new RangeError('KSplat section runs outside the file; download the complete capture');
    const lengths: number[] = [];
    if (level) {
      if (
        s.full + s.partial !== s.buckets ||
        s.bucketSize < 1 ||
        s.bucketBytes < 12 ||
        !(s.block > 0) ||
        !Number.isFinite(s.block) ||
        s.range < 1
      )
        throw new RangeError('Invalid KSplat spatial bucket table; re-export this capture');
      for (let i = 0; i < s.buckets; i++) {
        const n = i < s.full ? s.bucketSize : v.getUint32(base + (i - s.full) * 4, true);
        if (n < 1 || n > s.bucketSize)
          throw new RangeError('KSplat partial bucket length is invalid; re-export this capture');
        lengths.push(n);
      }
      if (lengths.reduce((a, b) => a + b, 0) !== s.capacity)
        throw new RangeError('KSplat bucket lengths disagree with its capacity; check the file');
    }
    let bucket = 0,
      fence = lengths[0] ?? s.capacity;
    const factor = s.block / (2 * s.range);
    for (let i = 0; i < s.count; i++, out++) {
      while (i >= fence) fence += lengths[++bucket];
      const p = dataBase + i * s.stride;
      for (let c = 0; c < 3; c++) {
        raw.positions[out * 3 + c] = level
          ? v.getFloat32(bucketBase + bucket * s.bucketBytes + c * 4, true) +
            (v.getUint16(p + c * 2, true) - s.range) * factor
          : v.getFloat32(p + c * 4, true);
        const scale = level ? half(v.getUint16(p + 6 + c * 2, true)) : v.getFloat32(p + 12 + c * 4, true);
        if (!(scale > 0) || !Number.isFinite(scale))
          throw new RangeError('KSplat axis scale must be finite and positive; re-export this capture');
        raw.logScales[out * 3 + c] = Math.log(scale);
        raw.dc[out * 3 + c] = (bytes[p + (level ? 20 : 40) + c] / 255 - 0.5) / C0;
      }
      raw.alphas[out] = bytes[p + (level ? 23 : 43)] / 255;
      for (let k = 0; k < 4; k++)
        raw.rotations[out * 4 + k] = level
          ? half(v.getUint16(p + 12 + k * 2, true))
          : v.getFloat32(p + 24 + k * 4, true);
      if (raw.rest) {
        const sh = p + (level ? 24 : 44),
          unit = level === 0 ? 4 : level === 1 ? 2 : 1;
        for (let band = 1; band <= s.degree; band++)
          for (let c = 0; c < 3; c++)
            for (let j = 0; j < 2 * band + 1; j++) {
              const k = (band * band - 1) * 3 + c * (2 * band + 1) + j,
                at = sh + k * unit;
              raw.rest[(out * rest + band * band - 1 + j) * 3 + c] =
                level === 0
                  ? v.getFloat32(at, true)
                  : level === 1
                    ? half(v.getUint16(at, true))
                    : minSH + (bytes[at] / 255) * (maxSH - minSH);
            }
      }
    }
    base += s.size;
  }
  if (base !== bytes.length) throw new RangeError('KSplat has trailing or missing sections; check the complete file');
  return splatsFromAttributes(raw);
}

interface Element {
  name: string;
  count: number;
  stride: number;
  offset: number;
  properties: Map<string, { offset: number; type: string }>;
}
const widths: Record<string, number> = { float: 4, float32: 4, uint: 4, uint32: 4, uchar: 1, uint8: 1 };
function packedHeader(bytes: Uint8Array): Map<string, Element> {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, 65536)),
    match = /^end_header\r?\n/m.exec(text);
  if ((!text.startsWith('ply\n') && !text.startsWith('ply\r\n')) || !match)
    throw new RangeError('Expected a complete PLY header under 64 KiB; check the file');
  const end = match.index + match[0].length,
    header = text.slice(0, end);
  if (!/^format binary_little_endian 1\.0\r?$/m.test(header))
    throw new MargoError('unsupported', 'Compressed PLY requires binary_little_endian 1.0; re-export this capture');
  const elements = new Map<string, Element>();
  let current: Element | undefined;
  for (const line of header.split(/\r?\n/)) {
    const w = line.trim().split(/\s+/);
    if (w[0] === 'element') {
      if (elements.has(w[1])) throw new RangeError('PLY elements must have unique names; fix the header');
      const count = Number(w[2]);
      if (!Number.isInteger(count) || count < 0 || count > 3_000_000)
        throw new RangeError('PLY element count must be between 0 and 3,000,000; check the header');
      current = { name: w[1], count, stride: 0, offset: 0, properties: new Map() };
      elements.set(w[1], current);
    } else if (w[0] === 'property' && current) {
      if (!widths[w[1]] || current.properties.has(w[2]))
        throw new RangeError('Compressed PLY needs unique scalar float, uint and uchar properties; fix the header');
      current.properties.set(w[2], { offset: current.stride, type: w[1] });
      current.stride += widths[w[1]];
    }
  }
  let at = end;
  for (const e of elements.values()) {
    e.offset = at;
    at += e.count * e.stride;
  }
  if (at !== bytes.length)
    throw new RangeError('Compressed PLY byte length disagrees with its header; download the complete file');
  return elements;
}

/**
 * Reads SuperSplat compressed PLY: 256-splat chunks, packed position/rotation/scale/colour, optional colour ranges
 * and channel-major uchar SH through degree 3. Returns ordinary linear-colour SplatData for every renderer entry.
 */
export function parseCompressedPly(input: ArrayBuffer | ArrayBufferView): SplatData {
  const bytes = bytesOf(input),
    elements = packedHeader(bytes),
    chunks = elements.get('chunk'),
    vertices = elements.get('vertex'),
    sh = elements.get('sh');
  if (!chunks || !vertices || chunks.count !== Math.ceil(vertices.count / 256))
    throw new RangeError('Compressed PLY needs one chunk per 256 vertices; check the header');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = (e: Element, i: number, name: string, type: 'float' | 'uint' | 'uchar') => {
    const p = e.properties.get(name);
    if (
      !p ||
      !{ float: ['float', 'float32'], uint: ['uint', 'uint32'], uchar: ['uchar', 'uint8'] }[type].includes(p.type)
    )
      throw new RangeError(`Compressed PLY property ${name} is missing or has the wrong type; re-export this capture`);
    const at = e.offset + i * e.stride + p.offset;
    return type === 'float' ? v.getFloat32(at, true) : type === 'uint' ? v.getUint32(at, true) : bytes[at];
  };
  const rest = sh ? sh.properties.size / 3 : 0,
    degree = Math.sqrt(rest + 1) - 1;
  if (![0, 1, 2, 3].includes(degree) || (sh && sh.count !== vertices.count))
    throw new RangeError('Compressed PLY SH needs 9, 24 or 45 bytes per vertex; check the sh element');
  const raw = attributes(vertices.count, degree),
    colorRanges = chunks.properties.has('min_r');
  const component = (word: number, c: number) =>
    c === 0 ? (word >>> 21) / 2047 : c === 1 ? ((word >>> 11) & 1023) / 1023 : (word & 2047) / 2047;
  const lerp = (lo: number, hi: number, t: number) => lo + (hi - lo) * t;
  for (let i = 0; i < vertices.count; i++) {
    const chunk = Math.floor(i / 256),
      position = value(vertices, i, 'packed_position', 'uint'),
      scale = value(vertices, i, 'packed_scale', 'uint'),
      rotation = value(vertices, i, 'packed_rotation', 'uint'),
      color = value(vertices, i, 'packed_color', 'uint');
    for (let c = 0; c < 3; c++) {
      const axis = ['x', 'y', 'z'][c];
      const lo = value(chunks, chunk, `min_${axis}`, 'float'),
        hi = value(chunks, chunk, `max_${axis}`, 'float'),
        ls = value(chunks, chunk, `min_scale_${axis}`, 'float'),
        hs = value(chunks, chunk, `max_scale_${axis}`, 'float');
      if (![lo, hi, ls, hs].every(Number.isFinite) || hi < lo || hs < ls)
        throw new RangeError('Compressed PLY bounds are invalid; re-export the capture');
      raw.positions[i * 3 + c] = lerp(lo, hi, component(position, c));
      raw.logScales[i * 3 + c] = lerp(ls, hs, component(scale, c));
      const channel = ['r', 'g', 'b'][c],
        a = colorRanges ? value(chunks, chunk, `min_${channel}`, 'float') : 0,
        b = colorRanges ? value(chunks, chunk, `max_${channel}`, 'float') : 1;
      if (!Number.isFinite(a) || !Number.isFinite(b) || a > b)
        throw new RangeError('Compressed PLY colour bounds are invalid; re-export the capture');
      raw.dc[i * 3 + c] = (lerp(a, b, ((color >>> (24 - c * 8)) & 255) / 255) - 0.5) / C0;
    }
    raw.alphas[i] = (color & 255) / 255;
    const largest = rotation >>> 30,
      q = [0, 0, 0, 0];
    let sum = 0,
      at = 0;
    for (let k = 0; k < 4; k++)
      if (k !== largest) {
        const t = (((rotation >>> (20 - at++ * 10)) & 1023) / 1023 - 0.5) * Math.SQRT2;
        q[k] = t;
        sum += t * t;
      }
    q[largest] = Math.sqrt(Math.max(0, 1 - sum));
    raw.rotations.set(q, i * 4);
    if (sh && raw.rest)
      for (let c = 0; c < 3; c++)
        for (let j = 0; j < rest; j++) {
          const code = value(sh, i, `f_rest_${c * rest + j}`, 'uchar');
          raw.rest[(i * rest + j) * 3 + c] = code === 0 ? -4 : code === 255 ? 4 : ((code + 0.5) / 256 - 0.5) * 8;
        }
  }
  return splatsFromAttributes(raw);
}

/** Options for encodePly. */
export interface EncodePlyOptions {
  /** Standard PLY encoding. Default binary_little_endian. */
  format?: 'binary_little_endian' | 'ascii';
}
/**
 * Writes standard Gaussian PLY including full SH, log scales, wxyz rotation and logit opacity.
 * Values retain float32 precision in binary or decimal round-trip precision in ASCII. Opacity endpoints use
 * IEEE infinity logits, preserving exact 0 and 1 when read. No splats are dropped or reordered.
 */
export function encodePly(data: SplatData, options: EncodePlyOptions = {}): Uint8Array<ArrayBuffer> {
  const count = validateSplats(data),
    format = options.format ?? 'binary_little_endian';
  if (format !== 'binary_little_endian' && format !== 'ascii')
    throw new RangeError('Choose binary_little_endian or ascii as the PLY format');
  if (data.colors.some((a, i) => i % 4 === 3 && a > 1))
    throw new RangeError('Gaussian PLY logit opacity cannot exceed 1; use SOG for this cloud');
  const raw = attributesFromSplats(data),
    rest = (raw.rest?.length ?? 0) / count / 3;
  const names = [
    'x',
    'y',
    'z',
    'nx',
    'ny',
    'nz',
    'f_dc_0',
    'f_dc_1',
    'f_dc_2',
    ...Array.from({ length: rest * 3 }, (_, i) => `f_rest_${i}`),
    'opacity',
    'scale_0',
    'scale_1',
    'scale_2',
    'rot_0',
    'rot_1',
    'rot_2',
    'rot_3',
  ];
  const header = new TextEncoder().encode(
    `ply\nformat ${format} 1.0\nelement vertex ${count}\n${names.map((n) => `property float ${n}\n`).join('')}end_header\n`,
  );
  const binary = format === 'binary_little_endian',
    out = binary ? new Uint8Array(header.length + count * names.length * 4) : undefined,
    view = out ? new DataView(out.buffer) : undefined,
    rows: string[] = [];
  out?.set(header);
  for (let i = 0; i < count; i++) {
    const values = [...raw.positions.subarray(i * 3, i * 3 + 3), 0, 0, 0, ...raw.dc.subarray(i * 3, i * 3 + 3)];
    if (raw.rest)
      for (let c = 0; c < 3; c++) for (let j = 0; j < rest; j++) values.push(raw.rest[(i * rest + j) * 3 + c]);
    const alpha = raw.alphas[i];
    values.push(
      Math.log(alpha / (1 - alpha)),
      ...raw.logScales.subarray(i * 3, i * 3 + 3),
      ...raw.rotations.subarray(i * 4, i * 4 + 4),
    );
    if (view)
      for (let k = 0; k < values.length; k++)
        view.setFloat32(header.length + (i * names.length + k) * 4, values[k], true);
    else rows.push(values.map((v) => String(Math.fround(v))).join(' '));
  }
  if (out) return out;
  const body = new TextEncoder().encode(rows.join('\n') + '\n'),
    file = new Uint8Array(header.length + body.length);
  file.set(header);
  file.set(body, header.length);
  return file;
}
