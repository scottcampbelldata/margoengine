import { RealFft2 } from '@margoengine/math/fft';
import { hypot } from '@margoengine/math/pinned';
import { rotateByQuaternion } from '@margoengine/math/quat';
import type { PhysicsBody } from '../body.js';
import {
  ProjectedWakeSource,
  SUBMERGED_WAKE_LAYOUT,
  SUBMERGED_WAKE_MAX_CELLS,
  SUBMERGED_WAKE_MAX_ROWS,
  SUBMERGED_WAKE_QUANTITY,
  SUBMERGED_WAKE_WORDS,
  type SubmergedWakeSource,
  type WakeSourceGrid,
  wakeDepths,
  wakePatch,
} from '../sea/submerged-wake.js';
import { WAKE_HEIGHT_FIELD, WAKE_LAYOUT, WAKE_SOURCE_LAYOUT, WAKE_SOURCE_WORDS, type WakeParams } from '../sea/wake.js';
import { hullSections } from '../seakeeping/strips.js';
import { submergedWakeNodes } from '../seakeeping/submerged-wake.js';
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
import {
  BODIES_FIELD,
  BODY_IMPULSES_FIELD,
  BODY_MOBILITY_FIELD,
  BODY_MOBILITY_WORDS,
  BODY_WORDS,
  IMPULSE_WORDS,
} from '../world/solvers/rigid.js';
import { invalidLoad } from './errors.js';
import type { FiniteQuayWake } from './finite-quay-wake.js';
import { equivalentEllipsoid } from './shapes.js';
import type { SurgeWakeOptions } from './surge-wake.js';

/** A live hull with horizontal surge, heave and three free rotational axes. */
export interface FreeHullWakeOptions extends Omit<SurgeWakeOptions, 'row' | 'axis' | 'waterline'> {
  /** A live dynamic body in the coupled RigidSolver with gyroscopic forces enabled. */
  readonly body: PhysicsBody;
  /** World guide X or Z, default X. Unlock that translation, heave and all three rotations. */
  readonly axis?: 'x' | 'z';
  /** Reference body-local still-water Y for the advancing depth bands. */
  readonly waterline: number;
}

type Point = [number, number];
type Vector = [number, number, number, number];
type Rows = [Vector, Vector, Vector, Vector];
type Sample = { x: number; z: number; coefficients: Vector };
const dt60 = 1 / 60;
const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
};
const turn = (a: Point, b: Point, c: Point): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function lengthIsFft(n: number): boolean {
  if (!Number.isInteger(n) || n < 4 || n > 4096) return false;
  for (const base of [2, 3, 5]) while (n % base === 0) n /= base;
  return n === 1;
}

/** Intersect the posed, outward-wound triangle mesh and integrate its single convex waterplane. */
function planeSamples(vertices: Float64Array, indices: Uint32Array, centreX: number, centreZ: number): Sample[] {
  const points: Point[] = [];
  let orientedArea = 0;
  let areaScale = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = 3 * indices[i]!,
      b = 3 * indices[i + 1]!,
      c = 3 * indices[i + 2]!;
    const cut: Point[] = [];
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const y = vertices[u + 1]!,
        next = vertices[v + 1]!;
      if (y < 0 === next < 0) continue;
      const t = -y / (next - y);
      cut.push([
        vertices[u]! + t * (vertices[v]! - vertices[u]!) - centreX,
        vertices[u + 2]! + t * (vertices[v + 2]! - vertices[u + 2]!) - centreZ,
      ]);
    }
    if (cut.length !== 2) continue;
    const p = cut[0]!,
      q = cut[1]!;
    const ux = vertices[b]! - vertices[a]!,
      uy = vertices[b + 1]! - vertices[a + 1]!,
      uz = vertices[b + 2]! - vertices[a + 2]!;
    const vx = vertices[c]! - vertices[a]!,
      vy = vertices[c + 1]! - vertices[a + 1]!,
      vz = vertices[c + 2]! - vertices[a + 2]!;
    const nx = uy * vz - uz * vy,
      nz = ux * vy - uy * vx;
    const orientation = Math.sign(-nz * (q[0] - p[0]) + nx * (q[1] - p[1]));
    orientedArea += orientation * (p[0] * q[1] - p[1] * q[0]);
    areaScale += Math.abs(p[0] * q[1]) + Math.abs(p[1] * q[0]);
    points.push(p, q);
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  function chain(ordered: readonly Point[]): Point[] {
    const result: Point[] = [];
    for (const point of ordered) {
      while (result.length >= 2 && turn(result.at(-2)!, result.at(-1)!, point) <= 0) result.pop();
      result.push(point);
    }
    result.pop();
    return result;
  }
  const contour = [...chain(points), ...chain(points.reverse())];
  let twiceArea = 0;
  const samples: Sample[] = [];
  for (let i = 1; i + 1 < contour.length; i++) {
    const a = contour[0]!,
      b = contour[i]!,
      c = contour[i + 1]!;
    const area = turn(a, b, c);
    twiceArea += area;
    for (const [p, q, r] of [
      [a, b, c],
      [b, c, a],
      [c, a, b],
    ] as const) {
      const x = (4 * p[0] + q[0] + r[0]) / 6,
        z = (4 * p[1] + q[1] + r[1]) / 6;
      const w = area / 6;
      samples.push({ x: centreX + x, z: centreZ + z, coefficients: [0, -w, w * z, -w * x] });
    }
  }
  if (!(twiceArea > 0) || Math.abs(twiceArea - orientedArea) > 128 * Number.EPSILON * areaScale)
    throw invalidLoad('Keep a single convex hull waterplane through the still surface within the coupled range.');
  return samples;
}

function solve(a: Rows, rhs: Vector): Vector {
  const m = a.map((row, i) => [...row, rhs[i]!]);
  for (let i = 0; i < 4; i++) {
    let p = i;
    for (let j = i + 1; j < 4; j++) if (Math.abs(m[j]![i]!) > Math.abs(m[p]![i]!)) p = j;
    [m[i], m[p]] = [m[p]!, m[i]!];
    const row = m[i]!,
      d = row[i]!;
    if (!(Number.isFinite(d) && d !== 0))
      throw invalidLoad('Use finite waves and a live hull with positive rotational inertia.');
    for (let j = i; j < 5; j++) row[j]! /= d;
    for (let j = 0; j < 4; j++)
      if (j !== i) {
        const other = m[j]!,
          factor = other[i]!;
        for (let k = i; k < 5; k++) other[k]! -= factor * row[k]!;
      }
  }
  return [m[0]![4]!, m[1]![4]!, m[2]![4]!, m[3]![4]!];
}

/**
 * Reciprocal work between a guided hull's surge, heave, roll and pitch and a dispersive wake.
 * Use single-substep rigid dynamics at 60 Hz with free native rotation and gyroscopic forces.
 * Supply the hull with ambient-only hydrostatics and give this coupling's two volume sources to the wake.
 * In the same staggered group, run hull, coupling, wake, rigid. Wake yaw torque is zero.
 */
export class FreeHullWakeCoupling implements Solver<undefined> {
  /** Layout-1 f64 surface volume source for the receiving WakeSolver. */
  readonly surfaceSource: FieldDescriptor;
  /** Layout-1 f64 submerged advancing volume source for the same WakeSolver. */
  readonly submergedSource: SubmergedWakeSource;
  private readonly body: PhysicsBody;
  private readonly axis: 0 | 2;
  private readonly geometry: Float64Array;
  private readonly indices: Uint32Array;
  private readonly posed: Float64Array;
  private readonly nodes: ReturnType<typeof submergedWakeNodes>;
  private readonly grid: WakeSourceGrid;
  private readonly settings: Required<
    Pick<WakeParams, 'cells' | 'cellSize' | 'centre' | 'depth' | 'density' | 'sponge'>
  >;
  private readonly waterline: number;
  private readonly radius: number;
  private readonly periodic?: { projection: ProjectedWakeSource; fft: RealFft2; spectrum: Float64Array };
  private readonly finiteReceiver?: () => FiniteQuayWake;
  private finite?: FiniteQuayWake;
  private readonly profiles: Float64Array[];
  private readonly pressure: Float64Array;
  private readonly advancing: Float64Array;
  private readonly surface: Float64Array;
  private host!: SolverHost;
  private capacity = 0;
  private scale = 0;
  private outputs!: [Region, Region, Region];

  constructor(
    options: FreeHullWakeOptions,
    readonly id = 'freeHullWake',
  ) {
    const {
      body,
      mesh,
      waterline,
      depth,
      depths,
      cells,
      cellSize: dx,
      centre = [0, 0],
      density = 1025,
      stations = 24,
      minimumRadius = dx,
      axis = 'x',
      finiteReceiver,
    } = options ?? ({} as FreeHullWakeOptions);
    if (finiteReceiver !== undefined && typeof finiteReceiver !== 'function')
      throw invalidLoad('Pass finiteReceiver as a function returning the attached FiniteQuayWake.');
    if (!body?.valid || !Number.isFinite(waterline) || (axis !== 'x' && axis !== 'z'))
      throw invalidLoad('Pass a live rigid hull, a finite reference waterline and an X or Z guide.');
    if (
      cells?.length !== 2 ||
      (finiteReceiver
        ? cells.some((n) => !Number.isSafeInteger(n) || n < 1) || cells[0] * cells[1] > 0x1fffffff
        : !cells.every(lengthIsFft) || cells[0] % 2 !== 0 || cells[0] * cells[1] > SUBMERGED_WAKE_MAX_CELLS) ||
      !(dx > 0) ||
      cells.some((n) => !Number.isFinite(n * dx)) ||
      centre?.length !== 2 ||
      !centre.every(Number.isFinite) ||
      !(depth > 0) ||
      (finiteReceiver && !Number.isFinite(depth)) ||
      !(density > 0 && Number.isFinite(density)) ||
      !(minimumRadius >= 0 && Number.isFinite(minimumRadius))
    )
      throw invalidLoad(
        finiteReceiver
          ? 'Use positive finite wake dimensions, spacing, density and depth, and a finite source radius.'
          : 'Use a finite positive FFT grid and density, positive depth, and a finite source radius.',
      );
    const bands = wakeDepths(depths);
    if (
      bands.at(-1)! > depth ||
      !Number.isSafeInteger(stations) ||
      stations < 2 ||
      4 * (stations + 1) * (bands.length - 1) > SUBMERGED_WAKE_MAX_ROWS
    )
      throw invalidLoad(
        'Use at least two hull stations and depth bands ending at or above the bed within the source row limit.',
      );
    equivalentEllipsoid(mesh);
    this.body = body;
    this.axis = axis === 'x' ? 0 : 2;
    this.waterline = waterline;
    this.geometry = Float64Array.from(mesh.vertices);
    this.indices = Uint32Array.from(mesh.indices);
    this.posed = new Float64Array(this.geometry.length);
    this.nodes = submergedWakeNodes(mesh, waterline, hullSections(mesh, waterline, stations), bands, minimumRadius);
    if (!this.nodes.length) throw invalidLoad('Give the reference hull a wetted advancing profile.');
    const [nx, nz] = cells;
    this.grid = { nx, nz, dx, x0: centre[0] - (nx * dx) / 2, z0: centre[1] - (nz * dx) / 2 };
    this.settings = { cells: [nx, nz], cellSize: dx, centre: [...centre], depth, density, sponge: 0 };
    this.radius = Math.max(dx, minimumRadius);
    this.finiteReceiver = finiteReceiver;
    if (!finiteReceiver)
      this.periodic = {
        projection: new ProjectedWakeSource(this.grid, bands, depth),
        fft: new RealFft2(nx, nz),
        spectrum: new Float64Array(2 * (nx / 2 + 1) * nz),
      };
    this.profiles = Array.from({ length: 4 }, () => new Float64Array(nx * nz));
    this.pressure = new Float64Array(nx * nz);
    this.advancing = new Float64Array(this.nodes.length * SUBMERGED_WAKE_WORDS);
    this.surface = new Float64Array(2 * this.indices.length * WAKE_SOURCE_WORDS);
    this.surfaceSource = Object.freeze({
      name: `${id}.surface`,
      kind: 'surfaceSampleSet',
      quantity: 'seaSource',
      unit: 'SI',
      centring: 'particle',
    });
    this.submergedSource = Object.freeze({
      field: Object.freeze({ ...this.surfaceSource, name: `${id}.submerged`, quantity: SUBMERGED_WAKE_QUANTITY }),
      depths: bands,
    });
    this.checkBody();
  }

  /** The receiving wake's matching periodic grid. Other wake sources and damping are outside this exchange. */
  wakeParams({ initial, waterBelow }: Pick<WakeParams, 'initial' | 'waterBelow'> = {}): WakeParams {
    if (this.finiteReceiver)
      throw invalidLoad('Set the finite wake’s cells, origin, density and layer depths when adding it.');
    return {
      ...this.settings,
      cells: [...this.settings.cells],
      centre: [...this.settings.centre],
      initial,
      waterBelow,
    };
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: 0,
      stableRate: () => 0,
      fields: [
        ...[BODIES_FIELD, BODY_MOBILITY_FIELD, this.receiver()?.heightField ?? WAKE_HEIGHT_FIELD].map((field) => ({
          field,
          access: 'read' as const,
        })),
        { field: this.surfaceSource, access: 'write' },
        { field: this.submergedSource.field, access: 'write' },
        { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
      ],
    };
  }

  init(host: SolverHost): void {
    const [x, y, z] = host.gravity,
      scale = -y * this.settings.density * this.grid.dx ** 2;
    this.capacity = host.bodyRows();
    if (x !== 0 || z !== 0 || !(scale > 0 && Number.isFinite(scale)) || this.body.row >= this.capacity)
      throw invalidLoad('Add the live rigid body before its coupling and use downward Y gravity.');
    const finite = this.receiver();
    if (finite) {
      finite.validateMotionSources(this.submergedSource, this.settings.depth, host.memory, this.surfaceSource);
      const { cells, cellSize, origin } = finite.grid,
        { nx, nz, dx, x0, z0 } = this.grid;
      if (
        cells[0] !== nx ||
        cells[1] !== nz ||
        cellSize !== dx ||
        origin[0] !== x0 ||
        origin[1] !== z0 ||
        finite.density !== this.settings.density
      )
        throw invalidLoad('Use the same XZ grid and density for free hull motion and its finite wake.');
    }
    this.finite = finite;
    this.host = host;
    this.scale = scale;
    this.outputs = [
      host.allocate(`${this.id}:surface`, this.surface.byteLength, 'f64', WAKE_SOURCE_LAYOUT),
      host.allocate(`${this.id}:submerged`, this.advancing.byteLength, 'f64', SUBMERGED_WAKE_LAYOUT),
      host.allocate(`${this.id}:impulse`, this.capacity * IMPULSE_WORDS * 8, 'f64', 1),
    ];
  }

  step(context: StepContext, dt: number): void {
    if (context.level !== 0 || dt !== dt60) throw invalidLoad('Run the coupled hull, wake and rigid at 60 Hz.');
    this.checkBody();
    const all = this.read(context, BODIES_FIELD, 'f32', 2, this.capacity * BODY_WORDS * 4) as Float32Array;
    const response = this.read(
      context,
      BODY_MOBILITY_FIELD,
      'f32',
      1,
      this.capacity * BODY_MOBILITY_WORDS * 4,
    ) as Float32Array;
    const eta = this.read(
      context,
      this.finite?.heightField ?? WAKE_HEIGHT_FIELD,
      'f64',
      WAKE_LAYOUT,
      this.pressure.byteLength,
    ) as Float64Array;
    const row = this.body.row,
      b = all.subarray(row * BODY_WORDS, (row + 1) * BODY_WORDS),
      m = response.subarray(row * BODY_MOBILITY_WORDS, (row + 1) * BODY_MOBILITY_WORDS);
    const live = [
      ...this.body.position,
      ...this.body.rotation,
      ...this.body.linearVelocity,
      ...this.body.angularVelocity,
    ];
    if (
      b[23] !== 1 ||
      b[24] !== 1 ||
      live.some((value, i) => value !== b[i < 7 ? i : i + 3]) ||
      !m.every(Number.isFinite) ||
      m[2 - this.axis] !== 0 ||
      !(m[this.axis]! > 0 && m[1]! > 0 && m[3]! > 0 && m[6]! > 0 && m[8]! > 0)
    )
      throw invalidLoad(
        'Use the published live rigid row with one substep and positive inverse inertia. Step the hull without direct pose setters.',
      );
    const q = b.subarray(3, 7),
      offset = [b[0]!, b[1]!, b[2]!],
      point = [0, 0, 0] as [number, number, number];
    for (let i = 0; i < this.geometry.length; i += 3) {
      rotateByQuaternion(this.geometry.subarray(i, i + 3), q, point);
      for (let j = 0; j < 3; j++) this.posed[i + j] = offset[j]! + point[j]!;
    }
    const samples = planeSamples(this.posed, this.indices, b[7]!, b[9]!);
    const forward = rotateByQuaternion([1, 0, 0], q),
      horizontal = hypot(forward[0], 0, forward[2]);
    if (!(horizontal > 0)) throw invalidLoad('Give the floating hull a horizontal longitudinal direction.');
    const along = forward[this.axis]! / horizontal;
    this.nodes.forEach(({ x, z, radius, band, area }, i) => {
      rotateByQuaternion([x, this.waterline, z], q, point);
      this.advancing.set(
        [point[0] + offset[0]!, point[2] + offset[2]!, radius, band, area * along],
        i * SUBMERGED_WAKE_WORDS,
      );
    });
    const heads = this.profileHeads(samples, eta, dt);
    // B maps the four displacements to the wave height kick. G = rho g dx² BᵀB pairs every
    // combination of columns. Use the native response A to solve p = -dt Bᵀ rho g dx² (eta + B ds/2)
    // with ds = dt (v + A p/2). Equating the two midpoint works survives wake dispersion and native
    // gyroscopic transport with all angular axes free.
    const G = this.profiles.map((a) => this.profiles.map((b) => this.scale * dot(a, b))) as Rows;
    const A: Rows = [
      [m[this.axis]!, 0, 0, 0],
      [0, m[1]!, 0, 0],
      [0, 0, m[3]!, m[5]!],
      [0, 0, m[5]!, m[8]!],
    ];
    const system = G.map((r, i) =>
      r.map((_, j) => (i === j ? 1 : 0) + (dt * dt * r.reduce((sum, x, k) => sum + x * A[k]![j]!, 0)) / 4),
    ) as Rows;
    const v: Vector = [b[10 + this.axis]!, b[11]!, b[13]!, b[15]!];
    const p = solve(system, G.map((r, i) => -dt * (this.scale * heads[i]! + (dt * dot(r, v)) / 2)) as Vector);
    const ds = A.map((a, i) => dt * (v[i]! + dot(a, p) / 2)) as Vector;
    if (!p.every(Number.isFinite) || !ds.every(Number.isFinite))
      throw invalidLoad('Use finite wave heights and guided hull velocities.');
    this.surface.fill(0);
    samples.forEach((s, i) =>
      this.surface.set([s.x, s.z, this.radius, 0, dot(s.coefficients, ds)], i * WAKE_SOURCE_WORDS),
    );
    for (let i = 4; i < this.advancing.length; i += SUBMERGED_WAKE_WORDS) this.advancing[i]! *= ds[0];
    if (!this.surface.every(Number.isFinite) || !this.advancing.every(Number.isFinite))
      throw invalidLoad('Keep the hull and wake forcing finite within the coupled range.');
    (regionWords(this.host.memory, this.outputs[0]) as Float64Array).set(this.surface);
    (regionWords(this.host.memory, this.outputs[1]) as Float64Array).set(this.advancing);
    const impulses = regionWords(this.host.memory, this.outputs[2]) as Float64Array,
      at = row * IMPULSE_WORDS;
    impulses[at + this.axis] = p[0];
    impulses[at + 1] = p[1];
    impulses[at + 3] = p[2];
    impulses[at + 5] = p[3];
  }

  exportPorts(tick: number): readonly Port[] {
    return [this.surfaceSource.name, this.submergedSource.field.name, BODY_IMPULSES_FIELD.name].map((field, i) => ({
      field,
      region: this.outputs[i]!,
      tick,
      cell: this.host.cell,
    }));
  }
  importPorts(): void {}
  stateRegions(): readonly Region[] {
    return this.outputs;
  }
  extraState(): readonly Region[] {
    return [];
  }

  private receiver(): FiniteQuayWake | undefined {
    const finite = this.finiteReceiver?.();
    if (this.finiteReceiver && !finite)
      throw invalidLoad('Create the finite wake before adding its free hull coupling.');
    return finite;
  }

  private profileHeads(samples: Sample[], eta: Float64Array, dt: number): number[] {
    if (this.finite) {
      const rows = this.surface.subarray(0, samples.length * WAKE_SOURCE_WORDS);
      const heads = [this.finite.motionProfile(this.advancing, this.profiles[0]!, eta, dt, true)];
      for (let i = 1; i < 4; i++) {
        samples.forEach((s, j) => rows.set([s.x, s.z, this.radius, 0, s.coefficients[i]!], j * WAKE_SOURCE_WORDS));
        heads.push(this.finite.motionProfile(rows, this.profiles[i]!, eta, dt, false));
      }
      return heads;
    }
    const { fft, projection, spectrum } = this.periodic!;
    spectrum.fill(0);
    projection.add(this.advancing, fft, spectrum);
    fft.inverse(spectrum, this.profiles[0]!);
    for (let i = 1; i < 4; i++) {
      const grid = this.profiles[i]!;
      grid.fill(0);
      for (const sample of samples)
        wakePatch(this.grid, sample.x, sample.z, this.radius, sample.coefficients[i]!, grid, 0, this.pressure);
    }
    return this.profiles.map((profile) => dot(profile, eta));
  }

  private checkBody(): void {
    const body = this.body;
    if (
      !body.valid ||
      !body.enabled ||
      body.type !== 'dynamic' ||
      !body.gyroscopicForces ||
      !body.enabledRotations.every(Boolean) ||
      !body.principalInertia.every((value) => value > 0 && Number.isFinite(value)) ||
      !body.enabledTranslations[1] ||
      !body.enabledTranslations[this.axis] ||
      body.enabledTranslations[2 - this.axis] ||
      body.angularDamping !== 0 ||
      body.linearDamping !== 0 ||
      body.maxLinearSpeed !== Infinity ||
      body.maxAngularSpeed !== Infinity
    )
      throw invalidLoad(
        'Keep a dynamic hull with heave and one surge axis, free rotation, gyroscopic forces, zero damping and no body speed caps.',
      );
  }

  private read(context: StepContext, field: FieldDescriptor, type: 'f32' | 'f64', layout: number, bytes: number) {
    const port = context.inputs.get(field.name);
    if (
      !port ||
      port.tick !== context.tick - 1 ||
      port.region.type !== type ||
      port.region.layout !== layout ||
      port.region.byteLength !== bytes ||
      context.cell.some((value, i) => value !== port.cell[i])
    )
      throw invalidLoad(
        `Read the prior-tick ${field.name} layout ${layout} in the same cell. Couple free hull, wake and rigid at 60 Hz.`,
      );
    return regionWords(port.region.memory ?? this.host.memory, port.region);
  }
}
