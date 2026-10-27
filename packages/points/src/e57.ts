// ASTM E57 (E2807) 3D imaging data reader and writer: the 48-byte file header, 1024-byte pages each closed by a
// CRC-32C, the XML section (data3D scans with pose, prototype and codecs), and compressed-vector binary sections
// (section header, data packets, bit-packed bytestreams of Float, ScaledInteger and Integer fields). Cartesian and
// spherical coordinates, invalid-state flags, intensity and colour with their limits. Written from the ASTM E2807-11
// standard's description of the format. Corrupt input throws a TypeError or RangeError naming the problem.
import { MargoError } from '@margoengine/math/errors';

const PAGE = 1024,
  PAYLOAD = 1020;

/** CRC-32C (Castagnoli, reflected polynomial 0x82F63B78), the page checksum of E57. */
const CRC32C = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
/** CRC-32C of bytes. */
export function crc32c(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32C[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A parsed XML element (the subset E57 uses: elements, attributes, text). */
export interface E57Element {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly E57Element[];
  readonly text: string;
}

const entities: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : entities[e],
  );

/** Parses XML into elements (no DTDs, no processing beyond the declaration); throws TypeError on malformed input. */
export function parseXML(source: string): E57Element {
  let i = 0;
  const fail = (what: string): never => {
    throw new TypeError(`Invalid E57 XML: ${what} at character ${i}; the file is corrupt`);
  };
  const skipMisc = () => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i])) i++;
      if (source.startsWith('<?', i)) i = source.indexOf('?>', i) + 2 || fail('unclosed declaration');
      else if (source.startsWith('<!--', i)) i = source.indexOf('-->', i) + 3 || fail('unclosed comment');
      else return;
      if (i <= 1) fail('unclosed markup');
    }
  };
  const element = (depth: number): E57Element => {
    if (depth > 64) fail('nesting deeper than 64 levels');
    if (source[i] !== '<') fail('expected an element');
    const nameMatch = /^<([A-Za-z_][\w.:-]*)/.exec(source.slice(i, i + 256)) ?? fail('bad element name');
    const name = nameMatch[1];
    i += nameMatch[0].length;
    const attributes: Record<string, string> = {};
    for (;;) {
      while (/\s/.test(source[i] ?? '')) i++;
      if (source[i] === '/' && source[i + 1] === '>') {
        i += 2;
        return { name, attributes, children: [], text: '' };
      }
      if (source[i] === '>') {
        i++;
        break;
      }
      const attr =
        /^([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(source.slice(i, i + 4096)) ?? fail('bad attribute');
      attributes[attr[1]] = unescape(attr[3] ?? attr[4]);
      i += attr[0].length;
    }
    const children: E57Element[] = [];
    let text = '';
    for (;;) {
      if (i >= source.length) fail(`unclosed <${name}>`);
      if (source.startsWith('</', i)) {
        const end = source.indexOf('>', i);
        if (end < 0 || source.slice(i + 2, end).trim() !== name) fail(`mismatched </${name}>`);
        i = end + 1;
        return { name, attributes, children, text: unescape(text).trim() };
      }
      if (source.startsWith('<![CDATA[', i)) {
        const end = source.indexOf(']]>', i);
        if (end < 0) fail('unclosed CDATA');
        text += source.slice(i + 9, end);
        i = end + 3;
      } else if (source.startsWith('<!--', i)) {
        const end = source.indexOf('-->', i);
        if (end < 0) fail('unclosed comment');
        i = end + 3;
      } else if (source[i] === '<') children.push(element(depth + 1));
      else {
        const next = source.indexOf('<', i);
        if (next < 0) fail(`unclosed <${name}>`);
        text += source.slice(i, next);
        i = next;
      }
    }
  };
  skipMisc();
  const root = element(0);
  return root;
}

/** The file header. */
export interface E57Header {
  readonly versionMajor: number;
  readonly versionMinor: number;
  readonly physicalLength: number;
  readonly xmlOffset: number;
  readonly xmlLength: number;
  readonly pageSize: number;
}

/** One field of a points prototype. */
export interface E57Field {
  readonly name: string;
  readonly type: 'Float' | 'ScaledInteger' | 'Integer';
  /** Float precision in bits (32 or 64), or the packed width of integers. */
  readonly bits: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly scale: number;
  readonly offset: number;
}

/** One scan (a data3D child): its points in world coordinates (pose applied) relative to the file's origin. */
export interface E57Scan {
  readonly name: string;
  readonly guid: string;
  /** Rotation quaternion [w, x, y, z] and translation of the scan's pose. */
  readonly pose: {
    readonly rotation: readonly [number, number, number, number];
    readonly translation: readonly [number, number, number];
  };
  readonly fields: readonly E57Field[];
  /** Records stored (including invalid ones). */
  readonly recordCount: number;
  /** Valid points kept. */
  readonly count: number;
  /** xyz per point relative to `origin`, float32. */
  readonly positions: Float32Array;
  /** Intensity normalised to 0..1 by `intensityLimits`, when the scan has it. */
  readonly intensity?: Float32Array;
  /** RGBA 0..255, normalised by `colorLimits`, when the scan has colour. */
  readonly colors?: Uint8Array;
  /** Any other numeric field (returnIndex, timeStamp, rowIndex, ...), by name, raw values. */
  readonly attributes: Readonly<Record<string, Float64Array>>;
}

/** A parsed E57 file. */
export interface E57File {
  readonly header: E57Header;
  readonly xml: E57Element;
  /** World position of local [0, 0, 0]: the centre of every scan's posed bounds unless `origin` was given. */
  readonly origin: readonly [number, number, number];
  readonly scans: readonly E57Scan[];
  /** Coordinate metadata text of the root, when present. */
  readonly coordinateMetadata?: string;
}

/** Options of `parseE57`. */
export interface E57Options {
  /** World position to store positions relative to. Default: the centre of all posed points. */
  origin?: readonly [number, number, number];
  /** Verify every page's CRC-32C. Default true. */
  verifyChecksums?: boolean;
  /** Keep points flagged invalid (cartesianInvalidState 2, sphericalInvalidState 2). Default false. */
  keepInvalid?: boolean;
  signal?: AbortSignal;
}

/** Reads the 48-byte header. */
export function readE57Header(bytes: Uint8Array): E57Header {
  if (bytes.byteLength < 48) throw new RangeError('E57 file shorter than its 48-byte header; the file is truncated');
  if (String.fromCharCode(...bytes.subarray(0, 8)) !== 'ASTM-E57')
    throw new TypeError('Not an E57 file (no ASTM-E57 signature); pass a .e57 file');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    u64 = (o: number) => Number(v.getBigUint64(o, true));
  const header = {
    versionMajor: v.getUint32(8, true),
    versionMinor: v.getUint32(12, true),
    physicalLength: u64(16),
    xmlOffset: u64(24),
    xmlLength: u64(32),
    pageSize: u64(40),
  };
  if (header.versionMajor !== 1)
    throw new TypeError(`Unsupported E57 version ${header.versionMajor}.${header.versionMinor}; read version 1`);
  if (header.pageSize !== PAGE)
    throw new TypeError(`Unsupported E57 page size ${header.pageSize}; the standard fixes it at 1024`);
  if (header.physicalLength > bytes.byteLength)
    throw new RangeError(
      `E57 file is ${bytes.byteLength} bytes, its header says ${header.physicalLength}; the file is truncated`,
    );
  return header;
}

/** Physical file offset to logical (checksum-free) offset, and back. */
const toLogical = (physical: number) => Math.floor(physical / PAGE) * PAYLOAD + (physical % PAGE);

class Logical {
  readonly length: number;
  constructor(
    private readonly bytes: Uint8Array,
    private readonly physicalLength: number,
    verify: boolean,
  ) {
    const pages = Math.floor(physicalLength / PAGE);
    if (physicalLength % PAGE)
      throw new RangeError('E57 file length is not a whole number of 1024-byte pages; the file is truncated');
    this.length = pages * PAYLOAD;
    if (verify)
      for (let p = 0; p < pages; p++) {
        const at = p * PAGE,
          stored = new DataView(bytes.buffer, bytes.byteOffset + at + PAYLOAD, 4).getUint32(0, false);
        if (crc32c(bytes.subarray(at, at + PAYLOAD)) !== stored)
          throw new RangeError(
            `E57 page ${p} fails its CRC-32C checksum; the file is corrupt (pass verifyChecksums: false to read it anyway)`,
          );
      }
  }
  /** Copies `length` logical bytes starting at a logical offset. */
  read(logical: number, length: number): Uint8Array {
    if (!Number.isFinite(logical) || logical < 0 || length < 0 || logical + length > this.length)
      throw new RangeError(
        `E57 read of ${length} bytes at logical ${logical} passes the file; it is truncated or corrupt`,
      );
    const out = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const l = logical + written,
        page = Math.floor(l / PAYLOAD),
        within = l % PAYLOAD,
        n = Math.min(PAYLOAD - within, length - written);
      out.set(this.bytes.subarray(page * PAGE + within, page * PAGE + within + n), written);
      written += n;
    }
    return out;
  }
}

function child(e: E57Element, name: string): E57Element | undefined {
  return e.children.find((c) => c.name === name);
}
function num(e: E57Element | undefined, fallback = 0): number {
  if (!e) return fallback;
  const v = Number(e.text);
  return Number.isFinite(v) ? v : fallback;
}

function fieldOf(e: E57Element): E57Field | undefined {
  const type = e.attributes.type,
    a = e.attributes;
  if (type === 'Float') {
    const bits = a.precision === 'single' ? 32 : 64;
    return {
      name: e.name,
      type,
      bits,
      minimum: Number(a.minimum ?? -Infinity),
      maximum: Number(a.maximum ?? Infinity),
      scale: 1,
      offset: 0,
    };
  }
  if (type === 'ScaledInteger' || type === 'Integer') {
    const minimum = Number(a.minimum ?? (type === 'Integer' ? -(2 ** 63) : 0)),
      maximum = Number(a.maximum ?? (type === 'Integer' ? 2 ** 63 - 1 : 0));
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum < minimum)
      throw new TypeError(`E57 field ${e.name} has an invalid range; the file is corrupt`);
    const range = maximum - minimum;
    const bits = range <= 0 ? 0 : Math.ceil(Math.log2(range + 1));
    if (bits > 52)
      throw new TypeError(`E57 field ${e.name} needs ${bits} bits; integers above 52 bits are not supported`);
    return {
      name: e.name,
      type,
      bits,
      minimum,
      maximum,
      scale: type === 'ScaledInteger' ? Number(a.scale ?? 1) : 1,
      offset: type === 'ScaledInteger' ? Number(a.offset ?? 0) : 0,
    };
  }
  return undefined;
}

/** Reads one compressed vector's bytestreams into one Float64Array per field. */
function readVector(
  file: Logical,
  physicalOffset: number,
  records: number,
  fields: readonly E57Field[],
  signal?: AbortSignal,
): Float64Array[] {
  const header = file.read(toLogical(physicalOffset), 32),
    hv = new DataView(header.buffer);
  if (hv.getUint8(0) !== 1)
    throw new TypeError('E57 compressed vector section has the wrong section id; the file is corrupt');
  const sectionLength = Number(hv.getBigUint64(8, true)),
    dataOffset = Number(hv.getBigUint64(16, true));
  const out = fields.map(() => new Float64Array(records)),
    filled = fields.map(() => 0),
    // Leftover bits of each field's stream between packets.
    carry = fields.map(() => ({ value: 0n, bits: 0 }));
  let logical = toLogical(dataOffset);
  const end = toLogical(physicalOffset) + sectionLength;
  let guard = 0;
  while (filled.some((n, f) => n < records && fields[f].bits > 0) && logical < end) {
    if (++guard % 64 === 0) signal?.throwIfAborted();
    const ph = file.read(logical, 6),
      pv = new DataView(ph.buffer),
      type = pv.getUint8(0),
      packetLength = pv.getUint16(2, true) + 1;
    if (type !== 1) {
      // Index and empty packets carry no point data.
      logical += packetLength;
      if (packetLength < 4) throw new RangeError('E57 packet length is invalid; the file is corrupt');
      continue;
    }
    const packet = file.read(logical, packetLength),
      v = new DataView(packet.buffer),
      streams = v.getUint16(4, true);
    if (streams !== fields.length)
      throw new TypeError(
        `E57 data packet has ${streams} bytestreams for ${fields.length} fields; the file is corrupt`,
      );
    let at = 6 + streams * 2;
    for (let f = 0; f < streams; f++) {
      const length = v.getUint16(6 + f * 2, true);
      if (at + length > packetLength) throw new RangeError('E57 bytestream runs past its packet; the file is corrupt');
      unpack(packet.subarray(at, at + length), fields[f], out[f], filled, f, carry[f], records);
      at += length;
    }
    logical += packetLength;
  }
  for (let f = 0; f < fields.length; f++) {
    if (fields[f].bits === 0) out[f].fill(fields[f].minimum * fields[f].scale + fields[f].offset);
    else if (filled[f] < records)
      throw new RangeError(
        `E57 field ${fields[f].name} holds ${filled[f]} of ${records} values; the file is truncated`,
      );
  }
  return out;
}

function unpack(
  bytes: Uint8Array,
  field: E57Field,
  out: Float64Array,
  filled: number[],
  f: number,
  carry: { value: bigint; bits: number },
  records: number,
): void {
  if (field.type === 'Float') {
    const size = field.bits / 8,
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Floats are byte aligned; a value split across packets is carried as bytes in `carry`.
    let at = 0;
    if (carry.bits) {
      const need = size - carry.bits / 8,
        joined = new Uint8Array(size);
      for (let k = 0; k < carry.bits / 8; k++) joined[k] = Number((carry.value >> BigInt(k * 8)) & 255n);
      joined.set(bytes.subarray(0, need), carry.bits / 8);
      const jv = new DataView(joined.buffer);
      if (filled[f] < records) out[filled[f]++] = size === 4 ? jv.getFloat32(0, true) : jv.getFloat64(0, true);
      at = need;
      carry.value = 0n;
      carry.bits = 0;
    }
    for (; at + size <= bytes.length && filled[f] < records; at += size)
      out[filled[f]++] = size === 4 ? view.getFloat32(at, true) : view.getFloat64(at, true);
    for (let k = 0; at + k < bytes.length; k++) {
      carry.value |= BigInt(bytes[at + k]) << BigInt(carry.bits);
      carry.bits += 8;
    }
    return;
  }
  // Integers: a continuous little-endian bit stream, least significant bit first.
  const width = field.bits,
    mask = (1n << BigInt(width)) - 1n;
  let value = carry.value,
    bits = carry.bits;
  for (let i = 0; i < bytes.length; i++) {
    value |= BigInt(bytes[i]) << BigInt(bits);
    bits += 8;
    while (bits >= width && filled[f] < records) {
      const raw = Number(value & mask);
      value >>= BigInt(width);
      bits -= width;
      out[filled[f]++] = (raw + field.minimum) * field.scale + field.offset;
    }
  }
  carry.value = value;
  carry.bits = bits;
}

/** Parses an E57 file: every scan's points posed into one world frame. */
export function parseE57(input: ArrayBuffer | Uint8Array, options: E57Options = {}): E57File {
  options.signal?.throwIfAborted();
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const header = readE57Header(bytes),
    file = new Logical(bytes, header.physicalLength, options.verifyChecksums ?? true);
  const xmlBytes = file.read(toLogical(header.xmlOffset), header.xmlLength),
    xml = parseXML(new TextDecoder().decode(xmlBytes));
  if (xml.name !== 'e57Root') throw new TypeError(`E57 XML root is <${xml.name}>, not <e57Root>; the file is corrupt`);
  const data3D = child(xml, 'data3D');
  const posed: { scan: Omit<E57Scan, 'positions' | 'count'>; world: Float64Array; keep: Uint8Array }[] = [];
  for (const [index, scan] of (data3D?.children ?? []).entries()) {
    options.signal?.throwIfAborted();
    const points = child(scan, 'points');
    if (!points || points.attributes.type !== 'CompressedVector') continue;
    const records = Number(points.attributes.recordCount ?? 0),
      offset = Number(points.attributes.fileOffset);
    if (!Number.isInteger(records) || records < 0 || !Number.isFinite(offset))
      throw new TypeError(`E57 scan ${index} has an invalid recordCount or fileOffset; the file is corrupt`);
    const codecs = child(points, 'codecs');
    if (codecs && codecs.children.length)
      throw new MargoError(
        'unsupported',
        `E57 scan ${index} uses a codec other than bitPack; re-export it with the default codec`,
      );
    const prototype = child(points, 'prototype');
    if (!prototype) throw new TypeError(`E57 scan ${index} has no prototype; the file is corrupt`);
    const fields = prototype.children.map((c) => {
      const f = fieldOf(c);
      if (!f)
        throw new MargoError(
          'unsupported',
          `E57 field ${c.name} of type ${c.attributes.type} is not supported; use Float, ScaledInteger or Integer fields`,
        );
      return f;
    });
    // A record count the file cannot hold is corruption; checking it first keeps a bad count from allocating gigabytes.
    const bitsPerRecord = fields.reduce((t, f) => t + f.bits, 0);
    if (records > 2 ** 31 || records * bitsPerRecord > file.length * 8)
      throw new RangeError(
        `E57 scan ${index} claims ${records} records, more than the file can hold; the file is corrupt`,
      );
    const values = readVector(file, offset, records, fields, options.signal),
      get = (name: string) => values[fields.findIndex((f) => f.name === name)] as Float64Array | undefined;
    const x = get('cartesianX'),
      y = get('cartesianY'),
      z = get('cartesianZ'),
      range = get('sphericalRange'),
      azimuth = get('sphericalAzimuth'),
      elevation = get('sphericalElevation');
    const local = new Float64Array(records * 3);
    let invalid: Float64Array | undefined;
    if (x && y && z) {
      for (let i = 0; i < records; i++) local.set([x[i], y[i], z[i]], i * 3);
      invalid = get('cartesianInvalidState');
    } else if (range && azimuth && elevation) {
      for (let i = 0; i < records; i++) {
        const r = range[i],
          ce = Math.cos(elevation[i]);
        local.set([r * ce * Math.cos(azimuth[i]), r * ce * Math.sin(azimuth[i]), r * Math.sin(elevation[i])], i * 3);
      }
      invalid = get('sphericalInvalidState');
    } else
      throw new MargoError(
        'unsupported',
        `E57 scan ${index} has neither cartesian nor spherical coordinates; it holds no points this reader can place`,
      );
    const pose = child(scan, 'pose'),
      q = child(pose ?? scan, 'rotation'),
      t = child(pose ?? scan, 'translation');
    let [qw, qx, qy, qz] = q
      ? [num(child(q, 'w'), 1), num(child(q, 'x')), num(child(q, 'y')), num(child(q, 'z'))]
      : [1, 0, 0, 0];
    const ql = Math.hypot(qw, qx, qy, qz) || 1;
    qw /= ql;
    qx /= ql;
    qy /= ql;
    qz /= ql;
    const tr: [number, number, number] = t ? [num(child(t, 'x')), num(child(t, 'y')), num(child(t, 'z'))] : [0, 0, 0];
    const world = new Float64Array(records * 3),
      keep = new Uint8Array(records);
    // The pose's rotation matrix from the unit quaternion (w, x, y, z), then the translation.
    const r = [
      1 - 2 * (qy * qy + qz * qz),
      2 * (qx * qy - qw * qz),
      2 * (qx * qz + qw * qy),
      2 * (qx * qy + qw * qz),
      1 - 2 * (qx * qx + qz * qz),
      2 * (qy * qz - qw * qx),
      2 * (qx * qz - qw * qy),
      2 * (qy * qz + qw * qx),
      1 - 2 * (qx * qx + qy * qy),
    ];
    for (let i = 0; i < records; i++) {
      const px = local[i * 3],
        py = local[i * 3 + 1],
        pz = local[i * 3 + 2];
      world[i * 3] = r[0] * px + r[1] * py + r[2] * pz + tr[0];
      world[i * 3 + 1] = r[3] * px + r[4] * py + r[5] * pz + tr[1];
      world[i * 3 + 2] = r[6] * px + r[7] * py + r[8] * pz + tr[2];
      keep[i] = options.keepInvalid || !invalid || invalid[i] !== 2 ? 1 : 0;
    }
    const intensityRaw = get('intensity'),
      intensityLimits = child(scan, 'intensityLimits'),
      field = fields.find((f) => f.name === 'intensity');
    const iMin = num(
        child(intensityLimits ?? scan, 'intensityMinimum'),
        field ? field.minimum * field.scale + field.offset : 0,
      ),
      iMax = num(
        child(intensityLimits ?? scan, 'intensityMaximum'),
        field ? field.maximum * field.scale + field.offset : 1,
      );
    const colorLimits = child(scan, 'colorLimits'),
      red = get('colorRed'),
      green = get('colorGreen'),
      blue = get('colorBlue'),
      redField = fields.find((f) => f.name === 'colorRed');
    const cMin = num(child(colorLimits ?? scan, 'colorRedMinimum'), redField ? redField.minimum : 0),
      cMax = num(child(colorLimits ?? scan, 'colorRedMaximum'), redField ? redField.maximum : 255);
    const attributes: Record<string, Float64Array> = {};
    const known = new Set([
      'cartesianX',
      'cartesianY',
      'cartesianZ',
      'sphericalRange',
      'sphericalAzimuth',
      'sphericalElevation',
      'intensity',
      'colorRed',
      'colorGreen',
      'colorBlue',
    ]);
    fields.forEach((f, k) => {
      if (!known.has(f.name)) attributes[f.name] = values[k];
    });
    const n = keep.reduce((s, v) => s + v, 0),
      compact = <T extends Float32Array | Uint8Array | Float64Array>(
        make: (n: number) => T,
        size: number,
        fill: (o: T, at: number, i: number) => void,
      ) => {
        const o = make(n * size);
        let j = 0;
        for (let i = 0; i < records; i++) if (keep[i]) fill(o, j++ * size, i);
        return o;
      };
    posed.push({
      scan: {
        name: child(scan, 'name')?.text ?? `scan ${index}`,
        guid: child(scan, 'guid')?.text ?? '',
        pose: { rotation: [qw, qx, qy, qz], translation: tr },
        fields,
        recordCount: records,
        intensity: intensityRaw
          ? compact(
              (m) => new Float32Array(m),
              1,
              (o, at, i) => {
                o[at] = (intensityRaw[i] - iMin) / (iMax - iMin || 1);
              },
            )
          : undefined,
        colors:
          red && green && blue
            ? compact(
                (m) => new Uint8Array(m),
                4,
                (o, at, i) => {
                  const s = 255 / (cMax - cMin || 1);
                  o[at] = (red[i] - cMin) * s;
                  o[at + 1] = (green[i] - cMin) * s;
                  o[at + 2] = (blue[i] - cMin) * s;
                  o[at + 3] = 255;
                },
              )
            : undefined,
        attributes: Object.fromEntries(
          Object.entries(attributes).map(([k, v]) => [
            k,
            compact(
              (m) => new Float64Array(m),
              1,
              (o, at, i) => (o[at] = v[i]),
            ),
          ]),
        ),
      },
      world,
      keep,
    });
  }
  let origin = options.origin;
  if (!origin) {
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (const { world, keep } of posed)
      for (let i = 0; i < keep.length; i++)
        if (keep[i])
          for (let k = 0; k < 3; k++) {
            const v = world[i * 3 + k];
            if (v < lo[k]) lo[k] = v;
            if (v > hi[k]) hi[k] = v;
          }
    origin = lo[0] <= hi[0] ? ([0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as [number, number, number]) : [0, 0, 0];
  }
  const o = origin;
  const scans = posed.map(({ scan, world, keep }) => {
    const n = keep.reduce((s, v) => s + v, 0),
      positions = new Float32Array(n * 3);
    let j = 0;
    for (let i = 0; i < keep.length; i++)
      if (keep[i]) {
        positions[j * 3] = world[i * 3] - o[0];
        positions[j * 3 + 1] = world[i * 3 + 1] - o[1];
        positions[j * 3 + 2] = world[i * 3 + 2] - o[2];
        j++;
      }
    return { ...scan, count: n, positions };
  });
  return { header, xml, origin: o, scans, coordinateMetadata: child(xml, 'coordinateMetadata')?.text };
}

/** Fetches and parses an E57 file. Aborts with `options.signal`. */
export async function loadE57(
  url: string | URL,
  options: E57Options & { fetch?: typeof fetch } = {},
): Promise<E57File> {
  const response = await (options.fetch ?? globalThis.fetch)(url, { signal: options.signal });
  if (!response.ok)
    throw new MargoError('failed', `GET ${url} answered ${response.status}; check the URL and the server`);
  return parseE57(await response.arrayBuffer(), options);
}

/** A scan for `writeE57`. */
export interface E57WriteScan {
  name?: string;
  /** xyz per point (scan-local unless a pose is given). Or give `spherical` instead. */
  positions?: ArrayLike<number>;
  /** range, azimuth, elevation per point (radians). */
  spherical?: ArrayLike<number>;
  /** Store coordinates as ScaledInteger with this resolution instead of double floats. */
  resolution?: number;
  /** Intensity 0..1 (stored as a 16-bit Integer). */
  intensity?: ArrayLike<number>;
  /** RGB 0..255 per point (8-bit Integers). */
  rgb?: ArrayLike<number>;
  /** cartesianInvalidState (or spherical) per point: 0 valid, 1 direction only, 2 invalid. */
  invalid?: ArrayLike<number>;
  pose?: { rotation?: readonly [number, number, number, number]; translation?: readonly [number, number, number] };
}

/** Writes an E57 file (bitPack codec, one data packet stream per scan). Meant for tools and round-trip tests. */
export function writeE57(scans: readonly E57WriteScan[], options: { packetBytes?: number } = {}): Uint8Array {
  // Logical stream: [48-byte header][sections...][XML]; then paged with CRCs.
  const logical: Uint8Array[] = [];
  let length = 0;
  const push = (b: Uint8Array) => {
    logical.push(b);
    length += b.byteLength;
  };
  const physical = (l: number) => Math.floor(l / PAYLOAD) * PAGE + (l % PAYLOAD);
  push(new Uint8Array(48));
  const xmlScans: string[] = [];
  const packetLimit = Math.min(options.packetBytes ?? 60_000, 64_000);
  for (const [s, scan] of scans.entries()) {
    const spherical = !!scan.spherical,
      coords = scan.spherical ?? scan.positions ?? [],
      n = coords.length / 3;
    const fields: { field: E57Field; values: (i: number) => number; xml: string }[] = [];
    const names = spherical
      ? ['sphericalRange', 'sphericalAzimuth', 'sphericalElevation']
      : ['cartesianX', 'cartesianY', 'cartesianZ'];
    names.forEach((name, k) => {
      if (scan.resolution && !spherical) {
        let lo = Infinity,
          hi = -Infinity;
        for (let i = 0; i < n; i++) {
          lo = Math.min(lo, Math.round(coords[i * 3 + k] / scan.resolution));
          hi = Math.max(hi, Math.round(coords[i * 3 + k] / scan.resolution));
        }
        if (!n) lo = hi = 0;
        const field: E57Field = {
          name,
          type: 'ScaledInteger',
          bits: hi > lo ? Math.ceil(Math.log2(hi - lo + 1)) : 0,
          minimum: lo,
          maximum: hi,
          scale: scan.resolution,
          offset: 0,
        };
        fields.push({
          field,
          values: (i) => Math.round(coords[i * 3 + k] / scan.resolution!) - lo,
          xml: `<${name} type="ScaledInteger" minimum="${lo}" maximum="${hi}" scale="${scan.resolution}" offset="0"/>`,
        });
      } else
        fields.push({
          field: { name, type: 'Float', bits: 64, minimum: -Infinity, maximum: Infinity, scale: 1, offset: 0 },
          values: (i) => coords[i * 3 + k],
          xml: `<${name} type="Float" precision="double"/>`,
        });
    });
    const integer = (name: string, max: number, values: (i: number) => number) =>
      fields.push({
        field: {
          name,
          type: 'Integer',
          bits: Math.ceil(Math.log2(max + 1)),
          minimum: 0,
          maximum: max,
          scale: 1,
          offset: 0,
        },
        values,
        xml: `<${name} type="Integer" minimum="0" maximum="${max}"/>`,
      });
    if (scan.intensity)
      integer('intensity', 65535, (i) => Math.round(Math.min(1, Math.max(0, scan.intensity![i])) * 65535));
    if (scan.rgb)
      for (const [k, c] of ['colorRed', 'colorGreen', 'colorBlue'].entries())
        integer(c, 255, (i) => scan.rgb![i * 3 + k]);
    if (scan.invalid)
      integer(spherical ? 'sphericalInvalidState' : 'cartesianInvalidState', 2, (i) => scan.invalid![i]);
    // Bytestreams.
    const streams = fields.map(({ field, values }) => {
      if (field.type === 'Float') {
        const b = new Uint8Array(n * 8),
          v = new DataView(b.buffer);
        for (let i = 0; i < n; i++) v.setFloat64(i * 8, values(i), true);
        return b;
      }
      const out = new Uint8Array(Math.ceil((n * field.bits) / 8));
      let bit = 0;
      for (let i = 0; i < n; i++) {
        let value = BigInt(values(i));
        for (let k = 0; k < field.bits; k++, bit++, value >>= 1n) if (value & 1n) out[bit >> 3] |= 1 << (bit & 7);
      }
      return out;
    });
    // Section header, then packets that split every stream into chunks of at most `share` bytes.
    const sectionStart = length;
    const sectionHeader = new Uint8Array(32);
    push(sectionHeader);
    const dataStart = length;
    const share = Math.max(8, Math.floor((packetLimit - 6 - fields.length * 2) / Math.max(1, fields.length) / 8) * 8);
    const cursors = streams.map(() => 0);
    while (cursors.some((c, f) => c < streams[f].length)) {
      const parts = streams.map((stream, f) =>
        stream.subarray(cursors[f], Math.min(stream.length, cursors[f] + share)),
      );
      let size = 6 + parts.length * 2 + parts.reduce((t, p) => t + p.length, 0);
      size = Math.ceil(size / 4) * 4;
      const packet = new Uint8Array(size),
        v = new DataView(packet.buffer);
      v.setUint8(0, 1);
      v.setUint16(2, size - 1, true);
      v.setUint16(4, parts.length, true);
      let at = 6 + parts.length * 2;
      parts.forEach((p, f) => {
        v.setUint16(6 + f * 2, p.length, true);
        packet.set(p, at);
        at += p.length;
        cursors[f] += p.length;
      });
      push(packet);
    }
    const hv = new DataView(sectionHeader.buffer);
    hv.setUint8(0, 1);
    hv.setBigUint64(8, BigInt(length - sectionStart), true);
    hv.setBigUint64(16, BigInt(physical(dataStart)), true);
    const pose = scan.pose
      ? `<pose type="Structure"><rotation type="Structure">${['w', 'x', 'y', 'z'].map((k, i) => `<${k} type="Float">${(scan.pose!.rotation ?? [1, 0, 0, 0])[i]}</${k}>`).join('')}</rotation><translation type="Structure">${['x', 'y', 'z'].map((k, i) => `<${k} type="Float">${(scan.pose!.translation ?? [0, 0, 0])[i]}</${k}>`).join('')}</translation></pose>`
      : '';
    const limits = scan.intensity
      ? '<intensityLimits type="Structure"><intensityMinimum type="Integer">0</intensityMinimum><intensityMaximum type="Integer">65535</intensityMaximum></intensityLimits>'
      : '';
    const colorLimits = scan.rgb
      ? `<colorLimits type="Structure">${['Red', 'Green', 'Blue'].map((c) => `<color${c}Minimum type="Integer">0</color${c}Minimum><color${c}Maximum type="Integer">255</color${c}Maximum>`).join('')}</colorLimits>`
      : '';
    xmlScans.push(
      `<vectorChild type="Structure"><guid type="String"><![CDATA[scan-${s}]]></guid><name type="String"><![CDATA[${scan.name ?? `scan ${s}`}]]></name>${pose}${limits}${colorLimits}<points type="CompressedVector" fileOffset="${physical(sectionStart)}" recordCount="${n}"><prototype type="Structure">${fields.map((f) => f.xml).join('')}</prototype><codecs type="Vector" allowHeterogeneousChildren="1"/></points></vectorChild>`,
    );
  }
  const xml = new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?>\n<e57Root type="Structure" xmlns="http://www.astm.org/COMMIT/E57/2010-e57-v1.0"><formatName type="String"><![CDATA[ASTM E57 3D Imaging Data File]]></formatName><guid type="String"><![CDATA[margo]]></guid><versionMajor type="Integer">1</versionMajor><versionMinor type="Integer">0</versionMinor><data3D type="Vector" allowHeterogeneousChildren="1">${xmlScans.join('')}</data3D><images2D type="Vector" allowHeterogeneousChildren="1"/></e57Root>`,
  );
  const xmlStart = length;
  push(xml);
  const pages = Math.ceil(length / PAYLOAD),
    out = new Uint8Array(pages * PAGE),
    flat = new Uint8Array(pages * PAYLOAD);
  let at = 0;
  for (const part of logical) {
    flat.set(part, at);
    at += part.byteLength;
  }
  const hv = new DataView(flat.buffer);
  flat.set(new TextEncoder().encode('ASTM-E57'));
  hv.setUint32(8, 1, true);
  hv.setUint32(12, 0, true);
  hv.setBigUint64(16, BigInt(out.byteLength), true);
  hv.setBigUint64(24, BigInt(physical(xmlStart)), true);
  hv.setBigUint64(32, BigInt(xml.byteLength), true);
  hv.setBigUint64(40, BigInt(PAGE), true);
  for (let p = 0; p < pages; p++) {
    const payload = flat.subarray(p * PAYLOAD, (p + 1) * PAYLOAD);
    out.set(payload, p * PAGE);
    new DataView(out.buffer).setUint32(p * PAGE + PAYLOAD, crc32c(payload), false);
  }
  return out;
}
