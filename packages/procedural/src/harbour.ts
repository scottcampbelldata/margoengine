// Harbour pieces for a coastal town: a concrete sea wall, tetrapods and their two-layer armour on a slope, a quay with
// bollards, fenders and ladders, a rubble mound breakwater armoured with tetrapods and capped with a crown wall, a
// slipway, mooring posts and a coastal fishing boat (FRP, wheelhouse aft of midships). Our own shapes, local origin at
// sea level (y = 0), +y up, metres; walls, quays and breakwaters run along +x with the sea on +z. Seeded, deterministic.
// Clean room from public engineering descriptions, no other engine's code:
// - US Army Corps of Engineers 1984, Shore Protection Manual, 4th ed., vol. II, ch. 7: tetrapod volume V = 0.28 H^3
//   for a unit of height H; armour layer thickness r = n k_D (W / w)^(1/3) and units per area
//   N / A = n k_D (1 - P / 100) (w / W)^(2/3), with k_D = 1.04 and porosity P = 50 % for two layers of tetrapods; armour
//   slopes of cot 1.5 to 2.
// - US Army Corps of Engineers 2002 (rev. 2011), Coastal Engineering Manual EM 1110-2-1100, part VI ch. 5: rubble mound
//   cross sections (core, filter, armour, crown wall), seawall profiles with a recurved wave return.
// - Danel, P. 1953, "Tetrapods", Proc. 4th Conference on Coastal Engineering, https://doi.org/10.9753/icce.v4.28: the
//   unit's four truncated cone legs on tetrahedral axes.
// - Japan Fisheries Agency, technical standards for fishing port facilities (quay crown height above high water,
//   bollard spacing), and the post-2011 Sanriku coast seawall surveys (crest heights of about 5 to 10 m above T.P.).
// - Gulbrandsen, O. 2004, "Fishing Boat Designs: 2. V-bottom Boats of Planked and Plywood Construction", FAO Fisheries
//   Technical Paper 134 rev. 2, and Fyson, J. (ed.) 1985, "Design of Small Fishing Vessels" (FAO / Fishing News Books):
//   V-bottom hull lines, length to beam 3 to 4.5, freeboard and deadrise for small coastal fishing boats.
import type { GeometryData } from '@margoengine/geometry/utils';
import { MeshBuilder, add, dot, len, lerp, random, scale, sub, unit, type V3 } from './mesh-builder.js';

function num(
  what: string,
  o: Record<string, unknown>,
  name: string,
  lo: number,
  hi: number,
  fallback: number,
  int = false,
) {
  const v = o[name];
  if (v === undefined) return fallback;
  if (typeof v !== 'number') throw new TypeError(`Invalid ${what} ${name}; pass a number from ${lo} to ${hi}.`);
  if (!Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v)))
    throw new RangeError(`Invalid ${what} ${name}; pass ${int ? 'an integer' : 'a number'} from ${lo} to ${hi}.`);
  return v;
}
function bool(what: string, o: Record<string, unknown>, name: string, fallback: boolean) {
  const v = o[name];
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new TypeError(`Invalid ${what} ${name}; pass true or false.`);
  return v;
}
function obj(o: unknown, what: string): Record<string, unknown> {
  if (o === undefined) return {};
  if (typeof o !== 'object' || o === null) throw new TypeError(`Invalid ${what} options; pass an object.`);
  return o as Record<string, unknown>;
}
const parts = <K extends string>(names: readonly K[]) =>
  Object.fromEntries(names.map((n) => [n, new MeshBuilder()])) as Record<K, MeshBuilder>;
function finish<K extends string>(p: Record<K, MeshBuilder>): Partial<Record<K, GeometryData>> {
  const out: Partial<Record<K, GeometryData>> = {};
  for (const [k, b] of Object.entries(p) as [K, MeshBuilder][]) if (b.triangles > 0) out[k] = b.finish();
  return out;
}

/** Concrete density used to turn a tetrapod's mass into its size, t/m3. */
export const CONCRETE_DENSITY = 2.3;
/** Tetrapod volume over height cubed (Shore Protection Manual 1984). */
export const TETRAPOD_VOLUME_RATIO = 0.28;
// Leg proportions as shares of the centre to tip length l: radius at the centre, at the tip, and how far each leg runs
// back behind the centre (so the leg ends are buried in the others). Fitted so the union's volume is 0.28 H^3.
const LEG = { base: 0.4, tip: 0.25, back: 0.3 };

/** Options for {@link generateTetrapod}. */
export interface TetrapodOptions {
  /** Unit mass, tonnes, 0.5 to 100 (sets the size through V = m / 2.3 and V = 0.28 H^3). Default 10. */
  readonly mass?: number;
  /** Sides on each leg, 8 to 48. Default 16. */
  readonly segments?: number;
}
/** A tetrapod: four truncated cone legs on tetrahedral axes, one straight up, resting on the other three. */
export interface Tetrapod {
  readonly geometry: GeometryData;
  /** Height when standing on three legs, metres. */
  readonly height: number;
  /** Concrete volume, m3 (0.28 H^3). */
  readonly volume: number;
  readonly mass: number;
  /** The legs: unit axis from the centre, length to the tip face, radius at the centre and at the tip, back length. */
  readonly legs: readonly { axis: V3; length: number; base: number; tip: number; back: number }[];
  /** Centre height above the ground when standing. */
  readonly centre: number;
}
/** A concrete tetrapod sized by its mass; the origin is on the ground under it. */
export function generateTetrapod(options: TetrapodOptions = {}): Tetrapod {
  const o = obj(options, 'tetrapod'),
    mass = num('tetrapod', o, 'mass', 0.5, 100, 10),
    segments = num('tetrapod', o, 'segments', 8, 48, 16, true),
    volume = mass / CONCRETE_DENSITY,
    H = Math.cbrt(volume / TETRAPOD_VOLUME_RATIO),
    s8 = Math.sqrt(8) / 3,
    l = H / (4 / 3 + LEG.tip * s8),
    centre = l / 3 + LEG.tip * l * s8,
    // A polygon of n sides with the same area as the circle.
    k = 1 / Math.sqrt((segments / (2 * Math.PI)) * Math.sin((2 * Math.PI) / segments)),
    axes: V3[] = [
      [0, 1, 0],
      ...[0, 1, 2].map((i): V3 => [s8 * Math.cos((2 * Math.PI * i) / 3), -1 / 3, s8 * Math.sin((2 * Math.PI * i) / 3)]),
    ],
    m = new MeshBuilder(),
    c: V3 = [0, centre, 0];
  for (const a of axes) {
    m.frustum(add(c, scale(a, -LEG.back * l)), add(c, scale(a, 0)), LEG.base * l * k, LEG.base * l * k, segments);
    m.frustum(c, add(c, scale(a, l)), LEG.base * l * k, LEG.tip * l * k, segments);
  }
  return {
    geometry: m.finish(),
    height: H,
    volume,
    mass,
    legs: axes.map((axis) => ({ axis, length: l, base: LEG.base * l, tip: LEG.tip * l, back: LEG.back * l })),
    centre,
  };
}

/** Options for {@link placeTetrapods}. */
export interface TetrapodArmourOptions {
  /** Unit mass, tonnes, 0.5 to 100. Default 10. */
  readonly mass?: number;
  /** Length along x from x = 0, metres, 1 to 2,000. Default 40. */
  readonly length?: number;
  /** Slope as cot (run over rise), 0 (level) to 4. Default 1.5. */
  readonly slope?: number;
  /** Height of the armour's top edge (the crest) and its toe, metres. Defaults 4 and -4. */
  readonly crest?: number;
  readonly toe?: number;
  /** Width of level armour at the crest, metres, 0 to 30. Default 0. */
  readonly crestWidth?: number;
  /** Where the slope's top edge is on z (the slope runs down toward +z). Default 0. */
  readonly z?: number;
  /** Layers, 1 to 3. Default 2. */
  readonly layers?: number;
  /**
   * `settled` (default): each unit is placed at its pattern spot and falls until it rests on the bed or the units under
   * it, none overlapping; `pattern`: units sit on the pattern's layer lines (faster, for far views; they may touch or
   * cross).
   */
  readonly placement?: 'settled' | 'pattern';
  /** Integer seed. Default 1. */
  readonly seed?: number;
}
/** Instances of one tetrapod mesh: a 4 by 4 column-major matrix each. */
export interface TetrapodArmour {
  readonly tetrapod: Tetrapod;
  readonly matrices: Float32Array;
  readonly count: number;
  /** Slope area covered, m2 (measured along the slope). */
  readonly area: number;
  /** Units per m2 of slope the layers were laid at (n k_D (1 - P) / V^(2/3)). */
  readonly density: number;
  /** Armour layer thickness, metres (n k_D V^(1/3)). */
  readonly thickness: number;
  /** How the units were placed. */
  readonly placement: 'settled' | 'pattern';
  /** The settled armour as measured (`placement: 'settled'` only). */
  readonly settling?: TetrapodSettling;
}
/** Layers of tetrapods on a slope at the Shore Protection Manual's placing density, settled (default) or on layer lines. */
export function placeTetrapods(options: TetrapodArmourOptions = {}): TetrapodArmour {
  const o = obj(options, 'tetrapod armour'),
    tetrapod = generateTetrapod({ mass: num('tetrapod armour', o, 'mass', 0.5, 100, 10) }),
    length = num('tetrapod armour', o, 'length', 1, 2000, 40),
    cot = num('tetrapod armour', o, 'slope', 0, 4, 1.5),
    crest = num('tetrapod armour', o, 'crest', -50, 50, 4),
    toe = num('tetrapod armour', o, 'toe', -100, crest, -4),
    crestWidth = num('tetrapod armour', o, 'crestWidth', 0, 30, 0),
    z0 = num('tetrapod armour', o, 'z', -1e4, 1e4, 0),
    layers = num('tetrapod armour', o, 'layers', 1, 3, 2, true),
    placement = o.placement === undefined ? 'settled' : o.placement,
    rand = random(num('tetrapod armour', o, 'seed', -0x80000000, 0xffffffff, 1, true) ^ 0x68e31da4);
  if (cot === 0 && crestWidth === 0) throw new RangeError('Invalid tetrapod armour; a level bed needs a crestWidth.');
  if (placement !== 'settled' && placement !== 'pattern')
    throw new RangeError('Invalid tetrapod armour placement; pass settled or pattern.');
  const kD = 1.04,
    porosity = 0.5,
    V = tetrapod.volume,
    Dn = Math.cbrt(V),
    perLayer = (kD * (1 - porosity)) / (Dn * Dn),
    rise = crest - toe,
    run = rise * cot,
    slopeLen = Math.hypot(run, rise),
    area = length * (slopeLen + crestWidth),
    thickness = layers * kD * Dn,
    // A square lattice of spacing a gives 1 / a^2 units per m2 in each layer.
    a = 1 / Math.sqrt(perLayer);
  const along = (s: number): [number, number, number] => {
    // s from the crest's landward edge down the slope: a point on the armour bed and its slope normal.
    if (s < crestWidth) return [z0 - crestWidth + s, crest, 0];
    const t = (s - crestWidth) / slopeLen;
    return [z0 + run * t, crest - rise * t, 1];
  };
  const mats: number[] = [];
  const nrmSlope = unit([0, run, rise]);
  // Whole rows and columns, spaced to fill the bed exactly at the layer density.
  const extent = crestWidth + slopeLen,
    nx = Math.max(1, Math.round(length / a)),
    ns = Math.max(1, Math.round(extent / a)),
    ax = length / nx,
    as = extent / ns;
  const spots: { x: number; z: number; R: number[]; alt: number[][]; shifts: [number, number][] }[] = [];
  // Small shifts tried at each spot, along x and up and down the slope.
  const shifts: [number, number][] = [
    [0, 0],
    [0.25 * a, 0],
    [-0.25 * a, 0],
    [0, 0.2 * a],
    [0, -0.2 * a],
  ];
  for (let layer = 0; layer < layers; layer++) {
    const shift = layer % 2 ? 0.5 : 0;
    // Settled armour is placed from the toe up the slope.
    for (let r = 0; r < ns; r++)
      for (let col = 0; col < nx; col++) {
        const row = placement === 'settled' ? ns - 1 - r : r;
        const s = (row + 0.5) * as,
          x = ((col + 0.5 + shift + (row % 2) * 0.5) % nx) * ax;
        const [zb, yb, onSlope] = along(s),
          n: V3 = onSlope ? nrmSlope : [0, 1, 0],
          lift = Dn * kD * (layer + 0.5) - tetrapod.centre,
          jitter = a * 0.18,
          px = x + (rand() - 0.5) * jitter,
          pz = zb + (rand() - 0.5) * jitter * 0.5,
          py = yb;
        // A random attitude: a random axis and angle (units interlock in any attitude on a slope).
        const yaw = rand() * 2 * Math.PI,
          tilt = Math.acos(1 - 2 * rand()),
          spin = rand() * 2 * Math.PI;
        const R = rotation(yaw, tilt, spin),
          base = add([px, py, pz], scale(n, lift + tetrapod.centre));
        // The mesh's origin is under its centre: put the centre on the layer line.
        if (placement === 'settled') {
          // Two placing attitudes: standing on three legs with the fourth along the bed normal, or turned over with one
          // leg down between the units under it; of each, four turns about that leg (ours, chosen so units interlock).
          const tilt = Math.atan2(n[2], n[1]),
            alt: number[][] = [];
          for (const flip of [0, Math.PI])
            for (let k = 0; k < 4; k++) alt.push(rotation(0, tilt + flip, spin + (k * Math.PI) / 6));
          spots.push({
            x: px,
            z: pz,
            R: alt[layer % 2 ? 4 : 0],
            alt: alt.filter((_, i) => i !== (layer % 2 ? 4 : 0)),
            shifts,
          });
          continue;
        }
        const t = sub(base, mul(R, [0, tetrapod.centre, 0]));
        mats.push(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, t[0], t[1], t[2], 1);
      }
  }
  let settling: TetrapodSettling | undefined;
  if (placement === 'settled') {
    // The bed: below the crest level and the armour slope, or below the sea bed at the toe level.
    const cs = dot(nrmSlope, [0, crest, z0]),
      bed: Bed = {
        cap:
          cot > 0
            ? [
                { n: [0, 1, 0], d: crest },
                { n: nrmSlope, d: cs },
              ]
            : [{ n: [0, 1, 0], d: crest }],
        floor: toe,
      },
      bedTop = (_x: number, z: number) => (cot > 0 && z > z0 ? Math.max(toe, crest - (z - z0) / cot) : crest);
    const { centres, rotations, placed, work } = settle(tetrapod, spots, bed, bedTop);
    centres.forEach((c, i) => {
      const R = rotations[i],
        t = sub(c, mul(R, [0, tetrapod.centre, 0]));
      mats.push(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, t[0], t[1], t[2], 1);
    });
    settling = measureSettled(tetrapod, placed, bed, work, {
      plane: (c) => (cot > 0 && c[2] > z0 ? { n: nrmSlope, d: cs } : { n: [0, 1, 0], d: crest }),
      middle: (c) =>
        c[0] > 0.2 * length &&
        c[0] < 0.8 * length &&
        (cot > 0 ? c[2] > z0 + 0.25 * run && c[2] < z0 + 0.75 * run : true),
      area: 0.6 * length * (cot > 0 ? 0.5 * slopeLen : crestWidth),
      cell: Dn,
    });
  }
  return {
    tetrapod,
    matrices: Float32Array.from(mats),
    count: mats.length / 16,
    area,
    density: mats.length / 16 / area,
    thickness,
    placement,
    settling,
  };
}
// Column-major 3 by 3 rotation: about y by yaw, then about x by tilt, then about y by spin.
function rotation(yaw: number, tilt: number, spin: number): number[] {
  const ry = (a: number) => [Math.cos(a), 0, -Math.sin(a), 0, 1, 0, Math.sin(a), 0, Math.cos(a)],
    rx = (a: number) => [1, 0, 0, 0, Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a)],
    m3 = (A: number[], B: number[]) => {
      const C = new Array(9).fill(0);
      for (let c = 0; c < 3; c++)
        for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) C[c * 3 + r] += A[k * 3 + r] * B[c * 3 + k];
      return C;
    };
  return m3(ry(yaw), m3(rx(tilt), ry(spin)));
}
const mul = (R: number[], v: V3): V3 => [
  R[0] * v[0] + R[3] * v[1] + R[6] * v[2],
  R[1] * v[0] + R[4] * v[1] + R[7] * v[2],
  R[2] * v[0] + R[5] * v[1] + R[8] * v[2],
];

// Settling. Each unit is held over its pattern spot as a crane holds it, then lowered straight down until it rests on
// the bed or on units already placed, in placing order (layer by layer, from the toe up the slope, as the Shore
// Protection Manual and the CIRIA Rock Manual describe armour placing). Of the placing attitudes and small shifts tried
// at the spot, the one that comes to rest lowest is kept: random sequential deposition with a lowest-of-k choice
// (Visscher and Bolsterli 1972; Jodrey and Tory 1985). The unit is lowered by conservative advancement: it moves down by
// its least clearance, which no contact can be nearer than (Mirtich 1996), so settled units never overlap.
//
// Contact shapes. Against the bed each leg is its exact frustum (a flat-ended cone from the centre to the tip face):
// the least of a plane's clearance over a disc of radius r whose axis is e is n . centre - r sqrt(1 - (n . e)^2). Between
// units each leg is a sphere-swept cone from the centre to one tip radius short of the tip face, which lies inside the
// frustum; only the rims of two tip faces can cross, by at most (sqrt 2 - 1) times the tip radius (about 0.04 H).
interface Leg {
  // Centre end, the sphere-swept cone's far end, and the tip face's centre.
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  fx: number;
  fy: number;
  fz: number;
  // Unit axis, radii at the centre and at the tip, and a bounding sphere (centre and radius).
  ex: number;
  ey: number;
  ez: number;
  ra: number;
  rb: number;
  mx: number;
  my: number;
  mz: number;
  r: number;
}
// The legs of a unit with rotation R (column-major 3 by 3) and centre c.
function unitLegs(t: Tetrapod, R: number[], c: V3): Leg[] {
  return t.legs.map((g) => {
    const [ex, ey, ez] = mul(R, g.axis),
      k = g.length - g.tip;
    return {
      ax: c[0],
      ay: c[1],
      az: c[2],
      bx: c[0] + ex * k,
      by: c[1] + ey * k,
      bz: c[2] + ez * k,
      fx: c[0] + ex * g.length,
      fy: c[1] + ey * g.length,
      fz: c[2] + ez * g.length,
      ex,
      ey,
      ez,
      ra: g.base,
      rb: g.tip,
      mx: c[0] + (ex * g.length) / 2,
      my: c[1] + (ey * g.length) / 2,
      mz: c[2] + (ez * g.length) / 2,
      r: g.length / 2 + g.base,
    };
  });
}
// Moves a unit's legs by dy.
function lowerLegs(legs: Leg[], dy: number) {
  for (const l of legs) {
    l.ay += dy;
    l.by += dy;
    l.fy += dy;
    l.my += dy;
  }
}
const GOLDEN = (Math.sqrt(5) - 1) / 2;
// Least clearance |A(s) - B(t)| - rA(s) - rB(t) of two sphere-swept cones. It is convex in (s, t). For a point the
// least over t has a closed form (the stationary point of a hyperbola less a line, clamped to the segment); the least
// over s of that is convex, found by golden-section search. Pairs whose bounding spheres stand more than `cut` apart
// return that bound instead (a lower bound on the clearance).
function legGap(p: Leg, q: Leg, cut: number): number {
  const dx = p.mx - q.mx,
    dy = p.my - q.my,
    dz = p.mz - q.mz,
    bound = Math.sqrt(dx * dx + dy * dy + dz * dz) - p.r - q.r;
  if (bound > cut) return bound;
  const ux = p.bx - p.ax,
    uy = p.by - p.ay,
    uz = p.bz - p.az,
    vx = q.bx - q.ax,
    vy = q.by - q.ay,
    vz = q.bz - q.az,
    vv = vx * vx + vy * vy + vz * vz,
    L = Math.sqrt(vv),
    c = q.rb - q.ra,
    k = c / L,
    lean = k / Math.sqrt(1 - k * k) / L,
    dp = p.rb - p.ra;
  const g = (s: number) => {
    const wx = p.ax + ux * s - q.ax,
      wy = p.ay + uy * s - q.ay,
      wz = p.az + uz * s - q.az,
      t0 = (wx * vx + wy * vy + wz * vz) / vv,
      hx = wx - vx * t0,
      hy = wy - vy * t0,
      hz = wz - vz * t0,
      t = Math.min(1, Math.max(0, t0 + lean * Math.sqrt(hx * hx + hy * hy + hz * hz))),
      sx = wx - vx * t,
      sy = wy - vy * t,
      sz = wz - vz * t;
    return Math.sqrt(sx * sx + sy * sy + sz * sz) - (q.ra + c * t) - (p.ra + dp * s);
  };
  let lo = 0,
    hi = 1,
    x1 = 1 - GOLDEN,
    x2 = GOLDEN,
    f1 = g(x1),
    f2 = g(x2);
  for (let i = 0; i < 18; i++)
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - GOLDEN * (hi - lo);
      f1 = g(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + GOLDEN * (hi - lo);
      f2 = g(x2);
    }
  return Math.min(f1, f2, g(0), g(1));
}
/** A plane n . p = d. */
interface Plane {
  readonly n: V3;
  readonly d: number;
}
/** The armour bed: solid below every cap plane, or below the sea bed level. */
interface Bed {
  readonly cap: readonly Plane[];
  readonly floor: number;
}
// Least clearance of a leg's frustum above a plane: linear along the leg, from the disc at the centre to the tip face.
function planeLine(l: Leg, p: Plane): [number, number] {
  const ne = p.n[0] * l.ex + p.n[1] * l.ey + p.n[2] * l.ez,
    sin = Math.sqrt(Math.max(0, 1 - ne * ne));
  return [
    p.n[0] * l.ax + p.n[1] * l.ay + p.n[2] * l.az - p.d - l.ra * sin,
    p.n[0] * l.fx + p.n[1] * l.fy + p.n[2] * l.fz - p.d - l.rb * sin,
  ];
}
const UP: V3 = [0, 1, 0];
// Exact least clearance of a leg from the bed: min(max(caps), floor) of lines in s, least at an end or a crossing.
function legBedGap(l: Leg, bed: Bed): number {
  const lines = [...bed.cap.map((c) => planeLine(l, c)), planeLine(l, { n: UP, d: bed.floor })],
    nc = bed.cap.length;
  const at = (s: number) => {
    let g = -Infinity;
    for (let i = 0; i < nc; i++) g = Math.max(g, lines[i][0] + (lines[i][1] - lines[i][0]) * s);
    return Math.min(g, lines[nc][0] + (lines[nc][1] - lines[nc][0]) * s);
  };
  let best = Math.min(at(0), at(1));
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const d0 = lines[i][0] - lines[j][0],
        d1 = lines[i][1] - lines[j][1];
      if (d0 !== d1) {
        const s = d0 / (d0 - d1);
        if (s > 0 && s < 1) best = Math.min(best, at(s));
      }
    }
  return best;
}
interface Placed {
  readonly c: V3;
  readonly legs: Leg[];
}
/** The settled units' report. */
export interface TetrapodSettling {
  /** Least clearance between two units' contact shapes or a unit and the bed, metres (0 or more: none overlap). */
  readonly minGap: number;
  /** Units resting within 2 cm of the bed or of another unit. */
  readonly supported: number;
  /** Mean armour top above the bed over the middle of the slope, measured on the units, metres. */
  readonly measuredThickness: number;
  /** Porosity of the armour from the units' volume in that measured layer (the Shore Protection Manual's P). */
  readonly porosity: number;
  /** Leg pair clearances computed exactly while settling (a work count). */
  readonly work: number;
}
// A spatial hash on x and z of placed units.
class UnitGrid {
  private readonly cells = new Map<number, Placed[]>();
  constructor(private readonly size: number) {}
  private key(i: number, j: number) {
    return (i + 32768) * 65536 + (j + 32768);
  }
  add(p: Placed) {
    const k = this.key(Math.floor(p.c[0] / this.size), Math.floor(p.c[2] / this.size));
    (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(p);
  }
  /** Units whose centres are within `r` of (x, z) on the plan (r at most the cell size). */
  near(x: number, z: number, r: number): Placed[] {
    const i = Math.floor(x / this.size),
      j = Math.floor(z / this.size),
      out: Placed[] = [];
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (const p of this.cells.get(this.key(i + di, j + dj)) ?? [])
          if (Math.hypot(p.c[0] - x, p.c[2] - z) <= r) out.push(p);
    return out;
  }
}
const reachOf = (t: Tetrapod) => Math.max(...t.legs.map((g) => g.length));
function settle(
  t: Tetrapod,
  spots: { x: number; z: number; R: number[]; alt: number[][]; shifts: [number, number][] }[],
  bed: Bed,
  bedTop: (x: number, z: number) => number,
): { centres: V3[]; rotations: number[][]; placed: Placed[]; work: number } {
  const reach = reachOf(t),
    grid = new UnitGrid(2 * reach),
    placed: Placed[] = [],
    centres: V3[] = [],
    rotations: number[][] = [],
    cut = 0.2 * t.height;
  let work = 0;
  // Least clearance of a unit from the bed and its neighbours (a lower bound where they are far).
  const gapOf = (legs: Leg[], y: number, others: Placed[]) => {
    let g = Infinity;
    for (const l of legs) g = Math.min(g, legBedGap(l, bed));
    for (const o of others) {
      const d = Math.abs(o.c[1] - y) - 2 * reach;
      if (d > cut) {
        g = Math.min(g, d);
        continue;
      }
      for (const l of legs)
        for (const m of o.legs) {
          const e = legGap(l, m, cut);
          if (e <= cut) work++;
          g = Math.min(g, e);
        }
    }
    return g;
  };
  for (const spot of spots) {
    let best: { c: V3; R: number[] } | null = null;
    for (const [dx, dz] of spot.shifts) {
      const x = spot.x + dx,
        z = spot.z + dz,
        // Only units within twice the reach on the plan can be met on the way down.
        others = grid.near(x, z, 2 * reach);
      let top = bedTop(x, z) + 2 * reach + 0.05;
      for (const o of others) top = Math.max(top, o.c[1] + 2 * reach + 0.05);
      for (const R of [spot.R, ...spot.alt]) {
        let y = top;
        const legs = unitLegs(t, R, [x, y, z]);
        let g = gapOf(legs, y, others);
        if (g < 0) continue;
        // Lower by the least clearance, less a margin for the search's tolerance (18 golden steps leave s within 2e-4),
        // until it touches.
        for (let it = 0; it < 400 && g > 1.5e-3; it++) {
          const dy = g - 5e-4;
          y -= dy;
          lowerLegs(legs, -dy);
          g = gapOf(legs, y, others);
        }
        if (!best || y < best.c[1]) best = { c: [x, y, z], R };
      }
    }
    if (!best) continue;
    const p = { c: best.c, legs: unitLegs(t, best.R, best.c) };
    placed.push(p);
    grid.add(p);
    centres.push(best.c);
    rotations.push(best.R);
  }
  return { centres, rotations, placed, work };
}
function measureSettled(
  t: Tetrapod,
  placed: Placed[],
  bed: Bed,
  work: number,
  m: { plane: (c: V3) => Plane; middle: (c: V3) => boolean; area: number; cell: number },
): TetrapodSettling {
  let minGap = Infinity,
    supported = 0;
  const reach = reachOf(t),
    grid = new UnitGrid(2 * reach);
  for (const p of placed) grid.add(p);
  for (const p of placed) {
    let g = Math.min(...p.legs.map((l) => legBedGap(l, bed)));
    for (const o of grid.near(p.c[0], p.c[2], 2 * reach)) {
      if (o === p || len(sub(o.c, p.c)) > 2 * reach + 0.05) continue;
      for (const l of p.legs) for (const q of o.legs) g = Math.min(g, legGap(l, q, 0.05));
    }
    if (g < 0.02) supported++;
    minGap = Math.min(minGap, g);
  }
  // The armour top: in each cell of the middle of the slope, the highest point of any unit centred there, above the
  // bed plane under it (a frustum's highest point over a plane is the far side of one of its end discs).
  const tops = new Map<string, number>();
  let n = 0;
  for (const p of placed) {
    if (!m.middle(p.c)) continue;
    n++;
    const pl = m.plane(p.c),
      flip: Plane = { n: scale(pl.n, -1), d: -pl.d },
      k = `${Math.floor(p.c[0] / m.cell)},${Math.floor(p.c[2] / m.cell)}`,
      top = Math.max(...p.legs.map((l) => -Math.min(...planeLine(l, flip))));
    tops.set(k, Math.max(tops.get(k) ?? -Infinity, top));
  }
  const measuredThickness = tops.size ? [...tops.values()].reduce((a, b) => a + b, 0) / tops.size : 0;
  return {
    minGap,
    supported,
    measuredThickness,
    porosity: measuredThickness > 0 ? 1 - (n * t.volume) / (m.area * measuredThickness) : 1,
    work,
  };
}

/** Options for {@link generateSeaWall}. */
export interface SeaWallOptions {
  /** Length along +x, metres, 1 to 2,000. Default 60. */
  readonly length?: number;
  /** Crest height above sea level, metres, 1 to 20. Default 6. */
  readonly crest?: number;
  /** Foot of the seaward face, metres (below sea level is negative), -10 to crest - 1. Default -1.5. */
  readonly toe?: number;
  /** Ground height on the land side, metres. Default 2. */
  readonly land?: number;
  /** Crown width, metres, 0.3 to 10. Default 1. */
  readonly crown?: number;
  /** Seaward face batter, horizontal per vertical, 0 to 3. Default 0.5. */
  readonly batter?: number;
  /** Landward face batter, 0 to 3. Default 0.1. */
  readonly landBatter?: number;
  /** A recurved wave return on the seaward top edge. Default true. */
  readonly recurve?: boolean;
  /** Expansion joint spacing, metres, 2 to 50 (grooves at mid and near detail). Default 10. */
  readonly joints?: number;
  /** Access stairs on the land side every this many metres, 0 for none, 10 to 2,000. Default 50. */
  readonly stairs?: number;
  /** Seaward toe protection: a row of tetrapods of this mass in tonnes, 0 for none. Default 0. */
  readonly toeTetrapods?: number;
  /** Default `mid`. */
  readonly detail?: 'far' | 'mid' | 'near';
  readonly seed?: number;
}
/** A sea wall from {@link generateSeaWall}. */
export interface SeaWall {
  readonly parts: Partial<Record<'concrete' | 'trim' | 'stairs' | 'rails', GeometryData>>;
  readonly crest: number;
  /** Seaward crown edge z and the seaward toe's z. */
  readonly seaward: readonly [number, number];
  /** Present with `toeTetrapods`. */
  readonly armour?: TetrapodArmour;
}
/**
 * A gravity concrete sea wall: a trapezoid section along x with a crown at `crest`, a battered seaward face (sea on +z)
 * with an optional recurved wave return, expansion joints, land side stairs with handrails, and an optional row of
 * toe tetrapods. Default a 6 m Sanriku coast wall.
 */
export function generateSeaWall(options: SeaWallOptions = {}): SeaWall {
  const o = obj(options, 'sea wall'),
    L = num('sea wall', o, 'length', 1, 2000, 60),
    crest = num('sea wall', o, 'crest', 1, 20, 6),
    toe = num('sea wall', o, 'toe', -10, crest - 1, -1.5),
    land = num('sea wall', o, 'land', -10, crest - 0.5, 2),
    crown = num('sea wall', o, 'crown', 0.3, 10, 1),
    batter = num('sea wall', o, 'batter', 0, 3, 0.5),
    landBatter = num('sea wall', o, 'landBatter', 0, 3, 0.1),
    recurve = bool('sea wall', o, 'recurve', true),
    joints = num('sea wall', o, 'joints', 2, 50, 10),
    stairs = o.stairs === 0 ? 0 : num('sea wall', o, 'stairs', 10, 2000, 50),
    toeT = o.toeTetrapods === undefined || o.toeTetrapods === 0 ? 0 : num('sea wall', o, 'toeTetrapods', 0.5, 100, 1),
    detail = (o.detail ?? 'mid') as string,
    seed = num('sea wall', o, 'seed', -0x80000000, 0xffffffff, 1, true);
  if (!['far', 'mid', 'near'].includes(detail))
    throw new RangeError("Invalid sea wall detail; pass 'far', 'mid' or 'near'.");
  const p = parts(['concrete', 'trim', 'stairs', 'rails'] as const),
    far = detail === 'far',
    zs = crown / 2,
    zl = -crown / 2,
    seaToe = zs + (crest - toe) * batter,
    landToe = zl - (crest - land) * landBatter,
    base = Math.min(toe, land) - 0.5;
  // The section, as a convex polygon in the plane x = 0, extruded along +x.
  const section: V3[] = [
    [0, base, landToe],
    [0, land, landToe],
    [0, crest, zl],
    [0, crest, zs],
    [0, toe, seaToe],
    [0, base, seaToe],
  ];
  p.concrete.slab(
    section.map((q) => [L, q[1], q[2]] as V3),
    L,
    [1, 0, 0],
  );
  if (recurve) {
    // A wave return lip: three facets curling seaward and up from 1.2 m below the crest.
    const r = 0.45;
    const prof: [number, number][] = [
      [0, -1.2],
      [0.2, -0.75],
      [0.38, -0.32],
      [r, 0],
    ];
    // The lip stands out from the battered face line, face(y), by the profile's offset at that height.
    const face = (yy: number) => zs + (crest - yy) * batter;
    for (let k = 0; k + 1 < prof.length; k++) {
      const [z0, y0] = prof[k],
        [z1, y1] = prof[k + 1],
        a = crest + y0,
        b = crest + y1,
        poly: V3[] = [
          [L, a, face(a)],
          [L, a, face(a) + z0],
          [L, b, face(b) + z1],
          [L, b, face(b)],
        ];
      p.concrete.slab(poly, L, [1, 0, 0]);
    }
  }
  if (!far) {
    // Joints: a dark groove strip on each face every `joints` metres; a coping band on the crown edges.
    for (let x = joints; x < L - 1e-6; x += joints) {
      // Grooves lie on the battered faces: thin strips from the crown edge down to each foot, just proud of the face.
      p.trim.beam([x, crest, zs + 0.01], [x, toe, seaToe + 0.01], 0.025, 0.02, [0, -batter, 1]);
      p.trim.beam([x, crest, zl - 0.01], [x, land, landToe - 0.01], 0.025, 0.02, [0, landBatter, -1]);
      p.trim.box([x, crest + 0.005, 0], [0.012, 0.006, crown / 2]);
    }
  }
  // Stairs on the land side: a flight along the face from the ground to the crown, with a handrail.
  if (stairs > 0) {
    const h = crest - land,
      count = Math.ceil(h / 0.18),
      rise = h / count,
      tread = 0.28,
      width = 1.2;
    for (let x0 = stairs / 2; x0 + count * tread < L; x0 += stairs) {
      for (let k = 0; k < count; k++) {
        const ytop = land + (k + 1) * rise,
          xc = x0 + k * tread + tread / 2,
          zFace = zl - (crest - ytop) * landBatter;
        p.stairs.box([xc, (land + ytop) / 2, zFace - width / 2], [tread / 2, (ytop - land) / 2, width / 2]);
      }
      if (!far) {
        const a: V3 = [x0, land + 0.9, zl - width - (crest - land) * landBatter],
          b: V3 = [x0 + count * tread, crest + 0.9, zl - width];
        p.rails.beam(a, b, 0.05, 0.05);
        for (let k = 0; k <= count; k += Math.max(1, Math.round(count / 6))) {
          const q = lerp(a, b, k / count);
          p.rails.beam(add(q, [0, -0.9, 0]), q, 0.045, 0.045, [1, 0, 0]);
        }
      }
    }
  }
  let armour: TetrapodArmour | undefined;
  if (toeT > 0) {
    const size = generateTetrapod({ mass: toeT }).height;
    armour = placeTetrapods({
      mass: toeT,
      length: L,
      slope: 0,
      crestWidth: size * 2.2,
      crest: toe,
      z: seaToe + size * 2.2,
      layers: 1,
      seed,
    });
  }
  return { parts: finish(p), crest, seaward: [zs, seaToe], armour };
}

/** Options for {@link generateQuay}. */
export interface QuayOptions {
  /** Length of the berth along +x, metres, 2 to 2,000. Default 80. */
  readonly length?: number;
  /** Apron width back from the face (toward -z), metres, 2 to 200. Default 20. */
  readonly width?: number;
  /** Crown height above sea level, metres, 0.5 to 6. Default 2. */
  readonly crest?: number;
  /** Sea bed at the face, metres below sea level (negative), -30 to -0.5. Default -4. */
  readonly bottom?: number;
  /** Bollard spacing, metres, 0 (none) or 5 to 50. Default 15. */
  readonly bollards?: number;
  /** Fender spacing, metres, 0 (none) or 2 to 30. Default 6. */
  readonly fenders?: number;
  /** Ladder spacing, metres, 0 (none) or 10 to 200. Default 30. */
  readonly ladders?: number;
  readonly detail?: 'far' | 'mid' | 'near';
}
/** A quay: a concrete block wall with a level apron, a kerb along the face, bollards, rubber fenders and ladders. */
export function generateQuay(options: QuayOptions = {}): {
  readonly parts: Partial<Record<'concrete' | 'kerb' | 'bollards' | 'fenders' | 'ladders', GeometryData>>;
  readonly crest: number;
  readonly bollards: readonly (readonly [number, number, number])[];
} {
  const o = obj(options, 'quay'),
    L = num('quay', o, 'length', 2, 2000, 80),
    Wd = num('quay', o, 'width', 2, 200, 20),
    crest = num('quay', o, 'crest', 0.5, 6, 2),
    bottom = num('quay', o, 'bottom', -30, -0.5, -4),
    bs = o.bollards === 0 ? 0 : num('quay', o, 'bollards', 5, 50, 15),
    fs = o.fenders === 0 ? 0 : num('quay', o, 'fenders', 2, 30, 6),
    ls = o.ladders === 0 ? 0 : num('quay', o, 'ladders', 10, 200, 30),
    far = o.detail === 'far',
    p = parts(['concrete', 'kerb', 'bollards', 'fenders', 'ladders'] as const);
  p.concrete.box([L / 2, (crest + bottom - 1) / 2, -Wd / 2], [L / 2, (crest - bottom + 1) / 2, Wd / 2]);
  // Block courses on the face (a step each 1.5 m) at mid detail.
  if (!far) for (let y = crest - 1.5; y > bottom; y -= 1.5) p.kerb.box([L / 2, y, 0.005], [L / 2, 0.015, 0.01]);
  p.kerb.box([L / 2, crest + 0.125, -0.3], [L / 2, 0.125, 0.3]);
  const bollards: [number, number, number][] = [];
  if (bs > 0)
    for (let x = bs / 2; x < L; x += bs) {
      bollards.push([x, crest, -0.9]);
      p.bollards.box([x, crest + 0.03, -0.9], [0.32, 0.03, 0.32]);
      p.bollards.frustum([x, crest + 0.06, -0.9], [x, crest + 0.5, -0.9], 0.17, 0.14, 16);
      p.bollards.frustum([x, crest + 0.5, -0.9], [x, crest + 0.6, -0.9], 0.24, 0.24, 16);
    }
  if (fs > 0) for (let x = fs / 2; x < L; x += fs) p.fenders.box([x, crest - 0.7, 0.15], [0.25, 0.6, 0.15]);
  if (ls > 0 && !far)
    for (let x = ls / 2 + 1; x < L; x += ls) {
      for (const dx of [-0.22, 0.22])
        p.ladders.beam([x + dx, crest + 0.9, 0.12], [x + dx, Math.max(bottom, -2.5), 0.12], 0.04, 0.04, [1, 0, 0]);
      for (let y = crest - 0.3; y > Math.max(bottom, -2.5); y -= 0.3)
        p.ladders.beam([x - 0.22, y, 0.12], [x + 0.22, y, 0.12], 0.03, 0.03);
    }
  return { parts: finish(p), crest, bollards };
}

/** Options for {@link generateBreakwater}. */
export interface BreakwaterOptions {
  /** Length along +x, metres, 5 to 3,000. Default 120. */
  readonly length?: number;
  /** Crest height above sea level, metres, 0.5 to 20. Default 4. */
  readonly crest?: number;
  /** Sea bed, metres (negative), -40 to -1. Default -8. */
  readonly bottom?: number;
  /** Crest width, metres, 2 to 40. Default 5. */
  readonly crestWidth?: number;
  /** Seaward (+z) and harbour side slopes as cot, 1.25 to 4 each. Defaults 1.5 and 1.5. */
  readonly slope?: number;
  readonly harbourSlope?: number;
  /** Armour tetrapod mass, tonnes, 0.5 to 100. Default 16. */
  readonly armour?: number;
  /** A concrete crown wall on the crest, metres above it, 0 (none) to 5. Default 1.5. */
  readonly crownWall?: number;
  readonly seed?: number;
}
/** A rubble mound breakwater: a quarry-run core with a filter, a crown wall and two layers of tetrapods seaward. */
export function generateBreakwater(options: BreakwaterOptions = {}): {
  readonly parts: Partial<Record<'core' | 'crown', GeometryData>>;
  readonly armour: TetrapodArmour;
  readonly crest: number;
} {
  const o = obj(options, 'breakwater'),
    L = num('breakwater', o, 'length', 5, 3000, 120),
    crest = num('breakwater', o, 'crest', 0.5, 20, 4),
    bottom = num('breakwater', o, 'bottom', -40, -1, -8),
    cw = num('breakwater', o, 'crestWidth', 2, 40, 5),
    cot = num('breakwater', o, 'slope', 1.25, 4, 1.5),
    hcot = num('breakwater', o, 'harbourSlope', 1.25, 4, 1.5),
    mass = num('breakwater', o, 'armour', 0.5, 100, 16),
    wall = num('breakwater', o, 'crownWall', 0, 5, 1.5),
    seed = num('breakwater', o, 'seed', -0x80000000, 0xffffffff, 1, true),
    p = parts(['core', 'crown'] as const),
    t = generateTetrapod({ mass }),
    layer = 2 * 1.04 * Math.cbrt(t.volume),
    h = crest - bottom;
  // The core sits under the armour on the seaward side, so its crest and slope are one layer in.
  const coreCrest = crest - layer,
    seaTop = cw / 2,
    seaFoot = seaTop + h * cot,
    harbourFoot = -cw / 2 - h * hcot,
    section: V3[] = [
      [L, bottom, harbourFoot],
      [L, crest, -cw / 2],
      [L, coreCrest, seaTop - layer * 0.3],
      [L, bottom + layer * 0.5, seaFoot - layer * Math.hypot(1, cot)],
      [L, bottom, seaFoot - layer * Math.hypot(1, cot)],
    ];
  p.core.slab(section, L, [1, 0, 0]);
  if (wall > 0) p.crown.box([L / 2, crest + wall / 2 - 0.3, -cw / 2 + 1.2], [L / 2, (wall + 0.6) / 2, 1]);
  const armour = placeTetrapods({
    mass,
    length: L,
    slope: cot,
    crest,
    toe: bottom,
    crestWidth: Math.max(0, cw / 2 - 0.2),
    z: seaTop,
    layers: 2,
    seed,
  });
  return { parts: finish(p), armour, crest };
}

/** Options for {@link generateSlipway}. */
export interface SlipwayOptions {
  /** Width, metres, 2 to 40. Default 6. */
  readonly width?: number;
  /** Top of the ramp, metres above sea level, 0.2 to 6. Default 2. */
  readonly top?: number;
  /** Foot of the ramp, metres (negative), -6 to -0.2. Default -1.5. */
  readonly foot?: number;
  /** Ramp gradient as run over rise, 4 to 20. Default 8. */
  readonly gradient?: number;
  readonly detail?: 'far' | 'mid' | 'near';
}
/** A concrete slipway running down into the sea along +z, with low side walls and, at near detail, grip grooves. */
export function generateSlipway(options: SlipwayOptions = {}): {
  readonly parts: Partial<Record<'concrete' | 'trim', GeometryData>>;
  readonly length: number;
} {
  const o = obj(options, 'slipway'),
    w = num('slipway', o, 'width', 2, 40, 6),
    top = num('slipway', o, 'top', 0.2, 6, 2),
    foot = num('slipway', o, 'foot', -6, -0.2, -1.5),
    g = num('slipway', o, 'gradient', 4, 20, 8),
    run = (top - foot) * g,
    p = parts(['concrete', 'trim'] as const);
  p.concrete.slab(
    [
      [w / 2, top, 0],
      [w / 2, foot, run],
      [w / 2, foot - 0.4, run],
      [w / 2, foot - 0.4, 0],
    ],
    w,
    [1, 0, 0],
  );
  for (const sx of [1, -1])
    p.concrete.beam([sx * (w / 2 + 0.15), top + 0.2, 0], [sx * (w / 2 + 0.15), foot + 0.2, run], 0.3, 0.8);
  if (o.detail === 'near')
    for (let z = 0.3; z < run; z += 0.3) {
      const y = top - z / g;
      p.trim.beam([-w / 2, y + 0.005, z], [w / 2, y + 0.005, z], 0.03, 0.01);
    }
  return { parts: finish(p), length: run };
}

/** A timber or steel mooring post standing from the sea bed, with a cap; origin at its foot. */
export function generateMooringPost(
  options: { height?: number; radius?: number; segments?: number } = {},
): GeometryData {
  const o = obj(options, 'mooring post'),
    h = num('mooring post', o, 'height', 1, 30, 7),
    r = num('mooring post', o, 'radius', 0.05, 1, 0.18),
    n = num('mooring post', o, 'segments', 6, 48, 12, true),
    m = new MeshBuilder();
  m.frustum([0, 0, 0], [0, h, 0], r * 1.05, r, n);
  m.frustum([0, h, 0], [0, h + r * 0.4, 0], r * 1.15, r * 0.9, n);
  return m.finish();
}

/** Options for {@link generateFishingBoat}. */
export interface FishingBoatOptions {
  /** Length overall, metres, 5 to 40. Default 14.5 (a 4.9 to 19 gross ton coastal boat). */
  readonly length?: number;
  /** Beam over length, 0.2 to 0.33. Default 0.245 (length to beam about 4.1). */
  readonly beamRatio?: number;
  /** Draft at the stern, metres, 0.3 to 4. Default length * 0.075. */
  readonly draft?: number;
  /** Freeboard to the deck at midships, metres, 0.3 to 3. Default length * 0.06. */
  readonly freeboard?: number;
  /** Bulwark height above the deck, metres, 0.2 to 1.5. Default 0.75. */
  readonly bulwark?: number;
  /** Wheelhouse centre as a share of the length from the stern, 0.15 to 0.7. Default 0.42. */
  readonly wheelhouse?: number;
  /** A mast with a cross tree and lights. Default true. */
  readonly mast?: boolean;
  /** A row of fishing lamps on a wire over the deck. Default false. */
  readonly lamps?: boolean;
  /** Stations along the hull, 12 to 96. Default 40. */
  readonly stations?: number;
  readonly seed?: number;
}
/** A fishing boat from {@link generateFishingBoat}. */
export interface FishingBoat {
  readonly parts: Partial<Record<'hull' | 'bottom' | 'deck' | 'cabin' | 'glass' | 'metal' | 'trim', GeometryData>>;
  readonly length: number;
  readonly beam: number;
  readonly draft: number;
  readonly freeboard: number;
  /** Length on the waterline, metres. */
  readonly waterline: number;
}
/**
 * A coastal fishing boat of the Japanese type: a V-bottom FRP hull with a raked flared bow, a wide transom, a bulwark
 * round a working deck, a wheelhouse a little aft of midships with windows all round, a mast and a rubbing strake. The
 * hull below the waterline is its own part (antifouling red). Origin on the waterline at midships, bow toward +x.
 */
export function generateFishingBoat(options: FishingBoatOptions = {}): FishingBoat {
  const o = obj(options, 'fishing boat'),
    L = num('fishing boat', o, 'length', 5, 40, 14.5),
    B = L * num('fishing boat', o, 'beamRatio', 0.2, 0.33, 0.245),
    T = num('fishing boat', o, 'draft', 0.3, 4, L * 0.075),
    F = num('fishing boat', o, 'freeboard', 0.3, 3, L * 0.06),
    hb = num('fishing boat', o, 'bulwark', 0.2, 1.5, 0.75),
    wh = num('fishing boat', o, 'wheelhouse', 0.15, 0.7, 0.42),
    mast = bool('fishing boat', o, 'mast', true),
    lamps = bool('fishing boat', o, 'lamps', false),
    N = num('fishing boat', o, 'stations', 12, 96, 40, true),
    p = parts(['hull', 'bottom', 'deck', 'cabin', 'glass', 'metal', 'trim'] as const);
  // Lines as functions of s, 0 at the transom and 1 at the stem.
  const half = (s: number) =>
    (B / 2) *
    (s < 0.5
      ? 0.86 + 0.14 * Math.sin((s / 0.5) * (Math.PI / 2))
      : Math.pow(Math.cos(((s - 0.5) / 0.5) * (Math.PI / 2)), 0.75));
  const keel = (s: number) =>
    s < 0.72
      ? -T * (1 - 0.15 * s)
      : -T * 0.89 * (1 - Math.pow((s - 0.72) / 0.28, 1.6)) + F * 0.35 * Math.pow((s - 0.72) / 0.28, 2.5);
  const sheer = (s: number) => F + hb + 0.35 * F * s * s + 0.1 * F * (1 - s) * (1 - s);
  const deadrise = (s: number) => ((12 + 38 * s * s) * Math.PI) / 180;
  const x = (s: number) => -L / 2 + s * L;
  // A section from the keel to the bulwark top: points [half-breadth, height].
  const section = (s: number): [number, number][] => {
    const b = half(s),
      yk = keel(s),
      ys = sheer(s),
      chineB = b * (s > 0.55 ? 0.82 - 0.2 * (s - 0.55) : 0.9),
      yc = Math.min(yk + chineB * Math.tan(deadrise(s)), ys - 0.15),
      pts: [number, number][] = [];
    for (let k = 0; k <= 4; k++) {
      const f = k / 4;
      pts.push([chineB * f, yk + (yc - yk) * (f * 0.9 + 0.1 * f * f)]);
    }
    for (let k = 1; k <= 5; k++) {
      const f = k / 5;
      pts.push([chineB + (b - chineB) * Math.sin((f * Math.PI) / 2), yc + (ys - yc) * f]);
    }
    return pts;
  };
  const rows = Array.from({ length: N + 1 }, (_, i) => section(i / N));
  const P = (i: number, j: number, side: number): V3 => [x(i / N), rows[i][j][1], side * rows[i][j][0]];
  for (const side of [1, -1])
    for (let i = 0; i < N; i++)
      for (let j = 0; j + 1 < rows[i].length; j++) {
        const q = [P(i, j, side), P(i + 1, j, side), P(i + 1, j + 1, side), P(i, j + 1, side)],
          mid = scale(add(add(q[0], q[1]), add(q[2], q[3])), 0.25),
          toward: V3 = [0, mid[1] < keel(i / N) + 0.01 ? -1 : 0, side];
        // Split at the waterline.
        const below = clipY(q, -1),
          above = clipY(q, 1);
        if (below.length >= 3) p.bottom.poly(below, toward);
        if (above.length >= 3) p.hull.poly(above, toward);
      }
  // Transom: the section at s = 0 closed across.
  for (const side of [1, -1]) {
    const r = rows[0];
    for (let j = 0; j + 1 < r.length; j++) {
      const q: V3[] = [
        [x(0), r[j][1], 0],
        [x(0), r[j][1], side * r[j][0]],
        [x(0), r[j + 1][1], side * r[j + 1][0]],
        [x(0), r[j + 1][1], 0],
      ];
      const below = clipY(q, -1),
        above = clipY(q, 1);
      if (below.length >= 3) p.bottom.poly(below, [-1, 0, 0]);
      if (above.length >= 3) p.hull.poly(above, [-1, 0, 0]);
    }
  }
  // Deck, inner bulwark faces and the rail cap.
  const deckY = (s: number) => sheer(s) - hb;
  for (let i = 0; i < N; i++) {
    const s0 = i / N,
      s1 = (i + 1) / N,
      b0 = half(s0) - 0.06,
      b1 = half(s1) - 0.06;
    p.deck.poly(
      [
        [x(s0), deckY(s0), -Math.max(0, b0)],
        [x(s1), deckY(s1), -Math.max(0, b1)],
        [x(s1), deckY(s1), Math.max(0, b1)],
        [x(s0), deckY(s0), Math.max(0, b0)],
      ],
      [0, 1, 0],
    );
    for (const side of [1, -1]) {
      p.hull.poly(
        [
          [x(s0), deckY(s0), side * Math.max(0, b0)],
          [x(s1), deckY(s1), side * Math.max(0, b1)],
          [x(s1), sheer(s1), side * Math.max(0, b1)],
          [x(s0), sheer(s0), side * Math.max(0, b0)],
        ],
        [0, 0, -side],
      );
      p.trim.beam(
        [x(s0), sheer(s0) + 0.03, side * (half(s0) - 0.03)],
        [x(s1), sheer(s1) + 0.03, side * (half(s1) - 0.03)],
        0.1,
        0.06,
      );
      // Rubbing strake at deck level.
      p.trim.beam(
        [x(s0), deckY(s0) - 0.05, side * (half(s0) + 0.03)],
        [x(s1), deckY(s1) - 0.05, side * (half(s1) + 0.03)],
        0.08,
        0.1,
      );
    }
  }
  // Wheelhouse.
  const cx = x(wh),
    cl = L * 0.2,
    cw = half(wh) * 1.3,
    cy = deckY(wh),
    ch = 2.1;
  p.cabin.box([cx, cy + 0.45, 0], [cl / 2, 0.45, cw / 2]);
  for (const [sx, sz, len, ax] of [
    [cl / 2, 0, cw, [0, 0, 1]],
    [-cl / 2, 0, cw, [0, 0, 1]],
    [0, cw / 2, cl, [1, 0, 0]],
    [0, -cw / 2, cl, [1, 0, 0]],
  ] as [number, number, number, V3][]) {
    const nrm = unit([sx, 0, sz]),
      centre: V3 = [cx + sx, cy + 1.3, sz];
    p.glass.poly(
      [
        add(add(centre, scale(ax, -len / 2 + 0.12)), [0, -0.38, 0]),
        add(add(centre, scale(ax, len / 2 - 0.12)), [0, -0.38, 0]),
        add(add(centre, scale(ax, len / 2 - 0.12)), [0, 0.38, 0]),
        add(add(centre, scale(ax, -len / 2 + 0.12)), [0, 0.38, 0]),
      ].map((q) => add(q, scale(nrm, 0.005))),
      nrm,
    );
    // Window posts.
    for (let k = 1; k < 4; k++) {
      const a = add(add(centre, scale(ax, -len / 2 + (len * k) / 4)), [0, -0.38, 0]);
      p.cabin.beam(add(a, scale(nrm, 0.01)), add(add(a, [0, 0.76, 0]), scale(nrm, 0.01)), 0.06, 0.04, nrm);
    }
  }
  p.cabin.box([cx, cy + 0.9 + 0.4 + 0.4 + 0.15, 0], [cl / 2, 0.15, cw / 2]);
  p.cabin.box([cx, cy + 1.3, 0], [cl / 2 - 0.05, 0.4, cw / 2 - 0.05]);
  p.cabin.box([cx, cy + ch - 0.05, 0], [cl / 2 + 0.2, 0.05, cw / 2 + 0.1]);
  if (mast) {
    const top = cy + ch + L * 0.32;
    p.metal.frustum([cx + cl * 0.2, cy + ch, 0], [cx + cl * 0.2, top, 0], 0.07, 0.04, 10);
    p.metal.beam([cx + cl * 0.2, top - 0.8, -0.8], [cx + cl * 0.2, top - 0.8, 0.8], 0.05, 0.05);
    p.metal.box([cx + cl * 0.2, cy + ch + 0.25, 0], [0.35, 0.03, 0.1]);
    // A stay forward to the stem head.
    p.metal.beam([cx + cl * 0.2, top - 0.2, 0], [x(0.97), sheer(0.97) + 0.1, 0], 0.015, 0.015);
    if (lamps) {
      const aft: V3 = [x(0.08), sheer(0.08) + 1.6, 0],
        fore: V3 = [cx + cl * 0.2, top - 0.8, 0];
      p.metal.beam(aft, fore, 0.01, 0.01);
      for (let k = 1; k < 12; k++)
        p.glass.frustum(
          add(lerp(aft, fore, k / 12), [0, -0.12, 0]),
          add(lerp(aft, fore, k / 12), [0, -0.38, 0]),
          0.06,
          0.12,
          8,
        );
    }
  }
  // A hand rail round the wheelhouse roof.
  p.metal.beam([cx - cl / 2, cy + ch + 0.5, cw / 2], [cx + cl / 2, cy + ch + 0.5, cw / 2], 0.03, 0.03);
  p.metal.beam([cx - cl / 2, cy + ch + 0.5, -cw / 2], [cx + cl / 2, cy + ch + 0.5, -cw / 2], 0.03, 0.03);
  // Waterline length: where the keel and hull cross y = 0 at the ends.
  let wlFore = 1;
  for (let k = 0; k <= 400; k++) {
    const s = k / 400;
    if (s > 0.5 && keel(s) >= 0) {
      wlFore = s;
      break;
    }
  }
  return { parts: finish(p), length: L, beam: B, draft: T, freeboard: F, waterline: wlFore * L };
}
// Clips a polygon to y <= 0 (side -1) or y >= 0 (side 1).
function clipY(q: V3[], side: number): V3[] {
  const out: V3[] = [];
  for (let k = 0; k < q.length; k++) {
    const a = q[k],
      b = q[(k + 1) % q.length],
      fa = side * a[1],
      fb = side * b[1];
    if (fa >= 0) out.push(a);
    if (fa >= 0 !== fb >= 0) out.push(lerp(a, b, fa / (fa - fb)));
  }
  return out;
}
