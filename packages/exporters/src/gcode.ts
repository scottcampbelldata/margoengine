// G-code writer: a mesh sliced into layers (outlines and rectilinear infill) or polylines walked as they are, as RepRap
// flavour G-code that `parseGCode` of @margoengine/loaders reads back. Slicing follows the plane-triangle intersection
// and even-odd scanline fill every slicer starts from; extrusion is the line's rectangular cross section
// (layer height x line width) over the filament's cross section.
import {
  collect,
  drawables,
  standZUp,
  toWorld,
  turnsToZUp,
  type ExportSource,
  type SceneOptions,
} from './scene.js';

/** Options of {@link exportGCode} and {@link exportGCodePaths}. Lengths are millimetres once `scale` has been applied. */
export interface GCodeOptions extends SceneOptions {
  /** Millimetres per scene unit. Default 1000 (the scene is in metres). */
  scale?: number;
  /** The scene's up axis; G-code is Z up, so 'y' (the glTF way) is turned to stand up. Default 'y'. */
  upAxis?: 'y' | 'z';
  /** Layer height in mm. Default 0.2. */
  layerHeight?: number;
  /** Height of the first layer in mm. Default: `layerHeight`. */
  firstLayerHeight?: number;
  /** Extrusion line width in mm. Default 0.4. */
  lineWidth?: number;
  /** Filament diameter in mm. Default 1.75. */
  filamentDiameter?: number;
  /** Multiplies every extrusion. Default 1. */
  extrusionMultiplier?: number;
  /** Rectilinear infill density, 0 (outlines only) to 1 (solid). Default 0.2. Mesh slicing only. */
  infill?: number;
  /** Nozzle temperature in degrees C (M104 and M109); 0 omits the commands. Default 200. */
  nozzleTemperature?: number;
  /** Bed temperature in degrees C (M140 and M190); 0 omits the commands. Default 60. */
  bedTemperature?: number;
  /** Print feed rate in mm/s. Default 50. */
  printSpeed?: number;
  /** Travel feed rate in mm/s. Default 120. */
  travelSpeed?: number;
  /** Feed rate in mm/s of the first layer. Default 20. */
  firstLayerSpeed?: number;
  /** Retraction length in mm; 0 disables retraction. Default 1. */
  retract?: number;
  /** Travels shorter than this mm skip the retraction. Default 2. */
  retractMinTravel?: number;
  /** Relative extrusion (M83, default) or absolute (M82). */
  relativeExtrusion?: boolean;
  /** Fan speed 0 to 255 from the second layer (M106), 0 for none. Default 255. */
  fan?: number;
  /** Lines written before the print (default: home, prime-free start for a RepRap printer). Replaces the default when given. */
  startCode?: string;
  /** Lines written after the print. Replaces the default (heaters off, motors off) when given. */
  endCode?: string;
  /**
   * Where the part sits on the bed, in mm. A mesh: its bounding box centre goes to this X and Y and its lowest point to
   * Z 0. Polylines: added to X and Y. Default: coordinates unchanged.
   */
  center?: [number, number];
}

/** The result of exporting: the program and what it contains. */
export interface GCodeResult {
  /** The G-code text, one command per line. */
  text: string;
  /** Layers written (distinct Z levels printed). */
  layers: number;
  /** Total extruded filament length in mm. */
  filament: number;
  /** Total printed path length in mm. */
  length: number;
  /** Bounding box of the printed path in mm. */
  min: [number, number, number];
  max: [number, number, number];
}

type Vec2 = [number, number];
interface Resolved {
  layerHeight: number;
  firstLayer: number;
  lineWidth: number;
  perMm: number;
  infill: number;
  printSpeed: number;
  travelSpeed: number;
  firstSpeed: number;
  retract: number;
  retractMin: number;
  relative: boolean;
  fan: number;
}

const positive = (value: number | undefined, fallback: number, name: string): number => {
  const v = value ?? fallback;
  if (!(v > 0) || !Number.isFinite(v)) throw new RangeError(`${name} must be a positive number; got ${value}`);
  return v;
};

function resolve(options: GCodeOptions): Resolved {
  const layerHeight = positive(options.layerHeight, 0.2, 'layerHeight'),
    lineWidth = positive(options.lineWidth, 0.4, 'lineWidth'),
    filament = positive(options.filamentDiameter, 1.75, 'filamentDiameter'),
    multiplier = positive(options.extrusionMultiplier, 1, 'extrusionMultiplier'),
    infill = options.infill ?? 0.2;
  if (!(infill >= 0 && infill <= 1)) throw new RangeError(`infill must be between 0 and 1; got ${infill}`);
  const nonNegative = (v: number | undefined, fallback: number, name: string): number => {
    const x = v ?? fallback;
    if (!(x >= 0) || !Number.isFinite(x)) throw new RangeError(`${name} must not be negative; got ${v}`);
    return x;
  };
  return {
    layerHeight,
    firstLayer: positive(options.firstLayerHeight, layerHeight, 'firstLayerHeight'),
    lineWidth,
    perMm: (multiplier * layerHeight * lineWidth) / (Math.PI * (filament / 2) ** 2),
    infill,
    printSpeed: positive(options.printSpeed, 50, 'printSpeed') * 60,
    travelSpeed: positive(options.travelSpeed, 120, 'travelSpeed') * 60,
    firstSpeed: positive(options.firstLayerSpeed, 20, 'firstLayerSpeed') * 60,
    retract: nonNegative(options.retract, 1, 'retract'),
    retractMin: nonNegative(options.retractMinTravel, 2, 'retractMinTravel'),
    relative: options.relativeExtrusion ?? true,
    fan: Math.min(255, Math.round(nonNegative(options.fan, 255, 'fan'))),
  };
}

/** One move in mm. `print` extrudes. */
interface Move {
  x: number;
  y: number;
  z: number;
  print: boolean;
}

const fixed = (v: number, digits = 3): string => {
  const s = v.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
};

function write(layers: Move[][], options: GCodeOptions, r: Resolved, comment: string): GCodeResult {
  const out: string[] = [`; ${comment}`, 'G21 ; millimetres', 'G90 ; absolute positioning'];
  const nozzle = options.nozzleTemperature ?? 200,
    bed = options.bedTemperature ?? 60;
  out.push(r.relative ? 'M83 ; relative extrusion' : 'M82 ; absolute extrusion');
  if (bed > 0) out.push(`M140 S${bed}`);
  if (nozzle > 0) out.push(`M104 S${nozzle}`);
  if (options.startCode !== undefined) out.push(...options.startCode.split(/\r?\n/));
  else out.push('G28 ; home');
  if (bed > 0) out.push(`M190 S${bed}`);
  if (nozzle > 0) out.push(`M109 S${nozzle}`);
  out.push('G92 E0');
  let e = 0,
    filament = 0,
    length = 0,
    cx = NaN,
    cy = NaN,
    cz = NaN,
    retracted = false;
  const min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const extrude = (amount: number): string => {
    if (r.relative) return fixed(amount, 5);
    e += amount;
    return fixed(e, 5);
  };
  layers.forEach((moves, index) => {
    if (!moves.length) return;
    out.push(`;LAYER:${index}`);
    if (index === 1 && r.fan > 0) out.push(`M106 S${r.fan}`);
    const speed = index === 0 ? r.firstSpeed : r.printSpeed;
    for (const m of moves) {
      const dist = Number.isNaN(cx) ? Infinity : Math.hypot(m.x - cx, m.y - cy, m.z - cz);
      if (m.print && !Number.isNaN(cx) && dist > 0) {
        if (retracted) {
          out.push(`G1 E${extrude(r.retract)} F${fixed(r.travelSpeed / 2, 0)}`);
          retracted = false;
        }
        const amount = dist * r.perMm;
        out.push(`G1 X${fixed(m.x)} Y${fixed(m.y)}${m.z !== cz ? ` Z${fixed(m.z)}` : ''} E${extrude(amount)} F${fixed(speed, 0)}`);
        filament += amount;
        length += dist;
        for (const [a, from, to] of [[0, cx, m.x], [1, cy, m.y], [2, cz, m.z]] as const) {
          min[a] = Math.min(min[a], from, to);
          max[a] = Math.max(max[a], from, to);
        }
      } else if (dist > 0 || Number.isNaN(cx)) {
        if (r.retract > 0 && !retracted && dist > r.retractMin && !Number.isNaN(cx)) {
          out.push(`G1 E${extrude(-r.retract)} F${fixed(r.travelSpeed / 2, 0)}`);
          retracted = true;
        }
        out.push(`G0 X${fixed(m.x)} Y${fixed(m.y)}${m.z !== cz ? ` Z${fixed(m.z)}` : ''} F${fixed(r.travelSpeed, 0)}`);
      }
      cx = m.x;
      cy = m.y;
      cz = m.z;
    }
  });
  if (options.endCode !== undefined) out.push(...options.endCode.split(/\r?\n/));
  else out.push('M107 ; fan off', 'M104 S0', 'M140 S0', 'M84 ; motors off');
  const empty = !Number.isFinite(min[0]);
  return {
    text: `${out.join('\n')}\n`,
    layers: layers.filter((l) => l.length).length,
    filament,
    length,
    min: empty ? [0, 0, 0] : min,
    max: empty ? [0, 0, 0] : max,
  };
}

// ---- slicing -------------------------------------------------------------------------------------------------------

/** Chains the segments of one layer into loops (closed when the end meets the start). Endpoints join within 1e-4 mm. */
function chain(segments: [Vec2, Vec2][]): Vec2[][] {
  const key = (p: Vec2): string => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  const at = new Map<string, number[]>();
  segments.forEach((s, i) => {
    for (const p of s) {
      const list = at.get(key(p));
      if (list) list.push(i);
      else at.set(key(p), [i]);
    }
  });
  const used = new Array<boolean>(segments.length).fill(false),
    loops: Vec2[][] = [];
  const next = (p: Vec2): number => (at.get(key(p)) ?? []).find((i) => !used[i]) ?? -1;
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const loop: Vec2[] = [segments[i][0], segments[i][1]];
    for (;;) {
      const tail = loop[loop.length - 1],
        j = next(tail);
      if (j < 0) break;
      used[j] = true;
      const [a, b] = segments[j];
      loop.push(key(a) === key(tail) ? b : a);
    }
    loops.push(loop);
  }
  return loops;
}

function sliceLayer(positions: ArrayLike<number>, indices: ArrayLike<number>, z: number): Vec2[][] {
  const segments: [Vec2, Vec2][] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => indices[t + k] * 3);
    // A vertex on the plane counts as above it, so every crossing yields zero or exactly two intersections.
    const above = v.map((o) => positions[o + 2] >= z),
      sum = above.filter(Boolean).length;
    if (sum === 0 || sum === 3) continue;
    const points: Vec2[] = [];
    for (let k = 0; k < 3; k++) {
      const a = v[k],
        b = v[(k + 1) % 3];
      if (above[k] === above[(k + 1) % 3]) continue;
      const f = (z - positions[a + 2]) / (positions[b + 2] - positions[a + 2]);
      points.push([positions[a] + f * (positions[b] - positions[a]), positions[a + 1] + f * (positions[b + 1] - positions[a + 1])]);
    }
    if (points.length === 2 && (points[0][0] !== points[1][0] || points[0][1] !== points[1][1])) segments.push([points[0], points[1]]);
  }
  return chain(segments);
}

/** Rectilinear infill: horizontal scanlines (even layers) or vertical (odd), filled between even-odd crossings, inset by one line width. */
function fill(loops: Vec2[][], spacing: number, vertical: boolean, inset: number): [Vec2, Vec2][] {
  const closed = loops.filter((l) => l.length > 3 && Math.hypot(l[0][0] - l[l.length - 1][0], l[0][1] - l[l.length - 1][1]) < 1e-3);
  if (!closed.length) return [];
  const a = vertical ? 0 : 1,
    b = 1 - a;
  let lo = Infinity,
    hi = -Infinity;
  for (const l of closed) for (const p of l) (lo = Math.min(lo, p[a])), (hi = Math.max(hi, p[a]));
  const lines: [Vec2, Vec2][] = [];
  let flip = false;
  for (let s = Math.ceil((lo + 1e-6) / spacing) * spacing; s < hi; s += spacing) {
    const xs: number[] = [];
    for (const l of closed)
      for (let i = 0; i + 1 < l.length; i++) {
        const p = l[i],
          q = l[i + 1];
        if (p[a] < s !== q[a] < s) xs.push(p[b] + ((s - p[a]) / (q[a] - p[a])) * (q[b] - p[b]));
      }
    xs.sort((m, n) => m - n);
    const row: [Vec2, Vec2][] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = xs[i] + inset,
        to = xs[i + 1] - inset;
      if (to - from < 1e-3) continue;
      const mk = (u: number): Vec2 => (vertical ? [s, u] : [u, s]);
      row.push(flip ? [mk(to), mk(from)] : [mk(from), mk(to)]);
    }
    lines.push(...(flip ? row.reverse() : row));
    flip = !flip;
  }
  return lines;
}

/**
 * Slices every mesh of `source` (an engine or scene, as the other exporters take) into layers and writes G-code: each
 * layer prints its outlines, then rectilinear infill at `infill` density, alternating direction layer to layer. A
 * layer's slice height is the middle of the layer. Open loops (a mesh with holes) are printed as the open lines they
 * are. Perimeters beyond the first, solid top and bottom skins and supports are not generated: the outline and the
 * sparse infill are the print.
 * @throws RangeError for an option that is out of range, TypeError for a source with no triangles.
 */
export function exportGCode(source: ExportSource, options: GCodeOptions = {}): GCodeResult {
  const r = resolve(options),
    scale = positive(options.scale, 1000, 'scale'),
    turn = turnsToZUp(options.upAxis, 'G-code');
  const meshes = drawables(collect(source, options, undefined, 'shape')).map((item) => {
    const mesh = toWorld(item, false),
      p = turn ? standZUp(mesh.positions) : mesh.positions,
      out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i++) out[i] = p[i] * scale;
    return { positions: out, indices: mesh.indices };
  });
  if (!meshes.some((m) => m.indices.length)) throw new TypeError('exportGCode needs a source with triangles to slice');
  let zMin = Infinity,
    zMax = -Infinity,
    xMin = Infinity,
    xMax = -Infinity,
    yMin = Infinity,
    yMax = -Infinity;
  for (const { positions: p } of meshes)
    for (let i = 0; i < p.length; i += 3) {
      xMin = Math.min(xMin, p[i]);
      xMax = Math.max(xMax, p[i]);
      yMin = Math.min(yMin, p[i + 1]);
      yMax = Math.max(yMax, p[i + 1]);
      zMin = Math.min(zMin, p[i + 2]);
      zMax = Math.max(zMax, p[i + 2]);
    }
  const dx = options.center ? options.center[0] - (xMin + xMax) / 2 : 0,
    dy = options.center ? options.center[1] - (yMin + yMax) / 2 : 0;
  const height = zMax - zMin,
    count = Math.max(1, Math.ceil((height - r.firstLayer) / r.layerHeight - 1e-9) + 1);
  if (count > 100_000) throw new RangeError(`${count} layers; raise layerHeight or scale the part down`);
  const spacing = r.infill > 0 ? r.lineWidth / r.infill : 0,
    layers: Move[][] = [];
  for (let k = 0; k < count; k++) {
    const bottom = k === 0 ? 0 : r.firstLayer + (k - 1) * r.layerHeight,
      top = Math.min(height, k === 0 ? r.firstLayer : bottom + r.layerHeight),
      printZ = options.center ? top : zMin + top,
      cut = zMin + (bottom + top) / 2,
      moves: Move[] = [];
    const loops = meshes.flatMap((m) => sliceLayer(m.positions, m.indices, cut));
    const emit = (path: Vec2[]): void => {
      path.forEach(([x, y], i) => moves.push({ x: x + dx, y: y + dy, z: printZ, print: i > 0 }));
    };
    for (const loop of loops) emit(loop);
    if (spacing > 0) for (const [p, q] of fill(loops, spacing, k % 2 === 1, r.lineWidth)) emit([p, q]);
    layers.push(moves);
  }
  return write(layers, options, r, 'Margo Engine G-code: sliced outlines and rectilinear infill');
}

/**
 * Writes polylines as printed paths: each path is a travel to its first point, then extrusion along it in X, Y and Z
 * (so a 3D line prints as a non-planar path). A path is `[x, y, z, x, y, z, ...]` in scene units; `scale` and `upAxis`
 * apply as for {@link exportGCode}. A layer is a distinct Z of the path's first point.
 */
export function exportGCodePaths(paths: ArrayLike<number>[], options: GCodeOptions = {}): GCodeResult {
  const r = resolve(options),
    scale = positive(options.scale, 1000, 'scale'),
    turn = turnsToZUp(options.upAxis, 'G-code');
  const byZ = new Map<string, Move[]>();
  for (const path of paths) {
    if (path.length % 3) throw new TypeError('each path needs x, y, z triples');
    if (path.length < 6) continue;
    const p = turn ? standZUp(Float64Array.from(path)) : path;
    const moves: Move[] = [];
    for (let i = 0; i < p.length; i += 3)
      moves.push({
        x: p[i] * scale + (options.center?.[0] ?? 0),
        y: p[i + 1] * scale + (options.center?.[1] ?? 0),
        z: p[i + 2] * scale,
        print: i > 0,
      });
    const key = fixed(moves[0].z, 3);
    byZ.set(key, [...(byZ.get(key) ?? []), ...moves]);
  }
  const layers = [...byZ.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, moves]) => moves);
  return write(layers, options, r, 'Margo Engine G-code: printed polylines');
}
