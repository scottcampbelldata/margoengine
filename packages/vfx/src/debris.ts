// Ballistic debris over film time (entry `@margoengine/vfx/debris`): earth clods, rock blocks and timber thrown out by
// an explosion or an impact, flying on drag-slowed paths, tumbling, landing and raising a puff of dust where each lands.
// Every output is a function of the film time and the seed: each piece's path is solved once when the Debris is made
// (fourth-order Runge-Kutta, 1/60 s steps, read back by cubic Hermite interpolation of position and velocity), so a seek,
// a re-render or a frame rendered out of order shows the same pieces. Sources (papers, read as text; no code;
// docs/clean-room.md "Ballistic debris"):
// - L. G. Mastin, "A simple calculator of ballistic trajectories for blocks ejected during volcanic eruptions", USGS
//   Open-File Report 01-45, 2001, https://pubs.usgs.gov/of/2001/0045/: a block on a ballistic path through still air
//   decelerated by the drag 1/2 rho_a Cd A v^2, with Cd about 1 for rough blocks at these Reynolds numbers.
// - K. R. Housen, R. M. Schmidt and K. A. Holsapple, "Crater ejecta scaling laws: fundamental forms based on
//   dimensional analysis", J. Geophys. Res. 88(B3), 2485-2499, 1983, https://doi.org/10.1029/JB088iB03p02485; K. R.
//   Housen and K. A. Holsapple, "Ejecta from impact craters", Icarus 211, 856-875, 2011,
//   https://doi.org/10.1016/j.icarus.2010.09.017: ejecta leave the ground at a speed falling as a power of the launch
//   point's distance from the centre, v proportional to (x / R)^(-1/mu), mu about 0.41 for dry sand and soil, at a
//   launch angle near 45 degrees.
// - S. Glasstone and P. J. Dolan, "The Effects of Nuclear Weapons", 3rd ed., 1977, ch. 2 and 6: the throw-out of a
//   buried burst falls back around the crater as its ejecta; the dust it raises where it lands.
// The dust puff of a landing grows as the cube root of its age (a model choice, the spreading of a small thermal of
// fixed energy) to a size set by the piece's kinetic energy at impact, and fades over `puffLife`.
import { lowbias32 } from './hash.js';
import { filmTime } from '../../shared/film-time.js';

/** What {@link Debris.draw} writes into: a gltf `PBRInstances` (mesh.instances) fits. */
export interface DebrisInstanceTarget {
  readonly capacity: number;
  count: number;
  setMatrixAt(i: number, m: ArrayLike<number>): unknown;
  setColorAt?(i: number, color: ArrayLike<number>): unknown;
}

/** What {@link Debris.drawPuffs} draws into: a `Clouds` of `@margoengine/vfx/clouds` fits. */
export interface DebrisPuffTarget {
  add(options: object): { readonly options: object; readonly matrix: Float32Array };
  remove(cloud: object): boolean;
}

/** Options of {@link Debris}. Every field has a documented default; the constructor checks the ranges. */
export interface DebrisOptions {
  /** World centre of the throw (the crater's centre on the ground), [x, y, z] metres. Default [0, 0, 0]. */
  origin?: readonly [number, number, number];
  /** Radius the pieces are launched from, metres above 0 (the crater's). Default 30. */
  radius?: number;
  /** Pieces, 1 to 20,000. Default 300. */
  count?: number;
  /** Film seconds the throw starts. Default 0. */
  start?: number;
  /** Seconds over which the pieces leave, inner first, 0 to 30. Default 1.5. */
  spread?: number;
  /** Launch speed at the rim, m/s, 1 to 1,000. Default 40. */
  speed?: number;
  /** Fastest launch speed (the inner pieces), m/s, at least `speed`, at most 2,000. Default 4 times `speed`. */
  maxSpeed?: number;
  /** Ejecta exponent mu of v proportional to (x / R)^(-1/mu) (Housen and Holsapple 2011), 0.2 to 0.7. Default 0.41. */
  mu?: number;
  /** Mean launch angle above the horizon, degrees, 10 to 90. Default 50. */
  angle?: number;
  /** Spread of the launch angle, degrees, 0 to 40. Default 12. */
  angleSpread?: number;
  /** Smallest and largest piece size (edge length), metres, each above 0. Default [0.2, 1.2]. */
  size?: readonly [number, number];
  /** Piece density, kg/m^3, 100 to 5,000. Default 1,800 (moist earth; 2,300 gypsum, 600 timber). */
  density?: number;
  /** Drag coefficient, 0 to 3 (Mastin 2001). Default 1. */
  drag?: number;
  /** Air density, kg/m^3, 0 to 2. Default 1.2. */
  airDensity?: number;
  /** Ground height under a world point; pieces land on it. Default flat at the origin's height. */
  ground?: (x: number, z: number) => number;
  /** Tumble rate, radians a second at most, 0 to 100. Default 6. */
  tumble?: number;
  /** Colour of the pieces, linear RGB 0 to 1, multiplied with each piece's shade. Default [0.22, 0.16, 0.1]. */
  color?: readonly [number, number, number];
  /** Seconds a landing puff lasts, 0 to 60 (0: no puffs). Default 6. */
  puffLife?: number;
  /** Colour of the landing dust, linear RGB 0 to 1. Default [0.36, 0.3, 0.23]. */
  puffColor?: readonly [number, number, number];
  /** Puff size per cube root of impact energy, metres per J^(1/3), 0 to 1. Default 0.04. */
  puffScale?: number;
  /** Seed of the pieces, an integer. Default 1. */
  seed?: number;
}

/** One piece at a film time, from {@link Debris.pieces}. */
export interface DebrisPiece {
  readonly position: readonly [number, number, number];
  readonly velocity: readonly [number, number, number];
  /** Edge length, metres. */
  readonly size: number;
  /** 'waiting' before it leaves, 'flying', or 'landed'. */
  readonly state: 'waiting' | 'flying' | 'landed';
  /** Film seconds it leaves the ground. */
  readonly launch: number;
  /** Film seconds it lands (Infinity if it never does within 120 s). */
  readonly landing: number;
}

const G = 9.80665;
const DT = 1 / 60;
const MAX_FLIGHT = 120;

const bad = (message: string): never => {
  throw new RangeError(`Debris option out of range; ${message}`);
};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** lowbias32 as a number in [0, 1). */
const hash = (x: number): number => lowbias32(x) / 4294967296;

const RANGES: Record<string, readonly [number, number]> = {
  radius: [1e-3, 1e5],
  count: [1, 20000],
  start: [0, 1e9],
  spread: [0, 30],
  speed: [1, 1000],
  maxSpeed: [1, 2000],
  mu: [0.2, 0.7],
  angle: [10, 90],
  angleSpread: [0, 40],
  density: [100, 5000],
  drag: [0, 3],
  airDensity: [0, 2],
  tumble: [0, 100],
  puffLife: [0, 60],
  puffScale: [0, 1],
};

interface Path {
  readonly launch: number;
  readonly size: number;
  readonly mass: number;
  readonly shade: number;
  readonly axis: readonly [number, number, number];
  readonly spin: number;
  /** Per step: x, y, z, vx, vy, vz. */
  readonly rows: Float64Array;
  /** Seconds of flight to landing. */
  readonly flight: number;
  readonly impact: number;
}

/**
 * Ballistic debris of an explosion or impact over film time: `count` pieces launched from within `radius` of `origin`,
 * the inner ones first and fastest (Housen and Holsapple 2011), flying through drag (Mastin 2001), tumbling, and landing
 * on `ground` with a dust puff. `draw(instances)` writes the pieces into a gltf `PBRInstances` (any mesh: a clod, a
 * block, a plank); `drawPuffs(clouds)` puts the landing dust into a `Clouds` of `@margoengine/vfx/clouds`.
 */
export class Debris {
  readonly options: Readonly<DebrisOptions>;
  private readonly paths: Path[];
  private film = 0;
  private puff: { readonly options: object; readonly matrix: Float32Array } | null = null;
  private puffTarget: DebrisPuffTarget | null = null;

  constructor(options: DebrisOptions = {}) {
    if (typeof options !== 'object' || options === null)
      throw new TypeError('Debris options must be an object; pass {} or leave it out.');
    const o = options as Record<string, unknown>;
    for (const [key, [lo, hi]] of Object.entries(RANGES))
      if (o[key] !== undefined && (!finite(o[key]) || (o[key] as number) < lo || (o[key] as number) > hi))
        bad(`${key} must be a number from ${lo} to ${hi}.`);
    for (const key of ['color', 'puffColor'])
      if (o[key] !== undefined) {
        const c = o[key];
        if (!Array.isArray(c) || c.length !== 3 || !c.every((v) => finite(v) && v >= 0 && v <= 1))
          bad(`${key} must be three linear RGB numbers from 0 to 1.`);
      }
    if (o.origin !== undefined && (!Array.isArray(o.origin) || o.origin.length !== 3 || !o.origin.every(finite)))
      throw new TypeError('Debris origin must be three numbers; pass [x, y, z].');
    if (
      o.size !== undefined &&
      (!Array.isArray(o.size) ||
        o.size.length !== 2 ||
        !o.size.every((v) => finite(v) && v > 0) ||
        o.size[0] > o.size[1])
    )
      bad('size must be [smallest, largest], each above 0.');
    if (o.count !== undefined && !Number.isInteger(o.count)) bad('count must be a whole number.');
    if (o.seed !== undefined && !Number.isInteger(o.seed)) bad('seed must be an integer.');
    if (o.ground !== undefined && typeof o.ground !== 'function')
      throw new TypeError('Debris ground must be a function; pass (x, z) => height.');
    const speed = options.speed ?? 40,
      maxSpeed = options.maxSpeed ?? Math.min(4 * speed, 2000);
    if (maxSpeed < speed) bad('maxSpeed must be at least speed.');
    this.options = options;
    const [ox, oy, oz] = options.origin ?? [0, 0, 0],
      R = options.radius ?? 30,
      n = options.count ?? 300,
      seed = options.seed ?? 1,
      mu = options.mu ?? 0.41,
      angle = ((options.angle ?? 50) * Math.PI) / 180,
      angleSpread = ((options.angleSpread ?? 12) * Math.PI) / 180,
      [s0, s1] = options.size ?? [0.2, 1.2],
      rho = options.density ?? 1800,
      cd = options.drag ?? 1,
      air = options.airDensity ?? 1.2,
      ground = options.ground ?? (() => oy),
      start = options.start ?? 0,
      spread = options.spread ?? 1.5,
      tumble = options.tumble ?? 6;
    const rnd = (i: number, c: number) =>
      hash((Math.imul(seed, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b) ^ Math.imul(c + 1, 0xc2b2ae35)) >>> 0);
    this.paths = [];
    for (let i = 0; i < n; i++) {
      // Launch point uniform over the disc, its speed by the ejecta power law, capped at maxSpeed.
      const x = R * Math.sqrt(Math.max(rnd(i, 0), 1e-6)),
        phi = rnd(i, 1) * 2 * Math.PI,
        v = Math.min(speed * (x / R) ** (-1 / mu), maxSpeed),
        el = Math.min(Math.max(angle + angleSpread * (rnd(i, 2) + rnd(i, 3) - 1), 0.05), Math.PI / 2),
        // Sizes spread log-uniformly: many small pieces, few big.
        size = s0 * (s1 / s0) ** rnd(i, 4),
        mass = rho * size ** 3,
        k = (0.5 * air * cd * size * size) / mass,
        px = ox + x * Math.cos(phi),
        pz = oz + x * Math.sin(phi);
      const launch = start + spread * (x / R) ** 2 * (0.8 + 0.2 * rnd(i, 5));
      let st = [
        px,
        ground(px, pz),
        pz,
        v * Math.cos(el) * Math.cos(phi),
        v * Math.sin(el),
        v * Math.cos(el) * Math.sin(phi),
      ];
      const rows: number[] = [...st];
      const f = (s: number[]): number[] => {
        const sp = Math.hypot(s[3]!, s[4]!, s[5]!);
        return [s[3]!, s[4]!, s[5]!, -k * sp * s[3]!, -G - k * sp * s[4]!, -k * sp * s[5]!];
      };
      let flight = Infinity,
        impact = 0;
      for (let step = 1; step * DT <= MAX_FLIGHT; step++) {
        const a = f(st),
          b = f(st.map((v, j) => v + 0.5 * DT * a[j]!)),
          c = f(st.map((v, j) => v + 0.5 * DT * b[j]!)),
          d = f(st.map((v, j) => v + DT * c[j]!));
        const next = st.map((v, j) => v + (DT / 6) * (a[j]! + 2 * b[j]! + 2 * c[j]! + d[j]!));
        const below = next[1]! - ground(next[0]!, next[2]!);
        if (next[4]! < 0 && below <= 0) {
          // Land between the steps where the height above the ground crosses 0.
          const above = st[1]! - ground(st[0]!, st[2]!),
            u = above / Math.max(above - below, 1e-12);
          const hit = st.map((v, j) => v + (next[j]! - v) * u);
          hit[1] = ground(hit[0]!, hit[2]!);
          rows.push(...hit);
          flight = (step - 1 + u) * DT;
          impact = 0.5 * mass * (hit[3]! ** 2 + hit[4]! ** 2 + hit[5]! ** 2);
          break;
        }
        rows.push(...next);
        st = next;
      }
      const ax = rnd(i, 6) * 2 - 1,
        ay = rnd(i, 7) * 2 - 1,
        az = rnd(i, 8) * 2 - 1,
        al = Math.hypot(ax, ay, az) || 1;
      this.paths.push({
        launch,
        size,
        mass,
        shade: 0.7 + 0.6 * rnd(i, 9),
        axis: [ax / al, ay / al, az / al],
        spin: tumble * (0.3 + 0.7 * rnd(i, 10)),
        rows: Float64Array.from(rows),
        flight,
        impact,
      });
    }
  }

  /** Film time now, seconds. */
  get time(): number {
    return this.film;
  }
  /** Sets the film time; the debris is a function of it alone. */
  seek(t: number): void {
    this.film = filmTime(t, bad, 'seek time');
  }
  /** Moves the film time on by `delta` seconds. */
  update(delta: number): void {
    this.film += filmTime(delta, bad, 'update delta');
  }

  private at(p: Path, t: number): { pos: number[]; vel: number[]; state: DebrisPiece['state']; age: number } {
    const age = t - p.launch,
      last = p.rows.length / 6 - 1;
    if (age < 0) return { pos: [p.rows[0]!, p.rows[1]!, p.rows[2]!], vel: [0, 0, 0], state: 'waiting', age };
    if (age >= p.flight) {
      const r = last * 6;
      return { pos: [p.rows[r]!, p.rows[r + 1]!, p.rows[r + 2]!], vel: [0, 0, 0], state: 'landed', age };
    }
    // Cubic Hermite between the stored steps (the landing row is a partial step; flight caps it).
    const f = age / DT,
      i = Math.min(Math.floor(f), last - 1),
      h = Math.min((i + 1) * DT, p.flight) - i * DT,
      u = (age - i * DT) / h,
      a = i * 6,
      b = (i + 1) * 6,
      h00 = 2 * u ** 3 - 3 * u ** 2 + 1,
      h10 = u ** 3 - 2 * u ** 2 + u,
      h01 = -2 * u ** 3 + 3 * u ** 2,
      h11 = u ** 3 - u ** 2,
      pos = [0, 1, 2].map(
        (c) =>
          h00 * p.rows[a + c]! + h10 * h * p.rows[a + 3 + c]! + h01 * p.rows[b + c]! + h11 * h * p.rows[b + 3 + c]!,
      ),
      vel = [3, 4, 5].map((c) => p.rows[a + c]! * (1 - u) + p.rows[b + c]! * u);
    return { pos, vel, state: 'flying', age };
  }

  /** Every piece at film time `t` (default now). */
  pieces(t = this.film): DebrisPiece[] {
    return this.paths.map((p) => {
      const s = this.at(p, t);
      return {
        position: s.pos as [number, number, number],
        velocity: s.vel as [number, number, number],
        size: p.size,
        state: s.state,
        launch: p.launch,
        landing: p.launch + p.flight,
      };
    });
  }

  /**
   * Writes the flying and landed pieces into `target` (a gltf `PBRInstances` of a unit-sized mesh: each instance is
   * scaled to its piece's size, turned by its tumble and tinted by `color` times its shade). Returns the count written.
   */
  draw(target: DebrisInstanceTarget): number {
    const color = this.options.color ?? [0.22, 0.16, 0.1],
      m = new Float32Array(16),
      tint = new Float32Array(3);
    let n = 0;
    for (const p of this.paths) {
      if (n >= target.capacity) break;
      const s = this.at(p, this.film);
      if (s.state === 'waiting') continue;
      const angle = p.spin * Math.min(Math.max(s.age, 0), p.flight),
        [x, y, z] = p.axis,
        c = Math.cos(angle),
        si = Math.sin(angle),
        t = 1 - c,
        k = p.size;
      // Rotation about the tumble axis (Rodrigues), scaled by the size, column-major; a landed piece sits half sunk.
      m.set([
        (t * x * x + c) * k,
        (t * x * y + si * z) * k,
        (t * x * z - si * y) * k,
        0,
        (t * x * y - si * z) * k,
        (t * y * y + c) * k,
        (t * y * z + si * x) * k,
        0,
        (t * x * z + si * y) * k,
        (t * y * z - si * x) * k,
        (t * z * z + c) * k,
        0,
        s.pos[0]!,
        s.pos[1]! + (s.state === 'landed' ? 0.25 * k : 0),
        s.pos[2]!,
        1,
      ]);
      target.setMatrixAt(n, m);
      if (target.setColorAt) {
        tint[0] = Math.min(1, color[0] * p.shade);
        tint[1] = Math.min(1, color[1] * p.shade);
        tint[2] = Math.min(1, color[2] * p.shade);
        target.setColorAt(n, tint);
      }
      n++;
    }
    target.count = n;
    return n;
  }

  /** The landing puffs alive at film time `t` (default now): centre, size (metres across) and opacity 0 to 1. */
  puffs(t = this.film): { centre: [number, number, number]; size: number; opacity: number }[] {
    const life = this.options.puffLife ?? 6,
      scale = this.options.puffScale ?? 0.04,
      out: { centre: [number, number, number]; size: number; opacity: number }[] = [];
    if (life === 0 || scale === 0) return out;
    for (const p of this.paths) {
      const age = t - p.launch - p.flight;
      if (!(age >= 0 && age < life)) continue;
      const full = scale * Math.cbrt(p.impact),
        size = full * Math.cbrt(Math.max(age / life, 1e-3)) + p.size,
        r = (p.rows.length / 6 - 1) * 6;
      out.push({
        centre: [p.rows[r]!, p.rows[r + 1]! + 0.3 * size, p.rows[r + 2]!],
        size,
        opacity: (1 - age / life) ** 2,
      });
    }
    return out;
  }

  /** Puts the landing puffs into `clouds` (a `Clouds` of `@margoengine/vfx/clouds`) as one cloud. */
  drawPuffs(clouds: DebrisPuffTarget): void {
    if (this.puffTarget && this.puffTarget !== clouds) this.clearPuffs();
    this.puffTarget = clouds;
    const list = this.puffs();
    if (!list.length) {
      if (this.puff) {
        clouds.remove(this.puff);
        this.puff = null;
      }
      return;
    }
    let x0 = Infinity,
      y0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      z1 = -Infinity,
      big = 0,
      fade = 0;
    for (const p of list) {
      x0 = Math.min(x0, p.centre[0]);
      x1 = Math.max(x1, p.centre[0]);
      y0 = Math.min(y0, p.centre[1]);
      y1 = Math.max(y1, p.centre[1]);
      z0 = Math.min(z0, p.centre[2]);
      z1 = Math.max(z1, p.centre[2]);
      big = Math.max(big, p.size);
      fade += p.opacity;
    }
    const cx = 0.5 * (x0 + x1),
      cy = 0.5 * (y0 + y1),
      cz = 0.5 * (z0 + z1),
      bounds: [number, number, number] = [Math.max(x1 - x0, 1e-3), Math.max(y1 - y0, 1e-3), Math.max(z1 - z0, 1e-3)];
    const options: Record<string, unknown> = {
      seed: this.options.seed ?? 1,
      segments: list.length,
      bounds,
      volume: big,
      color: [...(this.options.puffColor ?? [0.36, 0.3, 0.23])],
      // One opacity per cloud: the mean of the puffs' (each puff's own fade shows as its shrinking share of the size).
      opacity: Math.min(1, fade / list.length),
      distribute: (i: number) => {
        const p = list[i]!;
        return {
          point: [
            ((p.centre[0] - cx) * 2) / bounds[0],
            ((p.centre[1] - cy) * 2) / bounds[1],
            ((p.centre[2] - cz) * 2) / bounds[2],
          ],
          volume: (p.size / big) * (0.4 + 0.6 * p.opacity),
        };
      },
    };
    if (!this.puff) this.puff = clouds.add(options);
    else Object.assign(this.puff.options, options);
    const m = this.puff.matrix;
    m.fill(0);
    m[0] = m[5] = m[10] = m[15] = 1;
    m[12] = cx;
    m[13] = cy;
    m[14] = cz;
  }

  /** Takes the puff cloud {@link drawPuffs} added out of its `Clouds`. */
  clearPuffs(): void {
    if (this.puff) this.puffTarget?.remove(this.puff);
    this.puff = null;
  }
}
