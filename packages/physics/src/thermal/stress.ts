import { thermalError } from './errors.js';
import { thermalInputWords } from './inputs.js';
import type {
  FieldDescriptor,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import type { ThermalAxes } from './grid.js';
import { instantiateThermalKernel, loadThermalKernel, type ThermalKernelBuilds } from './kernel.js';

/** Sources and identity for a thermoelastic solid. */
export interface ThermoelasticityLoadOptions {
  /** Cell-centred, x-fastest f64 temperatures in K, for example HeatConduction.temperatureField. */
  readonly temperatureField: FieldDescriptor;
  /** Optional f64 liquid fraction port on the same grid. Any nonzero fraction prevents the solid solve. */
  readonly liquidFractionField?: FieldDescriptor;
  /** Solver ID and field-name prefix. Defaults to 'thermoelasticity'. */
  readonly id?: string;
  /** Cancels kernel loading with the signal's reason. */
  readonly signal?: AbortSignal;
}

/** Linear isotropic, solid elastic properties, independent of temperature. */
export interface ThermoelasticMaterial {
  /** Young's modulus in Pa, strictly positive. */
  readonly youngModulus: number;
  /** Poisson's ratio, strictly between -1 and 0.5. */
  readonly poissonRatio: number;
  /** Linear coefficient of thermal expansion in 1/K. */
  readonly expansionCoefficient: number;
  /** Stress-free temperature in K. Defaults to 293.15 K. */
  readonly referenceTemperature?: number;
}

/** A prescribed displacement at a vertex of the heat cells. */
export interface ThermoelasticRestraint {
  /** Integer x, y and z vertex indices, from zero through the cell count on their respective axes. */
  readonly node: ThermalAxes;
  /** Displacement in metres along each axis. A null component remains unconstrained. */
  readonly displacement: readonly [number | null, number | null, number | null];
}

/** A solid occupying exactly the cells of the associated temperature grid. */
export interface ThermoelasticityOptions {
  /** Heat cell counts in x, y and z. There is one more vertex than cell on each axis. */
  readonly dimensions: ThermalAxes;
  /** Cell widths in metres. Defaults to [1, 1, 1]. */
  readonly cellSize?: ThermalAxes;
  /** One material or an indexed palette. Adjacent cells are perfectly bonded. */
  readonly materials: ThermoelasticMaterial | readonly ThermoelasticMaterial[];
  /** Optional palette indices in x-fastest cell order. Defaults to material 0 in every cell. */
  readonly materialIndices?: ArrayLike<number>;
  /** User restraints. The default exterior is traction-free, with only rigid motion removed. */
  readonly restraints?: readonly ThermoelasticRestraint[];
  /** Maximum free nodal force imbalance relative to the initial imbalance. Defaults to 1e-9. */
  readonly relativeTolerance?: number;
  /** Maximum conjugate-gradient steps per equilibrium solve. Defaults to twice the number of free degrees of freedom, at least one. */
  readonly maxIterations?: number;
}

interface ElasticKernel {
  thermoelastic_prepare(
    grid: number,
    coefficients: number,
    constraints: number,
    inverseDiagonal: number,
    dofs: number,
  ): number;
  thermoelastic_solve(
    grid: number,
    coefficients: number,
    constraints: number,
    inverseDiagonal: number,
    temperature: number,
    phase: number,
    displacement: number,
    stress: number,
    reaction: number,
    work: number,
    cells: number,
    dofs: number,
  ): number;
}

interface SolidState {
  readonly host: SolverHost;
  readonly kernel: ElasticKernel;
  readonly cells: number;
  readonly dofs: number;
  readonly grid: Region;
  readonly coefficients: Region;
  readonly constraints: Region;
  readonly inverseDiagonal: Region;
  readonly displacement: Region;
  readonly stress: Region;
  readonly reaction: Region;
  readonly work: Region;
  readonly temperatureCopy: Region;
  readonly phaseCopy?: Region;
  readonly stateRegions: readonly Region[];
}

const LAYOUT = 1;
const F64 = Float64Array.BYTES_PER_ELEMENT;

function f64(memory: WebAssembly.Memory, region: Region): Float64Array {
  return new Float64Array(memory.buffer, region.byteOffset, region.byteLength / F64);
}

function elasticMaterial(material: ThermoelasticMaterial): readonly [number, number, number, number] {
  if (!material || typeof material !== 'object')
    throw thermalError('Thermoelasticity material is invalid; provide its elastic properties.');
  const {
    youngModulus: young,
    poissonRatio: poisson,
    expansionCoefficient: alpha,
    referenceTemperature = 293.15,
  } = material;
  if (!Number.isFinite(young) || !(young > 0) || !Number.isFinite(poisson) || !(poisson > -1 && poisson < 0.5))
    throw thermalError(
      'Thermoelasticity needs finite positive Young’s modulus and Poisson’s ratio strictly between -1 and 0.5.',
    );
  if (!Number.isFinite(alpha) || !Number.isFinite(referenceTemperature) || referenceTemperature < 0)
    throw thermalError(
      'Thermoelasticity needs a finite expansion coefficient and a finite, nonnegative reference temperature.',
    );
  const mu2 = young / (1 + poisson);
  const bulk = young / (3 * (1 - 2 * poisson));
  const expansionPressure = bulk * alpha * 3;
  if (!Number.isFinite(mu2) || !Number.isFinite(bulk) || !Number.isFinite(expansionPressure) || !(bulk > 0))
    throw thermalError(
      'Thermoelasticity elastic coefficients are outside the numeric range; use smaller contrasts and finite moduli.',
    );
  return [mu2, bulk, expansionPressure, referenceTemperature];
}

function addRigidModeRow(basis: number[][], axis: number, x: number, y: number, z: number): boolean {
  // Multiplying the physical displacement rows by their corresponding domain
  // lengths and rescaling the six columns gives the same rank in unit-box coordinates.
  const row = axis === 0 ? [1, 0, 0, 0, z, -y] : axis === 1 ? [0, 1, 0, -z, 0, x] : [0, 0, 1, y, -x, 0];
  for (const mode of basis) {
    let projection = 0;
    for (let j = 0; j < 6; j++) projection += row[j]! * mode[j]!;
    for (let j = 0; j < 6; j++) row[j] = row[j]! - projection * mode[j]!;
  }
  let normSquared = 0;
  for (const item of row) normSquared += item * item;
  const norm = Math.sqrt(normSquared);
  if (norm <= 64 * Number.EPSILON) return false;
  basis.push(row.map((item) => item / norm));
  return true;
}

function prepareConstraints(dimensions: ThermalAxes, dofs: number, restraints: readonly ThermoelasticRestraint[]) {
  const [nx, ny, nz] = dimensions;
  const flags = new Uint8Array(dofs);
  const displacement = new Float64Array(dofs);
  const basis: number[][] = [];
  const index = (i: number, j: number, k: number, axis: number) => 3 * (i + (nx + 1) * (j + (ny + 1) * k)) + axis;
  let constrained = 0;
  for (const restraint of restraints) {
    const node = restraint?.node;
    const values = restraint?.displacement;
    if (
      node?.length !== 3 ||
      ![node[0], node[1], node[2]].every(
        (coordinate, axis) => Number.isSafeInteger(coordinate) && coordinate >= 0 && coordinate <= dimensions[axis]!,
      ) ||
      values?.length !== 3
    )
      throw thermalError(
        'Thermoelasticity restraint is outside the grid; provide a vertex and three displacement components.',
      );
    const x = node[0],
      y = node[1],
      z = node[2];
    for (let axis = 0; axis < 3; axis++) {
      const value = values[axis];
      if (value === null) continue;
      const row = index(x, y, z, axis);
      if (value === undefined || !Number.isFinite(value) || flags[row] !== 0)
        throw thermalError(
          'Thermoelasticity restraint is invalid or repeated; give each fixed component one finite displacement.',
        );
      flags[row] = 2;
      displacement[row] = value === 0 ? 0 : value;
      constrained++;
      if (basis.length < 6) addRigidModeRow(basis, axis, x / nx, y / ny, z / nz);
    }
  }

  // Complete only the missing rigid modes, leaving thermal expansion and
  // all physical restraints intact. These six candidate rows form a full basis.
  const gauge = [
    [0, 0, 0],
    [0, 0, 1],
    [0, 0, 2],
    [nx, 0, 1],
    [nx, 0, 2],
    [0, ny, 2],
  ] as const;
  for (const [x, y, axis] of gauge) {
    if (basis.length === 6) break;
    const row = index(x, y, 0, axis);
    if (flags[row] === 0 && addRigidModeRow(basis, axis, x / nx, y / ny, 0)) {
      flags[row] = 1;
      constrained++;
    }
  }
  if (basis.length < 6)
    throw thermalError('Thermoelasticity could not fix the rigid modes; use restraints at distinct grid vertices.');
  return { flags, displacement, free: dofs - constrained };
}

function prepare(options: ThermoelasticityOptions, readsPhase: boolean) {
  const dimensions = options?.dimensions;
  const size = options?.cellSize ?? [1, 1, 1];
  if (
    dimensions?.length !== 3 ||
    ![dimensions[0], dimensions[1], dimensions[2]].every((count) => Number.isSafeInteger(count) && count > 0)
  )
    throw thermalError('Thermoelasticity needs three positive cell counts. Match the temperature grid.');
  if (size.length !== 3 || ![size[0], size[1], size[2]].every((width) => Number.isFinite(width) && width > 0))
    throw thermalError('Thermoelasticity needs three finite, positive cell sizes. Match the temperature grid.');
  const nx = dimensions[0],
    ny = dimensions[1],
    nz = dimensions[2];
  const hx = size[0],
    hy = size[1],
    hz = size[2];
  const volume = (hx * hy * hz) / 6;
  const inverseSize = [1 / hx, 1 / hy, 1 / hz];
  if (!(volume > 0) || !Number.isFinite(volume) || inverseSize.some((value) => !Number.isFinite(value)))
    throw thermalError('Thermoelasticity cell geometry is outside the numeric range; use representable cell sizes.');
  const cells = nx * ny * nz;
  const dofs = 3 * ((nx + 1) * (ny + 1) * (nz + 1));
  // Includes the working arrays, input copies, outputs and their two registry mirrors.
  const cellWords = readsPhase ? 31 : 30;
  const requiredBytes = F64 * (12 * dofs + cellWords * cells + 48) + dofs;
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes > 0xffffffff)
    throw thermalError('Thermoelasticity grid cannot fit in the Wasm address space; use fewer cells.');
  const tolerance = options.relativeTolerance ?? 1e-9;
  if (!Number.isFinite(tolerance) || !(tolerance > 0 && tolerance < 1))
    throw thermalError('Thermoelasticity relative tolerance is invalid. Choose a value between zero and one.');
  const restraints = options.restraints ?? [];
  if (!Array.isArray(restraints))
    throw thermalError('Thermoelasticity restraints are invalid. Supply an array of nodal restraints.');
  const restrained = prepareConstraints(dimensions, dofs, restraints);
  // Floating-point CG can need more than the exact-arithmetic dimension.
  const maxIterations = options.maxIterations ?? Math.max(2 * restrained.free, 1);
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 0xffffffff)
    throw thermalError('Thermoelasticity iterations are invalid. Choose a positive u32 count.');
  const materials = options.materials;
  if (!materials || typeof materials !== 'object' || (!Array.isArray(materials) && !('youngModulus' in materials)))
    throw thermalError('Thermoelasticity needs elastic properties. Supply a material or material palette.');
  const palette = ('youngModulus' in materials ? [materials] : materials).map(elasticMaterial);
  const indices = options.materialIndices;
  if (palette.length === 0 || (indices !== undefined && indices?.length !== cells))
    throw thermalError('Thermoelasticity materials do not match the grid; supply one palette index per cell.');
  const coefficients = new Float64Array(cells * 4);
  for (let cell = 0; cell < cells; cell++) {
    const i = indices === undefined ? 0 : indices[cell];
    if (i === undefined || !Number.isInteger(i) || i < 0 || i >= palette.length)
      throw thermalError('Thermoelasticity material index is outside the palette; use a valid index.');
    coefficients.set(palette[i]!, cell * 4);
  }
  return {
    cells,
    dofs,
    geometry: [nx, ny, nz, ...inverseSize, volume, tolerance, maxIterations],
    coefficients,
    ...restrained,
  };
}

function source(field: FieldDescriptor, quantity: string, unit: string): FieldDescriptor {
  if (
    !field ||
    field.kind !== 'uniformGrid' ||
    field.centring !== 'cell' ||
    field.quantity !== quantity ||
    field.unit !== unit
  )
    throw thermalError(
      `Thermoelasticity source is incompatible. Publish a cell-centred uniform grid of ${quantity} in ${unit}.`,
    );
  return Object.freeze({ ...field });
}

function output(
  id: string,
  name: string,
  quantity: string,
  unit: string,
  centring: 'vertex' | 'cell',
): FieldDescriptor {
  return Object.freeze({ name: id + '/' + name, kind: 'uniformGrid', quantity, unit, centring });
}

/**
 * One-way quasistatic thermal stress in a small-strain, isotropic solid.
 * It consumes a cell-temperature port and publishes equilibrium after each world tick.
 * Supply the same dimensions, widths, cell order and world origin as the temperature field.
 */
export class Thermoelasticity implements Solver<ThermoelasticityOptions> {
  /** Solver ID and field-name prefix. */
  readonly id: string;
  /** Three displacements in m per vertex, x-fastest grid order. */
  readonly displacementField: FieldDescriptor;
  /** Six averaged Cauchy stress components in Pa per cell: xx, yy, zz, xy, yz, zx. */
  readonly stressField: FieldDescriptor;
  /** Three support reactions in N per vertex, zero on components without user restraints. */
  readonly reactionField: FieldDescriptor;
  readonly #builds: ThermalKernelBuilds;
  readonly #temperature: FieldDescriptor;
  readonly #phase: FieldDescriptor | undefined;
  #data: SolidState | undefined;

  private constructor(id: string, builds: ThermalKernelBuilds, temperature: FieldDescriptor, phase?: FieldDescriptor) {
    this.id = id;
    this.#builds = builds;
    this.#temperature = temperature;
    this.#phase = phase;
    this.displacementField = output(id, 'displacement', 'displacement', 'm', 'vertex');
    this.stressField = output(id, 'stress', 'stress', 'Pa', 'cell');
    this.reactionField = output(id, 'reaction', 'force', 'N', 'vertex');
  }

  /** Loads the optional shared thermal Wasm. A solver instance belongs to one PhysicsWorld. */
  static async load(options: ThermoelasticityLoadOptions): Promise<Thermoelasticity> {
    if (!options?.temperatureField)
      throw thermalError('Thermoelasticity needs temperature. Supply the heat grid field.');
    const id = options.id ?? 'thermoelasticity';
    if (typeof id !== 'string' || id.trim() === '' || id.trim() !== id)
      throw thermalError('Thermoelasticity solver ID is invalid; use a nonempty ID without outer whitespace.');
    const temperature = source(options.temperatureField, 'temperature', 'K');
    const phase = options.liquidFractionField && source(options.liquidFractionField, 'volumeFraction', '1');
    return new Thermoelasticity(id, await loadThermalKernel(options.signal), temperature, phase);
  }

  /** Describes the heat inputs and mechanical outputs at the base world rate. */
  describe(): SolverDescription {
    return {
      id: this.id,
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: this.#temperature, access: 'read' },
        ...(this.#phase ? [{ field: this.#phase, access: 'read' as const }] : []),
        { field: this.displacementField, access: 'write' },
        { field: this.stressField, access: 'write' },
        { field: this.reactionField, access: 'write' },
      ],
    };
  }

  /** Validates the grid and allocates state in the world arena. */
  init(host: SolverHost, options: ThermoelasticityOptions): void {
    if (this.#data)
      throw thermalError('Thermoelasticity is already attached. Load a fresh solver for another world.', 'attached');
    const prepared = prepare(options, this.#phase !== undefined);
    const { cells, dofs } = prepared;
    const kernel = instantiateThermalKernel(host, this.#builds) as unknown as ElasticKernel;
    const allocate = (name: string, words: number) => host.allocate(name, words * F64, 'f64', LAYOUT);
    const grid = allocate('thermoelastic-grid-' + prepared.geometry.slice(0, 3).join('x'), prepared.geometry.length);
    const coefficients = allocate('thermoelastic-coefficients', cells * 4);
    const constraints = host.allocate('thermoelastic-restraints', dofs, 'u8', LAYOUT);
    const inverseDiagonal = allocate('thermoelastic-inverse-diagonal', dofs);
    const displacement = allocate('displacement', dofs);
    const stress = allocate('stress', cells * 6);
    const reaction = allocate('reaction', dofs);
    const work = allocate('thermoelastic-work', 5 * dofs + 7 * cells);
    const temperatureCopy = allocate('thermoelastic-temperature-copy', cells);
    const phaseCopy = this.#phase ? allocate('thermoelastic-phase-copy', cells) : undefined;
    f64(host.memory, grid).set(prepared.geometry);
    f64(host.memory, coefficients).set(prepared.coefficients);
    new Uint8Array(host.memory.buffer, constraints.byteOffset, dofs).set(prepared.flags);
    f64(host.memory, displacement).set(prepared.displacement);
    if (
      kernel.thermoelastic_prepare(
        grid.byteOffset,
        coefficients.byteOffset,
        constraints.byteOffset,
        inverseDiagonal.byteOffset,
        dofs,
      ) !== 0
    )
      throw thermalError(
        'Thermoelasticity stiffness is outside the numeric range; use representable cell sizes and moduli.',
      );
    this.#data = {
      host,
      kernel,
      cells,
      dofs,
      grid,
      coefficients,
      constraints,
      inverseDiagonal,
      displacement,
      stress,
      reaction,
      work,
      temperatureCopy,
      phaseCopy,
      stateRegions: [grid, coefficients, constraints, inverseDiagonal, displacement, stress, reaction],
    };
  }

  /** This solve uses declared read ports and has no accumulated inputs. */
  importPorts(_tick: number): void {}

  /** Solves the current solid equilibrium from the last published thermal fields. */
  step(context: StepContext, _dt: number): void {
    const data = this.#state();
    const temperature = this.#input(context, this.#temperature, data, data.temperatureCopy);
    const phase = this.#phase ? this.#input(context, this.#phase, data, data.phaseCopy!) : 0;
    const status = data.kernel.thermoelastic_solve(
      data.grid.byteOffset,
      data.coefficients.byteOffset,
      data.constraints.byteOffset,
      data.inverseDiagonal.byteOffset,
      temperature,
      phase,
      data.displacement.byteOffset,
      data.stress.byteOffset,
      data.reaction.byteOffset,
      data.work.byteOffset,
      data.cells,
      data.dofs,
    );
    if (status === 2)
      throw thermalError(
        'Thermoelasticity received a non-solid cell. Couple it to an entirely solid region.',
        'unsupported',
      );
    if (status === 3)
      throw thermalError(
        'Thermoelasticity did not converge. Increase the iteration budget or improve grid and material conditioning.',
        'failed',
      );
    if (status !== 0)
      throw thermalError(
        'Thermoelasticity inputs or results left the numeric range. Check the temperature port and scale the solid model.',
        'failed',
      );
  }

  /** Publishes displacement, stress and support reaction for the supplied tick. */
  exportPorts(tick: number): readonly Port[] {
    const data = this.#state();
    const cell = data.host.cell;
    return [
      { field: this.displacementField.name, region: data.displacement, tick, cell },
      { field: this.stressField.name, region: data.stress, tick, cell },
      { field: this.reactionField.name, region: data.reaction, tick, cell },
    ];
  }

  /** World-owned material, boundary and output state needed for snapshot and replay. */
  stateRegions(): readonly Region[] {
    return this.#state().stateRegions;
  }

  /** The equilibrium solve has no time integration history. */
  extraState(): readonly Region[] {
    return [];
  }

  /** Copies the three displacements in metres at each vertex. */
  readDisplacement(): Float64Array {
    const data = this.#state();
    return f64(data.host.memory, data.displacement).slice();
  }

  /** Copies the six cell-average stress components in Pa at each cell. */
  readStress(): Float64Array {
    const data = this.#state();
    return f64(data.host.memory, data.stress).slice();
  }

  /** Copies the three user-support reactions in N at each vertex. */
  readReaction(): Float64Array {
    const data = this.#state();
    return f64(data.host.memory, data.reaction).slice();
  }

  #state(): SolidState {
    if (!this.#data)
      throw thermalError('Thermoelasticity has no solid grid. Add it to a PhysicsWorld before reading or stepping.');
    return this.#data;
  }

  #input(context: StepContext, field: FieldDescriptor, data: SolidState, copy: Region): number {
    const port = context.inputs.get(field.name);
    if (!port) throw thermalError(`Thermoelasticity input ${field.name} is missing. Add the field owner to the world.`);
    const region = port.region;
    if (
      port.field !== field.name ||
      region.type !== 'f64' ||
      region.layout !== LAYOUT ||
      region.byteLength !== data.cells * F64 ||
      port.cell.length !== 3 ||
      port.cell.some((value, axis) => value !== context.cell[axis])
    )
      throw thermalError(
        `Thermoelasticity input ${field.name} does not match the solid grid. Use one f64 per cell in the same origin.`,
      );
    const values = thermalInputWords(data.host.memory, region);
    if ((region.memory ?? data.host.memory) === data.host.memory) return region.byteOffset;
    f64(data.host.memory, copy).set(values);
    return copy.byteOffset;
  }
}
