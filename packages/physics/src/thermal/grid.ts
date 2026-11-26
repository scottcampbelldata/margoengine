/** A uniform grid shape or a vector of cell widths, ordered x, y, z. */
export type ThermalAxes = readonly [number, number, number];

/** Which exterior face a boundary condition applies to. */
export type ThermalFace = 'xMin' | 'xMax' | 'yMin' | 'yMax' | 'zMin' | 'zMax';

/** Material data in SI units, held fixed during the solve. */
export interface ThermalMaterial {
  /** Isotropic thermal conductivity, W/(m K). Zero insulates the material. */
  readonly conductivity: number;
  /** Volumetric solid heat capacity, J/(m³ K). */
  readonly heatCapacity: number;
  /** Same temperature on melting and freezing. Omission models sensible heat only. */
  readonly phaseChange?: {
    /** Melting temperature in K. */
    readonly temperature: number;
    /** Latent heat of fusion per volume, J/m³. */
    readonly latentHeat: number;
    /** Volumetric liquid heat capacity, J/(m³ K). Defaults to the solid heat capacity. */
    readonly liquidHeatCapacity?: number;
  };
}

/** Exterior face condition. The default for an omitted face is zero heat flux. */
export type ThermalBoundary =
  | { readonly kind: 'temperature'; readonly kelvin: number }
  | { readonly kind: 'convection'; readonly kelvin: number; readonly coefficient: number }
  | {
      readonly kind: 'radiation';
      /** Temperature of the surroundings, K. Also used for the optional convection film. */
      readonly kelvin: number;
      /** Diffuse-grey emissivity between zero and one. */
      readonly emissivity: number;
      /** Optional convection coefficient in W/(m² K). Defaults to zero. */
      readonly coefficient?: number;
    }
  | { readonly kind: 'flux'; readonly wattsPerSquareMetre: number };

/** Initial conditions for one cell-centred thermal grid. Cell arrays run x fastest, then y, then z. */
export interface HeatConductionOptions {
  /** Positive integer cell counts in x, y and z. A singleton axis still has a physical width. */
  readonly dimensions: ThermalAxes;
  /** Positive, finite cell widths in metres. Defaults to [1, 1, 1]. */
  readonly cellSize?: ThermalAxes;
  /** A uniform material or a nonempty palette. */
  readonly materials: ThermalMaterial | readonly ThermalMaterial[];
  /** One palette index per cell. Defaults to material 0 in every cell. */
  readonly materialIndices?: ArrayLike<number>;
  /** Temperature in K, either uniform or one number per cell. Defaults to 293.15 K. */
  readonly initialTemperature?: number | ArrayLike<number>;
  /** Melt fraction at the melting temperature. Defaults to 0 at that temperature. */
  readonly initialLiquidFraction?: number | ArrayLike<number>;
  /** Exterior temperature, convection, radiation or heat flux in W/m² into the grid. Omitted faces are insulated. */
  readonly boundaries?: Partial<Record<ThermalFace, ThermalBoundary>>;
  /** Time integration. Defaults to 'explicit'. 'implicit' uses backward Euler. */
  readonly integration?: 'explicit' | 'implicit';
}

export const COEFFICIENTS = 11;
// The Rust stencil reads these records as [cell, half-cell conductance, radiative factor, film, surrounding K].
export const RADIATION_WORDS = 5;
const STEFAN_BOLTZMANN = 5.6703744191844314e-8;
type Radiation = readonly [number, number, number, number];
type FaceBalance = readonly [conductance: number, power: number, radiation?: Radiation];

const faces = [
  ['xMin', 'xMax'],
  ['yMin', 'yMax'],
  ['zMin', 'zMax'],
] as const;

// Planar layout shared with thermal-kernel/src/lib.rs.
const INV_SOLID = 0;
const INV_LIQUID = 1;
const SOLIDUS = 2;
const LIQUIDUS = 3;
const INV_LATENT = 4;
const FACE_X = 5;
const BOUNDARY = 8;
const POWER = 9;
const CONDUCTANCE = 10;

function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(name + ' must be finite and nonnegative; pass a value in range.');
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(name + ' must be finite and positive; pass a value in range.');
  return value;
}

function vector(value: ThermalAxes, name: string): ThermalAxes {
  if (value.length !== 3) throw new RangeError(name + ' requires three axes; pass [x, y, z].');
  return [positive(value[0], name), positive(value[1], name), positive(value[2], name)];
}

function cellValue(value: number | ArrayLike<number>, i: number): number {
  return typeof value === 'number' ? value : value[i]!;
}

function materialData(material: ThermalMaterial, volume: number) {
  const conductivity = nonnegative(material.conductivity, 'Thermal conductivity');
  const solid = positive(material.heatCapacity * volume, 'Solid cell heat capacity');
  const phase = material.phaseChange;
  const liquid = positive((phase?.liquidHeatCapacity ?? material.heatCapacity) * volume, 'Liquid cell heat capacity');
  const melting = phase ? positive(phase.temperature, 'Melting temperature') : 0;
  const latent = phase ? positive(phase.latentHeat * volume, 'Latent heat per cell') : 0;
  const solidus = phase ? positive(solid * melting, 'Solidus enthalpy') : 0;
  const liquidus = nonnegative(solidus + latent, 'Liquidus enthalpy');
  if (phase && liquidus === solidus)
    throw new RangeError(
      'Latent heat rounds away at the solidus; pass material data with a representable latent heat.',
    );
  return {
    conductivity,
    solid,
    liquid,
    melting,
    latent,
    solidus,
    liquidus,
    invSolid: positive(1 / solid, 'Inverse solid cell heat capacity'),
    invLiquid: positive(1 / liquid, 'Inverse liquid cell heat capacity'),
    invLatent: phase ? positive(1 / latent, 'Inverse latent heat per cell') : 0,
  };
}

function boundaryData(
  boundary: ThermalBoundary | undefined,
  area: number,
  halfWidth: number,
): (conductivity: number) => FaceBalance {
  if (boundary === undefined) return () => [0, 0] as const;
  if (boundary.kind === 'flux') {
    const watts = boundary.wattsPerSquareMetre * area;
    if (!Number.isFinite(watts))
      throw new RangeError('Boundary heat flux overflows; pass a finite flux and face area.');
    return () => [0, watts] as const;
  }
  if (boundary.kind !== 'temperature' && boundary.kind !== 'convection' && boundary.kind !== 'radiation')
    throw new TypeError('Unknown thermal boundary; pass a temperature, convection, radiation or flux condition.');
  const kelvin = nonnegative(boundary.kelvin, 'Boundary temperature');
  const film =
    boundary.kind === 'temperature'
      ? Infinity
      : nonnegative(
          boundary.kind === 'radiation' ? (boundary.coefficient ?? 0) : boundary.coefficient,
          'Convection coefficient',
        );
  if (boundary.kind === 'radiation') {
    const emissivity = nonnegative(boundary.emissivity, 'Emissivity');
    if (emissivity > 1) throw new RangeError('Emissivity is greater than one; pass a value from 0 to 1.');
    if (emissivity > 0) {
      const factor = STEFAN_BOLTZMANN * emissivity * area;
      const convective = nonnegative(film * area, 'Face convection conductance');
      return (conductivity) => {
        const conductance = area / (halfWidth / conductivity);
        return conductance === 0 ? [0, 0] : [0, 0, [conductance, factor, convective, kelvin]];
      };
    }
  }
  return (conductivity: number) => {
    const conductance = film === 0 || conductivity === 0 ? 0 : area / (halfWidth / conductivity + 1 / film);
    return [conductance, conductance * kelvin] as const;
  };
}

function faceConductance(k1: number, k2: number, scale: number): number {
  const low = Math.min(k1, k2);
  return low === 0 ? 0 : (low / (0.5 + 0.5 * (low / Math.max(k1, k2)))) * scale;
}

export function prepareThermalGrid(options: HeatConductionOptions) {
  const integration = options.integration ?? 'explicit';
  if (integration !== 'explicit' && integration !== 'implicit')
    throw new TypeError('Unknown thermal integration; pass explicit or implicit.');
  const dimensions = vector(options.dimensions, 'Thermal grid dimensions');
  const cellSize = vector(options.cellSize ?? [1, 1, 1], 'Thermal cell size');
  const [nx, ny, nz] = dimensions;
  const count = nx * ny * nz;
  if (!dimensions.every(Number.isSafeInteger) || count * COEFFICIENTS * 8 >= 0x100000000)
    throw new RangeError('Thermal grid does not fit its Wasm address space; pass smaller positive integer dimensions.');
  const [width, height, depth] = cellSize;
  const areas = [height * depth, width * depth, width * height];
  const volume = positive(width * areas[0]!, 'Cell volume');
  const factors = areas.map((area, axis) => positive(area / cellSize[axis]!, 'Face area divided by spacing'));
  const boundaries = faces.map((pair, axis) =>
    pair.map((face) => boundaryData(options.boundaries?.[face], areas[axis]!, cellSize[axis]! * 0.5)),
  );

  const palette = 'conductivity' in options.materials ? [options.materials] : options.materials;
  if (palette.length === 0) throw new RangeError('Thermal materials are empty; pass at least one material.');
  const data = palette.map((material) => materialData(material, volume));
  const indices = options.materialIndices;
  const initial = options.initialTemperature ?? 293.15;
  const fractions = options.initialLiquidFraction ?? 0;
  for (const values of [indices, initial, fractions]) {
    if (values !== undefined && typeof values !== 'number' && values.length !== count)
      throw new RangeError('Thermal cell data has the wrong length; pass one value per cell in x-fastest order.');
  }

  const energy = new Float64Array(count);
  const coefficients = new Float64Array(count * COEFFICIENTS);
  for (let i = 0; i < count; i++) {
    const index = indices === undefined ? 0 : indices[i]!;
    if (!Number.isInteger(index) || index < 0 || index >= data.length)
      throw new RangeError('Thermal material index is outside the palette; pass a valid index for every cell.');
    const material = data[index]!;
    const kelvin = nonnegative(cellValue(initial, i), 'Initial temperature');
    const fraction = nonnegative(cellValue(fractions, i), 'Initial liquid fraction');
    if (fraction > 1 || (fraction > 0 && (material.latent === 0 || kelvin !== material.melting)))
      throw new RangeError('Initial liquid fraction is invalid; pass 0 to 1 at the melting temperature or omit it.');
    const stored =
      kelvin <= material.melting
        ? material.solid * kelvin + material.latent * fraction
        : material.liquidus + (kelvin - material.melting) * material.liquid;
    energy[i] = nonnegative(stored, 'Initial cell enthalpy');
    coefficients[INV_SOLID * count + i] = material.invSolid;
    coefficients[INV_LIQUID * count + i] = material.invLiquid;
    coefficients[SOLIDUS * count + i] = material.solidus;
    coefficients[LIQUIDUS * count + i] = material.liquidus;
    coefficients[INV_LATENT * count + i] = material.invLatent;
  }

  let stiffness = 0;
  const radiators: number[] = [];
  const strides = [1, nx, nx * ny];
  const k = (i: number) => data[indices === undefined ? 0 : indices[i]!]!.conductivity;
  for (let i = 0; i < count; i++) {
    let boundaryConductance = 0;
    let watts = 0;
    let conductanceSum = 0;
    for (let axis = 0; axis < 3; axis++) {
      const stride = strides[axis]!;
      const coordinate = Math.floor(i / stride) % dimensions[axis]!;
      const faceOffset = (FACE_X + axis) * count + i;
      const conductivity = k(i);
      if (coordinate === 0) {
        const [conductance, power, radiation] = boundaries[axis]![0]!(conductivity);
        if (radiation) {
          radiators.push(i, ...radiation);
          conductanceSum += radiation[0];
        }
        boundaryConductance += conductance;
        watts += power;
      } else {
        conductanceSum += coefficients[faceOffset - stride]!;
      }
      if (coordinate + 1 === dimensions[axis]) {
        const [conductance, power, radiation] = boundaries[axis]![1]!(conductivity);
        if (radiation) {
          radiators.push(i, ...radiation);
          conductanceSum += radiation[0];
        }
        boundaryConductance += conductance;
        watts += power;
      } else {
        const conductance = faceConductance(conductivity, k(i + stride), factors[axis]!);
        coefficients[faceOffset] = conductance;
        conductanceSum += conductance;
      }
    }
    if (!Number.isFinite(watts))
      throw new RangeError('Total boundary heat flux overflows; reduce the flux or use a smaller cell.');
    coefficients[BOUNDARY * count + i] = boundaryConductance;
    coefficients[POWER * count + i] = watts;
    const diagonal = conductanceSum + boundaryConductance;
    coefficients[CONDUCTANCE * count + i] = diagonal;
    const invCapacity = Math.max(coefficients[INV_SOLID * count + i]!, coefficients[INV_LIQUID * count + i]!);
    stiffness = Math.max(stiffness, diagonal * invCapacity);
  }
  if (!Number.isFinite(stiffness))
    throw new RangeError('Thermal diffusion rate overflows; reduce conductivity or increase cell size.');
  return { dimensions, cellSize, integration, stiffness, coefficients, energy, radiation: new Float64Array(radiators) };
}
