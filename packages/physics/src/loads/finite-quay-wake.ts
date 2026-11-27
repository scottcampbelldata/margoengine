import type { SeaSurface, SeaSurfaceSample } from '@margoengine/math/fields';
import { cos, exp } from '@margoengine/math/pinned';
import {
  SUBMERGED_WAKE_LAYOUT,
  SUBMERGED_WAKE_QUANTITY,
  SUBMERGED_WAKE_WORDS,
  type SubmergedWakeSource,
  wakeDepths,
} from '../sea/submerged-wake.js';
import { WAKE_LAYOUT, WAKE_SOURCE_LAYOUT, WAKE_SOURCE_WORDS, type WakeSample } from '../sea/wake.js';
import { regionWords } from '../world/memory.js';
import type {
  FieldDescriptor,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import { invalidLoad } from './errors.js';
import { QuayPotential, type QuayPotentialGrid } from './quay-potential.js';

/** Finite wave tank with solid cells and partially open faces. All lengths are in metres. */
export interface FiniteQuayWakeParams extends QuayPotentialGrid {
  /** Minimum X and Z corners of the cell-centred grid in the world's cell. */
  readonly origin?: readonly [number, number];
  /** Water density in kg/m³. Default 1025. */
  readonly density?: number;
  /** Initial surface elevation and potential at a wet cell centre. Default still water. */
  readonly initial?: (x: number, z: number) => readonly [number, number];
  /** Optional perimeter elevation absorber. `rate` is the maximum decay in s⁻¹. */
  readonly sponge?: { readonly cells: number; readonly rate: number };
  /** Retain the time-centred Bernoulli pressure throughout the water volume. Default false. */
  readonly pressureAtDepth?: boolean;
}

/** A bounded 3D linear potential wake. Sources, wave work and the wet surface use the same finite geometry. */
export class FiniteQuayWake implements Solver<FiniteQuayWakeParams> {
  readonly heightField: FieldDescriptor;
  private readonly sourceField?: FieldDescriptor;
  private readonly submerged?: SubmergedWakeSource;
  private host!: SolverHost;
  private operator!: QuayPotential;
  private regions!: [Region, Region, Region, Region, Region];
  private pressureHead?: Region;
  private shape!: { cells: readonly [number, number]; cellSize: number; origin: readonly [number, number] };
  private depths!: readonly number[];
  private rho = 1025;
  private g = 9.81;
  private kick!: Float64Array;
  private bulkKick!: Float64Array;
  private rise!: Float64Array;
  private mid!: Float64Array;
  private nextHeight!: Float64Array;
  private nextBulk!: Float64Array;
  private forcingPressure!: Float64Array;
  private sponge?: Float64Array;

  constructor(
    readonly id = 'finiteQuayWake',
    sources: { readonly surface?: FieldDescriptor; readonly submerged?: SubmergedWakeSource } = {},
  ) {
    if (sources.surface && (sources.surface.quantity !== 'seaSource' || sources.surface.unit !== 'SI'))
      throw invalidLoad('Supply the layout-1 surface wake source in SI units.');
    if (
      sources.submerged &&
      (sources.submerged.field.quantity !== SUBMERGED_WAKE_QUANTITY || sources.submerged.field.unit !== 'SI')
    )
      throw invalidLoad('Supply the layout-1 submerged wake source and its depth bands in SI units.');
    this.sourceField = sources.surface;
    this.submerged = sources.submerged && {
      field: sources.submerged.field,
      depths: wakeDepths(sources.submerged.depths),
    };
    this.heightField = Object.freeze({
      name: `${id}.height`,
      kind: 'heightfield',
      quantity: 'height',
      unit: 'm',
      centring: 'cell',
    });
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: this.heightField, access: 'write' },
        ...(this.sourceField ? [{ field: this.sourceField, access: 'read' as const }] : []),
        ...(this.submerged ? [{ field: this.submerged.field, access: 'read' as const }] : []),
      ],
    };
  }

  init(host: SolverHost, params: FiniteQuayWakeParams): void {
    if (!params) throw invalidLoad('Pass the finite quay grid and depth faces.');
    const { cells, cellSize, depths, origin = [0, 0], density = 1025, initial, sponge, pressureAtDepth } = params;
    const [gx, gy, gz] = host.gravity;
    if (
      gx !== 0 ||
      gz !== 0 ||
      !(gy < 0) ||
      !Number.isFinite(gy) ||
      !(density > 0 && Number.isFinite(density)) ||
      origin.length !== 2 ||
      !origin.every(Number.isFinite)
    )
      throw invalidLoad('Use downward Y gravity, positive water density and a finite XZ origin.');
    const operator = new QuayPotential(params);
    if (
      sponge &&
      (!Number.isInteger(sponge.cells) ||
        sponge.cells < 1 ||
        2 * sponge.cells >= Math.min(...cells) ||
        !(sponge.rate > 0 && Number.isFinite(sponge.rate)))
    )
      throw invalidLoad('Use a positive sponge rate and leave an undamped interior larger than both perimeter bands.');
    if (this.submerged && this.submerged.depths.at(-1)! > depths.at(-1)!)
      throw invalidLoad('End the submerged source bands above the finite quay’s bed.');
    this.operator = operator;
    this.shape = Object.freeze({
      cells: Object.freeze([...cells] as const),
      cellSize,
      origin: Object.freeze([...origin] as const),
    });
    this.depths = [...depths];
    this.rho = density;
    this.g = -gy;
    this.host = host;
    const { surfaceCells, volumeCells } = operator;
    const allocate = (label: string, count: number) =>
      host.allocate(`${this.id}:${label}`, count * 8, 'f64', WAKE_LAYOUT);
    this.regions = [
      allocate('height', surfaceCells),
      allocate('surfacePotential', surfaceCells),
      allocate('bulkPotential', volumeCells),
      allocate('rise', surfaceCells),
      allocate('work', 5),
    ];
    this.pressureHead = pressureAtDepth ? allocate('pressureHead', surfaceCells + volumeCells) : undefined;
    this.kick = new Float64Array(surfaceCells);
    this.bulkKick = new Float64Array(volumeCells);
    this.rise = new Float64Array(surfaceCells);
    this.mid = new Float64Array(surfaceCells);
    this.forcingPressure = new Float64Array(surfaceCells);
    this.nextHeight = new Float64Array(surfaceCells);
    this.nextBulk = new Float64Array(volumeCells);
    this.sponge =
      sponge &&
      Float64Array.from({ length: surfaceCells }, (_, i) => {
        const x = i % cells[0],
          z = Math.floor(i / cells[0]);
        const distance = Math.min(x, cells[0] - x - 1, z, cells[1] - z - 1);
        return sponge.rate * Math.max(0, 1 - distance / sponge.cells) ** 2;
      });
    if (initial) {
      const height = this.words(0),
        trace = this.words(1);
      for (let i = 0; i < surfaceCells; i++)
        if (operator.wetCell(i)) {
          const value = initial(
            origin[0] + ((i % cells[0]) + 0.5) * cellSize,
            origin[1] + (Math.floor(i / cells[0]) + 0.5) * cellSize,
          );
          if (!Number.isFinite(value?.[0]) || !Number.isFinite(value?.[1]))
            throw invalidLoad('Return finite elevation and potential in the initial finite quay state.');
          height[i] = value[0];
          trace[i] = value[1];
        }
      operator.project(trace, this.words(3), undefined, 0, this.words(2));
      const head = this.headWords();
      if (head) {
        for (let i = 0; i < surfaceCells; i++) head[i] = this.g * height[i]!;
        operator.project(head.subarray(0, surfaceCells), this.rise, undefined, 0, head.subarray(surfaceCells));
      }
    }
  }

  step(context: StepContext, dt: number): void {
    const {
      operator,
      rho: density,
      g,
      kick,
      bulkKick,
      forcingPressure: pressure,
      mid,
      rise,
      nextHeight,
      nextBulk,
      sponge,
    } = this;
    const height = this.words(0),
      trace = this.words(1),
      ledger = this.words(4);
    const area = this.shape.cellSize ** 2;
    kick.fill(0);
    pressure.fill(0);
    const surface = this.sourceField && context.inputs.get(this.sourceField.name);
    const submerged = this.submerged && context.inputs.get(this.submerged.field.name);
    if (surface) this.stamp(surface, context, false);
    let iterations = 0;
    if (submerged) {
      bulkKick.fill(0);
      if (this.stamp(submerged, context, true)) {
        mid.fill(0);
        iterations += operator.project(mid, rise, bulkKick);
        for (let i = 0; i < kick.length; i++) kick[i]! += rise[i]!;
      }
    }
    let sourceWork = 0;
    let volume = 0;
    let absorbed = 0;
    let absorbedVolume = 0;
    const half = dt / 2;
    const robin = g * half * half;
    for (let i = 0; i < height.length; i++) {
      const original = height[i]!,
        eta = this.heightBeforeKick(original, i, half),
        change = kick[i]!;
      absorbed += 0.5 * (original * original - eta * eta);
      absorbedVolume += original - eta;
      nextHeight[i] = eta + change;
      mid[i] = trace[i]! - half * (g * nextHeight[i]! + pressure[i]! / density);
      sourceWork += density * g * change * (eta + change / 2) * area;
      volume += change * area;
    }
    iterations += operator.project(mid, rise, undefined, robin, nextBulk);
    const oldRise = this.words(3),
      oldBulk = this.words(2);
    const head = this.headWords();
    // Harmonic extension and upward flux are linear in the surface trace. Reflect the solved
    // midpoint around the old state to publish the endpoint without another elliptic solve.
    for (let i = 0; i < height.length; i++) {
      const motion = dt * rise[i]!;
      const eta = nextHeight[i]! + motion;
      const damped = sponge?.[i] ? eta * exp(-sponge[i]! * half) : eta;
      absorbed += 0.5 * (eta * eta - damped * damped);
      absorbedVolume += eta - damped;
      nextHeight[i] = damped;
      const next = 2 * (mid[i]! - robin * rise[i]!) - trace[i]!;
      if (head) head[i] = (trace[i]! - next) / dt;
      trace[i] = next;
      sourceWork -= pressure[i]! * motion * area;
      oldRise[i] = 2 * rise[i]! - oldRise[i]!;
    }
    for (let i = 0; i < oldBulk.length; i++) {
      const next = 2 * nextBulk[i]! - oldBulk[i]!;
      if (head) head[i + height.length] = (oldBulk[i]! - next) / dt;
      oldBulk[i] = next;
    }
    height.set(nextHeight);
    ledger[0]! += sourceWork;
    ledger[1]! += volume;
    ledger[2] = iterations;
    ledger[3]! += density * g * area * absorbed;
    ledger[4]! += area * absorbedVolume;
  }

  private stamp(port: Port, context: StepContext, below: boolean): boolean {
    const { region, cell } = port;
    const words = below ? SUBMERGED_WAKE_WORDS : WAKE_SOURCE_WORDS;
    if (
      region.type !== 'f64' ||
      region.layout !== (below ? SUBMERGED_WAKE_LAYOUT : WAKE_SOURCE_LAYOUT) ||
      region.byteLength % (8 * words) ||
      cell.some((value, i) => value !== context.cell[i])
    )
      throw invalidLoad(
        'Connect the finite quay and hull sources in the same cell with matching layout-1 f64 records.',
      );
    const rows = regionWords(port.region.memory ?? this.host.memory, region) as Float64Array;
    return this.stampRows(rows, below);
  }

  private stampRows(rows: Float64Array, below: boolean): boolean {
    const words = below ? SUBMERGED_WAKE_WORDS : WAKE_SOURCE_WORDS;
    let active = false;
    for (let at = 0; at < rows.length; at += words) {
      const x = rows[at]!,
        z = rows[at + 1]!,
        radius = rows[at + 2]!,
        band = rows[at + 3]!,
        volume = rows[at + 4]!;
      if (volume === 0 && (below || band === 0)) continue;
      const depths = this.submerged?.depths;
      if (
        ![x, z, radius, band, volume].every(Number.isFinite) ||
        radius <= 0 ||
        (below && (!Number.isInteger(band) || band < 0 || band + 1 >= depths!.length))
      )
        throw invalidLoad(
          'Use finite coordinates, positive radii and a valid band or finite surface pressure for each source.',
        );
      active = true;
      if (!below) this.scatter(x, z, radius, 0, volume, band);
      else {
        const upper = depths![band]!,
          lower = depths![band + 1]!;
        for (let layer = 0; layer + 1 < this.depths.length; layer++) {
          const thickness = Math.min(lower, this.depths[layer + 1]!) - Math.max(upper, this.depths[layer]!);
          if (thickness > 0) this.scatter(x, z, radius, layer, (volume * thickness) / (lower - upper));
        }
      }
    }
    return active;
  }

  /** Check that the guided surge will be the only actuator on this wake. Add the finite wake first. */
  validateSurgeSource(source: SubmergedWakeSource, depth: number, memory: WebAssembly.Memory): void {
    this.validateMotionSources(source, depth, memory);
  }

  /** Check that the attached hull owns both displacement ports on the receiving finite wake. */
  validateMotionSources(
    source: SubmergedWakeSource,
    depth: number,
    memory: WebAssembly.Memory,
    surface?: FieldDescriptor,
  ): void {
    if (
      this.host?.memory !== memory ||
      this.sourceField?.name !== surface?.name ||
      !this.submerged ||
      this.submerged.field.name !== source.field.name ||
      this.depths.at(-1) !== depth ||
      this.submerged.depths.length !== source.depths.length ||
      this.submerged.depths.some((value, i) => value !== source.depths[i])
    )
      throw invalidLoad('Add the finite wake first with the coupling’s own displacement sources, depth bands and bed.');
  }

  /** Dot products of the accepted finite displacement operator for the guided surge's work solve. */
  surgeProfile(rows: Float64Array, eta: Float64Array, dt: number): { head: number; stiffness: number } {
    const rise = this.displacementProfile(rows, eta, dt, true);
    let stiffness = 0;
    for (const column of rise) stiffness += column * column;
    return { head: this.profileHead(rise, eta, dt / 2), stiffness };
  }

  /** Write a unit hull-motion column and return its pairing with the surface after half-step absorption. */
  motionProfile(rows: Float64Array, out: Float64Array, eta: Float64Array, dt: number, below: boolean): number {
    if (out.length !== eta.length || out.buffer === eta.buffer)
      throw invalidLoad('Use a separate full-size surface buffer for the projected hull displacement.');
    const profile = this.displacementProfile(rows, eta, dt, below);
    out.set(profile);
    return this.profileHead(out, eta, dt / 2);
  }

  private displacementProfile(rows: Float64Array, eta: Float64Array, dt: number, below: boolean): Float64Array {
    if (
      !this.host ||
      !(below ? this.submerged : this.sourceField) ||
      rows.length % (below ? SUBMERGED_WAKE_WORDS : WAKE_SOURCE_WORDS) ||
      eta.length !== this.operator.surfaceCells ||
      !(dt > 0 && Number.isFinite(dt))
    )
      throw invalidLoad('Use complete finite displacement rows, the prior surface and a positive coupling step.');
    if (!below) {
      for (let at = 3; at < rows.length; at += WAKE_SOURCE_WORDS) {
        if (rows[at] !== 0) throw invalidLoad('Set the pressure column to zero for a surface displacement profile.');
      }
      this.kick.fill(0);
      this.stampRows(rows, false);
      return this.kick;
    }
    const { bulkKick, mid, rise } = this;
    bulkKick.fill(0);
    if (this.stampRows(rows, true)) {
      mid.fill(0);
      this.operator.project(mid, rise, bulkKick);
    } else rise.fill(0);
    return rise;
  }

  private profileHead(profile: Float64Array, eta: Float64Array, half: number): number {
    let head = 0;
    for (let i = 0; i < profile.length; i++) head += profile[i]! * this.heightBeforeKick(eta[i]!, i, half);
    return head;
  }

  private heightBeforeKick(height: number, i: number, half: number): number {
    const decay = this.sponge?.[i];
    return decay ? height * exp(-decay * half) : height;
  }

  private scatter(x: number, z: number, radius: number, layer: number, volume: number, pressure?: number): void {
    const {
      cells: [nx, nz],
      cellSize: dx,
      origin: [x0, z0],
    } = this.shape;
    const centre = this.cellIndex(x, z);
    if (!this.operator.wetCell(centre < 0 ? -1 : centre + layer * nx * nz))
      throw invalidLoad('Place every active advancing source inside its wet quay layer.');
    const sourceX = (x - x0) / dx,
      sourceZ = (z - z0) / dx;
    const u = sourceX - 0.5,
      v = sourceZ - 0.5;
    const ci = Math.floor(u),
      cj = Math.floor(v),
      fu = u - ci,
      fv = v - cj;
    const r = Math.max(1, radius / dx);
    const i0 = Math.max(0, Math.floor(u - r)),
      i1 = Math.min(nx - 1, Math.ceil(u + r));
    const j0 = Math.max(0, Math.floor(v - r)),
      j1 = Math.min(nz - 1, Math.ceil(v + r));
    const offset = nx * nz * layer,
      inverseArea = 1 / (dx * dx);
    const tap = (di: number, dj: number) => {
      const distance = Math.sqrt(di * di + dj * dj) / r;
      return distance < 1 ? 0.5 * (1 + cos(Math.PI * distance)) : 0;
    };
    let sum = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const index = i + j * nx + offset;
          if (!this.operator.wetCell(index)) continue;
          const a = i - ci,
            b = j - cj;
          const weight =
            (1 - fv) * ((1 - fu) * tap(a, b) + fu * tap(a - 1, b)) +
            fv * ((1 - fu) * tap(a, b - 1) + fu * tap(a - 1, b - 1));
          if (weight === 0 || !this.operator.reaches(sourceX, sourceZ, i, j, offset)) continue;
          if (pass === 0) sum += weight;
          else if (pressure === undefined) this.bulkKick[index]! += (weight * volume) / sum;
          else {
            this.kick[index]! += (weight * volume * inverseArea) / sum;
            this.forcingPressure[index]! += weight * pressure;
          }
        }
      if (!(sum > 0)) throw invalidLoad('Increase the source radius so it reaches a wet quay cell.');
    }
  }

  private words(index: 0 | 1 | 2 | 3 | 4): Float64Array {
    return regionWords(this.host.memory, this.regions[index]) as Float64Array;
  }

  private headWords(): Float64Array | undefined {
    return this.pressureHead && (regionWords(this.host.memory, this.pressureHead) as Float64Array);
  }

  private cellIndex(x: number, z: number): number {
    const {
      cells: [nx, nz],
      cellSize,
      origin,
    } = this.shape;
    const i = Math.floor((x - origin[0]) / cellSize),
      j = Math.floor((z - origin[1]) / cellSize);
    return i >= 0 && i < nx && j >= 0 && j < nz ? i + j * nx : -1;
  }

  get grid(): {
    readonly cells: readonly [number, number];
    readonly cellSize: number;
    readonly origin: readonly [number, number];
  } {
    return this.shape;
  }

  heights(): Float64Array {
    return this.words(0);
  }

  wet(x: number, z: number): boolean {
    return this.operator.wetCell(this.cellIndex(x, z));
  }

  /** A copy of the wet surface graph, X fastest. Bits 1, 2 and 4 are wet, open east and open north. */
  surfaceMask(): Uint8Array {
    const [nx] = this.shape.cells;
    const { operator } = this;
    const result = new Uint8Array(operator.surfaceCells);
    for (let i = 0; i < result.length; i++) {
      if (!operator.wetCell(i)) continue;
      const x = i % nx,
        z = Math.floor(i / nx);
      result[i] =
        1 +
        2 * Number(operator.reaches(x + 0.5, z + 0.5, x + 1, z, 0)) +
        4 * Number(operator.reaches(x + 0.5, z + 0.5, x, z + 1, 0));
    }
    return result;
  }

  get density(): number {
    return this.rho;
  }

  /** Elevation from the retained state, for wetted hulls reading a SeaQuery. */
  elevation(x: number, z: number): number {
    return this.wet(x, z) ? this.surfaceAt(this.heights(), x, z) : 0;
  }

  /** Time-centred gauge pressure in Pa, from the accepted potential. Enable `pressureAtDepth`. */
  pressure(x: number, y: number, z: number): number {
    const head = this.headWords();
    if (!head) throw invalidLoad('Enable pressureAtDepth on the finite quay to query its Bernoulli pressure.');
    const depth = Math.max(0, -y),
      plane = this.operator.surfaceCells;
    const i = this.cellIndex(x, z);
    if (!Number.isFinite(y) || i < 0 || depth > this.depths.at(-1)! || (this.wet(x, z) && y >= this.elevation(x, z)))
      return 0;
    const layer = this.layerAt(depth);
    if (!this.operator.wetCell(i + layer * plane)) return 0;
    const centre = (this.depths[layer]! + this.depths[layer + 1]!) / 2;
    const readLayer = (target: number) =>
      this.surfaceAt(head.subarray((target + 1) * plane, (target + 2) * plane), x, z, target);
    const local = readLayer(layer);
    const adjacent = depth < centre ? layer - 1 : layer + 1;
    let dynamic = local;
    if (adjacent === -1) {
      const surface = this.surfaceAt(head.subarray(0, plane), x, z);
      dynamic = surface + ((local - surface) * depth) / centre;
    } else if (adjacent + 1 < this.depths.length && this.operator.wetCell(i + adjacent * plane)) {
      const other = (this.depths[adjacent]! + this.depths[adjacent + 1]!) / 2;
      dynamic += ((readLayer(adjacent) - local) * (depth - centre)) / (other - centre);
    }
    return this.rho * (dynamic - this.g * y);
  }

  /** Give the retained height, pressure and depth motion to hulls or floaters through the sea contract. */
  seaSurface(): SeaSurface {
    const wake = this;
    const scratch: WakeSample = { height: 0, slope: [0, 0], velocity: [0, 0, 0] };
    return {
      get cell() {
        return wake.host?.cell ?? [0, 0, 0];
      },
      get density() {
        return wake.density;
      },
      elevation: (x, z) => wake.elevation(x, z),
      pressure: (x, y, z) => wake.pressure(x, y, z),
      sample(
        x,
        z,
        _time,
        out: SeaSurfaceSample = {
          height: 0,
          normal: [0, 1, 0],
          velocity: [0, 0, 0],
          current: [0, 0, 0],
          depth: 0,
          density: 0,
        },
      ) {
        wake.sample(x, z, scratch);
        const [a, b] = scratch.slope,
          length = Math.sqrt(1 + a * a + b * b),
          wet = wake.wet(x, z);
        out.height = scratch.height;
        out.normal[0] = -a / length;
        out.normal[1] = 1 / length;
        out.normal[2] = -b / length;
        for (let i = 0; i < 3; i++) {
          out.current[i] = 0;
          out.velocity[i] = scratch.velocity[i]!;
        }
        out.depth = wet ? wake.depths.at(-1)! : 0;
        out.density = wet ? wake.density : 0;
        return out;
      },
      water: {
        medium: 'water',
        get cell() {
          return wake.host?.cell ?? [0, 0, 0];
        },
        sample(x, y, z, _time, out = { velocity: [0, 0, 0], density: 0, temperature: 288.15 }) {
          const i = wake.cellIndex(x, z),
            depth = Math.max(0, -y);
          const wet =
            Number.isFinite(y) &&
            i >= 0 &&
            depth <= wake.depths.at(-1)! &&
            wake.operator.wetCell(i + wake.layerAt(depth) * wake.operator.surfaceCells) &&
            (wake.wet(x, z) ? y <= wake.elevation(x, z) : y < 0);
          if (wet) wake.velocityAt(x, y, z, out.velocity);
          else out.velocity[0] = out.velocity[1] = out.velocity[2] = 0;
          out.density = wet ? wake.density : 0;
          out.temperature = 288.15;
          return out;
        },
      },
    };
  }

  work(): {
    joules: number;
    displacedVolume: number;
    iterations: number;
    absorbedJoules: number;
    absorbedVolume: number;
  } {
    const [joules, displacedVolume, iterations, absorbedJoules, absorbedVolume] = this.words(4);
    return {
      joules: joules!,
      displacedVolume: displacedVolume!,
      iterations: iterations!,
      absorbedJoules: absorbedJoules!,
      absorbedVolume: absorbedVolume!,
    };
  }

  /** Hamiltonian of the accepted free surface in joules. */
  energy(): number {
    const height = this.words(0),
      trace = this.words(1),
      rate = this.words(3);
    let energy = 0;
    for (let i = 0; i < height.length; i++) energy += this.g * height[i]! ** 2 + rate[i]! * trace[i]!;
    return 0.5 * this.rho * this.shape.cellSize ** 2 * energy;
  }

  /** Bilinear height over visible wet cells, with centred or one-sided slopes at the wall. */
  sample(x: number, z: number, out: WakeSample = { height: 0, slope: [0, 0], velocity: [0, 0, 0] }): WakeSample {
    const height = this.words(0),
      dx = this.shape.cellSize;
    const wet = this.wet(x, z);
    out.height = wet ? this.surfaceAt(height, x, z) : 0;
    const slope = (a: number, b: number) => {
      const lower = this.surfaceReach(x, z, x - a, z - b);
      const upper = this.surfaceReach(x, z, x + a, z + b);
      if (!lower && !upper) return 0;
      const before = lower ? this.surfaceAt(height, x - a, z - b) : out.height;
      const after = upper ? this.surfaceAt(height, x + a, z + b) : out.height;
      return (after - before) / (dx * (Number(lower) + Number(upper)));
    };
    out.slope[0] = wet ? slope(dx, 0) : 0;
    out.slope[1] = wet ? slope(0, dx) : 0;
    this.velocityAt(x, 0, z, out.velocity);
    return out;
  }

  private surfaceAt(height: Float64Array, x: number, z: number, layer = 0): number {
    const {
      cells: [nx],
      cellSize,
      origin,
    } = this.shape;
    const u = (x - origin[0]) / cellSize - 0.5,
      v = (z - origin[1]) / cellSize - 0.5;
    const i = Math.floor(u),
      j = Math.floor(v),
      fu = u - i,
      fv = v - j;
    let sum = 0,
      value = 0;
    for (let a = 0; a < 2; a++)
      for (let b = 0; b < 2; b++) {
        if (!this.operator.reaches(u + 0.5, v + 0.5, i + a, j + b, layer * this.operator.surfaceCells)) continue;
        const weight = (a === 0 ? 1 - fu : fu) * (b === 0 ? 1 - fv : fv);
        sum += weight;
        value += weight * height[i + a + (j + b) * nx]!;
      }
    return sum > 0 ? value / sum : 0;
  }

  private surfaceReach(x: number, z: number, toX: number, toZ: number): boolean {
    const { origin, cellSize } = this.shape;
    return this.operator.reaches(
      (x - origin[0]) / cellSize,
      (z - origin[1]) / cellSize,
      Math.floor((toX - origin[0]) / cellSize),
      Math.floor((toZ - origin[1]) / cellSize),
      0,
    );
  }

  velocityAt(x: number, y: number, z: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    out[0] = out[1] = out[2] = 0;
    const plane = this.operator.surfaceCells,
      i = this.cellIndex(x, z);
    if (i < 0 || !Number.isFinite(y) || -y > this.depths.at(-1)!) return out;
    const layer = this.layerAt(Math.max(0, -y));
    const at = i + layer * plane;
    if (!this.operator.wetCell(at)) return out;
    const bulk = this.words(2),
      [nx] = this.shape.cells,
      dx = this.shape.cellSize;
    const flux = (axis: 'x' | 'z' | 'down', cell: number) => (cell < 0 ? 0 : this.operator.faceFlux(axis, cell, bulk));
    const horizArea = dx * (this.depths[layer + 1]! - this.depths[layer]!);
    out[0] = (flux('x', at) + flux('x', at - 1)) / (2 * horizArea);
    out[2] = (flux('z', at) + flux('z', at - nx)) / (2 * horizArea);
    const up = layer === 0 ? this.words(3)[i]! : -flux('down', at - plane) / (dx * dx);
    out[1] = y >= 0 ? up : 0.5 * (up - flux('down', at) / (dx * dx));
    return out;
  }

  private layerAt(depth: number): number {
    let layer = 0;
    while (layer + 2 < this.depths.length && this.depths[layer + 1]! < depth) layer++;
    return layer;
  }

  exportPorts(tick: number): readonly Port[] {
    return [{ field: this.heightField.name, region: this.regions[0], tick, cell: this.host.cell }];
  }

  importPorts(): void {}
  stateRegions(): readonly Region[] {
    return this.pressureHead ? [...this.regions, this.pressureHead] : this.regions;
  }
  extraState(): readonly Region[] {
    return [];
  }
}
