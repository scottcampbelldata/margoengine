// The craters charges dig in the terrain bed (EARTH-06): each explosion the ExplosionSolver publishes (`${id}:explosions`)
// that goes off in the ground digs a crater sized by `craterSize`, which forms over its formation time and throws its
// ejecta out as a curtain that lands as a blanket, all written to the terrain bed through `bedChange` so the bed's volume
// balances to rounding:
// - The apparent crater: a paraboloid bowl of radius R and depth D, dug at the rate material is launched.
// - The rim: the rest of the crater's volume not thrown or compacted, lifted outside the rim as (R / r)^3 out to 4 R
//   (the structural uplift of Toman's 1970 measured lips).
// - The ejecta: the thrown share in K equal-mass shells, launched from x within the crater at 45 degrees with speed
//   v_R (x / R)^(-e) (Housen and Holsapple 2011's form, as Ryugu's 2022 paper tabulates it), v_R = 0.78 sqrt(g R) at the
//   rim (calibrated to Sedan's ejecta; their impact sets give 0.41), at times T (x / R)^(1 + e) through the formation time T, each landing as an annulus of uniform
//   thickness at x + v^2 / g after its flight sqrt(2) v / g. With e = 3 / (2 (n - 2)) the blanket thins as r^(-n), n 3
//   by default (McGetchin et al. 1973); what lands past the bed's edge leaves the bed and is counted.
// The craters' rows are published as `${id}:craters`: where each is, its size, how far it has formed and its ejecta
// curtain's extent, for renderers and the base-surge solver.
import { pow } from '@margoengine/math/pinned';
import { BED_CHANGE_FIELD, type BedShape, BedChange, bedVertexCount } from '../earth/bed.js';
import { EXPLOSION_WORDS } from '../explosive/solver.js';
import { regionWords } from '../world/memory.js';
import type {
  Cell,
  FieldDescriptor,
  Port,
  RateLevel,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import { craterError } from './errors.js';
import { CRATER_GROUNDS, type CraterGround, checkGround, craterSize } from './law.js';

/** The layout version of the crater rows. */
export const CRATER_LAYOUT = 1;
/**
 * Words of a `craters` row: x, y, z (m), time it formed from (s), radius, depth (m), formation time (s), formed share (0 to
 * 1), the ejecta curtain's inner and outer radius and top height (m), and in cubic metres in place: in flight, landed, left
 * the bed, dug from the bowl; then the shells landed, its state (0 waiting, 1 forming, 2 done), the bowl's volume on the
 * bed, the rim's scale, the rim launch speed (m/s) and the ejecta's kinetic energy (J).
 */
export const CRATER_WORDS = 22;
const W = {
  x: 0,
  y: 1,
  z: 2,
  t0: 3,
  radius: 4,
  depth: 5,
  formation: 6,
  formed: 7,
  inner: 8,
  outer: 9,
  top: 10,
  flight: 11,
  landed: 12,
  offBed: 13,
  dug: 14,
  shells: 15,
  state: 16,
  bowl: 17,
  rim: 18,
  launch: 19,
  kinetic: 20,
  spare: 21,
} as const;
const WAITING = 0;
const FORMING = 1;
const DONE = 2;
/** Words of the ledger: dug, lifted to the rim, compacted, launched, landed, left the bed (m^3 in place), landed bulk (m^3). */
const LEDGER = 7;
const SQRT2 = Math.SQRT2;

/** What a {@link CraterSolver} is made from. */
export interface CraterParams {
  /** The terrain bed's grid: the same shape the TerrainBed was made with. */
  readonly bed: BedShape;
  /** The ground (default {@link CRATER_GROUNDS}.drySoil, desert alluvium). */
  readonly ground?: CraterGround;
  /** The ejecta's equal-mass shells (default 32, 4 to 256). */
  readonly shells?: number;
  /** For film: the craters' size over the law's (default 1, 0.1 to 10), radius and depth alike. */
  readonly size?: number;
  /** For film: the formation time over the law's (default 1, 0.1 to 10). */
  readonly pace?: number;
}

/** What the solver did on its last step, deterministic: craters forming, bed vertices visited, ejecta shells landed. */
export interface CraterWork {
  craters: number;
  vertices: number;
  shells: number;
}

/**
 * Digs craters in the terrain bed where buried charges go off. Reads the explosions field of an ExplosionSolver
 * (`explosions`, default id `'explosion'`), accumulates into `bedChange` and publishes `${id}:craters`.
 */
export class CraterSolver implements Solver<CraterParams> {
  readonly cratersField: FieldDescriptor;
  private readonly explosionsField: FieldDescriptor;
  private host!: SolverHost;
  private shape!: BedShape;
  private ground!: Required<CraterGround>;
  private count = 0;
  private shellCount = 32;
  private size = 1;
  private pace = 1;
  private g = 9.80665;
  private change!: BedChange;
  private rows!: Region;
  private landedShells!: Region;
  private ledger!: Region;
  private capacity = 0;
  private cell: Cell = [0, 0, 0];
  private readonly work: CraterWork = { craters: 0, vertices: 0, shells: 0 };

  /**
   * @param id The solver's id (default `'crater'`).
   * @param explosions The ExplosionSolver's id whose explosions it digs (default `'explosion'`).
   */
  constructor(
    readonly id = 'crater',
    explosions = 'explosion',
  ) {
    this.explosionsField = {
      name: `${explosions}:explosions`,
      kind: 'particleSet',
      quantity: 'explosion source position, time, energy, air and ground energy, scaled depth, gas mass',
      unit: 'm, s, J, m J^-1/3, kg',
      centring: 'particle',
    };
    this.cratersField = {
      name: `${id}:craters`,
      kind: 'particleSet',
      quantity: 'crater position, formation, size, formed share, ejecta curtain and volume ledger',
      unit: 'm, s, m^3, J',
      centring: 'particle',
    };
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: 0 as RateLevel,
      stableRate: () => 0 as RateLevel,
      fields: [
        { field: this.explosionsField, access: 'read' },
        { field: BED_CHANGE_FIELD, access: 'accumulate' },
        { field: this.cratersField, access: 'write' },
      ],
    };
  }

  init(host: SolverHost, params: CraterParams): void {
    if (!params?.bed)
      throw craterError("A CraterSolver needs its terrain bed's grid: world.add(solver, {bed: {...}}).");
    const { columns, rows, width, depth } = params.bed,
      centre = params.bed.centre ?? [0, 0];
    this.shape = { columns, rows, width, depth, centre };
    this.count = bedVertexCount(this.shape);
    const ground = params.ground ?? CRATER_GROUNDS.drySoil;
    checkGround(ground);
    this.ground = { ejected: 0.6, compaction: 0, bulking: 1, blanket: 3, launch: 0.78, ...ground };
    const shells = params.shells ?? 32,
      size = params.size ?? 1,
      pace = params.pace ?? 1;
    if (!(Number.isInteger(shells) && shells >= 4 && shells <= 256))
      throw craterError(`A crater's ejecta shells are a whole number from 4 to 256 (got ${shells}); pass one, or 32.`);
    for (const [name, v] of [
      ['size', size],
      ['pace', pace],
    ] as const)
      if (!(v >= 0.1 && v <= 10))
        throw craterError(`A crater's ${name} is a factor from 0.1 to 10 (got ${v}); pass one, or 1.`);
    this.shellCount = shells;
    this.size = size;
    this.pace = pace;
    const [gx, gy, gz] = host.gravity;
    this.g = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (!(this.g > 0))
      throw craterError('Craters need gravity: the ejecta fall back under it. Give the world gravity.');
    this.host = host;
    this.cell = host.cell;
    this.change = new BedChange(host, this.shape);
    this.ledger = host.allocate('ledger', LEDGER * 8, 'f64', CRATER_LAYOUT);
    this.grow(1);
  }

  /** Room for `n` crater rows (and their shells' flags), keeping what is there. */
  private grow(n: number): void {
    if (n <= this.capacity) return;
    const next = Math.max(n, 2 * this.capacity);
    this.rows = this.rows
      ? this.host.resize(this.rows, next * CRATER_WORDS * 8)
      : this.host.allocate('craters', next * CRATER_WORDS * 8, 'f64', CRATER_LAYOUT);
    this.landedShells = this.landedShells
      ? this.host.resize(this.landedShells, next * this.shellCount)
      : this.host.allocate('landedShells', next * this.shellCount, 'u8', CRATER_LAYOUT);
    this.capacity = next;
  }

  private f64(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }

  /** The vertices within `reach` m of (cx, cz): calls `visit(index, distance)` for each. */
  private around(cx: number, cz: number, reach: number, visit: (i: number, r: number) => void): void {
    const { columns, rows, width, depth, centre } = this.shape,
      x0 = centre[0] - width / 2,
      z0 = centre[1] - depth / 2,
      dx = width / columns,
      dz = depth / rows,
      c0 = Math.max(0, Math.floor((cx - reach - x0) / dx)),
      c1 = Math.min(columns, Math.ceil((cx + reach - x0) / dx)),
      r0 = Math.max(0, Math.floor((cz - reach - z0) / dz)),
      r1 = Math.min(rows, Math.ceil((cz + reach - z0) / dz));
    for (let c = c0; c <= c1; c++)
      for (let r = r0; r <= r1; r++) {
        const px = x0 + dx * c - cx,
          pz = z0 + dz * r - cz,
          d = Math.sqrt(px * px + pz * pz);
        this.work.vertices++;
        if (d <= reach) visit(r + (rows + 1) * c, d);
      }
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    this.work.craters = 0;
    this.work.vertices = 0;
    this.work.shells = 0;
    this.change.clear();
    const port = context.inputs.get(this.explosionsField.name);
    if (!port) return;
    if (port.cell.some((v, k) => v !== context.cell[k]))
      throw craterError(
        `The explosions are in origin cell ${port.cell} and the craters' bed in ${context.cell}; keep the ExplosionSolver and the CraterSolver in one cell.`,
        'state',
      );
    const source = regionWords(this.host.memory, port.region) as Float64Array,
      n = Math.floor(source.length / EXPLOSION_WORDS);
    this.grow(n);
    const time = (context.tick + 1) * dt,
      rows = this.f64(this.rows),
      area = this.change.area,
      { ejected, compaction, bulking, blanket, density } = this.ground,
      e = 3 / (2 * (blanket - 2)),
      K = this.shellCount;
    for (let i = 0; i < n; i++) {
      const o = i * CRATER_WORDS,
        s = i * EXPLOSION_WORDS;
      if (rows[o + W.state] === WAITING && source[s + 9] === 1 && source[s + 3]! <= time) {
        const energy = source[s + 4]!,
          ground = source[s + 6]!,
          depth = source[s + 7]! * pow(energy, 1 / 3);
        // A charge in the air (no ground share) digs nothing.
        const size = ground > 0 ? craterSize(energy, depth, this.ground, this.g) : null;
        rows[o + W.x] = source[s]!;
        rows[o + W.y] = source[s + 1]!;
        rows[o + W.z] = source[s + 2]!;
        rows[o + W.t0] = source[s + 3]!;
        if (!size || size.volume === 0) {
          rows[o + W.state] = DONE;
          continue;
        }
        const R = size.radius * this.size,
          D = size.depth * this.size,
          cx = rows[o + W.x]!,
          cz = rows[o + W.z]!;
        let bowl = 0,
          lift = 0;
        this.around(cx, cz, R, (v, r) => {
          bowl += D * (1 - (r / R) * (r / R)) * area[v]!;
        });
        this.around(cx, cz, 4 * R, (v, r) => {
          if (r >= R) lift += ((R * R * R) / (r * r * r)) * area[v]!;
        });
        rows[o + W.radius] = R;
        rows[o + W.depth] = D;
        rows[o + W.formation] = size.formation * this.pace * Math.sqrt(this.size);
        rows[o + W.bowl] = bowl;
        rows[o + W.rim] = lift > 0 ? ((1 - ejected - compaction) * bowl) / lift : 0;
        rows[o + W.launch] = this.ground.launch * Math.sqrt(this.g * R);
        // The ejecta's kinetic energy: each shell's mass at its middle launch speed.
        let kinetic = 0;
        for (let k = 0; k < K; k++) {
          const v = rows[o + W.launch]! * pow((k + 0.5) / K, -e / 3);
          kinetic += 0.5 * ((density * ejected * bowl) / K) * v * v;
        }
        rows[o + W.kinetic] = kinetic;
        rows[o + W.state] = bowl > 0 ? FORMING : DONE;
      }
      if (rows[o + W.state] !== FORMING) continue;
      this.form(i, time - rows[o + W.t0]!, rows, area, e, K, ejected, compaction, bulking);
    }
  }

  /** Advances crater `i` to age `age` s: digs and lifts its share formed since last step, lands the shells due. */
  private form(
    i: number,
    age: number,
    rows: Float64Array,
    area: Float64Array,
    e: number,
    K: number,
    ejected: number,
    compaction: number,
    bulking: number,
  ): void {
    this.work.craters++;
    const o = i * CRATER_WORDS,
      R = rows[o + W.radius]!,
      D = rows[o + W.depth]!,
      T = rows[o + W.formation]!,
      cx = rows[o + W.x]!,
      cz = rows[o + W.z]!,
      bowl = rows[o + W.bowl]!,
      vR = rows[o + W.launch]!,
      g = this.g,
      deltas = this.change.deltas,
      ledger = this.f64(this.ledger),
      flags = regionWords(this.host.memory, this.landedShells) as Uint8Array,
      // The share formed: the mass launched inside x(t), x ~ t^(1 / (1 + e)).
      formed = Math.min(1, pow(Math.max(0, age) / T, 3 / (1 + e))),
      step = formed - rows[o + W.formed]!;
    if (step > 0) {
      const rim = rows[o + W.rim]!;
      this.around(cx, cz, 4 * R, (v, r) => {
        deltas[v] = deltas[v]! + step * (r < R ? -D * (1 - (r / R) * (r / R)) : rim * ((R * R * R) / (r * r * r)));
      });
      rows[o + W.formed] = formed;
      rows[o + W.dug] = rows[o + W.dug]! + step * bowl;
      ledger[0] = ledger[0]! + step * bowl;
      ledger[1] = ledger[1]! + step * (1 - ejected - compaction) * bowl;
      ledger[2] = ledger[2]! + step * compaction * bowl;
      ledger[3] = ledger[3]! + step * ejected * bowl;
    }
    // The shells: launched from x at T (x / R)^(1 + e), landing after sqrt(2) v / g at x + v^2 / g.
    const shell = (ejected * bowl) / K,
      { width, depth, columns, rows: bedRows } = this.shape,
      cellDiagonal = Math.sqrt((width / columns) * (width / columns) + (depth / bedRows) * (depth / bedRows)),
      speed = (x: number) => (x > 0 ? vR * pow(x / R, -e) : Number.POSITIVE_INFINITY),
      landAt = (x: number) => x + (speed(x) * speed(x)) / g;
    let inner = Number.POSITIVE_INFINITY,
      outer = 0,
      top = 0;
    for (let k = 0; k < K; k++) {
      if (flags[i * K + k]) continue;
      const xIn = R * pow(k / K, 1 / 3),
        xOut = R * pow((k + 1) / K, 1 / 3),
        xMid = R * pow((k + 0.5) / K, 1 / 3),
        v = speed(xMid),
        launch = T * pow(xMid / R, 1 + e),
        flight = (SQRT2 * v) / g;
      if (age < launch) continue;
      if (age < launch + flight) {
        // In flight: its place on the 45 degree path.
        const s = age - launch,
          across = xMid + (v / SQRT2) * s;
        inner = Math.min(inner, across);
        outer = Math.max(outer, across);
        top = Math.max(top, (v / SQRT2) * s - 0.5 * g * s * s);
        continue;
      }
      // Landed: on the annulus between the outer edge's landing and the inner edge's, at least a cell wide.
      let from = landAt(xOut),
        to = landAt(xIn);
      if (Number.isFinite(to) && to - from < cellDiagonal) {
        const mid = 0.5 * (from + to);
        from = Math.max(0, mid - cellDiagonal / 2);
        to = mid + cellDiagonal / 2;
      }
      let onBed = 0;
      const reach = Number.isFinite(to) ? to : Math.sqrt(width * width + depth * depth) + Math.sqrt(cx * cx + cz * cz);
      this.around(cx, cz, reach, (vtx, r) => {
        if (r >= from && r < to) onBed += area[vtx]!;
      });
      const annulus = Math.PI * (to * to - from * from),
        share = Number.isFinite(annulus) && annulus > 0 ? Math.min(1, onBed / annulus) : 0;
      if (onBed > 0 && share > 0) {
        const thickness = (shell * share * bulking) / onBed;
        this.around(cx, cz, reach, (vtx, r) => {
          if (r >= from && r < to) deltas[vtx] = deltas[vtx]! + thickness;
        });
      }
      flags[i * K + k] = 1;
      this.work.shells++;
      rows[o + W.shells] = rows[o + W.shells]! + 1;
      rows[o + W.landed] = rows[o + W.landed]! + shell * share;
      rows[o + W.offBed] = rows[o + W.offBed]! + shell * (1 - share);
      ledger[4] = ledger[4]! + shell * share;
      ledger[5] = ledger[5]! + shell * (1 - share);
      ledger[6] = ledger[6]! + shell * share * bulking;
    }
    rows[o + W.inner] = Number.isFinite(inner) ? inner : 0;
    rows[o + W.outer] = outer;
    rows[o + W.top] = top;
    rows[o + W.flight] = ejected * bowl * formed - rows[o + W.landed]! - rows[o + W.offBed]!;
    if (formed >= 1 && rows[o + W.shells] === K) rows[o + W.state] = DONE;
  }

  exportPorts(tick: number): readonly Port[] {
    return [
      this.change.port(tick, this.cell),
      { field: this.cratersField.name, region: this.rows, tick, cell: this.cell },
    ];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.rows, this.landedShells, this.ledger, this.change.state];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Crater `i`'s row (the explosion's index): its words as {@link CRATER_WORDS} describes them. */
  crater(i: number): {
    position: [number, number, number];
    time: number;
    radius: number;
    depth: number;
    formation: number;
    formed: number;
    curtain: { inner: number; outer: number; top: number };
    volumes: { dug: number; flight: number; landed: number; offBed: number };
    kinetic: number;
    state: 'waiting' | 'forming' | 'done';
  } {
    if (!(Number.isInteger(i) && i >= 0 && i < this.capacity))
      throw craterError(`No crater row ${i}: rows run from 0 to ${this.capacity - 1}, one per explosion.`, 'state');
    const r = this.f64(this.rows).subarray(i * CRATER_WORDS, (i + 1) * CRATER_WORDS);
    return {
      position: [r[W.x]!, r[W.y]!, r[W.z]!],
      time: r[W.t0]!,
      radius: r[W.radius]!,
      depth: r[W.depth]!,
      formation: r[W.formation]!,
      formed: r[W.formed]!,
      curtain: { inner: r[W.inner]!, outer: r[W.outer]!, top: r[W.top]! },
      volumes: { dug: r[W.dug]!, flight: r[W.flight]!, landed: r[W.landed]!, offBed: r[W.offBed]! },
      kinetic: r[W.kinetic]!,
      state: r[W.state] === WAITING ? 'waiting' : r[W.state] === FORMING ? 'forming' : 'done',
    };
  }

  /**
   * The volume ledger, m^3 in place: dug from the bowls, lifted to the rims, compacted, launched, landed on the bed, left
   * the bed; and the landed ejecta's bulk volume. Dug = lifted + compacted + launched, and launched = landed + left + in flight.
   */
  ledgerTotals(): {
    dug: number;
    lifted: number;
    compacted: number;
    launched: number;
    landed: number;
    offBed: number;
    landedBulk: number;
  } {
    const l = this.f64(this.ledger);
    return {
      dug: l[0]!,
      lifted: l[1]!,
      compacted: l[2]!,
      launched: l[3]!,
      landed: l[4]!,
      offBed: l[5]!,
      landedBulk: l[6]!,
    };
  }

  /** The last step's work: craters forming, bed vertices visited, ejecta shells landed. */
  workCounts(): CraterWork {
    return { ...this.work };
  }
}
