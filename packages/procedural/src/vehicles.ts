// Period vehicles and street machines: a 1910 steam locomotive with its tender (Whyte arrangements 4-4-0, 2-6-0, 4-6-0
// and 2-8-0, a diamond stack for wood burning), railway freight cars on arch bar trucks (box car, flat car, log car,
// gondola), a 1910 Ford Model T style touring car, a Japanese cab-over kei truck with a drop-side bed and a Japanese
// drink vending machine. Our own shapes from published dimensions; origin on the rail top or the ground under the
// middle, +x forward, +y up, metres. Deterministic for a seed; no other engine's code or models.
// Sources (docs/clean-room.md, "Period vehicles"):
// - F. M. Whyte's wheel arrangement notation (1900): leading, driving and trailing wheels counted in total.
// - Standard gauge 1,435 mm (4 ft 8 1/2 in); wheel back-to-back 1,356 mm (4 ft 5 3/8 in) and flange height 1 in, Master
//   Car Builders' Association wheel and track gauge standards; coupler centreline 32 1/2 to 34 1/2 in above the rail
//   (MCB standard, later AAR S-2001); clearance diagram AAR Plate B, 10 ft 8 in wide by 15 ft 6 in high.
// - Forney, M. N. (ed.) 1906, Locomotive Dictionary (Railroad Gazette), and Baldwin Locomotive Works record cards
//   1905-1912: Consolidation and Mogul drivers 50 to 57 in, Ten-Wheeler 60 to 66 in, American 62 to 69 in; boiler
//   centrelines near 9 ft and stacks near 15 ft above the rail; tenders on two four-wheel trucks with 33 in wheels.
// - MCB standard box car, 1910: 36 ft by 8 ft 6 in by 8 ft inside; arch bar trucks of 5 ft wheelbase, 33 in wheels.
// - Ford Motor Company, Model T specifications 1909-1910: wheelbase 100 in, track 56 in, 30 in wheels (30 by 3 front,
//   30 by 3 1/2 rear tyres).
// - Japan, Road Transport Vehicle Act enforcement regulations, kei class (from 1998): length 3.40 m, width 1.48 m,
//   height 2.00 m at most. Suzuki Carry truck DA63T (2002-2013) catalogue: 3,395 by 1,475 by 1,765 mm, wheelbase
//   1,900 mm, bed floor 1,940 by 1,410 mm with 290 mm drop sides at 650 mm, 145R12 6PR tyres.
// - Americans with Disabilities Act Standards 2010, 308.2.1: forward reach 15 to 48 in (0.381 to 1.219 m), for the
//   vending machine's coin slot, bill slot, change return and selection buttons. Japan Vending Machine Manufacturers
//   Association: outdoor drink machines about 1,830 mm high, 700 to 750 mm deep.
import type { GeometryData } from '@margoengine/geometry/utils';
import { checkSettings, choiceSetting, numberSetting, settingDefaults, settingIndex, type SettingRow } from '../../shared/settings.js';
import { MeshBuilder, add, scale, type V3 } from './mesh-builder.js';

/** A material hint: linear albedo, roughness, metalness. */
export interface VehicleMaterial {
  readonly color: readonly [number, number, number];
  readonly roughness: number;
  readonly metalness: number;
}
/** A vehicle: one geometry per part and a material hint for each. */
export interface Vehicle<P extends string = string> {
  readonly parts: Readonly<Partial<Record<P, GeometryData>>>;
  readonly palette: Readonly<Record<P, VehicleMaterial>>;
  /** Overall length (x), width (z) and height (y) of every part, metres. */
  readonly size: readonly [number, number, number];
}
const mat = (color: [number, number, number], roughness: number, metalness = 0): VehicleMaterial => ({ color, roughness, metalness });
function num(what: string, o: Record<string, unknown>, name: string, lo: number, hi: number, fallback: number, int = false): number {
  const v = o[name];
  if (v === undefined) return fallback;
  if (typeof v !== 'number') throw new TypeError(`Invalid ${what} ${name}; pass a number from ${lo} to ${hi}.`);
  if (!Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v)))
    throw new RangeError(`Invalid ${what} ${name}; pass ${int ? 'an integer' : 'a number'} from ${lo} to ${hi}.`);
  return v;
}
function pick<T extends string>(what: string, o: Record<string, unknown>, name: string, choices: readonly T[], fallback: T): T {
  const v = o[name];
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !choices.includes(v as T)) throw new RangeError(`Invalid ${what} ${name}; pass one of ${choices.join(', ')}.`);
  return v as T;
}
function obj(o: unknown, what: string): Record<string, unknown> {
  if (o === undefined) return {};
  if (typeof o !== 'object' || o === null) throw new TypeError(`Invalid ${what} options; pass an object.`);
  return o as Record<string, unknown>;
}
function seeded(seed: number) {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
const builders = <K extends string>(names: readonly K[]) =>
  Object.fromEntries(names.map((n) => [n, new MeshBuilder()])) as Record<K, MeshBuilder>;
function finish<K extends string>(p: Record<K, MeshBuilder>): Partial<Record<K, GeometryData>> {
  const out: Partial<Record<K, GeometryData>> = {};
  for (const [k, b] of Object.entries(p) as [K, MeshBuilder][]) if (b.triangles > 0) out[k] = b.finish();
  return out;
}
/** Bounds of some parts: low corner and high corner. */
export function vehicleBounds(parts: Readonly<Partial<Record<string, GeometryData>>>, only?: readonly string[]): { lo: V3; hi: V3 } {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (const [k, g] of Object.entries(parts))
    if (g && (!only || only.includes(k)))
      for (let i = 0; i < g.positions.length; i += 3)
        for (let c = 0; c < 3; c++) {
          lo[c] = Math.min(lo[c], g.positions[i + c]);
          hi[c] = Math.max(hi[c], g.positions[i + c]);
        }
  return { lo: [lo[0], lo[1], lo[2]], hi: [hi[0], hi[1], hi[2]] };
}
function size(parts: Readonly<Partial<Record<string, GeometryData>>>): [number, number, number] {
  const { lo, hi } = vehicleBounds(parts);
  return [hi[0] - lo[0], hi[2] - lo[2], hi[1] - lo[1]];
}
const X: V3 = [1, 0, 0],
  Y: V3 = [0, 1, 0],
  Z: V3 = [0, 0, 1];
const box = (m: MeshBuilder, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
  m.box([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2]);
const ring = (c: V3, r: number, n: number, z: number): V3[] =>
  Array.from({ length: n }, (_, k): V3 => [c[0] + r * Math.cos((2 * Math.PI * k) / n), c[1] + r * Math.sin((2 * Math.PI * k) / n), z]);
// A spoked wheel on an axle along z, centre c, tread radius r, width w. The flange (railway wheels) is on the inner
// face, toward z = 0; `counter` adds a driver's crescent counterweight opposite the crank pin.
function wheel(m: MeshBuilder, c: V3, r: number, w: number, spokes: number, segments: number, flange = 0, counter = false) {
  const inner = c[2] > 0 ? -1 : 1,
    a = add(c, [0, 0, -w / 2]),
    b = add(c, [0, 0, w / 2]);
  m.frustum(a, b, r, r, segments, false);
  m.frustum(add(a, [0, 0, 0.005]), add(b, [0, 0, -0.005]), r * 0.86, r * 0.86, segments, false);
  // The tyre's rims, front and back faces.
  for (const [zc, s] of [
    [a[2], -1],
    [b[2], 1],
  ] as const) {
    const out = ring(c, r, segments, zc),
      inn = ring(c, r * 0.86, segments, zc);
    for (let k = 0; k < segments; k++) {
      const k1 = (k + 1) % segments;
      m.poly(s > 0 ? [out[k], out[k1], inn[k1], inn[k]] : [out[k1], out[k], inn[k], inn[k1]], [0, 0, s]);
    }
  }
  if (flange > 0) {
    const zf = c[2] + (inner * w) / 2;
    m.frustum([c[0], c[1], zf], [c[0], c[1], zf + inner * 0.03], r + flange, r + flange, segments);
  }
  m.frustum(add(c, [0, 0, -w * 0.7]), add(c, [0, 0, w * 0.7]), r * 0.17, r * 0.17, 14);
  if (spokes > 0)
    for (let k = 0; k < spokes; k++) {
      const t = (2 * Math.PI * k) / spokes;
      m.beam(add(c, [r * 0.15 * Math.cos(t), r * 0.15 * Math.sin(t), 0]), add(c, [r * 0.87 * Math.cos(t), r * 0.87 * Math.sin(t), 0]), w * 0.45, r * 0.09, Z);
    }
  else m.frustum(add(c, [0, 0, -w * 0.2]), add(c, [0, 0, w * 0.2]), r * 0.87, r * 0.87, segments);
  if (counter) {
    // A crescent between the spokes, opposite the crank pin (which is straight up).
    const pts: V3[] = [];
    for (let k = 0; k <= 8; k++) {
      const t = -Math.PI / 2 - 0.9 + (1.8 * k) / 8;
      pts.push(add(c, [r * 0.85 * Math.cos(t), r * 0.85 * Math.sin(t), 0]));
    }
    for (let k = 8; k >= 0; k--) {
      const t = -Math.PI / 2 - 0.6 + (1.2 * k) / 8;
      pts.push(add(c, [r * 0.45 * Math.cos(t), r * 0.45 * Math.sin(t) - r * 0.05, 0]));
    }
    m.slab(
      pts.map((p) => add(p, [0, 0, -w * 0.3])),
      w * 0.6,
      Z,
    );
  }
}
// A round handrail on posts, from a to b.
function rail(m: MeshBuilder, a: V3, b: V3, posts: number, drop: number) {
  m.frustum(a, b, 0.016, 0.016, 8);
  for (let k = 0; k <= posts; k++) {
    const p: V3 = [a[0] + ((b[0] - a[0]) * k) / posts, a[1] + ((b[1] - a[1]) * k) / posts, a[2] + ((b[2] - a[2]) * k) / posts];
    m.frustum(p, add(p, [0, -drop, 0]), 0.012, 0.012, 6, false);
  }
}

// --- Steam locomotive ---------------------------------------------------------------------------------------------
/** Whyte wheel arrangement. */
export type LocomotiveArrangement = '4-4-0' | '2-6-0' | '4-6-0' | '2-8-0';
/** Every locomotive wheel arrangement, the default first. */
export const LOCOMOTIVE_ARRANGEMENTS: readonly LocomotiveArrangement[] = ['2-8-0', '4-4-0', '2-6-0', '4-6-0'];
/** Options for {@link generateLocomotive}. */
export interface LocomotiveOptions {
  /** Default `2-8-0` (Consolidation, the heavy freight and logging engine of 1910). */
  readonly arrangement?: LocomotiveArrangement;
  /**
   * Driving wheel diameter, metres, 1.1 to 1.9. Default by arrangement: 1.32 (52 in) for 2-8-0 and 2-6-0, 1.6 (63 in)
   * for 4-6-0, 1.73 (68 in) for 4-4-0.
   */
  readonly driver?: number;
  /** `diamond` (a wood burner's spark arresting stack) or `straight`. Default `diamond`. */
  readonly stack?: 'diamond' | 'straight';
  /** A tender behind. Default true. */
  readonly tender?: boolean;
  /** Tender load: `wood` (cordwood) or `coal`. Default `wood`. */
  readonly fuel?: 'wood' | 'coal';
}
/** The locomotive's parts, one geometry and material each. */
export type LocomotivePart = 'boiler' | 'smokebox' | 'running' | 'wheels' | 'rods' | 'cab' | 'glass' | 'tender' | 'load' | 'brass' | 'pipes';
/** A locomotive and tender, with its wheel sets and measured sizes. */
export interface Locomotive extends Vehicle<LocomotivePart> {
  readonly arrangement: LocomotiveArrangement;
  /** Every wheel set: centre x, diameter, kind. Treads sit on the rail top (y = 0). */
  readonly wheels: readonly { readonly x: number; readonly diameter: number; readonly kind: 'leading' | 'driver' | 'trailing' | 'tender' }[];
  /** First to last driving axle, metres. */
  readonly drivingWheelbase: number;
  /** Track gauge and wheel back-to-back, metres. */
  readonly gauge: number;
  readonly backToBack: number;
  /** Coupler centreline above the rail, metres. */
  readonly coupler: number;
  /** Length over the coupler faces, metres. */
  readonly length: number;
}
/** Standard gauge, metres (4 ft 8 1/2 in). */
export const GAUGE = 1.435;
/** Wheel back-to-back, metres (4 ft 5 3/8 in). */
export const BACK_TO_BACK = 1.356;
/** Coupler centreline above the rail, metres (34 in). */
export const COUPLER_HEIGHT = 0.864;
const TRUCK_WHEEL = 0.838,
  FLANGE = 0.0254,
  TYRE = 0.14,
  // Wheel centre plane: the inner (flange) face on the back-to-back.
  ZW = BACK_TO_BACK / 2 + TYRE / 2;
function coupler(m: MeshBuilder, x: number, dir: number) {
  // Knuckle coupler head on a shank, on the centreline.
  m.box([x - dir * 0.25, COUPLER_HEIGHT, 0], [0.25, 0.07, 0.07]);
  m.box([x - dir * 0.09, COUPLER_HEIGHT, 0], [0.09, 0.13, 0.14]);
  m.box([x - dir * 0.03, COUPLER_HEIGHT, 0.08], [0.03, 0.11, 0.06]);
}
/** A 1910 steam locomotive and tender on standard gauge track, facing +x, the rail top at y = 0. */
export function generateLocomotive(options: LocomotiveOptions = {}): Locomotive {
  const o = obj(options, 'locomotive'),
    arr = pick('locomotive', o, 'arrangement', LOCOMOTIVE_ARRANGEMENTS, '2-8-0'),
    [lead, drive, trail] = arr.split('-').map(Number),
    D = num('locomotive', o, 'driver', 1.1, 1.9, arr === '4-4-0' ? 1.73 : arr === '4-6-0' ? 1.6 : 1.32),
    stack = pick('locomotive', o, 'stack', ['diamond', 'straight'] as const, 'diamond'),
    fuel = pick('locomotive', o, 'fuel', ['wood', 'coal'] as const, 'wood');
  if (o.tender !== undefined && typeof o.tender !== 'boolean') throw new TypeError('Invalid locomotive tender; pass true or false.');
  const hasTender = o.tender !== false,
    m = builders(['boiler', 'smokebox', 'running', 'wheels', 'rods', 'cab', 'glass', 'tender', 'load', 'brass', 'pipes'] as const),
    wheels: { x: number; diameter: number; kind: 'leading' | 'driver' | 'trailing' | 'tender' }[] = [],
    seg = 28;
  // Drivers spaced by their diameter plus 0.2 m (Baldwin 1910 Consolidations: 52 in drivers on a 15 ft driving
  // wheelbase); the leading truck ahead, a trailing axle under the firebox.
  const pitch = D + 0.2,
    drivers = Array.from({ length: drive / 2 }, (_, i) => -i * pitch),
    lastDriver = drivers[drivers.length - 1],
    leadD = 0.762,
    leads = Array.from({ length: lead / 2 }, (_, i) => drivers[0] + D / 2 + 0.9 + leadD / 2 + i * (leadD + 0.35)),
    cyl = (lead ? leads[0] : drivers[0] + D / 2) + (lead ? 0.15 : 0.9),
    front = Math.max(cyl + 0.75, ...leads.map((x) => x + leadD / 2 + 0.6));
  for (const x of drivers) wheels.push({ x, diameter: D, kind: 'driver' });
  for (const x of leads) wheels.push({ x, diameter: leadD, kind: 'leading' });
  for (let i = 0; i < trail / 2; i++) wheels.push({ x: lastDriver - pitch / 2 - 0.7 - i * 1.1, diameter: 0.9, kind: 'trailing' });
  const rear = Math.min(lastDriver - D / 2 - 1.3, ...wheels.map((w) => w.x - w.diameter / 2 - 0.5));
  // Boiler: centreline about 9 ft (2.75 m) above the rail, smokebox ahead, the firebox and cab behind.
  const bc = 2.75,
    br = 0.8,
    smoke = front - 0.2,
    fireF = rear + 1.9,
    tubes = smoke - 1.3;
  m.boiler.frustum([fireF, bc + 0.04, 0], [tubes, bc, 0], br * 1.04, br, seg);
  // Boiler lagging bands.
  for (let k = 1; k < 6; k++) {
    const x = fireF + ((tubes - fireF) * k) / 6;
    m.brass.frustum([x - 0.025, bc, 0], [x + 0.025, bc, 0], br * 1.045, br * 1.045, seg);
  }
  // Firebox (a Belpaire-less wagon top behind the barrel) between the frames, down to the mud ring.
  box(m.boiler, rear + 0.25, fireF, 1.2, bc + 0.55, -0.85, 0.85);
  m.boiler.frustum([rear + 0.25, bc + 0.5, 0], [fireF, bc + 0.5, 0], 0.85, 0.85, seg);
  m.smokebox.frustum([tubes, bc, 0], [smoke, bc, 0], br * 1.06, br * 1.06, seg);
  m.smokebox.frustum([smoke, bc, 0], [smoke + 0.06, bc, 0], br * 1.0, br * 0.95, seg);
  // Smokebox door: hinge straps, dogs and a number plate.
  for (const y of [-0.35, 0.35]) box(m.brass, smoke + 0.06, smoke + 0.08, bc + y - 0.03, bc + y + 0.03, -0.55, 0.3);
  m.brass.frustum([smoke + 0.06, bc, 0], [smoke + 0.09, bc, 0], 0.2, 0.2, 20);
  // Stack: straight, or a diamond spark arrester (cone up, wide crown, cone in), top about 15 ft above the rail.
  const sx = smoke - 0.65,
    sTop = 4.57;
  m.smokebox.frustum([sx, bc + br * 0.9, 0], [sx, bc + br + 0.3, 0], 0.26, 0.24, 20);
  if (stack === 'diamond') {
    m.smokebox.frustum([sx, bc + br + 0.3, 0], [sx, sTop - 0.6, 0], 0.24, 0.66, 24);
    m.smokebox.frustum([sx, sTop - 0.6, 0], [sx, sTop - 0.4, 0], 0.66, 0.66, 24);
    m.smokebox.frustum([sx, sTop - 0.4, 0], [sx, sTop, 0], 0.66, 0.3, 24);
  } else {
    m.smokebox.frustum([sx, bc + br + 0.3, 0], [sx, sTop - 0.2, 0], 0.26, 0.32, 20);
    m.smokebox.frustum([sx, sTop - 0.2, 0], [sx, sTop, 0], 0.36, 0.36, 20);
  }
  // Steam dome and sand dome, the bell in its yoke, the whistle and safety valves, the oil headlight on its bracket.
  const dome = (x: number, r: number, h: number, part: MeshBuilder) => {
    part.frustum([x, bc + br * 0.8, 0], [x, bc + br + h, 0], r * 1.1, r, 24);
    part.frustum([x, bc + br + h, 0], [x, bc + br + h + 0.14, 0], r, r * 0.5, 24);
  };
  const steamDome = fireF + (tubes - fireF) * 0.35,
    sandDome = fireF + (tubes - fireF) * 0.65,
    bell = fireF + (tubes - fireF) * 0.85;
  dome(steamDome, 0.38, 0.45, m.brass);
  dome(sandDome, 0.32, 0.36, m.boiler);
  m.brass.frustum([bell, bc + br + 0.32, 0], [bell, bc + br + 0.58, 0], 0.21, 0.13, 20);
  m.brass.frustum([bell, bc + br + 0.58, 0], [bell, bc + br + 0.62, 0], 0.13, 0.04, 12);
  for (const s of [-1, 1]) m.boiler.beam([bell, bc + br - 0.05, s * 0.24], [bell, bc + br + 0.55, s * 0.24], 0.04, 0.04);
  m.boiler.beam([bell, bc + br + 0.55, -0.24], [bell, bc + br + 0.55, 0.24], 0.04, 0.04, X);
  m.brass.frustum([steamDome + 0.5, bc + br - 0.05, 0.15], [steamDome + 0.5, bc + br + 0.32, 0.15], 0.035, 0.035, 10);
  m.brass.frustum([steamDome + 0.5, bc + br + 0.32, 0.15], [steamDome + 0.5, bc + br + 0.5, 0.15], 0.05, 0.05, 12);
  for (const s of [-1, 1]) m.brass.frustum([fireF + 0.25, bc + br - 0.02, s * 0.15], [fireF + 0.25, bc + br + 0.22, s * 0.15], 0.05, 0.04, 12);
  box(m.running, smoke - 0.15, smoke + 0.05, bc + br - 0.05, bc + br + 0.08, -0.12, 0.12);
  box(m.brass, smoke - 0.28, smoke + 0.24, bc + br + 0.08, bc + br + 0.58, -0.26, 0.26);
  m.brass.frustum([smoke - 0.05, bc + br + 0.58, 0], [smoke - 0.05, bc + br + 0.72, 0], 0.07, 0.03, 10);
  m.glass.poly([[smoke + 0.245, bc + br + 0.16, -0.18], [smoke + 0.245, bc + br + 0.16, 0.18], [smoke + 0.245, bc + br + 0.5, 0.18], [smoke + 0.245, bc + br + 0.5, -0.18]], X);
  // Sand pipes from the sand dome to the drivers, boiler handrails, the injector and check valve pipes.
  for (const s of [-1, 1]) {
    for (const x of drivers.slice(0, 2)) m.pipes.frustum([sandDome, bc + br * 0.6, s * br * 0.8], [x + D * 0.55, D * 0.75, s * (ZW + 0.08)], 0.02, 0.02, 6);
    rail(m.pipes, [fireF + 0.1, bc + br * 0.55, s * (br + 0.12)], [smoke - 0.1, bc + br * 0.55, s * (br + 0.12)], 6, 0.12);
    m.pipes.frustum([fireF - 0.1, bc - 0.3, s * 0.95], [tubes - 0.6, bc - 0.15, s * (br + 0.05)], 0.035, 0.035, 8);
    m.brass.frustum([tubes - 0.6, bc - 0.15, s * (br + 0.05)], [tubes - 0.6, bc - 0.15, s * (br + 0.12)], 0.06, 0.06, 10);
    // Steam pipe from the smokebox down to the steam chest.
    m.pipes.frustum([tubes + 0.4, bc - 0.3, s * br * 0.9], [cyl, 1.55, s * 1.0], 0.1, 0.1, 12);
  }
  // Westinghouse air pump on the right side and main reservoirs under the running boards.
  m.pipes.frustum([fireF + 0.9, bc - 0.75, 1.1], [fireF + 0.9, bc + 0.35, 1.1], 0.17, 0.17, 16);
  m.pipes.frustum([fireF + 0.9, bc - 0.15, 1.1], [fireF + 0.9, bc - 0.05, 1.1], 0.2, 0.2, 16);
  for (const s of [-1, 1]) m.pipes.frustum([fireF + 0.4, 1.0, s * 0.95], [tubes - 0.2, 1.0, s * 0.95], 0.2, 0.2, 16);
  // Frame, running boards with their valances, cylinders and steam chests, saddle, pilot (cow catcher), buffer beam.
  for (const s of [-1, 1]) box(m.running, rear, front - 0.15, 0.75, 1.15, s * 0.45, s * 0.6);
  for (const s of [-1, 1]) {
    box(m.running, fireF, smoke - 0.2, bc - 0.72, bc - 0.68, s * 0.8, s * 1.38);
    box(m.running, fireF, smoke - 0.2, bc - 0.82, bc - 0.68, s * 1.36, s * 1.38);
    m.running.frustum([cyl - 0.5, 1.05, s * 1.0], [cyl + 0.5, 1.05, s * 1.0], 0.3, 0.3, 24);
    for (const x of [cyl - 0.5, cyl + 0.5]) m.running.frustum([x - 0.03, 1.05, s * 1.0], [x + 0.03, 1.05, s * 1.0], 0.34, 0.34, 24);
    box(m.running, cyl - 0.42, cyl + 0.42, 1.38, 1.7, s * 0.85, s * 1.18);
    box(m.running, cyl - 0.35, cyl + 0.35, 1.05, bc - 0.55, s * 0.55, s * 0.9);
  }
  box(m.running, front - 0.15, front, 0.6, 1.2, -1.3, 1.3);
  for (let k = -6; k <= 6; k++) m.running.beam([front, 1.0, k * 0.2], [front + 0.95, 0.12, k * 0.07], 0.05, 0.05);
  m.running.beam([front + 0.95, 0.1, -0.5], [front + 0.95, 0.1, 0.5], 0.06, 0.06, Y);
  for (const s of [-1, 1]) m.running.beam([front, 0.85, s * 1.25], [front + 0.95, 0.1, s * 0.5], 0.06, 0.06);
  coupler(m.running, front + 0.95 + 0.06, 1);
  // Wheels, axles, crank pins; side rods, main rod, crosshead on its guides, valve rod.
  for (const w of wheels) {
    for (const s of [-1, 1])
      wheel(m.wheels, [w.x, w.diameter / 2, s * ZW], w.diameter / 2, TYRE, w.kind === 'driver' ? 18 : w.kind === 'tender' ? 0 : 10, seg, FLANGE, w.kind === 'driver');
    m.wheels.frustum([w.x, w.diameter / 2, -ZW], [w.x, w.diameter / 2, ZW], 0.09, 0.09, 12, false);
  }
  const crank = D * 0.18;
  for (const s of [-1, 1]) {
    const zr = s * (ZW + 0.13);
    for (const x of drivers) m.rods.frustum([x, D / 2 + crank, s * (ZW + 0.05)], [x, D / 2 + crank, s * (ZW + 0.17)], 0.05, 0.05, 10);
    m.rods.beam([drivers[0] + 0.05, D / 2 + crank, zr], [lastDriver - 0.05, D / 2 + crank, zr], 0.04, 0.11, Y);
    const main = drivers[Math.min(1, drivers.length - 1)],
      head = cyl - 0.5 - 0.35;
    m.rods.beam([head, 1.05, s * (ZW + 0.2)], [main, D / 2 + crank, s * (ZW + 0.2)], 0.05, 0.13, Y);
    box(m.rods, head - 0.15, head + 0.15, 0.95, 1.15, s * (ZW + 0.16), s * (ZW + 0.26));
    for (const y of [0.92, 1.18]) box(m.running, head - 0.45, cyl - 0.5, y - 0.02, y + 0.02, s * (ZW + 0.15), s * (ZW + 0.27));
    m.rods.beam([cyl - 0.45, 1.55, s * 1.0], [drivers[0] + 0.25, D / 2 + 0.1, s * (ZW + 0.3)], 0.025, 0.04, Y);
  }
  // Cab: steel sides with windows, front windows either side of the firebox, roof with an overhang and ventilator.
  const cab0 = rear,
    cab1 = rear + 1.9,
    cabTop = 3.95,
    cw = 1.45;
  for (const s of [-1, 1]) {
    box(m.cab, cab0, cab1, 1.25, 2.25, s * cw - 0.04, s * cw + 0.04);
    box(m.cab, cab0, cab0 + 0.25, 2.25, cabTop, s * cw - 0.04, s * cw + 0.04);
    box(m.cab, cab1 - 0.2, cab1, 2.25, cabTop, s * cw - 0.04, s * cw + 0.04);
    box(m.cab, cab0 + 0.95, cab0 + 1.05, 2.25, cabTop, s * cw - 0.04, s * cw + 0.04);
    box(m.cab, cab0, cab1, 3.2, cabTop, s * cw - 0.04, s * cw + 0.04);
    for (const [x0, x1] of [
      [cab0 + 0.3, cab0 + 0.9],
      [cab0 + 1.1, cab1 - 0.25],
    ])
      m.glass.poly(
        s > 0
          ? [[x0, 2.3, s * cw], [x1, 2.3, s * cw], [x1, 3.15, s * cw], [x0, 3.15, s * cw]]
          : [[x1, 2.3, s * cw], [x0, 2.3, s * cw], [x0, 3.15, s * cw], [x1, 3.15, s * cw]],
        [0, 0, s],
      );
    box(m.cab, cab1 - 0.06, cab1, 1.25, cabTop, s * 0.9, s * cw);
    m.glass.poly([[cab1 + 0.001, 3.0, s * 0.95], [cab1 + 0.001, 3.0, s * 1.35], [cab1 + 0.001, 3.6, s * 1.35], [cab1 + 0.001, 3.6, s * 0.95]], X);
    // Grab irons and steps at the cab door.
    m.pipes.frustum([cab0 + 0.05, 1.3, s * (cw + 0.08)], [cab0 + 0.05, 3.0, s * (cw + 0.08)], 0.015, 0.015, 6);
    box(m.running, cab0 - 0.1, cab0 + 0.35, 0.55, 0.6, s * (cw - 0.2), s * (cw + 0.05));
    box(m.running, cab0 - 0.1, cab0 + 0.35, 0.95, 1.0, s * (cw - 0.2), s * (cw + 0.05));
  }
  box(m.cab, cab1 - 0.06, cab1, 3.65, cabTop, -0.9, 0.9);
  m.cab.slab([[cab0 - 0.3, cabTop, -1.6], [cab1 + 0.15, cabTop, -1.6], [cab1 + 0.15, cabTop + 0.12, 0], [cab0 - 0.3, cabTop + 0.12, 0]], 0.05, Y);
  m.cab.slab([[cab0 - 0.3, cabTop + 0.12, 0], [cab1 + 0.15, cabTop + 0.12, 0], [cab1 + 0.15, cabTop, 1.6], [cab0 - 0.3, cabTop, 1.6]], 0.05, Y);
  box(m.cab, cab0 + 0.4, cab1 - 0.4, cabTop + 0.12, cabTop + 0.3, -0.35, 0.35);
  // Tender: a water tank with flared coping, the fuel space at the front, a water hatch, two four-wheel trucks.
  let tail = rear - 0.2;
  if (hasTender) {
    const t1 = rear - 0.45,
      t0 = t1 - 7.3;
    tail = t0;
    box(m.tender, t0, t1, 1.1, 1.3, -1.45, 1.45);
    box(m.tender, t0, t1, 1.3, 2.7, -1.42, 1.42);
    for (const s of [-1, 1]) m.tender.slab([[t0, 2.7, s * 1.42], [t1, 2.7, s * 1.42], [t1, 2.95, s * 1.56], [t0, 2.95, s * 1.56]], 0.03, [0, 0, s]);
    m.tender.slab([[t0, 2.7, -1.42], [t0, 2.7, 1.42], [t0 - 0.12, 2.95, 1.56], [t0 - 0.12, 2.95, -1.56]], 0.03, [-1, 0, 0]);
    m.tender.frustum([t0 + 0.9, 2.7, 0], [t0 + 0.9, 2.95, 0], 0.32, 0.32, 20);
    for (const s of [-1, 1]) m.pipes.frustum([t0 + 0.05, 1.35, s * 1.3], [t0 + 0.05, 2.9, s * 1.3], 0.015, 0.015, 6);
    const rnd = seeded(7);
    if (fuel === 'wood')
      for (let k = 0; k < 4; k++)
        for (let j = 0; j < 6; j++) {
          const z = -1.12 + j * 0.45 + (k % 2) * 0.1,
            y = 2.8 + k * 0.19,
            r = 0.09 + 0.02 * rnd();
          m.load.frustum([t1 - 3.4 + 0.2 * rnd(), y, z], [t1 - 0.15 - 0.2 * rnd(), y, z + 0.06 * (rnd() - 0.5)], r, r, 7);
        }
    else
      for (let k = 0; k < 7; k++) m.load.slab([[t1 - 3.4, 2.7, -1.35 + k * 0.4], [t1 - 0.2, 2.7, -1.35 + k * 0.4], [t1 - 0.2, 3.05 + 0.1 * Math.sin(k), -1.15 + k * 0.4], [t1 - 3.4, 3.0 + 0.1 * Math.cos(k), -1.15 + k * 0.4]], 0.4, Y);
    for (const tc of [t0 + 1.5, t1 - 1.5]) truck(m.running, m.wheels, tc, wheels.push.bind(wheels));
    coupler(m.running, t0 - 0.36, -1);
    tail = t0 - 0.36;
  } else coupler(m.running, rear - 0.36, -1);
  const parts = finish(m);
  return {
    parts,
    palette: {
      boiler: mat([0.03, 0.03, 0.035], 0.45, 0.6),
      smokebox: mat([0.02, 0.02, 0.02], 0.75, 0.5),
      running: mat([0.025, 0.025, 0.025], 0.6, 0.6),
      wheels: mat([0.03, 0.03, 0.03], 0.5, 0.7),
      rods: mat([0.55, 0.55, 0.57], 0.3, 1),
      cab: mat([0.18, 0.04, 0.03], 0.6),
      glass: mat([0.02, 0.025, 0.03], 0.05),
      tender: mat([0.03, 0.03, 0.035], 0.55, 0.5),
      load: mat(fuel === 'wood' ? [0.24, 0.16, 0.09] : [0.015, 0.015, 0.015], 0.85),
      brass: mat([0.65, 0.45, 0.15], 0.3, 1),
      pipes: mat([0.08, 0.08, 0.08], 0.5, 0.8),
    },
    size: size(parts),
    arrangement: arr,
    wheels,
    drivingWheelbase: drivers[0] - lastDriver,
    gauge: GAUGE,
    backToBack: BACK_TO_BACK,
    coupler: COUPLER_HEIGHT,
    length: front + 0.95 + 0.06 - tail,
  };
}
// A diamond (arch bar) freight truck centred at x: arch bars, column bolts, bolster, journal boxes and two wheel sets
// on a 5 ft (1.524 m) wheelbase with 33 in wheels.
function truck(frame: MeshBuilder, wheelPart: MeshBuilder, tc: number, add1: (w: { x: number; diameter: number; kind: 'tender' }) => void) {
  const r = TRUCK_WHEEL / 2,
    half = 0.762,
    zs = ZW + TYRE / 2 + 0.12;
  box(frame, tc - 0.14, tc + 0.14, 0.62, 0.95, -1.15, 1.15);
  for (const s of [-1, 1]) {
    const z = s * zs;
    box(frame, tc - half - 0.2, tc + half + 0.2, 0.68, 0.74, z - 0.05, z + 0.05);
    box(frame, tc - half - 0.2, tc + half + 0.2, 0.2, 0.25, z - 0.05, z + 0.05);
    frame.beam([tc - half - 0.1, 0.26, z], [tc - 0.25, 0.62, z], 0.1, 0.05, Z);
    frame.beam([tc + 0.25, 0.62, z], [tc + half + 0.1, 0.26, z], 0.1, 0.05, Z);
    for (const dx of [-0.25, 0.25]) box(frame, tc + dx - 0.04, tc + dx + 0.04, 0.25, 0.68, z - 0.06, z + 0.06);
    for (const dx of [-half, half]) box(frame, tc + dx - 0.14, tc + dx + 0.14, r - 0.12, r + 0.16, z - 0.09, z + 0.09);
  }
  for (const dx of [-half, half]) {
    const x = tc + dx;
    add1({ x, diameter: TRUCK_WHEEL, kind: 'tender' });
    for (const s of [-1, 1]) wheel(wheelPart, [x, r, s * ZW], r, TYRE, 0, 24, FLANGE);
    wheelPart.frustum([x, r, -zs], [x, r, zs], 0.07, 0.07, 10, false);
  }
}

// --- Railway freight cars -------------------------------------------------------------------------------------------
/** Freight car kinds. */
export type WagonKind = 'boxcar' | 'flatcar' | 'log-car' | 'gondola';
/** Every freight car kind, the default first. */
export const WAGON_KINDS: readonly WagonKind[] = ['boxcar', 'flatcar', 'log-car', 'gondola'];
/** Options for {@link generateWagon}. */
export interface WagonOptions {
  /** Default `boxcar`. */
  readonly kind?: WagonKind;
  /** Body length, metres, 6 to 18. Default 10.97 (36 ft). */
  readonly length?: number;
  /** Integer seed (log sizes, gondola load). Default 1. */
  readonly seed?: number;
}
/** A freight car's parts, one geometry and material each. */
export type WagonPart = 'body' | 'frame' | 'trucks' | 'roof' | 'doors' | 'load' | 'irons';
/** A freight car, with its wheel sets and measured sizes. */
export interface Wagon extends Vehicle<WagonPart> {
  readonly kind: WagonKind;
  /** Every wheel set: centre x and diameter. */
  readonly wheels: readonly { readonly x: number; readonly diameter: number }[];
  readonly coupler: number;
  readonly gauge: number;
  readonly backToBack: number;
  /** Deck (floor) height above the rail, metres. */
  readonly deck: number;
  /** Length over the coupler faces, metres. */
  readonly length: number;
}
/** A 1910 freight car on two arch bar trucks, centred on the rail top, its length along x. */
export function generateWagon(options: WagonOptions = {}): Wagon {
  const o = obj(options, 'wagon'),
    kind = pick('wagon', o, 'kind', WAGON_KINDS, 'boxcar'),
    L = num('wagon', o, 'length', 6, 18, 10.97),
    rand = seeded(num('wagon', o, 'seed', -0x80000000, 0xffffffff, 1, true));
  const m = builders(['body', 'frame', 'trucks', 'roof', 'doors', 'load', 'irons'] as const),
    W = 2.74,
    deck = 1.12,
    wheels: { x: number; diameter: number }[] = [];
  // Underframe: centre and side sills, needle beams, end sills, truss rods with queen posts and turnbuckles.
  for (const z of [-W / 2 + 0.06, -0.2, 0.2, W / 2 - 0.06]) box(m.frame, -L / 2, L / 2, deck - 0.32, deck - 0.05, z - 0.06, z + 0.06);
  for (const s of [-1, 1]) box(m.frame, s * L / 2 - 0.1, s * L / 2 + 0.1, deck - 0.35, deck, -W / 2, W / 2);
  for (const x of [-L / 6, L / 6]) {
    box(m.frame, x - 0.08, x + 0.08, deck - 0.3, deck - 0.05, -W / 2, W / 2);
    for (const z of [-0.65, 0.65]) box(m.frame, x - 0.04, x + 0.04, deck - 0.75, deck - 0.3, z - 0.04, z + 0.04);
  }
  for (const z of [-0.65, -0.25, 0.25, 0.65]) {
    const pts: V3[] = [[-L / 2 + 0.3, deck - 0.2, z], [-L / 6, deck - 0.75, z], [L / 6, deck - 0.75, z], [L / 2 - 0.3, deck - 0.2, z]];
    for (let i = 0; i < 3; i++) m.frame.frustum(pts[i], pts[i + 1], 0.016, 0.016, 6, false);
    m.irons.frustum([-0.12, deck - 0.75, z], [0.12, deck - 0.75, z], 0.03, 0.03, 8);
  }
  for (const s of [-1, 1]) {
    coupler(m.frame, s * (L / 2 + 0.45), s);
    // Brake wheel on a staff at the B end, grab irons and sill steps at each corner.
    if (s > 0) {
      m.irons.frustum([L / 2 + 0.06, deck - 0.2, W / 2 - 0.35], [L / 2 + 0.06, deck + (kind === 'boxcar' ? 2.75 : 1.4), W / 2 - 0.35], 0.018, 0.018, 6);
      m.irons.frustum([L / 2 + 0.06, deck + (kind === 'boxcar' ? 2.75 : 1.4), W / 2 - 0.35], [L / 2 + 0.06, deck + (kind === 'boxcar' ? 2.77 : 1.42), W / 2 - 0.35], 0.24, 0.24, 18);
    }
    for (const t of [-1, 1]) {
      box(m.irons, s * (L / 2 - 0.35), s * (L / 2 - 0.05), deck - 0.55, deck - 0.52, t * (W / 2 + 0.02), t * (W / 2 + 0.06));
      for (const h of [0.3, 0.7]) m.irons.frustum([s * (L / 2 - 0.4), deck + h, t * (W / 2 + 0.05)], [s * (L / 2 - 0.1), deck + h, t * (W / 2 + 0.05)], 0.012, 0.012, 6);
    }
  }
  // Arch bar trucks inset 1.6 m from the car ends.
  for (const tc of [-L / 2 + 1.6, L / 2 - 1.6]) truck(m.trucks, m.trucks, tc, (w) => wheels.push({ x: w.x, diameter: w.diameter }));
  if (kind === 'boxcar') {
    // MCB 1910: 8 ft inside height; outside sheathing in vertical boards, exterior posts and braces, sliding doors.
    const H = 2.55;
    box(m.body, -L / 2, L / 2, deck, deck + H, -W / 2, W / 2);
    for (const s of [-1, 1]) {
      for (let x = -L / 2 + 0.05; x <= L / 2; x += 0.9) box(m.body, x - 0.05, x + 0.05, deck, deck + H, s * (W / 2) - 0.02, s * (W / 2) + 0.03);
      box(m.body, -L / 2, L / 2, deck + H - 0.12, deck + H, s * (W / 2) - 0.02, s * (W / 2) + 0.04);
      box(m.doors, -0.95, 0.95, deck + 0.05, deck + H - 0.18, s * (W / 2 + 0.04), s * (W / 2 + 0.08));
      for (const x of [-0.95, 0.95]) box(m.doors, x - 0.05, x + 0.05, deck + 0.05, deck + H - 0.18, s * (W / 2 + 0.07), s * (W / 2 + 0.1));
      box(m.irons, -1.0, 2.2, deck + H - 0.17, deck + H - 0.13, s * (W / 2 + 0.03), s * (W / 2 + 0.08));
      box(m.irons, -1.0, 2.2, deck + 0.02, deck + 0.06, s * (W / 2 + 0.03), s * (W / 2 + 0.08));
      // End ladder rungs.
      for (let k = 0; k < 7; k++) m.irons.frustum([s * (L / 2 + 0.05), deck + 0.25 + k * 0.33, -W / 2 + 0.2], [s * (L / 2 + 0.05), deck + 0.25 + k * 0.33, -W / 2 + 0.6], 0.012, 0.012, 6);
    }
    m.roof.slab([[-L / 2 - 0.1, deck + H, -W / 2 - 0.1], [L / 2 + 0.1, deck + H, -W / 2 - 0.1], [L / 2 + 0.1, deck + H + 0.22, 0], [-L / 2 - 0.1, deck + H + 0.22, 0]], 0.05, Y);
    m.roof.slab([[-L / 2 - 0.1, deck + H + 0.22, 0], [L / 2 + 0.1, deck + H + 0.22, 0], [L / 2 + 0.1, deck + H, W / 2 + 0.1], [-L / 2 - 0.1, deck + H, W / 2 + 0.1]], 0.05, Y);
    // Running board along the ridge.
    box(m.roof, -L / 2, L / 2, deck + H + 0.25, deck + H + 0.3, -0.25, 0.25);
  } else if (kind === 'gondola') {
    for (const s of [-1, 1]) {
      box(m.body, -L / 2, L / 2, deck, deck + 1.0, s * W / 2 - 0.05, s * W / 2 + 0.05);
      box(m.body, s * L / 2 - 0.05, s * L / 2 + 0.05, deck, deck + 1.0, -W / 2, W / 2);
      for (let x = -L / 2 + 0.6; x < L / 2; x += 1.2) box(m.body, x - 0.06, x + 0.06, deck, deck + 1.0, s * (W / 2 + 0.05), s * (W / 2 + 0.11));
    }
    box(m.body, -L / 2 + 0.05, L / 2 - 0.05, deck, deck + 0.06, -W / 2 + 0.05, W / 2 - 0.05);
    // Heaped coal or rock: a ridge of lumps.
    for (let x = -L / 2 + 0.4; x < L / 2 - 0.3; x += 0.55)
      for (let z = -W / 2 + 0.35; z < W / 2 - 0.3; z += 0.55) {
        const h = 0.6 + 0.35 * (1 - Math.abs(z) / (W / 2)) + 0.12 * rand();
        box(m.load, x - 0.3, x + 0.3, deck + 0.06, deck + h, z - 0.3, z + 0.3);
      }
  } else {
    // Flat car deck planks; a log car carries a load of logs chained down between stakes.
    for (let x = -L / 2 + 0.05; x < L / 2 - 0.1; x += 0.2) box(m.body, x, x + 0.19, deck, deck + 0.07, -W / 2, W / 2);
    for (const s of [-1, 1]) for (let x = -L / 2 + 0.6; x < L / 2; x += 1.2) box(m.irons, x - 0.05, x + 0.05, deck - 0.2, deck + 0.04, s * (W / 2 + 0.01), s * (W / 2 + 0.05));
    if (kind === 'log-car') {
      for (const s of [-1, 1]) for (let x = -L / 2 + 0.8; x < L / 2; x += 2.4) box(m.frame, x - 0.07, x + 0.07, deck, deck + 1.9, s * W / 2 - 0.14, s * W / 2);
      let y = deck + 0.07;
      for (let row = 0; row < 4; row++) {
        const n = 5 - (row % 2),
          r = 0.26;
        for (let k = 0; k < n; k++) {
          const z = -W / 2 + 0.17 + r + k * 2 * r + (row % 2) * r,
            rr = r * (0.82 + 0.15 * rand()),
            out = 0.3 * rand();
          m.load.frustum([-L / 2 - out, y + rr, z], [L / 2 + 0.3 * rand(), y + rr, z], rr, rr * 0.9, 14);
        }
        y += 2 * r * 0.87;
      }
      for (let x = -L / 2 + 1.6; x < L / 2; x += 3.2) {
        m.irons.frustum([x, deck + 0.1, -W / 2 - 0.02], [x, y + 0.08, 0], 0.02, 0.02, 6, false);
        m.irons.frustum([x, y + 0.08, 0], [x, deck + 0.1, W / 2 + 0.02], 0.02, 0.02, 6, false);
      }
    }
  }
  const parts = finish(m);
  return {
    parts,
    palette: {
      body: mat(kind === 'boxcar' ? [0.25, 0.06, 0.03] : [0.2, 0.15, 0.1], 0.8),
      frame: mat([0.03, 0.03, 0.03], 0.7, 0.4),
      trucks: mat([0.03, 0.03, 0.03], 0.6, 0.6),
      roof: mat([0.12, 0.05, 0.03], 0.75),
      doors: mat([0.22, 0.05, 0.03], 0.8),
      load: mat(kind === 'gondola' ? [0.02, 0.02, 0.02] : [0.3, 0.2, 0.12], 0.9),
      irons: mat([0.04, 0.04, 0.04], 0.6, 0.6),
    },
    size: size(parts),
    kind,
    wheels,
    coupler: COUPLER_HEIGHT,
    gauge: GAUGE,
    backToBack: BACK_TO_BACK,
    deck,
    length: L + 0.9,
  };
}

// --- 1910 touring car -----------------------------------------------------------------------------------------------
/** Options for {@link generateTouringCar}. */
export interface TouringCarOptions {
  /** The folding top `up` or `down`. Default `up`. */
  readonly top?: 'up' | 'down';
}
/** The touring car's parts, one geometry and material each. */
export type TouringCarPart = 'body' | 'fenders' | 'wheels' | 'tyres' | 'brass' | 'top' | 'seats' | 'glass' | 'chassis' | 'spare';
/** A touring car, with its wheelbase, track and wheel size. */
export interface TouringCar extends Vehicle<TouringCarPart> {
  /** Wheelbase, track and wheel diameter, metres (100 in, 56 in, 30 in). */
  readonly wheelbase: number;
  readonly track: number;
  readonly wheel: number;
}
/** A 1910 five seat touring car in the manner of the Ford Model T, on the ground, facing +x. */
export function generateTouringCar(options: TouringCarOptions = {}): TouringCar {
  const o = obj(options, 'touring car'),
    top = pick('touring car', o, 'top', ['up', 'down'] as const, 'up');
  const m = builders(['body', 'fenders', 'wheels', 'tyres', 'brass', 'top', 'seats', 'glass', 'chassis', 'spare'] as const),
    wb = 2.54,
    tr = 1.4224,
    R = 0.381,
    fx = wb / 2,
    rx = -wb / 2;
  // Wooden artillery wheels (12 spokes), clincher tyres 3 in front and 3 1/2 in rear.
  for (const x of [fx, rx])
    for (const s of [-1, 1]) {
      const tw = x > 0 ? 0.0762 : 0.0889;
      wheel(m.wheels, [x, R, (s * tr) / 2], R - tw, 0.06, 12, 28);
      m.tyres.frustum([x, R, (s * tr) / 2 - tw / 2], [x, R, (s * tr) / 2 + tw / 2], R, R, 32, false);
      m.tyres.frustum([x, R, (s * tr) / 2 - tw / 2], [x, R, (s * tr) / 2 + tw / 2], R - tw, R - tw, 32, false);
      for (const zf of [-tw / 2, tw / 2]) {
        const out = ring([x, R, 0], R, 32, (s * tr) / 2 + zf),
          inn = ring([x, R, 0], R - tw, 32, (s * tr) / 2 + zf);
        for (let k = 0; k < 32; k++) {
          const k1 = (k + 1) % 32;
          m.tyres.poly(zf > 0 ? [out[k], out[k1], inn[k1], inn[k]] : [out[k1], out[k], inn[k], inn[k1]], [0, 0, zf > 0 ? 1 : -1]);
        }
      }
    }
  // Chassis rails, transverse springs over each axle, axles, the radius rods, the running gear pan.
  for (const s of [-1, 1]) box(m.chassis, rx - 0.3, fx + 0.12, 0.5, 0.6, s * 0.38 - 0.03, s * 0.38 + 0.03);
  for (const x of [fx, rx]) {
    m.chassis.beam([x, R, -tr / 2], [x, R, tr / 2], 0.05, 0.05);
    for (let k = 0; k < 5; k++) m.chassis.beam([x, 0.6 + k * 0.02, -0.4 + k * 0.05], [x, 0.6 + k * 0.02, 0.4 - k * 0.05], 0.05, 0.015);
  }
  for (const s of [-1, 1]) m.chassis.beam([fx, R, s * 0.6], [fx - 0.9, 0.45, 0], 0.03, 0.03);
  m.chassis.frustum([fx - 0.9, 0.45, 0], [rx, R, 0], 0.05, 0.08, 10);
  m.chassis.frustum([rx, R, -0.05], [rx, R, 0.05], 0.15, 0.15, 16);
  // Brass radiator with its shell and filler cap, black hood with louvres, the dash (firewall), body tub and doors.
  box(m.brass, fx + 0.1, fx + 0.2, 0.55, 1.25, -0.32, 0.32);
  m.brass.frustum([fx + 0.15, 1.25, 0], [fx + 0.15, 1.31, 0], 0.05, 0.05, 12);
  box(m.glass, fx + 0.2, fx + 0.205, 0.62, 1.18, -0.27, 0.27);
  box(m.body, fx - 0.75, fx + 0.1, 0.62, 1.18, -0.3, 0.3);
  m.body.frustum([fx - 0.75, 1.15, 0], [fx + 0.1, 1.15, 0], 0.3, 0.29, 20, true);
  for (const s of [-1, 1]) for (let k = 0; k < 6; k++) box(m.chassis, fx - 0.55 + k * 0.08, fx - 0.52 + k * 0.08, 0.8, 1.0, s * 0.301, s * 0.31);
  box(m.body, fx - 0.85, fx - 0.75, 0.6, 1.3, -0.45, 0.45);
  box(m.body, rx + 0.35, fx - 0.85, 0.62, 1.05, -0.8, 0.8);
  // Rounded rear of the tonneau.
  m.body.frustum([rx + 0.35, 0.62, 0], [rx + 0.35, 1.05, 0], 0.8, 0.8, 24, true);
  for (const s of [-1, 1]) {
    box(m.chassis, fx - 0.95, rx + 0.2, 0.55, 0.58, s * 0.82, s * 1.0);
    // Fenders: crowned arcs over each wheel joined to the running board by aprons.
    const arc = (x: number, from: number, to: number) => {
      for (let k = 0; k < 10; k++) {
        const a0 = from + (to - from) * (k / 10),
          a1 = from + (to - from) * ((k + 1) / 10),
          rr = R + 0.07;
        m.fenders.slab([[x + rr * Math.cos(a0), R + rr * Math.sin(a0), s * 0.62], [x + rr * Math.cos(a1), R + rr * Math.sin(a1), s * 0.62], [x + rr * Math.cos(a1), R + rr * Math.sin(a1), s * 0.86], [x + rr * Math.cos(a0), R + rr * Math.sin(a0), s * 0.86]], 0.012, Y);
      }
    };
    arc(fx, 0.15, Math.PI);
    arc(rx, 0, Math.PI - 0.15);
    // Brass headlamps on forks, side oil lamps on the dash, the bulb horn.
    m.brass.frustum([fx + 0.12, 1.0, s * 0.45], [fx + 0.32, 1.0, s * 0.45], 0.11, 0.13, 20);
    m.glass.frustum([fx + 0.32, 1.0, s * 0.45], [fx + 0.325, 1.0, s * 0.45], 0.12, 0.12, 20);
    m.brass.beam([fx + 0.2, 0.62, s * 0.45], [fx + 0.2, 0.9, s * 0.45], 0.03, 0.03);
    box(m.brass, fx - 0.92, fx - 0.8, 1.05, 1.25, s * 0.47, s * 0.57);
    m.brass.beam([fx - 0.85, 1.3, s * 0.45], [fx - 0.85, 1.75, s * 0.45], 0.03, 0.03);
    // Doors on the rear tonneau.
    box(m.body, rx - 0.05, rx + 0.55, 0.66, 1.0, s * 0.8, s * 0.815);
  }
  m.brass.frustum([fx - 0.8, 1.15, -0.55], [fx - 0.4, 1.15, -0.62], 0.02, 0.06, 12);
  m.glass.poly([[fx - 0.85, 1.32, -0.44], [fx - 0.85, 1.32, 0.44], [fx - 0.85, 1.73, 0.44], [fx - 0.85, 1.73, -0.44]], X);
  // Seats: front bench and rear tonneau, buttoned leather; steering column and wheel; the three foot pedals.
  for (const [x0, x1] of [
    [fx - 1.45, fx - 0.95],
    [rx - 0.2, rx + 0.4],
  ]) {
    box(m.seats, x0, x1, 0.85, 1.0, -0.7, 0.7);
    box(m.seats, x0 - 0.14, x0, 1.0, 1.42, -0.7, 0.7);
    for (let k = 0; k < 4; k++) box(m.seats, x0 - 0.01, x0 + 0.01, 1.3, 1.31, -0.6 + k * 0.4, -0.55 + k * 0.4);
  }
  m.body.frustum([fx - 0.8, 1.0, -0.3], [fx - 1.1, 1.45, -0.3], 0.025, 0.025, 8);
  m.body.frustum([fx - 1.12, 1.46, -0.3], [fx - 1.1, 1.48, -0.3], 0.2, 0.2, 24);
  for (let k = 0; k < 3; k++) box(m.chassis, fx - 0.95, fx - 0.9, 0.62, 0.75, -0.45 + k * 0.1, -0.42 + k * 0.1);
  // Spare tyre on the running board.
  m.spare.frustum([fx - 1.2, 0.95, 0.9], [fx - 1.2, 0.95, 0.98], R, R, 28, true);
  if (top === 'up') {
    m.top.slab([[rx - 0.4, 2.0, -0.82], [fx - 0.85, 2.0, -0.82], [fx - 0.85, 2.0, 0.82], [rx - 0.4, 2.0, 0.82]], 0.03, Y);
    for (const s of [-1, 1]) {
      m.top.beam([rx - 0.2, 1.05, s * 0.8], [rx - 0.4, 2.0, s * 0.8], 0.03, 0.03);
      m.top.beam([rx + 0.3, 1.05, s * 0.8], [rx - 0.2, 2.0, s * 0.8], 0.03, 0.03);
      m.top.frustum([fx - 0.85, 2.0, s * 0.82], [fx - 0.9, 1.72, s * 0.45], 0.008, 0.008, 6);
    }
  } else {
    m.top.frustum([rx - 0.35, 1.15, -0.8], [rx - 0.35, 1.15, 0.8], 0.12, 0.12, 14);
    for (const s of [-1, 1]) m.top.beam([rx - 0.1, 1.05, s * 0.8], [rx - 0.35, 1.15, s * 0.8], 0.03, 0.03);
  }
  const parts = finish(m);
  return {
    parts,
    palette: {
      body: mat([0.015, 0.015, 0.015], 0.25, 0.1),
      fenders: mat([0.015, 0.015, 0.015], 0.3, 0.1),
      wheels: mat([0.35, 0.25, 0.15], 0.6),
      tyres: mat([0.6, 0.58, 0.55], 0.9),
      brass: mat([0.7, 0.5, 0.18], 0.25, 1),
      top: mat([0.03, 0.03, 0.03], 0.8),
      seats: mat([0.08, 0.04, 0.02], 0.6),
      glass: mat([0.02, 0.025, 0.03], 0.05),
      chassis: mat([0.02, 0.02, 0.02], 0.6, 0.4),
      spare: mat([0.6, 0.58, 0.55], 0.9),
    },
    size: size(parts),
    wheelbase: wb,
    track: tr,
    wheel: 2 * R,
  };
}

// --- Kei truck ------------------------------------------------------------------------------------------------------
/** Options for {@link generateKeiTruck}. */
export interface KeiTruckOptions {
  /** Drop sides `closed` or `open` (lowered). Default `closed`. */
  readonly gates?: 'closed' | 'open';
  /** Body colour, linear RGB. Default white. */
  readonly color?: readonly [number, number, number];
}
/** The kei truck's parts, one geometry and material each. */
export type KeiTruckPart = 'cab' | 'glass' | 'bed' | 'chassis' | 'wheels' | 'tyres' | 'lights' | 'trim' | 'mirrors' | 'spare';
/** A kei truck, with its wheelbase, wheel size and bed. */
export interface KeiTruck extends Vehicle<KeiTruckPart> {
  readonly wheelbase: number;
  readonly wheel: number;
  /** Bed floor length and width inside the drop sides, its height above the ground and the drop side height, metres. */
  readonly bed: { readonly length: number; readonly width: number; readonly floor: number; readonly sides: number };
}
/**
 * A Japanese cab-over kei truck with a drop-side bed (the Suzuki Carry DA63T's catalogue sizes, inside the kei class:
 * 3.40 by 1.48 by 2.00 m without the door mirrors), facing +x.
 */
export function generateKeiTruck(options: KeiTruckOptions = {}): KeiTruck {
  const o = obj(options, 'kei truck'),
    gates = pick('kei truck', o, 'gates', ['closed', 'open'] as const, 'closed'),
    color = o.color === undefined ? ([0.8, 0.8, 0.78] as const) : (o.color as readonly [number, number, number]);
  if (!Array.isArray(color) || color.length !== 3 || !color.every((c) => typeof c === 'number' && c >= 0 && c <= 1))
    throw new RangeError('Invalid kei truck color; pass three numbers from 0 to 1.');
  const m = builders(['cab', 'glass', 'bed', 'chassis', 'wheels', 'tyres', 'lights', 'trim', 'mirrors', 'spare'] as const),
    L = 3.395,
    W = 1.475,
    Ht = 1.765,
    wb = 1.9,
    // 145R12: 12 in rim, 145 mm section, 80 % profile.
    R = (12 * 0.0254 + 2 * 0.145 * 0.8) / 2,
    front = L / 2,
    cabBack = front - 1.31,
    fx = front - 0.6,
    rx = fx - wb,
    zt = W / 2 - 0.16;
  for (const x of [fx, rx])
    for (const s of [-1, 1]) {
      m.tyres.frustum([x, R, s * zt - 0.0725], [x, R, s * zt + 0.0725], R, R, 32, false);
      m.tyres.frustum([x, R, s * zt - 0.0725], [x, R, s * zt + 0.0725], 0.16, 0.16, 32, false);
      for (const zf of [-0.0725, 0.0725]) {
        const out = ring([x, R, 0], R, 32, s * zt + zf),
          inn = ring([x, R, 0], 0.16, 32, s * zt + zf);
        for (let k = 0; k < 32; k++) {
          const k1 = (k + 1) % 32;
          m.tyres.poly(zf > 0 ? [out[k], out[k1], inn[k1], inn[k]] : [out[k1], out[k], inn[k], inn[k1]], [0, 0, zf > 0 ? 1 : -1]);
        }
      }
      // Steel wheel with four lug nuts and a hub cap.
      m.wheels.frustum([x, R, s * zt], [x, R, s * (zt + 0.07)], 0.155, 0.15, 24, true);
      m.wheels.frustum([x, R, s * (zt + 0.07)], [x, R, s * (zt + 0.09)], 0.06, 0.05, 16, true);
      for (let k = 0; k < 4; k++) {
        const t = (k * Math.PI) / 2 + Math.PI / 4;
        m.wheels.frustum([x + 0.05 * Math.cos(t), R + 0.05 * Math.sin(t), s * (zt + 0.07)], [x + 0.05 * Math.cos(t), R + 0.05 * Math.sin(t), s * (zt + 0.085)], 0.01, 0.01, 6);
      }
      // Wheel arches.
      const arch: V3[] = [];
      for (let k = 0; k <= 10; k++) arch.push([x + (R + 0.05) * Math.cos((Math.PI * k) / 10), R + (R + 0.05) * Math.sin((Math.PI * k) / 10), s * (W / 2 - 0.005)]);
      for (let k = 0; k < 10; k++) m.trim.slab([arch[k], arch[k + 1], add(arch[k + 1], [0, 0, -s * 0.2]), add(arch[k], [0, 0, -s * 0.2])], 0.01, Y);
    }
  // Ladder frame, leaf springs at the rear, fuel tank, exhaust and the spare wheel under the bed.
  for (const s of [-1, 1]) box(m.chassis, -L / 2 + 0.05, front - 0.25, 0.3, 0.42, s * 0.42 - 0.03, s * 0.42 + 0.03);
  for (const s of [-1, 1]) for (let k = 0; k < 4; k++) box(m.chassis, rx - 0.5 + k * 0.03, rx + 0.5 - k * 0.03, 0.26 + k * 0.012, 0.272 + k * 0.012, s * 0.42 - 0.03, s * 0.42 + 0.03);
  m.chassis.beam([rx, R, -zt], [rx, R, zt], 0.07, 0.07);
  box(m.chassis, rx + 0.4, rx + 0.85, 0.3, 0.5, -0.55, -0.2);
  m.chassis.frustum([fx - 0.8, 0.25, 0.2], [-L / 2 + 0.05, 0.22, 0.3], 0.025, 0.025, 8);
  m.spare.frustum([-L / 2 + 0.65, 0.2, 0], [-L / 2 + 0.65, 0.345, 0], R, R, 24, true);
  // Cab-over: lower body to the belt line, a raked windscreen, side doors and windows, the roof.
  const cy0 = 0.42,
    belt = 1.08,
    roof = Ht;
  // Sheet metal 5 mm inside the catalogue width, so trim and glass stand proud of it within the width.
  const ws = W / 2 - 0.005;
  box(m.cab, cabBack, front - 0.03, cy0, belt, -ws, ws);
  m.cab.slab([[cabBack, belt, -ws], [front - 0.03, belt, -ws], [front - 0.28, roof - 0.04, -W / 2 + 0.07], [cabBack, roof - 0.04, -W / 2 + 0.07]], 0.04, [0, 0, -1]);
  m.cab.slab([[cabBack, belt, ws], [front - 0.03, belt, ws], [front - 0.28, roof - 0.04, W / 2 - 0.07], [cabBack, roof - 0.04, W / 2 - 0.07]], 0.04, Z);
  box(m.cab, cabBack, front - 0.27, roof - 0.07, roof, -W / 2 + 0.06, W / 2 - 0.06);
  box(m.cab, cabBack - 0.04, cabBack, belt, roof - 0.04, -W / 2 + 0.07, W / 2 - 0.07);
  m.cab.slab([[front - 0.03, belt, -W / 2 + 0.03], [front - 0.03, belt, W / 2 - 0.03], [front - 0.28, roof - 0.06, W / 2 - 0.09], [front - 0.28, roof - 0.06, -W / 2 + 0.09]], 0.01, [1, 0.2, 0], true);
  m.glass.poly([[front - 0.02, belt + 0.04, -W / 2 + 0.1], [front - 0.02, belt + 0.04, W / 2 - 0.1], [front - 0.265, roof - 0.1, W / 2 - 0.13], [front - 0.265, roof - 0.1, -W / 2 + 0.13]], [1, 0.25, 0]);
  m.glass.poly([[cabBack - 0.045, belt + 0.15, W / 2 - 0.25], [cabBack - 0.045, belt + 0.15, -W / 2 + 0.25], [cabBack - 0.045, roof - 0.15, -W / 2 + 0.25], [cabBack - 0.045, roof - 0.15, W / 2 - 0.25]], [-1, 0, 0]);
  for (const s of [-1, 1]) {
    const side = (pts: V3[]) => (s > 0 ? pts : [...pts].reverse());
    m.glass.poly(side([[cabBack + 0.12, belt + 0.05, s * (W / 2 - 0.002)], [front - 0.32, belt + 0.05, s * (W / 2 - 0.002)], [front - 0.45, roof - 0.12, s * (W / 2 - 0.055)], [cabBack + 0.12, roof - 0.12, s * (W / 2 - 0.055)]]), [0, 0, s]);
    // Door seams, handle, step; headlamps and turn signals on the front panel; wipers.
    box(m.trim, cabBack + 0.08, cabBack + 0.09, cy0 + 0.05, belt, s * (W / 2 - 0.006), s * (W / 2 - 0.001));
    box(m.trim, front - 0.2, front - 0.19, cy0 + 0.05, belt, s * (W / 2 - 0.006), s * (W / 2 - 0.001));
    box(m.trim, cabBack + 0.2, cabBack + 0.34, belt - 0.12, belt - 0.09, s * (W / 2 - 0.012), s * (W / 2));
    box(m.trim, cabBack + 0.1, front - 0.25, 0.3, 0.34, s * (W / 2 - 0.15), s * (W / 2 - 0.02));
    box(m.lights, front - 0.04, front + 0.005, 0.66, 0.8, s * 0.56 - 0.09, s * 0.56 + 0.09);
    box(m.lights, front - 0.04, front + 0.004, 0.55, 0.6, s * 0.62 - 0.05, s * 0.62 + 0.05);
    m.trim.beam([front - 0.05, belt + 0.03, s * 0.08], [front - 0.17, belt + 0.45, s * 0.3], 0.01, 0.008);
    // Door mirror on an arm (not counted in the kei width, as the makers' catalogues list it).
    m.mirrors.frustum([front - 0.32, belt + 0.12, s * (W / 2)], [front - 0.25, belt + 0.14, s * (W / 2 + 0.14)], 0.012, 0.012, 6);
    box(m.mirrors, front - 0.28, front - 0.22, belt + 0.08, belt + 0.24, s * (W / 2 + 0.11), s * (W / 2 + 0.21));
  }
  // Front panel: grille slot, emblem, bumper with licence plate.
  box(m.trim, front - 0.04, front + 0.003, 0.7, 0.76, -0.4, 0.4);
  box(m.trim, front - 0.05, front + 0.03, 0.3, 0.45, -W / 2 + 0.02, W / 2 - 0.02);
  box(m.lights, front + 0.03, front + 0.035, 0.33, 0.43, -0.165, 0.165);
  // Bed: floor 1.94 by 1.41 m at 0.65 m, drop sides and tail gate 0.29 m high, a guard frame behind the cab.
  const bl = 1.94,
    bw = 1.41,
    by = 0.65,
    gh = 0.29,
    b0 = cabBack - 0.07 - bl,
    b1 = cabBack - 0.07,
    t = 0.03,
    gate = (a: V3, b: V3, out: V3) => {
      // Closed, a gate stands up from the floor edge; lowered, it hangs down from its hinges at the floor edge.
      const top: V3 = gates === 'closed' ? [0, gh, 0] : [0, -gh, 0];
      m.bed.slab([a, b, add(b, top), add(a, top)], t, out);
      // Ribs pressed into the gate and its latches.
      for (let k = 1; k < 4; k++) {
        const f = k / 4,
          pa = add(a, scale(top, f)),
          pb = add(b, scale(top, f));
        m.bed.frustum(add(pa, scale(out, -0.006)), add(pb, scale(out, -0.006)), 0.008, 0.008, 6, false);
      }
    };
  box(m.bed, b0 - t, b1, by - 0.08, by, -bw / 2 - t, bw / 2 + t);
  for (let z = -bw / 2 + 0.1; z < bw / 2; z += 0.2) box(m.bed, b0, b1, by, by + 0.01, z - 0.02, z + 0.02);
  // Each gate: its outer face given, its inner face on the bed floor's edge (a slab is extruded inward).
  gate([b0, by, -bw / 2 - t], [b1, by, -bw / 2 - t], [0, 0, -1]);
  gate([b1, by, bw / 2 + t], [b0, by, bw / 2 + t], Z);
  gate([b0 - t, by, bw / 2], [b0 - t, by, -bw / 2], [-1, 0, 0]);
  // Gate posts, the guard frame (a tube frame with bars), stake pockets.
  for (const s of [-1, 1]) for (const x of [b0, b1]) box(m.bed, x - 0.025, x + 0.025, by, by + gh + 0.02, s * (bw / 2) - 0.025, s * (bw / 2) + 0.025);
  for (const s of [-1, 1]) m.bed.frustum([b1 + 0.02, by, s * (bw / 2 - 0.03)], [b1 + 0.02, by + 1.0, s * (bw / 2 - 0.03)], 0.02, 0.02, 8);
  m.bed.frustum([b1 + 0.02, by + 1.0, -bw / 2 + 0.03], [b1 + 0.02, by + 1.0, bw / 2 - 0.03], 0.02, 0.02, 8);
  for (let k = 0; k < 5; k++) m.bed.frustum([b1 + 0.02, by + 0.3 + k * 0.14, -bw / 2 + 0.05], [b1 + 0.02, by + 0.3 + k * 0.14, bw / 2 - 0.05], 0.01, 0.01, 6);
  for (const s of [-1, 1]) box(m.lights, b0 - 0.04, b0 - 0.01, by - 0.25, by - 0.08, s * 0.6 - 0.08, s * 0.6 + 0.08);
  const parts = finish(m);
  return {
    parts,
    palette: {
      cab: mat([color[0], color[1], color[2]], 0.35, 0.1),
      glass: mat([0.02, 0.025, 0.03], 0.05),
      bed: mat([color[0], color[1], color[2]], 0.45, 0.1),
      chassis: mat([0.03, 0.03, 0.03], 0.7, 0.5),
      wheels: mat([0.55, 0.55, 0.56], 0.4, 1),
      tyres: mat([0.02, 0.02, 0.02], 0.9),
      lights: mat([0.9, 0.85, 0.7], 0.2),
      trim: mat([0.04, 0.04, 0.04], 0.6),
      mirrors: mat([0.04, 0.04, 0.04], 0.5),
      spare: mat([0.02, 0.02, 0.02], 0.9),
    },
    size: size(parts),
    wheelbase: wb,
    wheel: 2 * R,
    bed: { length: bl, width: bw, floor: by, sides: gh },
  };
}

// --- Vending machine ------------------------------------------------------------------------------------------------
/** Options for {@link generateVendingMachine}. */
export interface VendingMachineOptions {
  /** Width, metres, 0.9 to 1.25. Default 1.0. */
  readonly width?: number;
  /** Rows of sample cans in the display, 2 to 4. Default 3. */
  readonly rows?: number;
  /** Integer seed (can colours). Default 1. */
  readonly seed?: number;
}
/** The vending machine's parts, one geometry and material each. */
export type VendingMachinePart = 'cabinet' | 'panel' | 'glass' | 'samples' | 'labels' | 'buttons' | 'port' | 'light';
/** A vending machine, with the heights of its controls. */
export interface VendingMachine extends Vehicle<VendingMachinePart> {
  /** Heights above the ground of the coin slot, bill slot and change return, metres. */
  readonly controls: { readonly coin: number; readonly bill: number; readonly change: number };
  /** Lowest and highest selection button under the samples, metres above the ground. */
  readonly buttons: readonly [number, number];
  /** Lowest and highest key of the low selection keypad on the control strip (universal design), metres. */
  readonly keypad: readonly [number, number];
  /** Sample cans shown. */
  readonly samples: number;
}
/** A Japanese outdoor drink vending machine, its front facing +x, standing on the ground. */
export function generateVendingMachine(options: VendingMachineOptions = {}): VendingMachine {
  const o = obj(options, 'vending machine'),
    W = num('vending machine', o, 'width', 0.9, 1.25, 1.0),
    rows = num('vending machine', o, 'rows', 2, 4, 3, true),
    rand = seeded(num('vending machine', o, 'seed', -0x80000000, 0xffffffff, 1, true));
  const m = builders(['cabinet', 'panel', 'glass', 'samples', 'labels', 'buttons', 'port', 'light'] as const),
    H = 1.83,
    Dp = 0.72,
    f = Dp / 2;
  box(m.cabinet, -f, f - 0.06, 0.05, H, -W / 2, W / 2);
  box(m.cabinet, -f + 0.02, f - 0.08, 0, 0.05, -W / 2 + 0.03, W / 2 - 0.03);
  // Vent louvres low on each side.
  for (const s of [-1, 1]) for (let k = 0; k < 6; k++) box(m.port, -f + 0.1, -f + 0.4, 0.15 + k * 0.04, 0.165 + k * 0.04, s * (W / 2) - 0.002, s * (W / 2) + 0.004);
  // Door: display window over the button rows; the control strip at the right; the pick-up port at the bottom.
  const disp0 = 0.95,
    disp1 = H - 0.1,
    z0 = -W / 2 + 0.06,
    z1 = W / 2 - 0.27;
  box(m.panel, f - 0.06, f, 0.05, H - 0.02, -W / 2 + 0.01, W / 2 - 0.01);
  m.glass.poly([[f + 0.002, disp0, z0], [f + 0.002, disp0, z1], [f + 0.002, disp1, z1], [f + 0.002, disp1, z0]], X);
  box(m.light, f - 0.08, f - 0.07, disp0, disp1, z0, z1);
  const cols = Math.max(6, Math.round((z1 - z0) / 0.085)),
    rowH = (disp1 - disp0) / rows,
    btn: number[] = [];
  let samples = 0;
  for (let r = 0; r < rows; r++) {
    const y = disp0 + r * rowH + 0.05;
    box(m.panel, f - 0.06, f - 0.005, y - 0.012, y, z0, z1);
    for (let c = 0; c < cols; c++) {
      const z = z0 + (c + 0.5) * ((z1 - z0) / cols),
        tall = rand() < 0.4;
      // A 350 ml can (66 by 122 mm) or a 500 ml bottle (65 by 205 mm, a neck and cap).
      if (tall) {
        m.samples.frustum([f - 0.045, y, z], [f - 0.045, y + 0.14, z], 0.032, 0.032, 12);
        m.samples.frustum([f - 0.045, y + 0.14, z], [f - 0.045, y + 0.19, z], 0.032, 0.013, 12);
        m.labels.frustum([f - 0.045, y + 0.19, z], [f - 0.045, y + 0.205, z], 0.014, 0.014, 10);
        m.labels.frustum([f - 0.045, y + 0.04, z], [f - 0.045, y + 0.1, z], 0.0325, 0.0325, 12, false);
      } else {
        m.samples.frustum([f - 0.045, y, z], [f - 0.045, y + 0.11, z], 0.033, 0.033, 12);
        m.samples.frustum([f - 0.045, y + 0.11, z], [f - 0.045, y + 0.122, z], 0.033, 0.027, 12);
        m.labels.frustum([f - 0.045, y + 0.03, z], [f - 0.045, y + 0.08, z], 0.0335, 0.0335, 12, false);
      }
      samples++;
      // Each sample's selection button and price strip just under it, on the display front.
      box(m.buttons, f + 0.002, f + 0.014, y - 0.04, y - 0.02, z - 0.016, z + 0.016);
    }
    btn.push(y - 0.03);
  }
  // Control strip: bill slot, coin slot, change return, a card reader and the price display, inside ADA reach.
  const cz = W / 2 - 0.145,
    coin = 1.02,
    bill = 0.92,
    change = 0.5;
  box(m.panel, f, f + 0.025, 0.4, 1.7, cz - 0.11, cz + 0.11);
  box(m.port, f + 0.025, f + 0.035, coin - 0.025, coin + 0.025, cz - 0.004, cz + 0.004);
  box(m.port, f + 0.025, f + 0.035, bill - 0.006, bill + 0.006, cz - 0.04, cz + 0.04);
  box(m.port, f + 0.015, f + 0.04, change - 0.05, change + 0.05, cz - 0.05, cz + 0.05);
  box(m.light, f + 0.025, f + 0.03, 1.12, 1.18, cz - 0.07, cz + 0.07);
  // A low selection keypad (universal design machines repeat the selection within reach): 4 rows of 3 keys.
  const keys: number[] = [];
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 3; c++) {
      const y = 0.66 + r * 0.045,
        z = cz - 0.05 + c * 0.05;
      box(m.buttons, f + 0.025, f + 0.035, y - 0.015, y + 0.015, z - 0.018, z + 0.018);
      keys.push(y);
    }
  // Pick-up port with its flap, the kick plate, the top canopy.
  box(m.port, f - 0.02, f + 0.005, 0.18, 0.42, z0 + 0.05, z1 - 0.05);
  box(m.panel, f + 0.005, f + 0.01, 0.4, 0.43, z0 + 0.05, z1 - 0.05);
  box(m.port, f - 0.08, f + 0.002, 0.05, 0.12, -W / 2 + 0.02, W / 2 - 0.02);
  box(m.cabinet, -f - 0.02, f + 0.03, H, H + 0.03, -W / 2 - 0.02, W / 2 + 0.02);
  const parts = finish(m);
  return {
    parts,
    palette: {
      cabinet: mat([0.75, 0.75, 0.74], 0.4, 0.2),
      panel: mat([0.6, 0.05, 0.04], 0.35, 0.1),
      glass: mat([0.6, 0.65, 0.68], 0.05),
      samples: mat([0.5, 0.35, 0.1], 0.3, 0.6),
      labels: mat([0.8, 0.75, 0.6], 0.4),
      buttons: mat([0.85, 0.85, 0.85], 0.3),
      port: mat([0.03, 0.03, 0.03], 0.6, 0.3),
      light: mat([1, 1, 0.95], 0.5),
    },
    size: size(parts),
    controls: { coin, bill, change },
    buttons: [Math.min(...btn), Math.max(...btn)],
    keypad: [Math.min(...keys), Math.max(...keys)],
    samples,
  };
}

// --- Sliders --------------------------------------------------------------------------------------------------------
/** Vehicle slider rows on the shared shape (packages/shared/settings.js), named `<vehicle>.<option>`. All rebuild. */
export const VEHICLE_SETTINGS: readonly SettingRow[] = [
  choiceSetting('locomotive.arrangement', 'locomotive', LOCOMOTIVE_ARRANGEMENTS, 'Whyte wheel arrangement.', false),
  numberSetting('locomotive.driver', 'locomotive', 1.32, 1.1, 1.9, 0.01, 'm', 'Driving wheel diameter.', false),
  choiceSetting('locomotive.stack', 'locomotive', ['diamond', 'straight'], 'Smoke stack.', false),
  choiceSetting('locomotive.tender', 'locomotive', ['on', 'off'], 'A tender behind.', false),
  choiceSetting('locomotive.fuel', 'locomotive', ['wood', 'coal'], 'Tender load.', false),
  choiceSetting('wagon.kind', 'wagon', WAGON_KINDS, 'Freight car kind.', false),
  numberSetting('wagon.length', 'wagon', 10.97, 6, 18, 0.01, 'm', 'Car body length.', false),
  choiceSetting('car.top', 'touring car', ['up', 'down'], 'Folding top.', false),
  choiceSetting('kei.gates', 'kei truck', ['closed', 'open'], 'Bed drop sides.', false),
  numberSetting('vending.width', 'vending machine', 1.0, 0.9, 1.25, 0.01, 'm', 'Machine width.', false),
  numberSetting('vending.rows', 'vending machine', 3, 2, 4, 1, '', 'Rows of sample drinks.', false),
];
const VEHICLE_INDEX = settingIndex(VEHICLE_SETTINGS);
/** Every vehicle setting at its default. */
export function vehicleSettingDefaults(): Record<string, number | string> {
  return settingDefaults(VEHICLE_SETTINGS) as Record<string, number | string>;
}
/** Maps slider values (`<vehicle>.<option>`) to each generator's options; rows left out keep the defaults. */
export function vehicleOptionsFromSettings(values: Readonly<Record<string, number | string>>): {
  locomotive: LocomotiveOptions;
  wagon: WagonOptions;
  car: TouringCarOptions;
  kei: KeiTruckOptions;
  vending: VendingMachineOptions;
} {
  checkSettings(VEHICLE_INDEX, values, 'vehicle', 'the rows in VEHICLE_SETTINGS');
  const out: Record<string, Record<string, unknown>> = { locomotive: {}, wagon: {}, car: {}, kei: {}, vending: {} };
  for (const [name, value] of Object.entries(values)) {
    const [piece, key] = name.split('.');
    out[piece][key] = key === 'tender' ? value === 'on' : value;
  }
  return out as never;
}
