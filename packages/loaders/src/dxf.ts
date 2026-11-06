// DXF (AutoCAD Drawing Exchange Format), written from Autodesk's published DXF reference: ASCII files and binary files
// (R13 and later), the HEADER units and version, LAYER table colours and visibility, BLOCKS expanded through INSERT
// (rows and columns included) and DIMENSION, and the model-space entities a viewer draws. Faces (3DFACE, SOLID, TRACE,
// polyface and polygon-mesh POLYLINEs, MESH) become one triangle list; curves (LINE, polylines with bulges, ARC,
// CIRCLE, ELLIPSE, SPLINE) become line segments; ACIS solids (3DSOLID, BODY, REGION) are handed back as SAT text.
import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import { checkCount, latin1, limits, toBytes, type BinaryInput } from './util.js';

const F = 'DXF';

/** Options of {@link parseDXF}. */
export interface DXFOptions extends ParseLimits {
  /** `'meters'` (default) scales the drawing by its `$INSUNITS`; `'file'` keeps drawing units. */
  units?: 'meters' | 'file';
  /** Line segments per full turn of an arc, circle, ellipse or bulge, 8 to 4,096 (default 64). */
  arcSegments?: number;
  /** Line segments per knot span of a spline, 1 to 1,024 (default 16). */
  splineSegments?: number;
  /** Most line segments in all (default 8,000,000). */
  maxSegments?: number;
  /** Most block references expanded, rows and columns counted one by one (default 1,000,000). */
  maxInserts?: number;
  /** Deepest nesting of block references (default 32). */
  maxDepth?: number;
}

/** sRGB in 0..1. */
export type DXFColor = [number, number, number];

/** A layer from the LAYER table. */
export interface DXFLayer {
  name: string;
  color: DXFColor;
  /** False when the layer is off or frozen: its entities are left out. */
  visible: boolean;
}

/** A TEXT or MTEXT entity: the string (MTEXT formatting codes removed) and where it stands. */
export interface DXFText {
  text: string;
  /** Insertion point, in the output's units. */
  position: [number, number, number];
  /** Character height, in the output's units. */
  height: number;
  /** Direction of the baseline, a unit vector. */
  direction: [number, number, number];
  /** The text's plane normal, a unit vector. */
  normal: [number, number, number];
  layer: string;
  color: DXFColor;
}

/** An ACIS solid, body or region: its SAT text (decoded) and the placement of the block reference that holds it. */
export interface DXFSolid {
  type: '3DSOLID' | 'BODY' | 'REGION';
  /** The SAT data, lines joined with '\n'. */
  sat: string;
  /** Column-major 4x4 from the SAT's coordinates to the output's (units and block placements). */
  transform: number[];
  layer: string;
  color: DXFColor;
}

/** Line segments, two vertices each, grouped by layer and colour. */
export interface DXFLines {
  positions: Float32Array;
  /** sRGB per vertex in 0..1. */
  colors: Float32Array;
  /** Vertex ranges (`start`, `count` in vertices), one per layer and colour. */
  groups: LoadedGroup[];
}

/** What {@link parseDXF} reads. */
export interface DXFResult {
  /** Faces as triangles, grouped by layer (`name`) and colour; empty when the drawing has none. Not consistently wound. */
  mesh: LoadedGeometry;
  lines: DXFLines;
  /** POINT entities, xyz each. */
  points: Float32Array;
  texts: DXFText[];
  layers: DXFLayer[];
  solids: DXFSolid[];
  /** Meters per drawing unit, from `$INSUNITS` (1 when the drawing has none). */
  unit: number;
  /** `$ACADVER`, such as 'AC1032'. */
  version: string;
  /** Entities left out, by type: unsupported kinds, paper space, binary ACIS data. */
  skipped: Record<string, number>;
}

/** Meters per unit for `$INSUNITS` codes 0 to 20 (0: unitless). */
const UNITS = [
  1, 0.0254, 0.3048, 1609.344, 0.001, 0.01, 1, 1000, 2.54e-8, 2.54e-5, 0.9144, 1e-10, 1e-9, 1e-6, 0.1, 10, 100, 1e9,
  149597870700, 9.4607304725808e15, 3.0856775814913673e16,
];

/** The AutoCAD Color Index as sRGB 0..1: 1 to 9 named, 10 to 249 a 24-hue wheel at five values (odd: half saturation), 250 to 255 greys. */
const ACI: DXFColor[] = (() => {
  const table: DXFColor[] = [[0, 0, 0]];
  const named: DXFColor[] = [
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 1, 1],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [128 / 255, 128 / 255, 128 / 255],
    [192 / 255, 192 / 255, 192 / 255],
  ];
  table.push(...named);
  const values = [255, 204, 153, 127, 76];
  for (let i = 10; i < 250; i++) {
    const hue = (Math.floor((i - 10) / 10) * 15) / 60,
      k = (i - 10) % 10,
      v = values[k >> 1] / 255,
      low = k & 1 ? v / 2 : 0,
      sector = Math.floor(hue) % 6,
      f = hue - Math.floor(hue),
      rise = low + (v - low) * f,
      fall = v - (v - low) * f;
    table.push(
      (
        [
          [v, rise, low],
          [fall, v, low],
          [low, v, rise],
          [low, fall, v],
          [rise, low, v],
          [v, low, fall],
        ] as DXFColor[]
      )[sector],
    );
  }
  for (const g of [51, 91, 132, 173, 214, 255]) table.push([g / 255, g / 255, g / 255]);
  return table;
})();

type Value = string | number;
interface Entity {
  type: string;
  codes: number[];
  values: Value[];
}

/** Group code value types for binary DXF, by code. */
function binaryKind(code: number): 'string' | 'double' | 'int16' | 'int32' | 'int64' | 'bool' | 'binary' {
  if (code <= 9 || code === 100 || code === 102 || code === 105 || code === 999) return 'string';
  if (code < 60 || (code >= 110 && code < 150) || (code >= 210 && code < 240) || (code >= 460 && code < 470))
    return 'double';
  if (code >= 1010 && code < 1060) return 'double';
  if (code < 80 || (code >= 170 && code < 180) || (code >= 270 && code < 290) || (code >= 370 && code < 390))
    return 'int16';
  if ((code >= 400 && code < 410) || (code >= 1060 && code < 1071)) return 'int16';
  if ((code >= 90 && code < 100) || (code >= 420 && code < 430) || (code >= 440 && code < 460) || code === 1071)
    return 'int32';
  if (code >= 160 && code < 170) return 'int64';
  if (code >= 290 && code < 300) return 'bool';
  if ((code >= 310 && code < 320) || code === 1004) return 'binary';
  return 'string';
}

/** Group codes and values of the whole file, in order. */
function readPairs(bytes: Uint8Array, decode: (b: Uint8Array) => string): { codes: number[]; values: Value[] } {
  const codes: number[] = [],
    values: Value[] = [],
    sentinel = 'AutoCAD Binary DXF\r\n\x1a\0';
  if (bytes.length >= 22 && latin1(bytes, 0, 22) === sentinel) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 22;
    // Before R13 a group code is one byte, 255 announcing a two-byte code; the first group, 0 SECTION, tells which.
    const wide = bytes[at + 1] === 0;
    const need = (n: number) => {
      if (at + n > bytes.length) throw new LoaderError(F, 'truncated', `binary DXF ends inside a group at byte ${at}`);
    };
    while (at < bytes.length) {
      need(wide ? 2 : 1);
      let code = wide ? view.getUint16(at, true) : bytes[at];
      at += wide ? 2 : 1;
      if (!wide && code === 255) {
        need(2);
        code = view.getUint16(at, true);
        at += 2;
      }
      let value: Value;
      switch (binaryKind(code)) {
        case 'double':
          need(8);
          value = view.getFloat64(at, true);
          at += 8;
          break;
        case 'int16':
          need(2);
          value = view.getInt16(at, true);
          at += 2;
          break;
        case 'int32':
          need(4);
          value = view.getInt32(at, true);
          at += 4;
          break;
        case 'int64':
          need(8);
          value = Number(view.getBigInt64(at, true));
          at += 8;
          break;
        case 'bool':
          need(1);
          value = bytes[at++];
          break;
        case 'binary': {
          need(1);
          const length = bytes[at++];
          need(length);
          value = '';
          at += length;
          break;
        }
        default: {
          let end = at;
          while (end < bytes.length && bytes[end]) end++;
          if (end >= bytes.length) throw new LoaderError(F, 'truncated', 'binary DXF ends inside a string');
          value = decode(bytes.subarray(at, end));
          at = end + 1;
        }
      }
      codes.push(code);
      values.push(value);
      if (code === 0 && value === 'EOF') break;
    }
    return { codes, values };
  }
  const lines = decode(bytes).split(/\r\n|\r|\n/);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const text = lines[i].trim();
    if (!text) {
      if (lines.slice(i).every((l) => !l.trim())) break;
      throw new LoaderError(F, 'syntax', `line ${i + 1}: empty group code`);
    }
    const code = Number(text);
    if (!Number.isInteger(code))
      throw new LoaderError(F, 'syntax', `line ${i + 1}: group code "${text.slice(0, 20)}" is not a number`);
    const value = lines[i + 1];
    codes.push(code);
    values.push(code === 0 || code === 2 || code === 8 ? value.trim() : value);
    if (code === 0 && value.trim() === 'EOF') break;
  }
  return { codes, values };
}

/** `\U+XXXX` escapes (pre-2007 files) to characters. */
const unicode = (s: string) =>
  s.replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** MTEXT's inline formatting codes removed: paragraphs become line breaks. */
function plainMText(s: string): string {
  return unicode(s)
    .replace(/\\P/g, '\n')
    .replace(/\\[ACcFfHhQqTtWwp][^;\\{}]*;/g, '')
    .replace(/\\S([^;]*)[/#^]([^;]*);/g, '$1/$2')
    .replace(/\\[LlOoKkNX~]/g, (m) => (m === '\\~' ? ' ' : ''))
    .replace(/\\([\\{}])/g, '$1')
    .replace(/[{}]/g, '');
}

/** ACIS data of a DXF 3DSOLID: caret escapes undone, then each character but space mapped back (159 - code). */
function decodeSAT(lines: string[]): string {
  return lines
    .map((line) =>
      line
        .replace(/\^(.)/g, (_, c: string) => (c === ' ' ? '^' : String.fromCharCode(c.charCodeAt(0) - 64)))
        .replace(/[^ ]/g, (c) => {
          const code = c.charCodeAt(0);
          return code > 32 && code < 127 ? String.fromCharCode(159 - code) : c;
        }),
    )
    .join('\n');
}

// --- 4x4 column-major ---------------------------------------------------------------------------------------------
type M4 = Float64Array;
const identity = (): M4 => Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
function mul(a: M4, b: M4): M4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}
const apply = (m: M4, x: number, y: number, z: number): [number, number, number] => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
const direction = (m: M4, x: number, y: number, z: number): [number, number, number] => {
  const v: [number, number, number] = [
      m[0] * x + m[4] * y + m[8] * z,
      m[1] * x + m[5] * y + m[9] * z,
      m[2] * x + m[6] * y + m[10] * z,
    ],
    l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const translate = (x: number, y: number, z: number): M4 =>
  Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1);
const scaling = (x: number, y: number, z: number): M4 =>
  Float64Array.of(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1);
const rotateZ = (a: number): M4 => {
  const c = Math.cos(a),
    s = Math.sin(a);
  return Float64Array.of(c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
};
/** The Arbitrary Axis Algorithm: an entity's object coordinate system from its extrusion direction. */
function ocs(n: [number, number, number]): M4 {
  const l = Math.hypot(n[0], n[1], n[2]);
  if (!l || (n[0] === 0 && n[1] === 0 && n[2] > 0)) return identity();
  const z = [n[0] / l, n[1] / l, n[2] / l],
    w = Math.abs(z[0]) < 1 / 64 && Math.abs(z[1]) < 1 / 64 ? [0, 1, 0] : [0, 0, 1],
    x0 = [w[1] * z[2] - w[2] * z[1], w[2] * z[0] - w[0] * z[2], w[0] * z[1] - w[1] * z[0]],
    xl = Math.hypot(x0[0], x0[1], x0[2]),
    x = [x0[0] / xl, x0[1] / xl, x0[2] / xl],
    y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return Float64Array.of(x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1);
}

/**
 * Reads a DXF drawing (ASCII or binary) into faces, line segments, points, texts and ACIS solids, in
 * meters by default. Throws a {@link LoaderError}: `'syntax'` or `'truncated'` for a malformed file, `'limit'` past a
 * limit, `'range'` for a bad option.
 */
export function parseDXF(input: BinaryInput, options: DXFOptions = {}): DXFResult {
  const bytes = toBytes(input, F),
    { maxVertices, maxTriangles } = limits(options, F),
    option = (value: number | undefined, fallback: number, low: number, high: number, label: string) => {
      if (value === undefined) return fallback;
      if (!Number.isInteger(value) || value < low || value > high)
        throw new LoaderError(F, 'range', `${label} must be a whole number from ${low} to ${high}`);
      return value;
    },
    arcSegments = option(options.arcSegments, 64, 8, 4096, 'arcSegments'),
    splineSegments = option(options.splineSegments, 16, 1, 1024, 'splineSegments'),
    maxSegments = option(options.maxSegments, 8_000_000, 0, 2 ** 31, 'maxSegments'),
    maxInserts = option(options.maxInserts, 1_000_000, 0, 2 ** 31, 'maxInserts'),
    maxDepth = option(options.maxDepth, 32, 0, 256, 'maxDepth');
  if (options.units !== undefined && options.units !== 'meters' && options.units !== 'file')
    throw new LoaderError(F, 'range', "units must be 'meters' or 'file'");

  // Text: UTF-8 from AutoCAD 2007 (AC1021) on, the drawing's code page (Windows-1252 assumed) before.
  const head = latin1(bytes, 0, Math.min(bytes.length, 1 << 16)),
    // Text writes the name and value on lines; binary as a zero-ended string, group code 1 (one byte before R13), string.
    version = /\$ACADVER(?:\s*\r?\n\s*1\s*\r?\n|\0\x01\0?)([^\r\n\0]*)/.exec(head)?.[1]?.trim() ?? '',
    utf8 = version >= 'AC1021',
    decoder = (() => {
      try {
        return new TextDecoder(utf8 ? 'utf-8' : 'windows-1252');
      } catch {
        return undefined;
      }
    })(),
    decode = (b: Uint8Array) => (decoder ? decoder.decode(b) : latin1(b));
  const { codes, values } = readPairs(bytes, decode);

  const num = (v: Value | undefined, fallback = 0) => {
    const n = typeof v === 'number' ? v : v === undefined ? Number.NaN : Number(v.trim());
    return Number.isFinite(n) ? n : fallback;
  };
  const str = (v: Value | undefined) => (v === undefined ? '' : String(v));

  // --- sections ---------------------------------------------------------------------------------------------------
  const header = new Map<string, Map<number, Value>>(),
    layers = new Map<string, DXFLayer & { aci: number }>(),
    blocks = new Map<string, { base: [number, number, number]; entities: Entity[] }>(),
    model: Entity[] = [];
  /** Entities from pair `i` (a code 0) up to the end of the section or `stop`. */
  const entitiesFrom = (i: number, stop: (type: string) => boolean): { list: Entity[]; next: number } => {
    const list: Entity[] = [];
    while (i < codes.length) {
      if (codes[i] !== 0) {
        i++;
        continue;
      }
      const type = str(values[i]).trim().toUpperCase();
      if (stop(type)) return { list, next: i };
      const entity: Entity = { type, codes: [], values: [] };
      i++;
      while (i < codes.length && codes[i] !== 0) {
        entity.codes.push(codes[i]);
        entity.values.push(values[i]);
        i++;
      }
      list.push(entity);
    }
    return { list, next: i };
  };
  for (let i = 0; i < codes.length; ) {
    if (!(codes[i] === 0 && str(values[i]).trim() === 'SECTION')) {
      i++;
      continue;
    }
    const name =
      codes[i + 1] === 2
        ? str(values[i + 1])
            .trim()
            .toUpperCase()
        : '';
    i += 2;
    if (name === 'HEADER') {
      let variable = '';
      for (; i < codes.length && !(codes[i] === 0 && str(values[i]).trim() === 'ENDSEC'); i++)
        if (codes[i] === 9) {
          variable = str(values[i]).trim();
          header.set(variable, new Map());
        } else if (variable) header.get(variable)!.set(codes[i], values[i]);
    } else if (name === 'TABLES' || name === 'BLOCKS' || name === 'ENTITIES') {
      const { list, next } = entitiesFrom(i, (type) => type === 'ENDSEC');
      i = next;
      if (name === 'TABLES') {
        for (const e of list)
          if (e.type === 'LAYER') {
            const get = (code: number) => e.values[e.codes.indexOf(code)],
              layerName = unicode(str(get(2)).trim()),
              aci = num(get(62), 7),
              flags = num(get(70)),
              rgb = e.codes.includes(420) ? num(get(420)) : undefined;
            layers.set(layerName, {
              name: layerName,
              aci: Math.abs(aci),
              color:
                rgb === undefined
                  ? ([...(ACI[Math.abs(aci)] ?? ACI[7])] as DXFColor)
                  : [((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255],
              visible: aci >= 0 && !(flags & 1),
            });
          }
      } else if (name === 'BLOCKS') {
        let current: { name: string; base: [number, number, number]; entities: Entity[] } | undefined;
        for (const e of list) {
          if (e.type === 'BLOCK') {
            const get = (code: number) => e.values[e.codes.indexOf(code)];
            current = {
              name: unicode(str(get(2)).trim()),
              base: [num(get(10)), num(get(20)), num(get(30))],
              entities: [],
            };
            blocks.set(current.name, current);
          } else if (e.type === 'ENDBLK') current = undefined;
          else current?.entities.push(e);
        }
      } else model.push(...list);
    } else i++;
  }

  const insUnits = num(header.get('$INSUNITS')?.get(70), 0),
    unit = UNITS[insUnits] ?? 1,
    scale = options.units === 'file' ? 1 : unit;

  // --- output -----------------------------------------------------------------------------------------------------
  const faceGroups = new Map<string, { name: string; color: DXFColor; positions: number[] }>(),
    lineGroups = new Map<string, { name: string; color: DXFColor; positions: number[] }>(),
    points: number[] = [],
    texts: DXFText[] = [],
    solids: DXFSolid[] = [],
    skipped: Record<string, number> = {};
  let faceVertices = 0,
    segments = 0,
    inserts = 0;
  const skip = (type: string) => {
    skipped[type] = (skipped[type] ?? 0) + 1;
  };
  const group = (map: typeof faceGroups, layer: string, color: DXFColor) => {
    const key = `${layer}\u0000${color.join(',')}`;
    let g = map.get(key);
    if (!g) map.set(key, (g = { name: layer, color, positions: [] }));
    return g.positions;
  };
  const triangle = (out: number[], a: number[], b: number[], c: number[]) => {
    faceVertices += 3;
    checkCount(faceVertices, maxVertices, F, 'face vertex');
    checkCount(faceVertices / 3, maxTriangles, F, 'triangle');
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  };
  /** A polyline's points as segments (closed adds the last to the first). */
  const polyline = (out: number[], list: number[][], closed: boolean) => {
    const n = list.length;
    for (let k = 0; k + 1 < n + (closed && n > 2 ? 1 : 0); k++) {
      const a = list[k],
        b = list[(k + 1) % n];
      segments++;
      if (segments > maxSegments)
        throw new LoaderError(F, 'limit', `line segment count exceeds the limit of ${maxSegments}`);
      out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  };
  /** Points of an arc about (cx, cy) at height z, from angle a0 through sweep (radians, CCW positive). */
  const arc = (cx: number, cy: number, z: number, r: number, a0: number, sweep: number) => {
    const n = Math.max(1, Math.ceil((arcSegments * Math.abs(sweep)) / (2 * Math.PI))),
      out: number[][] = [];
    for (let k = 0; k <= n; k++) {
      const a = a0 + (sweep * k) / n;
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
    }
    return out;
  };
  /** 2D vertices with bulges (polyline arcs) as points, at height z. */
  const bulged = (vertices: { x: number; y: number; bulge: number }[], closed: boolean, z: number) => {
    const out: number[][] = [];
    const n = vertices.length;
    for (let k = 0; k < n; k++) {
      const a = vertices[k],
        last = k === n - 1;
      out.push([a.x, a.y, z]);
      if (last && !closed) break;
      const b = vertices[(k + 1) % n];
      if (!a.bulge || (a.x === b.x && a.y === b.y)) continue;
      const dx = b.x - a.x,
        dy = b.y - a.y,
        chord = Math.hypot(dx, dy),
        theta = 4 * Math.atan(a.bulge),
        offset = (chord * (1 - a.bulge * a.bulge)) / (4 * a.bulge),
        cx = (a.x + b.x) / 2 - (dy / chord) * offset,
        cy = (a.y + b.y) / 2 + (dx / chord) * offset,
        r = Math.hypot(a.x - cx, a.y - cy),
        points = arc(cx, cy, z, r, Math.atan2(a.y - cy, a.x - cx), theta);
      out.push(...points.slice(1, -1));
    }
    if (closed && n > 1) out.push(out[0]);
    return out;
  };
  /** A NURBS curve sampled per knot span (de Boor on homogeneous points). */
  const spline = (degree: number, knots: number[], control: number[][], weights: number[]) => {
    const n = control.length,
      p = degree;
    if (n < 2 || p < 1 || knots.length !== n + p + 1) return control;
    const h = control.map((c, i) => {
        const w = weights[i] ?? 1;
        return [c[0] * w, c[1] * w, c[2] * w, w];
      }),
      at = (t: number, span: number) => {
        const d = Array.from({ length: p + 1 }, (_, j) => [...h[span - p + j]]);
        for (let r = 1; r <= p; r++)
          for (let j = p; j >= r; j--) {
            const i = span - p + j,
              denominator = knots[i + p - r + 1] - knots[i],
              alpha = denominator ? (t - knots[i]) / denominator : 0;
            for (let k = 0; k < 4; k++) d[j][k] = (1 - alpha) * d[j - 1][k] + alpha * d[j][k];
          }
        const w = d[p][3] || 1;
        return [d[p][0] / w, d[p][1] / w, d[p][2] / w];
      },
      out: number[][] = [];
    for (let span = p; span < n; span++) {
      const t0 = knots[span],
        t1 = knots[span + 1];
      if (!(t1 > t0)) continue;
      for (let k = out.length ? 1 : 0; k <= splineSegments; k++)
        out.push(at(t0 + ((t1 - t0) * k) / splineSegments, span));
    }
    return out.length ? out : control;
  };

  interface Context {
    matrix: M4;
    /** Layer of the INSERT: entities on layer 0 inside a block take it. */
    layer: string;
    /** Colour of the INSERT: entities coloured BYBLOCK take it. */
    color: DXFColor;
    depth: number;
  }
  const emit = (e: Entity, context: Context): void => {
    const first = (code: number) => {
        const k = e.codes.indexOf(code);
        return k < 0 ? undefined : e.values[k];
      },
      n = (code: number, fallback = 0) => num(first(code), fallback);
    if (n(67) === 1) {
      skip(`${e.type} (paper space)`);
      return;
    }
    if (n(60) === 1) return;
    const ownLayer = unicode(str(first(8)).trim() || '0'),
      layerName = ownLayer === '0' && context.depth > 0 ? context.layer : ownLayer,
      layer = layers.get(layerName);
    if (layer && !layer.visible) return;
    const aci = n(62, 256),
      rgb = first(420),
      color: DXFColor =
        rgb !== undefined
          ? [((num(rgb) >> 16) & 255) / 255, ((num(rgb) >> 8) & 255) / 255, (num(rgb) & 255) / 255]
          : aci === 0
            ? context.color
            : aci === 256
              ? (layer?.color ?? ACI[7])
              : (ACI[Math.abs(aci)] ?? ACI[7]),
      extrusion: [number, number, number] = [n(210, 0), n(220, 0), n(230, 1)],
      m = context.matrix,
      world = (p: number[]) => apply(m, p[0], p[1], p[2]),
      inOCS = (p: number[]) => {
        const o = ocs(extrusion);
        return apply(m, ...apply(o, p[0], p[1], p[2]));
      },
      faces = () => group(faceGroups, layerName, color),
      lineOut = () => group(lineGroups, layerName, color);
    switch (e.type) {
      case 'LINE':
        polyline(lineOut(), [world([n(10), n(20), n(30)]), world([n(11), n(21), n(31)])], false);
        return;
      case 'POINT': {
        const p = world([n(10), n(20), n(30)]);
        points.push(p[0], p[1], p[2]);
        return;
      }
      case 'CIRCLE':
        polyline(lineOut(), arc(n(10), n(20), n(30), n(40), 0, 2 * Math.PI).map(inOCS), false);
        return;
      case 'ARC': {
        const a0 = (n(50) * Math.PI) / 180;
        let sweep = (n(51) * Math.PI) / 180 - a0;
        while (sweep <= 0) sweep += 2 * Math.PI;
        polyline(lineOut(), arc(n(10), n(20), n(30), n(40), a0, sweep).map(inOCS), false);
        return;
      }
      case 'ELLIPSE': {
        const c = [n(10), n(20), n(30)],
          major = [n(11), n(21), n(31)],
          ratio = n(40, 1),
          z = extrusion,
          cross = [
            z[1] * major[2] - z[2] * major[1],
            z[2] * major[0] - z[0] * major[2],
            z[0] * major[1] - z[1] * major[0],
          ],
          cl = Math.hypot(cross[0], cross[1], cross[2]) || 1,
          ml = Math.hypot(major[0], major[1], major[2]),
          minor = cross.map((v) => (v / cl) * ml * ratio),
          t0 = n(41, 0);
        let sweep = n(42, 2 * Math.PI) - t0;
        while (sweep <= 0) sweep += 2 * Math.PI;
        const count = Math.max(1, Math.ceil((arcSegments * sweep) / (2 * Math.PI))),
          list: number[][] = [];
        for (let k = 0; k <= count; k++) {
          const t = t0 + (sweep * k) / count;
          list.push(world([0, 1, 2].map((a) => c[a] + major[a] * Math.cos(t) + minor[a] * Math.sin(t))));
        }
        polyline(lineOut(), list, false);
        return;
      }
      case 'LWPOLYLINE': {
        const vertices: { x: number; y: number; bulge: number }[] = [];
        for (let k = 0; k < e.codes.length; k++)
          if (e.codes[k] === 10) vertices.push({ x: num(e.values[k]), y: 0, bulge: 0 });
          else if (e.codes[k] === 20 && vertices.length) vertices[vertices.length - 1].y = num(e.values[k]);
          else if (e.codes[k] === 42 && vertices.length) vertices[vertices.length - 1].bulge = num(e.values[k]);
        polyline(lineOut(), bulged(vertices, !!(n(70) & 1), n(38)).map(inOCS), false);
        return;
      }
      case 'POLYLINE':
        // Its vertices travel with it (gathered below as e.vertices).
        polylineEntity(e as Entity & { vertices?: Entity[] }, n(70), n(30), world, inOCS, faces, lineOut, n);
        return;
      case 'SPLINE': {
        const knots: number[] = [],
          weights: number[] = [],
          control: number[][] = [],
          fit: number[][] = [];
        for (let k = 0; k < e.codes.length; k++) {
          const code = e.codes[k],
            v = num(e.values[k]);
          if (code === 40) knots.push(v);
          else if (code === 41) weights.push(v);
          else if (code === 10) control.push([v, 0, 0]);
          else if (code === 20 && control.length) control[control.length - 1][1] = v;
          else if (code === 30 && control.length) control[control.length - 1][2] = v;
          else if (code === 11) fit.push([v, 0, 0]);
          else if (code === 21 && fit.length) fit[fit.length - 1][1] = v;
          else if (code === 31 && fit.length) fit[fit.length - 1][2] = v;
        }
        const list = control.length ? spline(n(71, 3), knots, control, weights) : fit;
        polyline(lineOut(), list.map(world), false);
        return;
      }
      case '3DFACE': {
        const p = [0, 1, 2, 3].map((k) => world([n(10 + k), n(20 + k), n(30 + k)]));
        triangle(faces(), p[0], p[1], p[2]);
        if (p[3].some((v, k) => v !== p[2][k])) triangle(faces(), p[0], p[2], p[3]);
        return;
      }
      case 'SOLID':
      case 'TRACE': {
        // Corners 3 and 4 are written in zig-zag order.
        const p = [0, 1, 3, 2].map((k) => inOCS([n(10 + k), n(20 + k), n(30 + k)]));
        triangle(faces(), p[0], p[1], p[2]);
        if (p[2].some((v, k) => v !== p[3][k])) triangle(faces(), p[0], p[2], p[3]);
        return;
      }
      case 'MESH': {
        const vertices: number[][] = [];
        let k = e.codes.indexOf(92);
        if (k < 0) return;
        const count = num(e.values[k]);
        checkCount(count, maxVertices, F, 'MESH vertex');
        for (k++; k < e.codes.length && vertices.length < count; k++)
          if (e.codes[k] === 10) vertices.push([num(e.values[k]), num(e.values[k + 1]), num(e.values[k + 2])]);
        while (k < e.codes.length && e.codes[k] !== 93) k++;
        const size = num(e.values[k]),
          list: number[] = [];
        for (k++; k < e.codes.length && list.length < size && e.codes[k] === 90; k++) list.push(num(e.values[k]));
        const at = vertices.map(world);
        for (let f = 0; f < list.length; ) {
          const sides = list[f],
            ids = list.slice(f + 1, f + 1 + sides);
          f += 1 + sides;
          if (ids.length < 3 || ids.some((id) => !(id >= 0 && id < at.length)))
            throw new LoaderError(F, 'range', 'MESH face index outside its vertices');
          for (let t = 1; t + 1 < ids.length; t++) triangle(faces(), at[ids[0]], at[ids[t]], at[ids[t + 1]]);
        }
        return;
      }
      case 'TEXT':
      case 'MTEXT': {
        const mtext = e.type === 'MTEXT',
          raw = mtext
            ? e.codes.flatMap((c, k) => (c === 3 ? [str(e.values[k])] : [])).join('') + str(first(1))
            : str(first(1)),
          aligned = !mtext && (n(72) !== 0 || n(73) !== 0) && first(11) !== undefined,
          o = ocs(extrusion),
          local = mtext
            ? [n(10), n(20), n(30)]
            : apply(o, aligned ? n(11) : n(10), aligned ? n(21) : n(20), aligned ? n(31) : n(30)),
          angle = mtext ? n(50) : (n(50) * Math.PI) / 180,
          xAxis =
            mtext && first(11) !== undefined
              ? [n(11), n(21), n(31)]
              : direction(o, Math.cos(angle), Math.sin(angle), 0),
          position = apply(m, local[0], local[1], local[2]),
          height = n(40) * Math.hypot(m[4], m[5], m[6]);
        texts.push({
          text: mtext ? plainMText(raw) : unicode(raw),
          position,
          height,
          direction: direction(m, xAxis[0], xAxis[1], xAxis[2]),
          normal: direction(m, ...direction(o, 0, 0, 1)),
          layer: layerName,
          color,
        });
        return;
      }
      case 'INSERT':
      case 'DIMENSION': {
        const name = unicode(str(first(2)).trim()),
          block = blocks.get(name);
        if (!block) {
          if (name) skip(`${e.type} of a missing block`);
          return;
        }
        if (context.depth >= maxDepth)
          throw new LoaderError(F, 'limit', `block references nest deeper than maxDepth ${maxDepth} (at "${name}")`);
        const base = translate(-block.base[0], -block.base[1], -block.base[2]);
        if (e.type === 'DIMENSION') {
          // A dimension's anonymous block is drawn in world coordinates.
          inserts++;
          if (inserts > maxInserts)
            throw new LoaderError(F, 'limit', `block references exceed maxInserts ${maxInserts}`);
          for (const child of block.entities)
            emit(child, { matrix: mul(m, base), layer: layerName, color, depth: context.depth + 1 });
          return;
        }
        const o = ocs(extrusion),
          placed = mul(mul(o, translate(n(10), n(20), n(30))), rotateZ((n(50) * Math.PI) / 180)),
          scaled = mul(scaling(n(41, 1), n(42, 1), n(43, 1)), base),
          columns = Math.max(1, n(70, 1)),
          rows = Math.max(1, n(71, 1));
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < columns; c++) {
            inserts++;
            if (inserts > maxInserts)
              throw new LoaderError(F, 'limit', `block references exceed maxInserts ${maxInserts}`);
            const local = mul(mul(placed, translate(c * n(44), r * n(45), 0)), scaled);
            for (const child of block.entities)
              emit(child, { matrix: mul(m, local), layer: layerName, color, depth: context.depth + 1 });
          }
        return;
      }
      case '3DSOLID':
      case 'BODY':
      case 'REGION': {
        const lines: string[] = [];
        for (let k = 0; k < e.codes.length; k++)
          if (e.codes[k] === 1) lines.push(str(e.values[k]));
          else if (e.codes[k] === 3 && lines.length) lines[lines.length - 1] += str(e.values[k]);
        if (!lines.length) {
          // AutoCAD 2013 and later keep the ACIS data as binary SAB in the ACDSDATA section.
          skip(`${e.type} (binary ACIS)`);
          return;
        }
        solids.push({ type: e.type, sat: decodeSAT(lines), transform: [...m], layer: layerName, color });
        return;
      }
      case 'VERTEX':
      case 'SEQEND':
      case 'ATTRIB':
      case 'ATTDEF':
      case 'VIEWPORT':
        return;
      default:
        skip(e.type);
    }
  };
  /** POLYLINE: polyface mesh, polygon mesh, 3D polyline, or 2D polyline (with bulges, in its OCS at its elevation). */
  const polylineEntity = (
    e: Entity & { vertices?: Entity[] },
    flags: number,
    elevation: number,
    world: (p: number[]) => [number, number, number],
    inOCS: (p: number[]) => [number, number, number],
    faces: () => number[],
    lineOut: () => number[],
    n: (code: number, fallback?: number) => number,
  ) => {
    const vertices = (e.vertices ?? []).map((v) => {
      const get = (code: number, fallback = 0) => {
        const k = v.codes.indexOf(code);
        return k < 0 ? fallback : num(v.values[k], fallback);
      };
      return {
        p: [get(10), get(20), get(30)],
        bulge: get(42),
        flags: get(70),
        ids: [get(71), get(72), get(73), get(74)],
      };
    });
    if (flags & 64) {
      const positions = vertices.filter((v) => v.flags & 128 && v.flags & 64).map((v) => world(v.p));
      for (const v of vertices)
        if (v.flags & 128 && !(v.flags & 64)) {
          const ids = v.ids.map(Math.abs).filter((id) => id > 0);
          if (ids.some((id) => id > positions.length))
            throw new LoaderError(F, 'range', 'polyface face index outside its vertices');
          for (let t = 1; t + 1 < ids.length; t++)
            triangle(faces(), positions[ids[0] - 1], positions[ids[t] - 1], positions[ids[t + 1] - 1]);
        }
    } else if (flags & 16) {
      const rows = n(71),
        columns = n(72),
        at = vertices.map((v) => world(v.p));
      if (rows * columns > at.length || rows < 2 || columns < 2)
        throw new LoaderError(F, 'range', `polygon mesh of ${rows} x ${columns} has ${at.length} vertices`);
      const closedM = !!(flags & 1),
        closedN = !!(flags & 32);
      for (let i = 0; i < rows - (closedM ? 0 : 1); i++)
        for (let j = 0; j < columns - (closedN ? 0 : 1); j++) {
          const a = at[i * columns + j],
            b = at[i * columns + ((j + 1) % columns)],
            c = at[((i + 1) % rows) * columns + ((j + 1) % columns)],
            d = at[((i + 1) % rows) * columns + j];
          triangle(faces(), a, b, c);
          triangle(faces(), a, c, d);
        }
    } else if (flags & 8)
      polyline(
        lineOut(),
        vertices.map((v) => world(v.p)),
        !!(flags & 1),
      );
    else
      polyline(
        lineOut(),
        bulged(
          vertices.map((v) => ({ x: v.p[0], y: v.p[1], bulge: v.bulge })),
          !!(flags & 1),
          elevation,
        ).map(inOCS),
        false,
      );
  };
  /** Attaches each POLYLINE's VERTEX entities to it (and drops an INSERT's ATTRIBs), up to SEQEND. */
  const gather = (list: Entity[]): Entity[] => {
    const out: Entity[] = [];
    for (let k = 0; k < list.length; k++) {
      const e = list[k];
      if (e.type === 'POLYLINE') {
        const vertices: Entity[] = [];
        while (k + 1 < list.length && list[k + 1].type === 'VERTEX') vertices.push(list[++k]);
        if (k + 1 < list.length && list[k + 1].type === 'SEQEND') k++;
        out.push(Object.assign(e, { vertices }));
      } else if (e.type === 'INSERT') {
        out.push(e);
        let j = k + 1;
        while (j < list.length && list[j].type === 'ATTRIB') j++;
        if (j > k + 1 && j < list.length && list[j].type === 'SEQEND') k = j;
      } else out.push(e);
    }
    return out;
  };
  for (const block of blocks.values()) block.entities = gather(block.entities);
  const root: Context = { matrix: scaling(scale, scale, scale), layer: '0', color: ACI[7], depth: 0 };
  for (const e of gather(model)) emit(e, root);

  // --- assemble ---------------------------------------------------------------------------------------------------
  const facePositions = new Float32Array(faceVertices * 3),
    meshGroups: LoadedGroup[] = [];
  let at = 0;
  for (const g of faceGroups.values()) {
    if (!g.positions.length) continue;
    facePositions.set(g.positions, at * 3);
    meshGroups.push({ start: at, count: g.positions.length / 3, name: g.name, color: [...g.color, 1] });
    at += g.positions.length / 3;
  }
  const linePositions = new Float32Array(segments * 6),
    lineColors = new Float32Array(segments * 6),
    lineGroupList: LoadedGroup[] = [];
  at = 0;
  for (const g of lineGroups.values()) {
    if (!g.positions.length) continue;
    const count = g.positions.length / 3;
    linePositions.set(g.positions, at * 3);
    for (let k = 0; k < count; k++) lineColors.set(g.color, (at + k) * 3);
    lineGroupList.push({ start: at, count, name: g.name, color: [...g.color, 1] });
    at += count;
  }
  return {
    mesh: {
      kind: 'mesh',
      positions: facePositions,
      indices: Uint32Array.from({ length: facePositions.length / 3 }, (_, k) => k),
      groups: meshGroups,
    },
    lines: { positions: linePositions, colors: lineColors, groups: lineGroupList },
    points: Float32Array.from(points),
    texts,
    layers: [...layers.values()].map(({ name, color, visible }) => ({ name, color, visible })),
    solids,
    unit,
    version,
    skipped,
  };
}
