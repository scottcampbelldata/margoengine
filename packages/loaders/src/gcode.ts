// RepRap G-code toolpaths: G0 and G1 moves and G2 and G3 arcs with E, grouped by Z into layers of line segments.
//
// Arcs follow the RepRap G-code wiki (G2 and G3, G17 to G19) and the LinuxCNC G-code reference (5. G2, G3 Arc Move):
// I, J and K are the centre's offset from the start in the selected plane, R a radius whose sign picks the arc under
// 180 degrees (positive) or over it (negative), an arc that ends where it starts is a full circle, P counts turns, and
// the axis normal to the plane moves linearly (a helix). G2 turns clockwise seen from the positive end of that axis.
// G90.1 makes I, J and K the centre itself and G91.1 (the default) an offset again (LinuxCNC G-code reference). Marlin's
// G2 and G3 page (marlinfw.org/docs/gcode/G002-G003.html) gives P as complete circles, read with arcP: 'circles'.
import { LoaderError, type ParseLimits } from './types.js';
import { type BinaryInput, floats, limits, toText } from './util.js';

const F = 'G-code';
/** Largest gap between an arc and its chords, in millimetres; a turn takes at least 16 chords. */
const ARC_TOLERANCE = 0.002;

/** One layer of {@link GCode.layers}. Both arrays hold two xyz points per segment: `mode: 'segments'` of `Line`. */
export interface GCodeLayer {
  /** The Z of the layer's extruding moves, in millimetres. */
  z: number;
  /** Moves that lay down material. */
  extrusion: Float32Array;
  /** Moves without material that lead into this layer. */
  travel: Float32Array;
}

/** Options of {@link parseGCode}: the shared size limits and what P on G2 and G3 counts. */
export interface GCodeOptions extends ParseLimits {
  /**
   * What P on a G2 or G3 arc counts. `'turns'` (default, LinuxCNC): P is the number of turns, P1 the programmed arc
   * alone, and each step above 1 adds a full circle. `'circles'` (Marlin with `ARC_P_CIRCLES`): P full circles are
   * drawn on top of the programmed arc, so P0 is the arc alone and P1 is one circle more than LinuxCNC's P1.
   */
  arcP?: 'turns' | 'circles';
}

/** What {@link parseGCode} returns. Coordinates are the machine's, in millimetres, Z up. */
export interface GCode {
  /** Layers by rising Z. */
  layers: GCodeLayer[];
  /** Net filament pushed in, the sum of every E move in millimetres, so a retraction and its recovery cancel. */
  filament: number;
  /** Bounds of every segment; zeros when there are none. */
  min: [number, number, number];
  max: [number, number, number];
  /** Things the parser moved past without drawing, each listed once. Empty today: every move it reads is drawn. */
  warnings: string[];
}

/**
 * Parses RepRap-flavoured G-code: G0 and G1 with X, Y, Z, E; G2 and G3 arcs by centre offsets (I, J, K) or radius (R),
 * with full circles, turns (P, counted as `arcP` says) and helices, in the plane G17, G18 or G19 selects; G90.1 and
 * G91.1 for absolute and incremental arc centres; G90, G91, M82 and M83 for absolute and relative axes; G92 to set a position; G20 and G21 for units; G28 to home. Other commands are skipped. An arc is
 * drawn as chords within 0.002 mm of it, its E spread evenly along them. `maxVertices` counts two per segment.
 *
 * @param input The file's bytes or text.
 * @param options The shared size limits and `arcP`.
 * @returns The layers, filament use and bounds.
 * @throws LoaderError with code `syntax` for a bad number, an arc without its centre or radius, or a G90.1 arc
 * missing one of its plane's two centre words, `range` for an arc
 * whose end is off its circle (past LinuxCNC's tolerance) or whose radius is shorter than half its chord, and `limit`
 * past `maxVertices`.
 *
 * @example
 * ```ts
 * import { parseGCode } from '@margoengine/loaders/gcode';
 *
 * const { layers, filament } = parseGCode('G1 Z0.2\nG1 X10 E1\nG3 X0 Y10 I-10 E2\n');
 * console.log(layers[0].z, layers[0].extrusion.length, filament);
 * ```
 */
export function parseGCode(input: BinaryInput | string, options: GCodeOptions = {}): GCode {
  const text = toText(input, F),
    { maxVertices } = limits(options, F),
    circles = options.arcP === 'circles';
  if (options.arcP !== undefined && options.arcP !== 'turns' && !circles)
    throw new LoaderError(F, 'range', `arcP must be 'turns' or 'circles', not ${String(options.arcP).slice(0, 40)}`);
  const byZ = new Map<number, ReturnType<typeof makeLayer>>(),
    warnings: string[] = [],
    position = [0, 0, 0, 0],
    min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let pending = floats(),
    relative = false,
    relativeE = false,
    // G90.1: I, J and K are the centre itself; G91.1 (the default): its offset from the start.
    absoluteCentre = false,
    unit = 1,
    filament = 0,
    vertices = 0,
    current: ReturnType<typeof makeLayer> | undefined,
    // The arc plane's first and second axes and its normal: G17 X Y (Z), G18 Z X (Y), G19 Y Z (X).
    plane = [0, 1, 2],
    lineNumber = 0;
  const axes = 'XYZE';
  // No exponents: G-code has none, and in G1X1E2 the E is the extruder.
  const word = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))?/g;

  /** Where a move's words take the tool: each axis absolute or relative by its mode. */
  const target = (words: readonly (number | undefined)[]): number[] =>
    position.map((at, a) => {
      const value = words[a];
      return value === undefined ? at : (a === 3 ? relativeE : relative) ? at + value : value;
    });

  /** One straight move, extruding when E rises along it. */
  const segment = (from: readonly number[], to: readonly number[]): void => {
    const pushed = to[3] - from[3];
    filament += pushed; // A retraction takes back what its recovery pushes again.
    if (to[0] === from[0] && to[1] === from[1] && to[2] === from[2]) return;
    if ((vertices += 2) > maxVertices)
      throw new LoaderError(F, 'limit', `vertex count exceeds the limit of ${maxVertices}`);
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], from[a], to[a]);
      max[a] = Math.max(max[a], from[a], to[a]);
    }
    const extruding = pushed > 0;
    if (extruding) {
      current = byZ.get(to[2]);
      if (!current) byZ.set(to[2], (current = makeLayer(to[2])));
      // Travel seen since the last extrusion leads into this layer.
      current.travel.reserve(pending.length);
      current.travel.array.set(pending.array.subarray(0, pending.length), current.travel.length);
      current.travel.length += pending.length;
      pending = floats();
    }
    const into = extruding && current ? current.extrusion : pending;
    into.reserve(6);
    into.array.set([from[0], from[1], from[2], to[0], to[1], to[2]], into.length);
    into.length += 6;
  };

  /** G2 (clockwise) or G3 as chords; `words` holds I, J, K, R and P. */
  const arc = (ccw: boolean, to: readonly number[], words: readonly (number | undefined)[]): void => {
    const from = position.slice(),
      [u, v, w] = plane,
      radius = words[3],
      // Both readings become the number of whole turns past the first.
      p = words[4] ?? (circles ? 0 : 1),
      extra = circles ? p : p - 1,
      su = from[u],
      sv = from[v],
      eu = to[u],
      ev = to[v];
    if (!Number.isInteger(p) || extra < 0)
      throw new LoaderError(
        F,
        'syntax',
        circles
          ? `P must be a whole number of circles, 0 or more, on line ${lineNumber}`
          : `P must be a whole number of turns on line ${lineNumber}`,
      );
    let cu: number, cv: number;
    if (radius !== undefined) {
      // Radius form: the centre is on the chord's bisector, left of the chord for a short G3 or a long G2.
      const chord = Math.hypot(eu - su, ev - sv),
        r = Math.abs(radius);
      if (!chord) throw new LoaderError(F, 'syntax', `an R arc must end away from its start on line ${lineNumber}`);
      if (r < chord / 2 - Math.max(0.005, 1e-3 * r))
        throw new LoaderError(F, 'range', `radius ${r} is shorter than half its chord on line ${lineNumber}`);
      const rise = Math.sqrt(Math.max(0, r * r - (chord * chord) / 4)) / chord,
        side = (ccw ? 1 : -1) * (radius < 0 ? -1 : 1);
      cu = (su + eu) / 2 - side * rise * (ev - sv);
      cv = (sv + ev) / 2 + side * rise * (eu - su);
    } else {
      // The offsets in the plane's own order: I J for G17, K I for G18, J K for G19 (words are I, J, K).
      const du = words[u],
        dv = words[v];
      if (absoluteCentre) {
        // LinuxCNC: with G90.1 both of the plane's centre words must be given.
        if (du === undefined || dv === undefined)
          throw new LoaderError(
            F,
            'syntax',
            `a G90.1 arc needs both centre words of its plane or R on line ${lineNumber}`,
          );
        cu = du;
        cv = dv;
      } else {
        if (du === undefined && dv === undefined)
          throw new LoaderError(F, 'syntax', `an arc needs centre offsets in its plane or R on line ${lineNumber}`);
        cu = su + (du ?? 0);
        cv = sv + (dv ?? 0);
      }
    }
    const r0 = Math.hypot(su - cu, sv - cv),
      r1 = Math.hypot(eu - cu, ev - cv),
      off = Math.abs(r1 - r0);
    // LinuxCNC: the end may miss the circle by at most 0.5 mm, and by at most 0.005 mm or 0.1% of the radius.
    if (off > 0.5 || (off > 0.005 && off > 1e-3 * r0))
      throw new LoaderError(F, 'range', `the arc's end is ${off} mm off its circle on line ${lineNumber}`);
    const a0 = Math.atan2(sv - cv, su - cu);
    let sweep = eu === su && ev === sv ? 0 : Math.atan2(ev - cv, eu - cu) - a0;
    // Turn the long way round to keep the direction; an arc that ends where it starts is a full circle.
    if (ccw ? sweep <= 0 : sweep >= 0) sweep += ccw ? 2 * Math.PI : -2 * Math.PI;
    sweep += (ccw ? 2 : -2) * Math.PI * extra;
    const step = r0 > ARC_TOLERANCE ? 2 * Math.acos(1 - ARC_TOLERANCE / r0) : Math.PI,
      chords = Math.max(1, Math.ceil(Math.abs(sweep) / Math.min(step, Math.PI / 8)));
    if (vertices + chords * 2 > maxVertices)
      throw new LoaderError(F, 'limit', `vertex count exceeds the limit of ${maxVertices}`);
    let last = from;
    for (let c = 1; c <= chords; c++) {
      const t = c / chords,
        point = to.slice();
      if (c < chords) {
        const angle = a0 + sweep * t,
          r = r0 + (r1 - r0) * t;
        point[u] = cu + r * Math.cos(angle);
        point[v] = cv + r * Math.sin(angle);
        point[w] = from[w] + (to[w] - from[w]) * t;
        point[3] = from[3] + (to[3] - from[3]) * t;
      }
      segment(last, point);
      last = point;
    }
  };

  for (let start = 0; start < text.length; ) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\(.*?\)/g, '');
    start = end + 1;
    lineNumber++;
    const semicolon = line.indexOf(';');
    let body = semicolon >= 0 ? line.slice(0, semicolon) : line;
    const star = body.indexOf('*');
    if (star >= 0) body = body.slice(0, star);
    let command = '';
    const values: (number | undefined)[] = [undefined, undefined, undefined, undefined],
      // I, J, K, R and P of an arc.
      arcWords: (number | undefined)[] = [undefined, undefined, undefined, undefined, undefined];
    word.lastIndex = 0;
    for (let match = word.exec(body); match; match = word.exec(body)) {
      const letter = match[1].toUpperCase();
      if (letter === 'N' && !command) continue;
      if (!command) {
        if (match[2] === undefined)
          throw new LoaderError(F, 'syntax', `command without a number on line ${lineNumber}`);
        command = letter + Number(match[2]);
        continue;
      }
      const axis = axes.indexOf(letter);
      if (axis < 0) {
        const at = 'IJKRP'.indexOf(letter);
        if (at < 0 || (command !== 'G2' && command !== 'G3')) continue;
        if (match[2] === undefined) throw new LoaderError(F, 'syntax', `${letter} has no number on line ${lineNumber}`);
        arcWords[at] = Number(match[2]) * (letter === 'P' ? 1 : unit);
        continue;
      }
      if (match[2] === undefined) {
        if (command === 'G28') values[axis] = 0;
        else if (command !== 'G92') throw new LoaderError(F, 'syntax', `${letter} has no number on line ${lineNumber}`);
        else values[axis] = 0;
      } else values[axis] = Number(match[2]) * unit;
    }
    switch (command) {
      case 'G90':
        relative = relativeE = false;
        break;
      case 'G91':
        relative = relativeE = true;
        break;
      case 'G90.1':
        absoluteCentre = true;
        break;
      case 'G91.1':
        absoluteCentre = false;
        break;
      case 'M82':
        relativeE = false;
        break;
      case 'M83':
        relativeE = true;
        break;
      case 'G20':
        unit = 25.4;
        break;
      case 'G21':
        unit = 1;
        break;
      case 'G17':
        plane = [0, 1, 2];
        break;
      case 'G18':
        plane = [2, 0, 1];
        break;
      case 'G19':
        plane = [1, 2, 0];
        break;
      case 'G92':
        for (let a = 0; a < 4; a++) position[a] = values[a] ?? (values.every((v) => v === undefined) ? 0 : position[a]);
        break;
      case 'G28':
        for (let a = 0; a < 3; a++)
          if (values[a] !== undefined || values.every((v) => v === undefined)) position[a] = 0;
        break;
      case 'G2':
      case 'G3': {
        const to = target(values);
        arc(command === 'G3', to, arcWords);
        position.splice(0, 4, ...to);
        break;
      }
      case 'G0':
      case 'G1': {
        const from = position.slice();
        position.splice(0, 4, ...target(values));
        segment(from, position);
        break;
      }
      default:
    }
  }
  if (pending.length) {
    const last = current ?? makeLayer(position[2]);
    if (!current) byZ.set(position[2], last);
    last.travel.reserve(pending.length);
    last.travel.array.set(pending.array.subarray(0, pending.length), last.travel.length);
    last.travel.length += pending.length;
  }
  const layers = [...byZ.values()]
    .sort((a, b) => a.z - b.z)
    .map((layer) => ({
      z: layer.z,
      extrusion: layer.extrusion.array.slice(0, layer.extrusion.length),
      travel: layer.travel.array.slice(0, layer.travel.length),
    }));
  if (!vertices) {
    min.fill(0);
    max.fill(0);
  }
  return { layers, filament, min, max, warnings };
}

function makeLayer(z: number) {
  return { z, extrusion: floats(), travel: floats() };
}

/** Options of {@link toolpathBeads}. */
export interface ToolpathBeadOptions {
  /** Bead width across the path, in the segments' units. Default 0.45 (a 0.4 mm nozzle's usual line). */
  width?: number;
  /** Bead height, the layer height; the bead's top is at the segment's Z. Default 0.2. Clamped to `width`. */
  height?: number;
  /** Chords on each rounded side of the bead, 1 to 16. Default 3. */
  round?: number;
}

/** A triangle mesh in the segments' frame (Z up), ready for `new Geometry(positions, normals, indices)`. */
export interface ToolpathBeadMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/**
 * Solid beads along toolpath segments, as a slicer preview draws them: each segment of a {@link GCodeLayer}'s
 * `extrusion` (or `travel`) becomes a prism of the stadium section that extruded filament takes, a rectangle with
 * half-round sides (Comminal, Serdeczny, Pedersen and Spangenberg, "Numerical modeling of the strand deposition flow
 * in extrusion-based additive manufacturing", Additive Manufacturing 20, 68-76, 2018,
 * https://doi.org/10.1016/j.addma.2017.12.013; the same rounded-rectangle area Slic3r's flow math uses), `width`
 * across and `height` tall with its top on the nozzle path, closed at both ends. Segments are two xyz points each, Z
 * up; vertical and zero-length segments draw nothing.
 *
 * @throws RangeError for a segment array whose length is not a multiple of 6, a non-positive width or height, or
 * `round` outside 1..16.
 *
 * @example
 * ```ts
 * import { parseGCode, toolpathBeads } from '@margoengine/loaders/gcode';
 *
 * const { layers } = parseGCode('G1 Z0.2\nG1 X10 E1\nG1 Y10 E2\n');
 * const bead = toolpathBeads(layers[0].extrusion, { width: 0.45, height: 0.2 });
 * console.log(bead.positions.length / 3, bead.indices.length / 3);
 * ```
 */
export function toolpathBeads(segments: ArrayLike<number>, options: ToolpathBeadOptions = {}): ToolpathBeadMesh {
  const width = options.width ?? 0.45,
    round = options.round ?? 3;
  if (
    !(width > 0) ||
    !Number.isFinite(width) ||
    !(options.height === undefined || (options.height > 0 && Number.isFinite(options.height)))
  )
    throw new RangeError('Invalid bead size; pass a positive finite width and height');
  if (!Number.isInteger(round) || round < 1 || round > 16)
    throw new RangeError('Invalid bead round; pass an integer 1 to 16');
  if (segments.length % 6) throw new RangeError('Invalid toolpath segments; pass two xyz points per segment');
  const height = Math.min(options.height ?? 0.2, width),
    r = height / 2,
    flat = width / 2 - r;
  // The section ring in (across, up) with its normals: the right half-round top to bottom, then the left one bottom
  // to top; the flats between them join points whose normals already agree.
  const ring: number[][] = [];
  for (let i = 0; i <= round; i++) {
    const a = Math.PI / 2 - (i * Math.PI) / round;
    ring.push([flat + r * Math.cos(a), r * Math.sin(a), Math.cos(a), Math.sin(a)]);
  }
  for (let i = 0; i <= round; i++) {
    const a = -Math.PI / 2 - (i * Math.PI) / round;
    ring.push([-flat + r * Math.cos(a), r * Math.sin(a), Math.cos(a), Math.sin(a)]);
  }
  const n = ring.length,
    perSegment = 2 * n + 2 * n,
    count = segments.length / 6;
  const positions = new Float32Array(count * perSegment * 3),
    normals = new Float32Array(count * perSegment * 3),
    indices = new Uint32Array(count * (2 * n * 3 + 2 * (n - 2) * 3));
  let v = 0,
    t = 0;
  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    normals[v * 3] = nx;
    normals[v * 3 + 1] = ny;
    normals[v * 3 + 2] = nz;
    return v++;
  };
  for (let s = 0; s < segments.length; s += 6) {
    const ax = segments[s],
      ay = segments[s + 1],
      az = segments[s + 2];
    const bx = segments[s + 3],
      by = segments[s + 4],
      bz = segments[s + 5];
    const dx = bx - ax,
      dy = by - ay,
      length = Math.hypot(dx, dy);
    if (!(length > 1e-9 * Math.max(1, width))) continue;
    // Across the path (the direction times -Z, so the right side is on the right of travel), up is +Z.
    const ux = dx / length,
      uy = dy / length,
      sx = uy,
      sy = -ux;
    const first = v;
    for (const [px, py, pz] of [
      [ax, ay, az],
      [bx, by, bz],
    ])
      for (const [across, up, na, nu] of ring)
        put(px + sx * across, py + sy * across, pz - r + up, sx * na, sy * na, nu);
    for (let i = 0; i < n; i++) {
      const a0 = first + i,
        a1 = first + ((i + 1) % n),
        b0 = a0 + n,
        b1 = a1 + n;
      indices.set([a0, a1, b0, a1, b1, b0], t);
      t += 6;
    }
    // Flat caps facing back along and forward along the path, as fans over the convex section.
    for (const [end, px, py, pz, sign] of [
      [0, ax, ay, az, -1],
      [1, bx, by, bz, 1],
    ] as const) {
      const cap = v;
      for (const [across, up] of ring) put(px + sx * across, py + sy * across, pz - r + up, ux * sign, uy * sign, 0);
      for (let i = 1; i < n - 1; i++) {
        indices.set(end ? [cap, cap + i, cap + i + 1] : [cap, cap + i + 1, cap + i], t);
        t += 3;
      }
    }
  }
  return { positions: positions.slice(0, v * 3), normals: normals.slice(0, v * 3), indices: indices.slice(0, t) };
}
