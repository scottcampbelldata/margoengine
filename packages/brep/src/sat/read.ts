// ACIS SAT (Standard ACIS Text) to STEP, written from Spatial's published description of the save file format (the
// three-line header, entity records with $n pointers and # terminators, subtypes in braces with `ref n` reuse, and
// each class's restore order). Bodies, lumps, shells, faces, loops, coedges, edges and vertices become a STEP B-rep;
// plane, cone (and cylinder), sphere, torus and spline surfaces, straight, ellipse and interpolated curves become STEP
// geometry. Procedural splines (blends, offsets, sweeps, intersection curves) are taken from the B-spline
// approximation the file stores with them. The STEP text then goes through the kernel's own reader and tessellator.

/** What {@link satToSTEP} produces. */
export interface SATConversion {
  /** An AP214 STEP file with one product holding every body, in millimetres. */
  readonly step: string;
  /** The SAT save version (for example 700 for ACIS 7.0). */
  readonly version: number;
  /** Millimetres per SAT model unit (from the header; 1 when the file gives none). */
  readonly unit: number;
  /** What was left out and why: faces on geometry with no stored approximation, unknown surface types. */
  readonly warnings: readonly string[];
}

type Token = string | { ref: number } | Subtype;
interface Subtype {
  readonly name: string;
  readonly items: Token[];
}
interface SATRecord {
  readonly type: string;
  /** Data after the ENTITY header (attribute pointer, id and pattern pointer removed). */
  readonly data: Token[];
  /** The record's attribute pointer. */
  readonly attrib: number;
}

const fail = (message: string): never => {
  throw new TypeError(`Invalid SAT file: ${message}`);
};

/** Splits the record text into tokens: pointers, numbers, words, @-strings, braces and terminators. */
function tokenize(text: string, from: number): { tokens: string[]; end: number } {
  const tokens: string[] = [];
  let i = from;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c <= 32) {
      i++;
      continue;
    }
    const ch = text[i];
    if (ch === '{' || ch === '}' || ch === '#') {
      tokens.push(ch);
      i++;
      continue;
    }
    if (ch === '@') {
      // A string: @<length> <characters>.
      let j = i + 1;
      while (j < n && /\d/.test(text[j])) j++;
      const length = Number(text.slice(i + 1, j));
      const start = j + 1;
      tokens.push(`@${text.slice(start, start + length)}`);
      i = start + length;
      continue;
    }
    let j = i;
    while (j < n && text.charCodeAt(j) > 32 && !'{}#'.includes(text[j])) j++;
    const word = text.slice(i, j);
    i = j;
    if (word === 'End-of-ACIS-data' || word === 'Begin-of-ACIS-History-Data' || word === 'End-of-ASM-data')
      return { tokens, end: i };
    // Runs of infinite-interval markers may be written without spaces ("IIII").
    if (/^I{2,}$/.test(word)) for (const _ of word) tokens.push('I');
    else tokens.push(word);
  }
  return { tokens, end: n };
}

const isPointer = (t: Token | undefined): t is string => typeof t === 'string' && t[0] === '$';
const isNumber = (t: Token | undefined): t is string => typeof t === 'string' && /^[-+]?(\d|\.\d)/.test(t);
const pointer = (t: Token | undefined) => (isPointer(t) ? Number(t.slice(1)) : -1);

/** Groups braces into subtypes; `{ ref n }` becomes a reference. Every definition is numbered in order of opening. */
function nest(tokens: string[], table: Subtype[]): Token[] {
  const root: Token[] = [],
    stack: { items: Token[]; slot: number }[] = [];
  let current = root;
  for (const t of tokens) {
    if (t === '{') {
      const items: Token[] = [];
      stack.push({ items: current, slot: table.length });
      table.push({ name: '', items });
      current = items;
    } else if (t === '}') {
      const parent = stack.pop();
      if (!parent) fail('a closing brace without an opening one');
      const done = table[parent!.slot],
        [head, ...rest] = done.items;
      if (head === 'ref' && rest.length === 1 && isNumber(rest[0])) {
        // A reference, not a definition: its slot is not a subtype index.
        table.splice(parent!.slot, 1);
        parent!.items.push({ ref: Number(rest[0]) });
      } else {
        const subtype = { name: typeof head === 'string' ? head : '', items: rest };
        table[parent!.slot] = subtype;
        parent!.items.push(subtype);
      }
      current = parent!.items;
    } else current.push(t);
  }
  if (stack.length) fail('a subtype is not closed');
  return root;
}

/** A cursor over a record's data. */
class Reader {
  at = 0;
  constructor(
    readonly items: Token[],
    readonly table: Subtype[],
    readonly where: string,
  ) {}
  peek(): Token | undefined {
    return this.items[this.at];
  }
  next(): Token | undefined {
    return this.items[this.at++];
  }
  number(): number {
    const t = this.next();
    if (!isNumber(t)) fail(`${this.where}: expected a number, found ${typeof t === 'string' ? t : 'a subtype'}`);
    return Number(t);
  }
  numbers(count: number): number[] {
    return Array.from({ length: count }, () => this.number());
  }
  word(): string {
    const t = this.next();
    return typeof t === 'string' ? t : '';
  }
  pointer(): number {
    while (this.at < this.items.length && !isPointer(this.peek())) this.at++;
    return pointer(this.next());
  }
  subtype(): Subtype | undefined {
    while (this.at < this.items.length) {
      const t = this.next();
      if (typeof t === 'object') return 'ref' in t ? this.table[t.ref] : t;
    }
    return undefined;
  }
}

/** A B-spline read from a bs3 curve or surface record: standard knot vectors (end multiplicity degree + 1). */
interface Spline {
  degrees: number[];
  /** Per direction: distinct knots and their multiplicities. */
  knots: number[][];
  multiplicities: number[][];
  /** Control points (u fastest for surfaces), and weights when rational. */
  points: number[][];
  weights?: number[];
  /** Points per direction. */
  counts: number[];
}

/** bs3_curve or bs3_surface data at the reader (from 'nubs' or 'nurbs'); undefined for 'nullbs'. */
function readSpline(r: Reader, dimensions: 1 | 2): Spline | undefined {
  const kind = r.word();
  if (kind === 'nullbs') return undefined;
  if (kind !== 'nubs' && kind !== 'nurbs') fail(`${r.where}: unknown spline kind ${kind}`);
  const rational = kind === 'nurbs',
    degrees = r.numbers(dimensions);
  // A rational spline may name the rational direction; forms (open, closed, periodic) and, for surfaces,
  // singularities (none, ...) follow as words.
  const words = new Set(['open', 'closed', 'periodic']);
  if (rational && typeof r.peek() === 'string' && !words.has(r.peek() as string) && !isNumber(r.peek())) r.next();
  for (let k = 0; k < dimensions; k++) r.word();
  if (dimensions === 2) {
    r.word();
    r.word();
  }
  const counts = r.numbers(dimensions),
    knots: number[][] = [],
    multiplicities: number[][] = [];
  for (let d = 0; d < dimensions; d++) {
    const values: number[] = [],
      mults: number[] = [];
    for (let k = 0; k < counts[d]; k++) {
      values.push(r.number());
      mults.push(r.number());
    }
    // ACIS writes end knots with multiplicity equal to the degree; STEP's clamped ends carry one more.
    if (mults.length && mults[0] === degrees[d]) {
      mults[0]++;
      mults[mults.length - 1]++;
    }
    knots.push(values);
    multiplicities.push(mults);
  }
  const poles = multiplicities.map((m, d) => m.reduce((s, v) => s + v, 0) - degrees[d] - 1);
  if (poles.some((p) => !(p > 0) || p > 1e6)) fail(`${r.where}: spline knots give ${poles.join(' x ')} control points`);
  const total = poles.reduce((a, b) => a * b, 1),
    points: number[][] = [],
    weights: number[] = [];
  for (let k = 0; k < total; k++) {
    points.push(r.numbers(3));
    if (rational) weights.push(r.number());
  }
  return { degrees, knots, multiplicities, points, counts: poles, ...(rational ? { weights } : {}) };
}

/** The B-spline a spline surface or interpolated curve subtype carries (exact, or its stored approximation). */
function subtypeSpline(subtype: Subtype, table: Subtype[], dimensions: 1 | 2, where: string): Spline | undefined {
  const items = subtype.items;
  // The common data starts with an optional approximation level, then the bs3 data.
  for (let k = 0; k < Math.min(items.length, 4); k++) {
    const t = items[k];
    if (t === 'nubs' || t === 'nurbs') {
      const r = new Reader(items, table, `${where} ${subtype.name}`);
      r.at = k;
      return readSpline(r, dimensions);
    }
    if (t === 'nullbs' || t === 'summary' || t === 'none') return undefined;
  }
  return undefined;
}

/** A 3x4 affine map: point' = scale * (point . R) + t, with R's rows as written (ACIS row-vector convention). */
interface Placement {
  rows: number[][];
  scale: number;
  translation: number[];
}

/**
 * Converts ACIS SAT text to an AP214 STEP file the kernel reads. Throws a TypeError for a file it cannot read; faces it
 * cannot convert are left out and listed in `warnings`.
 */
export function satToSTEP(input: string | ArrayBuffer | ArrayBufferView): SATConversion {
  const text =
    typeof input === 'string'
      ? input
      : new TextDecoder('latin1').decode(
          input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
        );
  // --- header: version line, product line (length-prefixed strings), units line ---------------------------------
  const lines = text.split(/\r\n|\r|\n/),
    first = lines[0]?.trim().split(/\s+/).map(Number) ?? [];
  if (!(first.length >= 3 && Number.isInteger(first[0]) && first[0] > 0)) fail('the first line is not a SAT header');
  const version = first[0];
  // From ACIS 2.0 the header has a product line and a units line (millimetres per unit first); before, one line.
  const line = version >= 200 ? 2 : 0,
    unitsLine = line ? (lines[line]?.trim().split(/\s+/).map(Number) ?? []) : [],
    mmPerUnit = unitsLine[0] > 0 ? unitsLine[0] : 1;
  // The records start after the header's last line (lines end in \r, \n or both).
  const headerEnd = (() => {
    let at = 0;
    for (let k = 0; k <= line; k++) {
      const m = /\r\n|\r|\n/.exec(text.slice(at));
      if (!m) return text.length;
      at += m.index + m[0].length;
    }
    return at;
  })();
  const { tokens } = tokenize(text, headerEnd);

  // --- records ---------------------------------------------------------------------------------------------------
  const table: Subtype[] = [],
    records: SATRecord[] = [];
  let start = 0;
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k] !== '#') continue;
    let raw = tokens.slice(start, k);
    start = k + 1;
    // Optional sequence numbers ("-12 face ...") say where a record belongs; without them, order does.
    let index = records.length;
    if (raw.length > 1 && /^-\d+$/.test(raw[0]) && /^[a-z]/i.test(raw[1])) {
      index = -Number(raw[0]);
      raw = raw.slice(1);
    }
    const [type, ...rest] = raw;
    if (!type) continue;
    const items = nest(rest, table),
      attribute = type.endsWith('attrib'),
      simple = attribute || type === 'transform';
    // ENTITY header: attribute pointer; from ACIS 7.0 an id, then (topology and geometry) a pattern pointer.
    let at = 1;
    if (version >= 700) {
      if (isNumber(items[at])) at++;
      if (!simple && isPointer(items[at])) at++;
    }
    records[index] = { type, attrib: pointer(items[0]), data: items.slice(at) };
  }
  if (!records.length) fail('no entity records');

  const warnings: string[] = [],
    warn = (message: string) => {
      if (warnings.length < 200) warnings.push(message);
    };
  const record = (index: number, ...types: string[]) => {
    const r = records[index];
    if (!r) fail(`pointer $${index} has no record`);
    if (types.length && !types.some((t) => r!.type === t || r!.type.endsWith(`-${t}`)))
      fail(`$${index} is a ${r!.type}, expected ${types.join(' or ')}`);
    return r!;
  };
  const reader = (index: number, ...types: string[]) => new Reader(record(index, ...types).data, table, `$${index}`);

  // --- STEP output ------------------------------------------------------------------------------------------------
  const out: string[] = [];
  let nextId = 100;
  const add = (entity: string) => {
    const id = `#${nextId++}`;
    out.push(`${id}=${entity};`);
    return id;
  };
  // STEP reals need a decimal point before any exponent.
  const r6 = (v: number) => {
    if (!Number.isFinite(v)) fail('a number is not finite');
    const s = v
      .toPrecision(17)
      .replace(/(\.\d*?)0+(e|$)/, '$1$2')
      .replace(/\.(e|$)/, '.0$1');
    return s.includes('.') ? s.replace('e', 'E') : `${s}.`;
  };
  let placement: Placement = {
    rows: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    scale: 1,
    translation: [0, 0, 0],
  };
  const position = (p: number[]) => {
    const { rows: m, scale: s, translation: t } = placement;
    return [0, 1, 2].map((j) => (s * (p[0] * m[0][j] + p[1] * m[1][j] + p[2] * m[2][j]) + t[j]) * mmPerUnit);
  };
  const vector = (v: number[]) => {
    const { rows: m, scale: s } = placement;
    return [0, 1, 2].map((j) => s * (v[0] * m[0][j] + v[1] * m[1][j] + v[2] * m[2][j]) * mmPerUnit);
  };
  const unit = (v: number[]) => {
    const w = vector(v),
      l = Math.hypot(w[0], w[1], w[2]);
    if (!(l > 0)) fail('a direction has zero length');
    return w.map((x) => x / l);
  };
  const length = (v: number) => v * Math.abs(placement.scale) * mmPerUnit;
  const point = (p: number[]) => add(`CARTESIAN_POINT('',(${p.map(r6).join(',')}))`);
  const direction = (d: number[]) => add(`DIRECTION('',(${d.map(r6).join(',')}))`);
  const axis = (origin: number[], z: number[], x: number[]) => {
    // x made perpendicular to z, as STEP's placement does.
    const along = x[0] * z[0] + x[1] * z[1] + x[2] * z[2],
      px = [x[0] - along * z[0], x[1] - along * z[1], x[2] - along * z[2]],
      l = Math.hypot(px[0], px[1], px[2]);
    const ref =
      l > 1e-12
        ? px.map((v) => v / l)
        : Math.abs(z[0]) < 0.9
          ? [1 - z[0] * z[0], -z[0] * z[1], -z[0] * z[2]].map((v, _, a) => v / Math.hypot(a[0], a[1], a[2]))
          : [-z[1] * z[0], 1 - z[1] * z[1], -z[1] * z[2]].map((v, _, a) => v / Math.hypot(a[0], a[1], a[2]));
    return add(`AXIS2_PLACEMENT_3D('',${point(origin)},${direction(z)},${direction(ref)})`);
  };
  const splineEntity = (s: Spline, surface: boolean) => {
    const pts = s.points.map((p) => point(position(p)));
    const list = surface
      ? `(${Array.from({ length: s.counts[0] }, (_, i) => `(${Array.from({ length: s.counts[1] }, (_, j) => pts[j * s.counts[0] + i]).join(',')})`).join(',')})`
      : `(${pts.join(',')})`;
    const knots = s.knots.map((k) => `(${k.map(r6).join(',')})`),
      mults = s.multiplicities.map((m) => `(${m.join(',')})`);
    if (surface) {
      const body = `${s.degrees[0]},${s.degrees[1]},${list},.UNSPECIFIED.,.F.,.F.,.F.`,
        withKnots = `${mults[0]},${mults[1]},${knots[0]},${knots[1]},.UNSPECIFIED.`;
      if (!s.weights) return add(`B_SPLINE_SURFACE_WITH_KNOTS('',${body},${withKnots})`);
      const w = `(${Array.from({ length: s.counts[0] }, (_, i) => `(${Array.from({ length: s.counts[1] }, (_, j) => r6(s.weights![j * s.counts[0] + i])).join(',')})`).join(',')})`;
      return add(
        `(BOUNDED_SURFACE()B_SPLINE_SURFACE(${body})B_SPLINE_SURFACE_WITH_KNOTS(${withKnots})GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE(${w})REPRESENTATION_ITEM('')SURFACE())`,
      );
    }
    const body = `${s.degrees[0]},${list},.UNSPECIFIED.,.F.,.F.`,
      withKnots = `${mults[0]},${knots[0]},.UNSPECIFIED.`;
    if (!s.weights) return add(`B_SPLINE_CURVE_WITH_KNOTS('',${body},${withKnots})`);
    return add(
      `(BOUNDED_CURVE()B_SPLINE_CURVE(${body})B_SPLINE_CURVE_WITH_KNOTS(${withKnots})CURVE()GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_CURVE((${s.weights.map(r6).join(',')}))REPRESENTATION_ITEM(''))`,
    );
  };

  // Surfaces: STEP id and whether the face's sense must flip (the ACIS surface's normal is the STEP one's opposite).
  const surfaces = new Map<number, { id: string; flip: boolean } | null>();
  const surface = (index: number, vertices: () => number[][]): { id: string; flip: boolean } | null => {
    if (surfaces.has(index)) return surfaces.get(index)!;
    const rec = record(index),
      r = new Reader(rec.data, table, `$${index} ${rec.type}`);
    let result: { id: string; flip: boolean } | null = null;
    switch (rec.type.replace(/-surface$/, '')) {
      case 'plane': {
        const root = r.numbers(3),
          normal = r.numbers(3),
          u = isNumber(r.peek()) ? r.numbers(3) : [1, 0, 0];
        result = { id: add(`PLANE('',${axis(position(root), unit(normal), unit(u))})`), flip: false };
        break;
      }
      case 'cone': {
        const center = r.numbers(3),
          normal = r.numbers(3),
          major = r.numbers(3),
          ratio = r.number();
        // The base ellipse's curve interval, then the cone angle's sine and cosine.
        while (r.peek() === 'I' || r.peek() === 'F' || r.peek() === 'T') r.next();
        let sin = r.number(),
          cos = r.number();
        if (isNumber(r.peek())) r.number(); // u parameter scale
        const reversed = r.word() === 'reversed',
          c = position(center),
          z = unit(normal),
          majorWorld = vector(major),
          radius = Math.hypot(majorWorld[0], majorWorld[1], majorWorld[2]),
          x = majorWorld.map((v) => v / (radius || 1));
        if (Math.abs(ratio - 1) > 1e-9)
          warn(`$${index}: elliptical cone or cylinder (ratio ${ratio}) meshed as circular`);
        if (Math.abs(sin) < 1e-12) {
          result = { id: add(`CYLINDRICAL_SURFACE('',${axis(c, z, x)},${r6(radius)})`), flip: reversed };
          break;
        }
        // The radius grows along the axis by tan(angle) per unit; which way is read from the face's vertices.
        if (cos < 0) {
          sin = -sin;
          cos = -cos;
        }
        let tan = Math.abs(sin / cos),
          sign = Math.sign(sin) || 1;
        for (const p of vertices()) {
          const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]],
            h = d[0] * z[0] + d[1] * z[1] + d[2] * z[2],
            rho = Math.hypot(d[0] - h * z[0], d[1] - h * z[1], d[2] - h * z[2]);
          if (Math.abs(h) > 1e-6 * (radius + 1)) {
            sign = Math.sign((rho - radius) / h) || sign;
            break;
          }
        }
        tan = Math.abs(tan);
        const zz = sign > 0 ? z : z.map((v) => -v);
        result = {
          id: add(`CONICAL_SURFACE('',${axis(c, zz, x)},${r6(radius)},${r6(Math.atan(tan))})`),
          flip: reversed,
        };
        break;
      }
      case 'sphere': {
        const center = r.numbers(3),
          radius = r.number(),
          origin = isNumber(r.peek()) ? r.numbers(3) : [1, 0, 0],
          pole = isNumber(r.peek()) ? r.numbers(3) : [0, 0, 1];
        result = {
          id: add(
            `SPHERICAL_SURFACE('',${axis(position(center), unit(pole), unit(origin))},${r6(length(Math.abs(radius)))})`,
          ),
          flip: radius < 0,
        };
        break;
      }
      case 'torus': {
        const center = r.numbers(3),
          normal = r.numbers(3),
          major = r.number(),
          minor = r.number(),
          origin = isNumber(r.peek()) ? r.numbers(3) : [1, 0, 0],
          R = length(Math.abs(major)),
          m = length(Math.abs(minor)),
          type = m > R ? 'DEGENERATE_TOROIDAL_SURFACE' : 'TOROIDAL_SURFACE';
        result = {
          id: add(
            `${type}('',${axis(position(center), unit(normal), unit(origin))},${r6(R)},${r6(m)}${type === 'TOROIDAL_SURFACE' ? '' : ',.T.'})`,
          ),
          flip: minor < 0,
        };
        break;
      }
      case 'spline': {
        const reversed = r.word() === 'reversed',
          sub = r.subtype(),
          s = sub && subtypeSpline(sub, table, 2, `$${index}`);
        if (!s) warn(`$${index}: spline surface ${sub?.name ?? ''} has no stored B-spline; its faces are left out`);
        else result = { id: splineEntity(s, true), flip: reversed };
        break;
      }
      default:
        warn(`$${index}: ${rec.type} is not supported; its faces are left out`);
    }
    surfaces.set(index, result);
    return result;
  };

  // Curves: STEP id and whether the edge's sense flips.
  const curves = new Map<number, { id: string; flip: boolean } | null>();
  const curve = (index: number): { id: string; flip: boolean } | null => {
    if (curves.has(index)) return curves.get(index)!;
    const rec = record(index),
      r = new Reader(rec.data, table, `$${index} ${rec.type}`);
    let result: { id: string; flip: boolean } | null = null;
    switch (rec.type.replace(/-curve$/, '')) {
      case 'straight': {
        const root = r.numbers(3),
          dir = r.numbers(3);
        const along = add(`VECTOR('',${direction(unit(dir))},1.)`);
        result = { id: add(`LINE('',${point(position(root))},${along})`), flip: false };
        break;
      }
      case 'ellipse': {
        const center = r.numbers(3),
          normal = r.numbers(3),
          major = r.numbers(3),
          ratio = r.number(),
          m = vector(major),
          radius = Math.hypot(m[0], m[1], m[2]),
          place = axis(
            position(center),
            unit(normal),
            m.map((v) => v / (radius || 1)),
          );
        result = {
          id:
            Math.abs(ratio - 1) < 1e-12
              ? add(`CIRCLE('',${place},${r6(radius)})`)
              : add(`ELLIPSE('',${place},${r6(radius)},${r6(radius * Math.abs(ratio))})`),
          flip: false,
        };
        break;
      }
      case 'intcurve': {
        const reversed = r.word() === 'reversed',
          sub = r.subtype(),
          s = sub && subtypeSpline(sub, table, 1, `$${index}`);
        if (s) result = { id: splineEntity(s, false), flip: reversed };
        break;
      }
      default:
        break;
    }
    curves.set(index, result);
    return result;
  };

  // Colours: an rgb_color attribute (red, green, blue in 0..1) on the entity's attribute chain.
  const colour = (attrib: number): number[] | undefined => {
    for (let k = attrib, guard = 0; k >= 0 && guard < 1000; guard++) {
      const a = records[k];
      if (!a) return undefined;
      const r = new Reader(a.data, table, `$${k}`),
        next = r.pointer();
      r.pointer();
      r.pointer();
      if (a.type.startsWith('rgb_color')) {
        const c = r.numbers(3);
        if (c.every((v) => v >= 0 && v <= 1)) return c;
      }
      k = next;
    }
    return undefined;
  };
  const styled: string[] = [];
  const style = (item: string, c: number[]) => {
    const rgb = add(`COLOUR_RGB('',${c.map(r6).join(',')})`),
      fill = add(`FILL_AREA_STYLE('',(${add(`FILL_AREA_STYLE_COLOUR('',${rgb})`)}))`),
      side = add(`SURFACE_SIDE_STYLE('',(${add(`SURFACE_STYLE_FILL_AREA(${fill})`)}))`),
      usage = add(`SURFACE_STYLE_USAGE(.BOTH.,${side})`),
      assignment = add(`PRESENTATION_STYLE_ASSIGNMENT((${usage}))`);
    styled.push(add(`STYLED_ITEM('',(${assignment}),${item})`));
  };

  // --- topology ---------------------------------------------------------------------------------------------------
  const vertices = new Map<number, { id: string; p: number[] }>();
  const vertex = (index: number) => {
    let v = vertices.get(index);
    if (!v) {
      const r = reader(index, 'vertex');
      r.pointer();
      const p = position(reader(r.pointer(), 'point').numbers(3));
      v = { id: add(`VERTEX_POINT('',${point(p)})`), p };
      vertices.set(index, v);
    }
    return v;
  };
  const edges = new Map<number, { id: string } | null>();
  const edge = (index: number) => {
    if (edges.has(index)) return edges.get(index)!;
    const r = reader(index, 'edge'),
      start = r.pointer();
    // From ACIS 5.0 the start parameter follows the start vertex, and the end parameter the end vertex.
    const end = r.pointer(),
      _coedge = r.pointer(),
      geometry = r.pointer();
    void _coedge;
    while (r.at < r.items.length && r.peek() !== 'forward' && r.peek() !== 'reversed') r.next();
    const sense = r.word() !== 'reversed';
    let result: { id: string } | null = null;
    if (geometry >= 0) {
      const c = curve(geometry);
      if (c) {
        const a = vertex(start),
          b = vertex(end);
        result = { id: add(`EDGE_CURVE('',${a.id},${b.id},${c.id},${sense !== c.flip ? '.T.' : '.F.'})`) };
      } else warn(`$${index}: edge on ${record(geometry).type} with no stored B-spline`);
    }
    edges.set(index, result);
    return result;
  };
  /** A loop's coedges, in order from its first. */
  const coedges = (first: number) => {
    const list: number[] = [];
    for (let k = first, guard = 0; k >= 0 && guard < 100000; guard++) {
      list.push(k);
      const next = reader(k, 'coedge').pointer();
      if (next === first || next < 0) break;
      k = next;
    }
    return list;
  };
  const faceIds: { shell: number; id: string; closed: boolean }[] = [];
  const convertFace = (index: number, shell: number) => {
    const rec = record(index, 'face'),
      r = new Reader(rec.data, table, `$${index}`),
      _next = r.pointer(),
      firstLoop = r.pointer();
    void _next;
    r.pointer(); // shell
    r.pointer(); // subshell
    const geometry = r.pointer(),
      sense = r.word() !== 'reversed';
    const loops: number[] = [];
    for (let k = firstLoop, guard = 0; k >= 0 && guard < 100000; guard++) {
      loops.push(k);
      k = reader(k, 'loop').pointer();
    }
    let closed = true;
    const loopVertices = () =>
      loops.flatMap((l) => {
        const lr = reader(l, 'loop');
        lr.pointer();
        return coedges(lr.pointer()).flatMap((c) => {
          const cr = reader(c, 'coedge');
          cr.pointer();
          cr.pointer();
          cr.pointer();
          const e = reader(cr.pointer(), 'edge');
          return [vertex(e.pointer()).p];
        });
      });
    const s = geometry >= 0 ? surface(geometry, loopVertices) : null;
    if (!s) {
      warn(`$${index}: face left out (its surface could not be converted)`);
      return;
    }
    const bounds: string[] = [];
    let missing = false;
    for (const l of loops) {
      const lr = reader(l, 'loop');
      lr.pointer();
      const oriented: string[] = [];
      for (const c of coedges(lr.pointer())) {
        const cr = reader(c, 'coedge');
        cr.pointer(); // next
        cr.pointer(); // previous
        const partner = cr.pointer(),
          e = cr.pointer();
        while (cr.at < cr.items.length && !isNumber(cr.peek()) && cr.peek() !== 'forward' && cr.peek() !== 'reversed')
          cr.next();
        const t = cr.next(),
          forward = t === 'forward' || t === '0';
        if (partner < 0) closed = false;
        const converted = edge(e);
        if (converted) oriented.push(add(`ORIENTED_EDGE('',*,*,${converted.id},${forward ? '.T.' : '.F.'})`));
        else {
          // A degenerate edge (no curve, at an apex or pole) is no part of a STEP loop; any other is a gap.
          const er = reader(e, 'edge');
          const a = er.pointer(),
            b = er.pointer();
          er.pointer();
          if (!(a === b && er.pointer() < 0)) missing = true;
        }
      }
      if (oriented.length) bounds.push(add(`FACE_BOUND('',${add(`EDGE_LOOP('',(${oriented.join(',')}))`)},.T.)`));
    }
    if (missing) warn(`$${index}: face has an edge that could not be converted`);
    const id = add(`ADVANCED_FACE('',(${bounds.join(',')}),${s.id},${sense !== s.flip ? '.T.' : '.F.'})`);
    const c = colour(rec.attrib);
    if (c) style(id, c);
    faceIds.push({ shell, id, closed });
  };

  // Bodies: each lump's shells become solids (closed) or shell-based surface models.
  const items: string[] = [];
  records.forEach((rec, index) => {
    if (rec.type !== 'body') return;
    const r = new Reader(rec.data, table, `$${index}`);
    let lump = r.pointer();
    r.pointer(); // wire
    const transform = r.pointer();
    placement = {
      rows: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      scale: 1,
      translation: [0, 0, 0],
    };
    if (transform >= 0) {
      const t = reader(transform, 'transform'),
        v = t.numbers(12),
        scale = isNumber(t.peek()) ? t.number() : 1;
      placement = { rows: [v.slice(0, 3), v.slice(3, 6), v.slice(6, 9)], translation: v.slice(9, 12), scale };
    }
    const bodyColour = colour(rec.attrib);
    for (let guard = 0; lump >= 0 && guard < 100000; guard++) {
      const lr = reader(lump, 'lump'),
        nextLump = lr.pointer();
      let shell = lr.pointer();
      while (shell >= 0) {
        const sr = reader(shell, 'shell'),
          nextShell = sr.pointer();
        sr.pointer(); // subshell
        let face = sr.pointer();
        const before = faceIds.length;
        for (let g = 0; face >= 0 && g < 1000000; g++) {
          convertFace(face, shell);
          face = reader(face, 'face').pointer();
        }
        const mine = faceIds.slice(before);
        if (mine.length) {
          const closed = mine.every((f) => f.closed),
            faces = mine.map((f) => f.id).join(','),
            item = closed
              ? add(`MANIFOLD_SOLID_BREP('',${add(`CLOSED_SHELL('',(${faces}))`)})`)
              : add(`SHELL_BASED_SURFACE_MODEL('',(${add(`OPEN_SHELL('',(${faces}))`)}))`);
          items.push(item);
          if (bodyColour) style(item, bodyColour);
        }
        shell = nextShell;
      }
      lump = nextLump;
    }
  });
  if (!items.length) fail('no body with faces');

  const representation = add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${items.join(',')},#12),#10)`);
  add(`SHAPE_REPRESENTATION_RELATIONSHIP('','',#13,${representation})`);
  if (styled.length) add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styled.join(',')}),#10)`);
  const step = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('converted from ACIS SAT ${version}'),'2;1');
FILE_NAME('model.stp','',(''),(''),'Margo SAT reader','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'));
ENDSEC;
DATA;
#1=APPLICATION_CONTEXT('automotive design');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT('SAT','SAT','',(#2));
#4=PRODUCT_DEFINITION_FORMATION('','',#3);
#5=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#6=PRODUCT_DEFINITION('design','',#4,#5);
#7=PRODUCT_DEFINITION_SHAPE('','',#6);
#8=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#9=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#10=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#8,#9))REPRESENTATION_CONTEXT('',''));
#11=CARTESIAN_POINT('',(0.,0.,0.));
#12=AXIS2_PLACEMENT_3D('',#11,$,$);
#13=SHAPE_REPRESENTATION('',(#12),#10);
#14=SHAPE_DEFINITION_REPRESENTATION(#7,#13);
${out.join('\n')}
ENDSEC;
END-ISO-10303-21;
`;
  return { step, version, unit: mmPerUnit, warnings };
}
