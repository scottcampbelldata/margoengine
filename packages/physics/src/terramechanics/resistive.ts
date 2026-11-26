import { MargoError } from '@margoengine/math/errors';
import { hypot } from '@margoengine/math/pinned';
import { rotateByQuaternion } from '@margoengine/math/quat';
import { BED_FIELD, type BedShape, bedFromPort, bedVertexCount } from '../earth/bed.js';
import { regionWords } from '../world/memory.js';
import type { Cell, Port, Region, Solver, SolverHost, StepContext } from '../world/solver.js';
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, bodyRowsOf, FORCE_WORDS } from '../world/solvers/rigid.js';
import { bindSoil, type Builds, loadSoil, type NativeSoil } from './kernel.js';

type Point = readonly [number, number, number];
type MutablePoint = [number, number, number];
const ACROSS = [0, 0, 1] as const;
const SAMPLE_WORDS = 8;
const MAX_SAMPLES = 65_536;

/** The nine Fourier coefficients of Li, Zhang and Goldman (2013), Eq. S9, converted to N/m³. */
export type ResistiveSoilCoefficients = readonly [
  a00: number,
  a10: number,
  b11: number,
  b01: number,
  bMinus11: number,
  c11: number,
  c01: number,
  cMinus11: number,
  d10: number,
];

/** One thin strip of a shoe, hoof or leg in the rigid body's local XY plane. Width runs along local +Z. */
export interface ResistiveSoilStrip {
  /** Start and end of the strip centre line, m. The z coordinates must agree. */
  readonly start: Point;
  readonly end: Point;
  readonly width: number;
  /** Midpoint quadrature samples along the strip, 1–128. Default 30. */
  readonly samples?: number;
}

export interface ResistiveSoilParams {
  readonly terrain: BedShape;
  /** Prepared dry soil response. Use coefficients from a separate plate test. */
  readonly coefficients: ResistiveSoilCoefficients;
  /** Connect each rigid-kernel body row to one or more strips. */
  readonly bodies: readonly { readonly row: number; readonly strips: readonly ResistiveSoilStrip[] }[];
  /** Metres per floating-origin cell. Default 4096. */
  readonly cellSize?: number;
}

export interface ResistiveSoilOptions {
  /** Solver ID. Default 'resistive-soil'. */
  readonly id?: string;
  readonly signal?: AbortSignal;
}

type RuntimeStrip = { first: Point; step: Point; area: number; count: number };
type MovingBody = {
  readonly row: number;
  readonly strips: readonly RuntimeStrip[];
};

function stripOf({ start, end, width, samples: count = 30 }: ResistiveSoilStrip): RuntimeStrip {
  const length = hypot(end[0] - start[0], end[1] - start[1]);
  const area = (length * width) / count;
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 128 ||
    ![...start, ...end, length, area].every(Number.isFinite) ||
    !(area > 0) ||
    start[2] !== end[2]
  )
    throw new MargoError(
      'state',
      'Invalid resistive soil strip. Use finite distinct in-plane ends, a positive width and 1–128 samples.',
    );
  return {
    first: [...start],
    step: [(end[0] - start[0]) / count, (end[1] - start[1]) / count, 0],
    area,
    count,
  };
}

/** Integrates quasistatic granular resistive forces over moving strips on the live bed, through `bodyForces`. */
export class ResistiveSoil implements Solver<ResistiveSoilParams> {
  private host!: SolverHost;
  private kernel!: NativeSoil;
  private forces!: Region;
  private coefficients!: Region;
  private samples!: Region;
  private terrain!: BedShape;
  private bodies: readonly MovingBody[] = [];
  private cell: Cell = [0, 0, 0];
  private cellSize = 4096;

  private constructor(
    private readonly builds: Builds,
    readonly id: string,
  ) {}

  static async load(options: ResistiveSoilOptions = {}): Promise<ResistiveSoil> {
    return new ResistiveSoil(await loadSoil(options.signal), options.id ?? 'resistive-soil');
  }

  describe() {
    return {
      id: this.id,
      rate: 0 as const,
      stableRate: () => 0 as const,
      fields: [
        { field: BED_FIELD, access: 'read' as const },
        { field: BODIES_FIELD, access: 'read' as const },
        { field: BODY_FORCES_FIELD, access: 'accumulate' as const },
      ],
    };
  }

  init(host: SolverHost, params: ResistiveSoilParams): void {
    this.host = host;
    this.terrain = { ...params.terrain, centre: [...params.terrain.centre] };
    bedVertexCount(this.terrain);
    this.cellSize = params.cellSize ?? 4096;
    if (!Number.isFinite(this.cellSize) || this.cellSize <= 0)
      throw new MargoError('state', 'Invalid resistive soil cell size. Supply positive finite metres.');
    if (params.coefficients.length !== 9 || !params.coefficients.every(Number.isFinite))
      throw new MargoError(
        'state',
        'Invalid soil stress profile. Supply the nine finite Fourier coefficients in N/m³.',
      );
    const seen = new Set<number>();
    let sampleCount = 0;
    this.bodies = params.bodies.map(({ row, strips }) => {
      if (!Number.isSafeInteger(row) || row < 0 || seen.has(row) || !strips.length)
        throw new MargoError('state', 'Invalid resistive soil body binding. Supply unique body rows with strips.');
      seen.add(row);
      const resolved = strips.map(stripOf);
      for (const strip of resolved) sampleCount += strip.count;
      return { row, strips: resolved };
    });
    if (!sampleCount || sampleCount > MAX_SAMPLES)
      throw new MargoError('state', 'Invalid resistive soil work size. Configure 1–65,536 strip samples.');
    const rows = bodyRowsOf(host, 'ResistiveSoil', [...seen]);
    this.forces = host.allocate('resistive-soil-forces', rows * FORCE_WORDS * 8, 'f64', 1);
    this.coefficients = host.allocate('resistive-soil-coefficients', 9 * 8, 'f64', 1);
    this.samples = host.allocate(
      'resistive-soil-samples',
      (sampleCount + (sampleCount % 2)) * SAMPLE_WORDS * 8,
      'f64',
      1,
    );
    this.kernel = bindSoil(host, this.builds);
    this.words(this.coefficients).set(params.coefficients);
  }

  private words(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }

  step(context: StepContext): void {
    this.cell = context.cell;
    this.words(this.forces).fill(0);
    const bedPort = context.inputs.get(BED_FIELD.name);
    const bodyPort = context.inputs.get(BODIES_FIELD.name);
    if (!bedPort || !bodyPort)
      throw new MargoError('state', 'Resistive soil needs body and bed inputs. Add RigidSolver and TerrainBed.');
    const region = bodyPort.region;
    const expectedBodyRows = this.forces.byteLength / (FORCE_WORDS * 8);
    if (region.type !== 'f32' || region.layout !== 2 || region.byteLength !== expectedBodyRows * BODY_WORDS * 4)
      throw new MargoError(
        'state',
        'Resistive soil needs the layout-2 rigid body field. Connect the real RigidSolver.',
      );
    const bodyWords = regionWords(region.memory ?? this.host.memory, region) as Float32Array;
    const bed = bedFromPort(this.host.memory, bedPort, this.terrain);
    const offset = bodyPort.cell.map((value, axis) => (value - bedPort.cell[axis]!) * this.cellSize);
    const sample = { elevation: 0, normal: [0, 1, 0] as MutablePoint };
    const points = this.words(this.samples);
    for (const body of this.bodies) {
      const at = body.row * BODY_WORDS;
      const rotation = bodyWords.subarray(at + 3, at + 7);
      if (rotation.every((component) => component === 0)) continue;
      const across = rotateByQuaternion(ACROSS, rotation);
      const acrossLength = hypot(across[0], across[2]);
      if (acrossLength === 0) continue;
      const horizontalX = across[2] / acrossLength;
      const horizontalZ = -across[0] / acrossLength;
      const [ox, oy, oz, cx, cy, cz] = [
        bodyWords[at]!,
        bodyWords[at + 1]!,
        bodyWords[at + 2]!,
        bodyWords[at + 7]!,
        bodyWords[at + 8]!,
        bodyWords[at + 9]!,
      ];
      const [vx, vy, vz, wx, wy, wz] = [
        bodyWords[at + 10]!,
        bodyWords[at + 11]!,
        bodyWords[at + 12]!,
        bodyWords[at + 13]!,
        bodyWords[at + 14]!,
        bodyWords[at + 15]!,
      ];
      let count = 0;
      for (const strip of body.strips) {
        const first = rotateByQuaternion(strip.first, rotation);
        const step = rotateByQuaternion(strip.step, rotation);
        const along = step[0] * horizontalX + step[2] * horizontalZ;
        const length = hypot(along, step[1]);
        if (length === 0) continue;
        // Fig. 2A: beta is clockwise from horizontal. The stress is invariant under beta + pi.
        const cosB = along / length;
        const sinB = -step[1] / length;
        const cos2B = cosB * cosB - sinB * sinB;
        const sin2B = 2 * cosB * sinB;
        for (let i = 0; i < strip.count; i++) {
          const t = i + 0.5;
          const x = ox + first[0] + t * step[0];
          const y = oy + first[1] + t * step[1];
          const z = oz + first[2] + t * step[2];
          const depth = bed.sample(x + offset[0]!, z + offset[2]!, sample).elevation - (y + offset[1]!);
          if (depth <= 0) continue;
          const rx = x - cx;
          const ry = y - cy;
          const rz = z - cz;
          const sy = vy + wz * rx - wx * rz;
          const sh = (vx + wy * rz - wz * ry) * horizontalX + (vz + wx * ry - wy * rx) * horizontalZ;
          const speed = hypot(sh, sy);
          // A two-sided strip has one leading face unless its motion is tangent to the strip.
          if (speed === 0 || sy * cosB + sh * sinB === 0) continue;
          const index = count++ * SAMPLE_WORDS;
          points[index] = rx;
          points[index + 1] = ry;
          points[index + 2] = rz;
          points[index + 3] = depth * strip.area;
          points[index + 4] = cos2B;
          points[index + 5] = sin2B;
          points[index + 6] = -sh / speed;
          points[index + 7] = -sy / speed;
        }
      }
      if (count % 2) {
        points.fill(0, count * SAMPLE_WORDS, (count + 1) * SAMPLE_WORDS);
        count += 1;
      }
      this.kernel.resistive(
        this.coefficients.byteOffset,
        this.samples.byteOffset,
        count,
        horizontalX,
        horizontalZ,
        this.forces.byteOffset + body.row * FORCE_WORDS * 8,
      );
    }
    if (!this.words(this.forces).every(Number.isFinite))
      throw new MargoError(
        'state',
        'Resistive soil produced an invalid load. Check the SI geometry and stress ranges.',
      );
  }

  /** Last tick's world-space force (N) and torque about the body's centre of mass (N·m). */
  read(row: number): { readonly force: Point; readonly torque: Point } {
    const out = this.words(this.forces);
    const at = row * FORCE_WORDS;
    if (!Number.isSafeInteger(row) || at < 0 || at >= out.length)
      throw new MargoError('state', 'Resistive soil body row is out of bounds. Choose a row in this rigid world.');
    return {
      force: [out[at]!, out[at + 1]!, out[at + 2]!],
      torque: [out[at + 3]!, out[at + 4]!, out[at + 5]!],
    };
  }

  exportPorts(tick: number): readonly Port[] {
    return [{ field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: this.cell }];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.forces, this.coefficients];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
