// L-systems: seeded stochastic and parametric rewriting, a 3D turtle and tube meshes for plants and branching structures.
import { Geometry } from '@margoengine/core';

/** One symbol with its parameters: `F(2)` is `{symbol: 'F', params: [2]}`. */
export interface Module {
  readonly symbol: string;
  readonly params: readonly number[];
}
/** A replacement: module text such as `'F[+F]F'`, or a function of the matched module's parameters (parametric rules). */
export type Successor = string | ((...params: number[]) => string | readonly Module[]);
/** A rule for one symbol. Among the rules whose `condition` holds, one is picked with probability proportional to `weight`. */
export interface Rule {
  successor: Successor;
  /** Relative probability (default 1). */
  weight?: number;
  /** Guard on the module's parameters. */
  condition?: (...params: number[]) => boolean;
}
/** Rules by symbol; symbols without a matching rule are copied unchanged. */
export type Rules = Readonly<Record<string, string | Rule | readonly Rule[]>>;
/** `expand` settings. */
export interface ExpandOptions {
  /** Seed for stochastic rule choice (default 1). */ seed?: number;
  /** Throws past this many modules (default 1,000,000). */
  maxModules?: number;
}
/** `interpret` settings. Draw symbols move forward and add a segment; move symbols move without drawing. */
export interface TurtleOptions {
  /** Turn angle in degrees for `+ - & ^ \ /` without a parameter (default 25). */ angle?: number;
  /** Step length for draw/move symbols without a parameter (default 1). */ step?: number;
  /** Starting branch radius (default 0.1). */ radius?: number;
  /** `!` without a parameter multiplies the radius by this (default 0.7); `!(r)` sets it. */ radiusScale?: number;
  /** Symbols that draw (default `'FG'`). */ draw?: string;
  /** Symbols that move without drawing (default `'fg'`). */ move?: string;
  /** Start position (default origin). */ origin?: readonly [number, number, number];
}
/** Turtle output, one entry per drawn segment. `positions` feeds `new Line({mode: 'segments', positions})` from @margoengine/lines. */
export interface Branches {
  /** Start and end point per segment: x0, y0, z0, x1, y1, z1. */ readonly positions: Float32Array;
  /** Radius per segment. */ readonly radii: Float32Array;
  /** Turtle up vector per segment (a frame for tube rings). */ readonly ups: Float32Array;
  /** The segment this one continues from, or -1 at a root or after a move. */ readonly parents: Int32Array;
  /** Bracket depth per segment (0 on the trunk). */ readonly depths: Uint16Array;
}
/** `tubes` settings. */
export interface TubeOptions {
  /** Vertices per ring, 3..32 (default 6). */ radialSegments?: number;
  /** End radius of a branch tip as a fraction of its radius (default 0.6). */
  tipScale?: number;
}

const symbolText = /\s*([^\s(),])\s*(?:\(([^)]*)\))?/y;
/** Parses module text: one character per symbol, optional comma-separated numeric parameters, whitespace ignored. */
export function parseModules(text: string): Module[] {
  const out: Module[] = [];
  symbolText.lastIndex = 0;
  while (symbolText.lastIndex < text.length) {
    if (!text.slice(symbolText.lastIndex).trim()) break;
    const at = symbolText.lastIndex,
      m = symbolText.exec(text);
    if (!m) throw new SyntaxError(`Invalid L-system text at ${at}: ${text.slice(at, at + 12)}`);
    const params = m[2] === undefined ? [] : m[2].split(',').map(Number);
    if (params.some((p) => !Number.isFinite(p))) throw new SyntaxError(`Invalid L-system parameter in ${m[0].trim()}`);
    out.push({ symbol: m[1], params });
  }
  return out;
}

/** Rewrites `axiom` `iterations` times (0..64). Seeded: the same inputs always give the same modules. */
export function expand(
  axiom: string | readonly Module[],
  rules: Rules,
  iterations: number,
  { seed = 1, maxModules = 1_000_000 }: ExpandOptions = {},
): Module[] {
  if (
    !Number.isInteger(iterations) ||
    iterations < 0 ||
    iterations > 64 ||
    !Number.isSafeInteger(seed) ||
    !Number.isInteger(maxModules) ||
    maxModules < 1
  )
    throw new RangeError('Invalid L-system iterations, seed or module budget');
  const table = new Map<string, { rules: Rule[]; parsed: (Module[] | undefined)[] }>();
  for (const [symbol, value] of Object.entries(rules)) {
    if ([...symbol].length !== 1) throw new TypeError(`L-system rule keys are single symbols, got "${symbol}"`);
    const list = (
      typeof value === 'string' ? [{ successor: value }] : Array.isArray(value) ? value : [value]
    ) as Rule[];
    if (
      list.some(
        (r) =>
          (typeof r.successor !== 'string' && typeof r.successor !== 'function') ||
          !(Number.isFinite(r.weight ?? 1) && (r.weight ?? 1) > 0),
      )
    )
      throw new TypeError(`Invalid rule for "${symbol}"`);
    table.set(symbol, {
      rules: list,
      parsed: list.map((r) => (typeof r.successor === 'string' ? parseModules(r.successor) : undefined)),
    });
  }
  let state = seed >>> 0 || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  let modules = typeof axiom === 'string' ? parseModules(axiom) : [...axiom];
  for (let step = 0; step < iterations; step++) {
    const next: Module[] = [];
    for (const module of modules) {
      const entry = table.get(module.symbol),
        matches: number[] = [];
      if (entry)
        for (let r = 0; r < entry.rules.length; r++)
          if (entry.rules[r].condition?.(...module.params) ?? true) matches.push(r);
      if (!entry || !matches.length) {
        next.push(module);
        continue;
      }
      let pick = matches[0];
      if (matches.length > 1) {
        let total = 0;
        for (const r of matches) total += entry.rules[r].weight ?? 1;
        let choice = random() * total;
        for (const r of matches) {
          pick = r;
          choice -= entry.rules[r].weight ?? 1;
          if (choice < 0) break;
        }
      }
      const successor = entry.rules[pick].successor,
        made = entry.parsed[pick] ?? (successor as Exclude<Successor, string>)(...module.params);
      for (const m of typeof made === 'string' ? parseModules(made) : made) next.push(m);
      if (next.length > maxModules) throw new RangeError('L-system expansion exceeds the module budget');
    }
    modules = next;
  }
  return modules;
}

type V = [number, number, number];
const rotate = (a: V, b: V, angle: number): void => {
  // Rotates the orthonormal pair (a, b) by `angle` in their plane: a toward b.
  const c = Math.cos(angle),
    s = Math.sin(angle);
  for (let i = 0; i < 3; i++) {
    const x = a[i],
      y = b[i];
    a[i] = x * c + y * s;
    b[i] = y * c - x * s;
  }
};
/**
 * Runs a 3D turtle over `modules` (heading +Y, up +Z): draw/move symbols step (parameter: length); `+`/`-` yaw left/right,
 * `&`/`^` pitch down/up, `\`/`/` roll (parameter: degrees); `|` turns around; `[`/`]` push/pop; `!` shrinks the radius.
 * Other symbols are ignored, so grammar-only symbols (`X`, `A`) need no handling.
 */
export function interpret(
  modules: readonly Module[],
  {
    angle = 25,
    step = 1,
    radius = 0.1,
    radiusScale = 0.7,
    draw = 'FG',
    move = 'fg',
    origin = [0, 0, 0],
  }: TurtleOptions = {},
): Branches {
  if (![angle, step, radius, radiusScale, ...origin].every(Number.isFinite) || origin.length !== 3)
    throw new RangeError('Invalid turtle options');
  let p: V = [origin[0], origin[1], origin[2]],
    h: V = [0, 1, 0],
    l: V = [-1, 0, 0],
    u: V = [0, 0, 1],
    r = radius,
    last = -1,
    depth = 0;
  const stack: { p: V; h: V; l: V; u: V; r: number; last: number }[] = [];
  const positions: number[] = [],
    radii: number[] = [],
    ups: number[] = [],
    parents: number[] = [],
    depths: number[] = [];
  for (const { symbol, params } of modules) {
    const value = params[0],
      turn = ((value ?? angle) * Math.PI) / 180;
    if (draw.includes(symbol) || move.includes(symbol)) {
      const length = value ?? step,
        q: V = [p[0] + h[0] * length, p[1] + h[1] * length, p[2] + h[2] * length];
      if (draw.includes(symbol)) {
        positions.push(...p, ...q);
        radii.push(r);
        ups.push(...u);
        parents.push(last);
        depths.push(depth);
        last = radii.length - 1;
      } else last = -1;
      p = q;
    } else if (symbol === '+') rotate(h, l, turn);
    else if (symbol === '-') rotate(h, l, -turn);
    else if (symbol === '&') rotate(h, u, -turn);
    else if (symbol === '^') rotate(h, u, turn);
    else if (symbol === '\\') rotate(l, u, turn);
    else if (symbol === '/') rotate(l, u, -turn);
    else if (symbol === '|') rotate(h, l, Math.PI);
    else if (symbol === '[') {
      stack.push({ p, h: [...h], l: [...l], u: [...u], r, last });
      depth++;
    } else if (symbol === ']') {
      const s = stack.pop();
      if (!s) throw new SyntaxError('Unbalanced ] in L-system');
      ({ p, h, l, u, r, last } = s);
      depth--;
    } else if (symbol === '!') r = value ?? r * radiusScale;
    if (!Number.isFinite(r) || r < 0) throw new RangeError('Branch radius must be finite and non-negative');
  }
  return {
    positions: new Float32Array(positions),
    radii: new Float32Array(radii),
    ups: new Float32Array(ups),
    parents: new Int32Array(parents),
    depths: Uint16Array.from(depths),
  };
}

/**
 * Tube mesh along the branches: one ring per segment end. A branch continues smoothly into its same-depth child (the joint
 * ring is shared and tilted to the bisector); side branches start with their own ring inside the parent. Open at the ends.
 */
export function tubes(branches: Branches, { radialSegments = 6, tipScale = 0.6 }: TubeOptions = {}): Geometry {
  const { positions: P, radii, ups, parents, depths } = branches,
    count = radii.length;
  if (!Number.isInteger(radialSegments) || radialSegments < 3 || radialSegments > 32 || !(tipScale >= 0))
    throw new RangeError('Invalid tube options');
  if (!count) throw new RangeError('No branches to build');
  if (count * 2 * radialSegments > 1_000_000) throw new RangeError('Tube mesh exceeds the geometry budget');
  // The continuation of a segment: its first child at the same depth, else its first child.
  const next = new Int32Array(count).fill(-1);
  for (let s = 0; s < count; s++) {
    const q = parents[s];
    if (q >= 0 && (next[q] < 0 || (depths[next[q]] !== depths[q] && depths[s] === depths[q]))) next[q] = s;
  }
  const dir = (s: number): V => {
    const x = P[s * 6 + 3] - P[s * 6],
      y = P[s * 6 + 4] - P[s * 6 + 1],
      z = P[s * 6 + 5] - P[s * 6 + 2],
      n = Math.hypot(x, y, z) || 1;
    return [x / n, y / n, z / n];
  };
  const vertices: number[] = [],
    normals: number[] = [],
    indices: number[] = [];
  const ring = (c: ArrayLike<number>, at: number, axis: V, s: number, radius: number): number => {
    // Frame: the segment's turtle up made perpendicular to the axis.
    let [ux, uy, uz] = [ups[s * 3], ups[s * 3 + 1], ups[s * 3 + 2]];
    const d = ux * axis[0] + uy * axis[1] + uz * axis[2];
    ux -= d * axis[0];
    uy -= d * axis[1];
    uz -= d * axis[2];
    let n = Math.hypot(ux, uy, uz);
    if (n < 1e-6) {
      [ux, uy, uz] = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const e = ux * axis[0] + uy * axis[1];
      ux -= e * axis[0];
      uy -= e * axis[1];
      uz -= e * axis[2];
      n = Math.hypot(ux, uy, uz);
    }
    ux /= n;
    uy /= n;
    uz /= n;
    const vx = axis[1] * uz - axis[2] * uy,
      vy = axis[2] * ux - axis[0] * uz,
      vz = axis[0] * uy - axis[1] * ux,
      first = vertices.length / 3;
    for (let k = 0; k < radialSegments; k++) {
      const a = (k / radialSegments) * Math.PI * 2,
        cos = Math.cos(a),
        sin = Math.sin(a),
        nx = cos * ux + sin * vx,
        ny = cos * uy + sin * vy,
        nz = cos * uz + sin * vz;
      vertices.push(c[at] + nx * radius, c[at + 1] + ny * radius, c[at + 2] + nz * radius);
      normals.push(nx, ny, nz);
    }
    return first;
  };
  const joints = new Int32Array(count); // shared ring at the end of a segment that has a continuation (parents come first)
  for (let s = 0; s < count; s++) {
    const axis = dir(s),
      q = parents[s],
      start = q >= 0 && next[q] === s ? joints[q] : ring(P, s * 6, axis, s, radii[s]);
    let end: number;
    if (next[s] >= 0) {
      const c = next[s],
        a = dir(c),
        b: V = [a[0] + axis[0], a[1] + axis[1], a[2] + axis[2]],
        n = Math.hypot(...b) || 1;
      end = joints[s] = ring(P, s * 6 + 3, [b[0] / n, b[1] / n, b[2] / n], c, radii[c]);
    } else end = ring(P, s * 6 + 3, axis, s, radii[s] * tipScale);
    for (let k = 0; k < radialSegments; k++) {
      const k1 = (k + 1) % radialSegments;
      indices.push(start + k, start + k1, end + k1, start + k, end + k1, end + k);
    }
  }
  return new Geometry(vertices, normals, indices);
}
