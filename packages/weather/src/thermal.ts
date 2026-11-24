// An instantaneous release: the buoyant thermal of a large explosion (an ammunition dump, a quarry blast, a buried
// charge), rising as a mushroom cloud over film time. Every output is a function of the film time and the seed alone:
// the rise is solved once per source when it is made (fourth-order Runge-Kutta in time, steps of 1/20 s) and read back
// by interpolation, so a seek, a re-render or a frame rendered out of order gives the same cloud. Sources (papers, read
// as text; no code; docs/clean-room.md "Blast thermal"):
// - B. R. Morton, G. I. Taylor and J. S. Turner, "Turbulent gravitational convection from maintained and instantaneous
//   sources", Proc. R. Soc. Lond. A 234(1196), 1-23, 1956, https://doi.org/10.1098/rspa.1956.0011: the instantaneous
//   source (a thermal) as a top-hat cloud of radius b entraining ambient air at a speed proportional to its own, so in
//   still air b grows linearly with height, its volume flux and buoyancy obey d(b^3)/dt = 3 alpha b^2 w and
//   d(b^3 g')/dt = -N^2 b^3 w, and in stable air it stops at a height proportional to B^(1/4) N^(-1/2).
// - R. S. Scorer, "Experiments on convection of isolated masses of buoyant fluid", J. Fluid Mech. 2(6), 583-594, 1957,
//   https://doi.org/10.1017/S0022112057000397: laboratory thermals spread with b / z near 0.25 (our default
//   `entrainment`), and in uniform surroundings rise as z proportional to (B t^2)^(1/4).
// - J. S. Turner, "Buoyant vortex rings", Proc. R. Soc. Lond. A 239(1216), 61-75, 1957,
//   https://doi.org/10.1098/rspa.1957.0023: a thermal carries its buoyancy in a rising vortex ring, the mushroom's cap,
//   whose circulation draws the dust under it up the stem.
// - M. P. Escudier and T. Maxworthy, "On the motion of turbulent thermals", J. Fluid Mech. 61(3), 541-552, 1973,
//   https://doi.org/10.1017/S0022112073000856: the thermal's momentum includes the ambient fluid it pushes aside, an
//   added mass coefficient near that of a sphere, 1/2 (our default `addedMass`).
// - J. S. Turner, "Buoyant plumes and thermals", Annu. Rev. Fluid Mech. 1, 29-44, 1969,
//   https://doi.org/10.1146/annurev.fl.01.010169.000333: the review of the entrainment equations used here.
// - S. Glasstone and P. J. Dolan, "The Effects of Nuclear Weapons", 3rd ed., US DoD and ERDA, 1977, ch. 2: a shallow
//   buried burst throws up a column of earth with a dense dust cloud at its top, and the cloud rises and spreads as the
//   hot gas inside it is buoyant; the base surge rolls out along the ground.
// - W. E. Baker, P. A. Cox, P. S. Westine, J. J. Kulesz and R. A. Strehlow, "Explosion Hazards and Evaluation",
//   Elsevier, 1983: the cube-root scaling of an explosion's sizes with its charge mass (the initial cloud radius here,
//   b0 = W^(1/3) metres for W kg of TNT, a model choice: about the sphere the hot detonation products fill at the air's
//   pressure) and the TNT heat of detonation, 4.184 MJ/kg.
// The buoyancy of the released heat Q in air of density rho, heat capacity c_p and temperature T is B = g Q / (rho c_p T)
// (the heat-to-buoyancy flux relation of Morton et al. 1956); `heatShare` of the charge's energy heats the air (a model
// choice). The atmosphere is the ICAO standard one (`standardAtmosphere`), whose N^2 = g / T (dT/dz + g / c_p) stops the
// rise. The wind drifts the cap as the 1/7 power of height to the tropopause, as `Eruption`.
import { standardAtmosphere } from './eruption.js';

const G = 9.80665;
const C_AIR = 1005;
const TNT = 4.184e6;
const DT = 0.05;

/** One instantaneous release of {@link BlastCloud}. */
export interface BlastSource {
  /** Film seconds it goes off. Default 0. */
  at?: number;
  /** World place of the charge, [x, y, z] metres. Default [0, 0, 0]. */
  position?: readonly [number, number, number];
  /** Charge as kilograms of TNT, 1 to 1e9. Default 1e6 (1,000 tonnes). */
  tnt?: number;
  /** Initial cloud radius, metres above 0. Default tnt^(1/3) (cube-root scaling, Baker et al. 1983). */
  radius?: number;
  /** Initial rise speed of the cloud, m/s, 0 to 500: the upward throw of a buried or ground burst. Default 0. */
  speed?: number;
}

/** Options of {@link BlastCloud}. Every field has a documented default; the constructor checks the ranges. */
export interface BlastCloudOptions {
  /** The releases, 1 to 8. Default one source of 1,000 tonnes at the origin at film time 0. */
  sources?: readonly BlastSource[];
  /** Ground height above sea level, metres, 0 to 8,000 (the air's density and stability). Default 0. */
  altitude?: number;
  /** Share of the charge's energy that heats the air, 0.01 to 1. Default 0.4 (a model choice). */
  heatShare?: number;
  /** Thermal spread b / z (Scorer 1957), 0.1 to 0.5. Default 0.25. */
  entrainment?: number;
  /** Added mass coefficient (Escudier and Maxworthy 1973), 0 to 2. Default 0.5. */
  addedMass?: number;
  /** Air temperature at sea level, kelvin, 220 to 320. Default 288.15 (ICAO). */
  airTemperature?: number;
  /** Height of the tropopause above sea level, metres, 6,000 to 20,000. Default 11,000 (ICAO). */
  tropopause?: number;
  /** Air stability N^2, 1/s^2, 0 to 0.01: a value holds it constant; null follows the standard atmosphere. Default null. */
  stability?: number | null;
  /** Wind at 10 m, m/s, 0 to 60, growing with height as the 1/7 power to the tropopause. Default 0. */
  wind?: number;
  /** Direction the wind blows toward, degrees, 0 is +Z, 90 is +X. Default 0. */
  windDirection?: number;
  /** Seconds the rise is solved for, 10 to 7,200; afterwards the cloud holds its last state. Default 900. */
  horizon?: number;
  /** Seconds the fire at the base burns, 0 to 600. Default 4. */
  fireDuration?: number;
  /** Colour of the cap (smoke and fine ash), linear RGB 0 to 1. Default [0.06, 0.055, 0.05], near black. */
  color?: readonly [number, number, number];
  /** Colour of the stem and base surge (thrown earth), linear RGB 0 to 1. Default [0.1, 0.075, 0.05], dark brown. */
  stemColor?: readonly [number, number, number];
  /** Colour of the fire, linear RGB 0 to 1 (drawn unlit; multiply in a Clouds of `shading: 'unlit'`). Default [1, 0.42, 0.1]. */
  fireColor?: readonly [number, number, number];
  /** Seed of the puff layout, an integer. Default 1. */
  seed?: number;
}

/** One thermal at a film time, from {@link BlastCloud.thermals}. */
export interface BlastThermal {
  /** Seconds since its source went off (0 before it). */
  readonly age: number;
  /** World place of the cap's centre, metres. */
  readonly centre: readonly [number, number, number];
  /** Height of the cap's centre above the source, metres. */
  readonly height: number;
  /** Cap radius b, metres. */
  readonly radius: number;
  /** Rise speed, m/s. */
  readonly speed: number;
  /** Reduced gravity g' of the cap, m/s^2 (negative once it overshoots its neutral level). */
  readonly buoyancy: number;
  /** Total buoyancy b^3 g' at the source, m^4/s^2 (the conserved B of uniform air, over 4 pi / 3). */
  readonly sourceBuoyancy: number;
  /** Fire at the base, 0 to 1. */
  readonly fire: number;
}

/** What {@link BlastCloud.draw} draws into: a `Clouds` of `@margoengine/vfx/clouds` fits it. */
export interface BlastCloudTarget {
  add(options: object): { readonly options: object; readonly matrix: Float32Array };
  remove(cloud: object): boolean;
}

/** How many puffs {@link BlastCloud.draw} lays out. */
export interface BlastDrawOptions {
  /** Puffs of each cap, 8 to 4,096. Default 220. */
  cap?: number;
  /** Puffs of each stem and its base surge, 8 to 4,096. Default 160. */
  stem?: number;
  /** Puffs of each fire, 0 to 1,024. Default 60. */
  fire?: number;
}

interface Track {
  readonly at: number;
  readonly position: readonly [number, number, number];
  readonly b0: number;
  readonly B: number;
  /** Per step: z, b, w, g', drift x, drift z. */
  readonly rows: Float64Array;
}

const RANGES: Record<string, readonly [number, number]> = {
  altitude: [0, 8000],
  heatShare: [0.01, 1],
  entrainment: [0.1, 0.5],
  addedMass: [0, 2],
  airTemperature: [220, 320],
  tropopause: [6000, 20000],
  wind: [0, 60],
  windDirection: [-360, 720],
  horizon: [10, 7200],
  stability: [0, 0.01],
  fireDuration: [0, 600],
};

const bad = (message: string): never => {
  throw new RangeError(`BlastCloud option out of range; ${message}`);
};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const colour = (v: unknown, key: string): void => {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length !== 3 || !v.every((c) => finite(c) && c >= 0 && c <= 1))
    bad(`${key} must be three linear RGB numbers from 0 to 1.`);
};

/** lowbias32 (C. Wellons, "Prospecting for Hash Functions"), as a number in [0, 1). */
const hash = (x: number): number => {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

/** N^2 of the standard atmosphere at height z above sea level, 1/s^2. */
export function airStability(z: number, seaLevel = 288.15, tropopause = 11000): number {
  const [T] = standardAtmosphere(z, seaLevel, tropopause),
    dT =
      (standardAtmosphere(z + 5, seaLevel, tropopause)[0] -
        standardAtmosphere(Math.max(z - 5, 0), seaLevel, tropopause)[0]) /
      (z >= 5 ? 10 : 5 + z);
  return (G / T) * (dT + G / C_AIR);
}

/**
 * The height a thermal of source buoyancy `B` (b^3 g', m^4/s^2) reaches in still air of constant stability `N2`, by
 * the same equations {@link BlastCloud} solves: the scale B^(1/4) N^(-1/2) of Morton et al. (1956) times a constant
 * that depends on `entrainment` and `addedMass`.
 */
export function thermalTop(B: number, N2: number, entrainment = 0.25, addedMass = 0.5, b0 = 1): number {
  const rows = solve(
    B,
    b0,
    0,
    entrainment,
    addedMass,
    () => N2,
    () => 0,
    7200,
  );
  let top = 0;
  for (let k = 0; k < rows.length; k += 6) top = Math.max(top, rows[k]!);
  return top;
}

function solve(
  B: number,
  b0: number,
  w0: number,
  alpha: number,
  k: number,
  N2: (z: number) => number,
  wind: (z: number) => number,
  horizon: number,
): Float64Array {
  const steps = Math.ceil(horizon / DT),
    rows = new Float64Array((steps + 1) * 6);
  // State: z, V = b^3, M = (1 + k) b^3 w, F = b^3 g', drift s.
  let z = 0,
    V = b0 * b0 * b0,
    M = (1 + k) * V * w0,
    F = B,
    s = 0;
  const d = (z: number, V: number, M: number, F: number): [number, number, number, number, number] => {
    const b = Math.cbrt(V),
      w = M / ((1 + k) * V);
    return [w, 3 * alpha * b * b * Math.abs(w), F, -N2(z) * V * w, wind(z)];
  };
  for (let i = 0; ; i++) {
    const b = Math.cbrt(V);
    rows.set([z, b, M / ((1 + k) * V), F / V, s, 0], i * 6);
    if (i === steps) break;
    // Sub-steps of at most a tenth of the radius travelled or fallen, so a small hot start is resolved.
    for (let left = DT; left > 0; ) {
      const bb = Math.cbrt(V),
        ww = Math.abs(M / ((1 + k) * V)),
        gg = Math.abs(F / ((1 + k) * V)),
        h = Math.min(left, (0.1 * bb) / Math.max(ww, 1e-9), Math.sqrt((0.2 * bb) / Math.max(gg, 1e-9)));
      left = left - h < 1e-12 ? 0 : left - h;
      const a1 = d(z, V, M, F),
        a2 = d(z + 0.5 * h * a1[0], V + 0.5 * h * a1[1], M + 0.5 * h * a1[2], F + 0.5 * h * a1[3]),
        a3 = d(z + 0.5 * h * a2[0], V + 0.5 * h * a2[1], M + 0.5 * h * a2[2], F + 0.5 * h * a2[3]),
        a4 = d(z + h * a3[0], V + h * a3[1], M + h * a3[2], F + h * a3[3]);
      z = Math.max(0, z + (h / 6) * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]));
      V += (h / 6) * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]);
      M += (h / 6) * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2]);
      F += (h / 6) * (a1[3] + 2 * a2[3] + 2 * a3[3] + a4[3]);
      s += (h / 6) * (a1[4] + 2 * a2[4] + 2 * a3[4] + a4[4]);
      // A thermal that has settled back onto the ground stays there.
      if (z === 0 && M < 0) M = 0;
    }
  }
  return rows;
}

/**
 * The mushroom cloud of one or more instantaneous releases over film time (entry `@margoengine/weather/eruption`):
 * each source is a buoyant thermal (Morton, Taylor and Turner 1956) that rises, spreads as b = alpha z and slows in
 * the stable air until it stops, its cap a dark vortex ring over a stem of thrown earth and a fire at its base.
 * `seek(t)` and `draw(clouds)` put it into a `Clouds` of `@margoengine/vfx/clouds`, whose puffs shadow each other.
 */
export class BlastCloud {
  readonly options: Readonly<BlastCloudOptions>;
  private readonly tracks: Track[];
  private film = 0;
  private readonly drawn = new Map<string, { readonly options: object; readonly matrix: Float32Array }>();
  private target: BlastCloudTarget | null = null;
  private fireTarget: BlastCloudTarget | null = null;

  constructor(options: BlastCloudOptions = {}) {
    if (typeof options !== 'object' || options === null) throw new TypeError('BlastCloud options must be an object.');
    const o = options as Record<string, unknown>;
    for (const [key, [lo, hi]] of Object.entries(RANGES))
      if (o[key] != null && (!finite(o[key]) || (o[key] as number) < lo || (o[key] as number) > hi))
        bad(`${key} must be a number from ${lo} to ${hi}.`);
    colour(o.color, 'color');
    colour(o.stemColor, 'stemColor');
    colour(o.fireColor, 'fireColor');
    if (o.seed !== undefined && !Number.isInteger(o.seed)) bad('seed must be an integer.');
    const sources = options.sources ?? [{}];
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 8) bad('sources must hold 1 to 8 releases.');
    this.options = options;
    const alt = options.altitude ?? 0,
      T0 = options.airTemperature ?? 288.15,
      trop = options.tropopause ?? 11000,
      alpha = options.entrainment ?? 0.25,
      k = options.addedMass ?? 0.5,
      share = options.heatShare ?? 0.4,
      u10 = options.wind ?? 0,
      [Ta, Pa] = standardAtmosphere(alt, T0, trop),
      rho = Pa / (287.05287 * Ta),
      fixed = options.stability ?? null,
      N2 = fixed === null ? (z: number) => Math.max(airStability(alt + z, T0, trop), 0) : () => fixed,
      wind = (z: number) => u10 * Math.pow(Math.max(Math.min(alt + z, trop) - alt, 10) / 10, 1 / 7);
    this.tracks = sources.map((s, i) => {
      if (typeof s !== 'object' || s === null) bad(`sources[${i}] must be an object.`);
      const at = s.at ?? 0,
        tnt = s.tnt ?? 1e6,
        position = s.position ?? [0, alt, 0];
      if (!finite(at) || at < 0) bad(`sources[${i}].at must be 0 or more.`);
      if (!finite(tnt) || tnt < 1 || tnt > 1e9) bad(`sources[${i}].tnt must be from 1 to 1e9 kg.`);
      if (!Array.isArray(position) || position.length !== 3 || !position.every(finite))
        bad(`sources[${i}].position must be [x, y, z].`);
      const b0 = s.radius ?? Math.cbrt(tnt),
        w0 = s.speed ?? 0;
      if (!finite(b0) || b0 <= 0) bad(`sources[${i}].radius must be above 0.`);
      if (!finite(w0) || w0 < 0 || w0 > 500) bad(`sources[${i}].speed must be from 0 to 500 m/s.`);
      // B = g Q / (rho c_p T), shared over the top-hat's b^3 (the 4 pi / 3 of a sphere's volume divided out).
      const B = (G * share * tnt * TNT) / (rho * C_AIR * Ta) / ((4 * Math.PI) / 3);
      return { at, position, b0, B, rows: solve(B, b0, w0, alpha, k, N2, wind, options.horizon ?? 900) };
    });
  }

  /** Film time now, seconds. */
  get time(): number {
    return this.film;
  }

  /** Sets the film time; the cloud is a function of it alone. */
  seek(t: number): void {
    if (!finite(t) || t < 0) bad('seek time must be 0 or more.');
    this.film = t;
  }

  /** Moves the film time on by `delta` seconds. */
  update(delta: number): void {
    if (!finite(delta) || delta < 0) bad('update delta must be 0 or more.');
    this.film += delta;
  }

  /** Each source's thermal at film time `t` (default now), in source order. */
  thermals(t = this.film): BlastThermal[] {
    const dir = ((this.options.windDirection ?? 0) * Math.PI) / 180,
      wx = Math.sin(dir),
      wz = Math.cos(dir),
      fireFor = this.options.fireDuration ?? 4;
    return this.tracks.map((tr) => {
      const age = Math.max(t - tr.at, 0),
        f = Math.min(age / DT, tr.rows.length / 6 - 1),
        i = Math.floor(f),
        j = Math.min(i + 1, tr.rows.length / 6 - 1),
        u = f - i,
        r = (c: number) => tr.rows[i * 6 + c]! * (1 - u) + tr.rows[j * 6 + c]! * u,
        z = r(0),
        b = r(1),
        s = r(4),
        fire = t < tr.at || fireFor === 0 ? 0 : Math.max(0, 1 - age / fireFor) ** 1.5;
      return {
        age,
        centre: [tr.position[0] + wx * s, tr.position[1] + z, tr.position[2] + wz * s] as const,
        height: z,
        radius: b,
        speed: r(2),
        buoyancy: r(3),
        sourceBuoyancy: tr.B,
        fire,
      };
    });
  }

  /**
   * Puts the caps, stems and base surges into `clouds` and the fires into `fire` (a second `Clouds`, `shading:
   * 'unlit'`, attached before `clouds` so the smoke draws over the fire; left out, the fires are not drawn). Each kind is one cloud for all sources, so the caps shadow each
   * other and the stems under them. The layout is a function of the film time and the seed: call after `seek` or
   * `update`.
   */
  draw(clouds: BlastCloudTarget, fire?: BlastCloudTarget, counts: BlastDrawOptions = {}): void {
    if (this.target && this.target !== clouds) this.clear();
    this.target = clouds;
    if (fire !== undefined) this.fireTarget = fire;
    const capN = counts.cap ?? 220,
      stemN = counts.stem ?? 160,
      fireN = counts.fire ?? 60;
    for (const [n, lo, key] of [
      [capN, 8, 'cap'],
      [stemN, 8, 'stem'],
      [fireN, 0, 'fire'],
    ] as const)
      if (!Number.isInteger(n) || n < lo || n > 4096)
        bad(`draw counts.${key} must be a whole number from ${lo} to 4,096.`);
    const o = this.options,
      seed = o.seed ?? 1,
      lit = this.thermals()
        .map((th, i) => ({ th, tr: this.tracks[i]! }))
        .filter((x) => this.film >= x.tr.at);
    const place = (
      target: BlastCloudTarget,
      id: string,
      options: Record<string, unknown>,
      box: [number, number, number, number, number, number] | null,
    ): void => {
      let c = this.drawn.get(id);
      if (!box) {
        if (c) {
          target.remove(c);
          this.drawn.delete(id);
        }
        return;
      }
      if (!c) {
        c = target.add(options);
        this.drawn.set(id, c);
      } else Object.assign(c.options, options);
      const m = c.matrix;
      m.fill(0);
      m[0] = m[5] = m[10] = m[15] = 1;
      m[12] = box[0];
      m[13] = box[1];
      m[14] = box[2];
    };
    // Every puff in world units relative to a box centre; distribute returns box units, so build the list first.
    type Puff = [number, number, number, number];
    const layout = (
      puffs: Puff[],
    ): {
      box: [number, number, number, number, number, number];
      bounds: [number, number, number];
      volume: number;
      distribute: (i: number) => { point: [number, number, number]; volume: number };
    } => {
      let x0 = Infinity,
        y0 = Infinity,
        z0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity,
        z1 = -Infinity,
        big = 0;
      for (const [x, y, z, s] of puffs) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
        big = Math.max(big, s);
      }
      const cx = 0.5 * (x0 + x1),
        cy = 0.5 * (y0 + y1),
        cz = 0.5 * (z0 + z1),
        bounds: [number, number, number] = [Math.max(x1 - x0, 1e-3), Math.max(y1 - y0, 1e-3), Math.max(z1 - z0, 1e-3)];
      return {
        box: [cx, cy, cz, 0, 0, 0],
        bounds,
        volume: big,
        distribute: (i: number) => {
          const p = puffs[i]!;
          return {
            point: [((p[0] - cx) * 2) / bounds[0], ((p[1] - cy) * 2) / bounds[1], ((p[2] - cz) * 2) / bounds[2]],
            volume: big > 0 ? p[3] / big : 0,
          };
        },
      };
    };
    const caps: Puff[] = [],
      stems: Puff[] = [],
      fires: Puff[] = [];
    lit.forEach(({ th, tr }, s) => {
      const b = th.radius,
        [cx, cy, cz] = th.centre,
        [gx, gy, gz] = tr.position,
        rnd = (n: number, c: number) => hash((seed * 7919 + s * 104729 + n * 31 + c) >>> 0);
      // Cap: a vortex ring (Turner 1957) of ring radius 0.55 b and core 0.45 b, its top domed.
      for (let n = 0; n < capN; n++) {
        const phi = rnd(n, 0) * 2 * Math.PI,
          ring = n % 3 !== 2,
          core = ring ? 0.45 * b * Math.sqrt(rnd(n, 1)) : 0.6 * b * Math.sqrt(rnd(n, 1)),
          psi = rnd(n, 2) * 2 * Math.PI,
          R = ring ? 0.55 * b + core * Math.cos(psi) : core * Math.cos(psi) * 0.6,
          y = ring ? core * Math.sin(psi) * 0.8 : 0.25 * b + Math.abs(core * Math.sin(psi)),
          size = b * (0.55 + 0.4 * rnd(n, 3));
        caps.push([cx + R * Math.cos(phi), cy + y, cz + R * Math.sin(phi), size]);
      }
      // Stem from the ground to under the cap, drawn up by the ring's circulation, narrowing upward; and the base
      // surge rolling out along the ground (Glasstone and Dolan 1977, ch. 2), growing with the cap.
      const top = Math.max(th.height - 0.4 * b, 0),
        surge = Math.min(tr.b0 * (1 + 0.6 * Math.sqrt(th.age)), 1.2 * b + tr.b0);
      for (let n = 0; n < stemN; n++) {
        const along = rnd(n, 4),
          phi = rnd(n, 5) * 2 * Math.PI;
        if (n % 4 === 3) {
          const r = surge * Math.sqrt(rnd(n, 6)),
            size = tr.b0 * (1.1 + 0.8 * rnd(n, 7)) * Math.min(1, th.age / 4);
          stems.push([gx + r * Math.cos(phi), gy + 0.3 * size, gz + r * Math.sin(phi), size]);
          continue;
        }
        const y = along * top,
          w = 0.28 * b * (1 - 0.45 * along) + 0.5 * tr.b0 * (1 - along),
          r = w * Math.sqrt(rnd(n, 6)),
          sx = gx + (cx - gx) * along,
          sz = gz + (cz - gz) * along;
        stems.push([
          sx + r * Math.cos(phi),
          gy + y,
          sz + r * Math.sin(phi),
          Math.max(w, tr.b0) * (1 + 0.6 * rnd(n, 7)),
        ]);
      }
      if (th.fire > 0)
        for (let n = 0; n < fireN; n++) {
          // Fire low in the base of the cloud, under the stem: it shrinks and sinks as it burns down.
          const fr = tr.b0 * (0.7 + 0.5 * th.fire),
            phi = rnd(n, 8) * 2 * Math.PI,
            r = fr * Math.sqrt(rnd(n, 9)),
            y = fr * 0.6 * rnd(n, 10) ** 2 * th.fire;
          fires.push([
            gx + r * Math.cos(phi),
            gy + 0.15 * fr + y,
            gz + r * Math.sin(phi),
            fr * (0.25 + 0.25 * rnd(n, 11)) * (0.4 + 0.6 * th.fire),
          ]);
        }
    });
    const put = (
      target: BlastCloudTarget | null,
      id: string,
      puffs: Puff[],
      color: readonly number[],
      opacity: number,
    ): void => {
      if (!target) return;
      if (puffs.length === 0) return place(target, id, {}, null);
      const l = layout(puffs);
      place(
        target,
        id,
        {
          seed: seed * 131 + id.length,
          segments: puffs.length,
          bounds: l.bounds,
          volume: l.volume,
          color: [...color],
          opacity,
          concentrate: 'inside',
          distribute: l.distribute,
        },
        l.box,
      );
    };
    put(clouds, 'cap', caps, o.color ?? [0.06, 0.055, 0.05], 1);
    put(clouds, 'stem', stems, o.stemColor ?? [0.1, 0.075, 0.05], 1);
    const heat = lit.reduce((m, x) => Math.max(m, x.th.fire), 0);
    const fc = o.fireColor ?? [1, 0.42, 0.1];
    put(this.fireTarget, 'fire', fires, fc, Math.min(1, heat * 1.5));
  }

  /** Takes every cloud {@link draw} added out of its `Clouds`. */
  clear(): void {
    for (const [id, c] of this.drawn) (id === 'fire' ? this.fireTarget : this.target)?.remove(c);
    this.drawn.clear();
  }
}
