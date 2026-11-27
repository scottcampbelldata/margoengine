import type { FieldDescriptor } from '../world/solver.js';

/** The registry field of the water on the ground: per cell h (m), hu and hv (m^2/s), owned by {@link ShallowWaterSolver}. */
export const SURFACE_WATER_FIELD: FieldDescriptor = {
  name: 'surfaceWater',
  kind: 'uniformGrid',
  quantity: 'waterDepthAndDischarge',
  unit: 'm, m^2/s',
  centring: 'cell',
};
/** The layout of the solver's regions: per cell (x fastest), h, hu, hv. */
export const SURFACE_WATER_LAYOUT = 1;
/**
 * The registry field the water takes waves' forcing from, owned by {@link ShallowWaterSolver}: per cell, the force of the
 * waves' radiation stress over the water's density (m^2/s^2 along x and z: the momentum per area per second it adds), the
 * waves' Stokes drift (m/s along x and z: the water's momentum is Lagrangian, its bed friction acts on what is left of it),
 * and the waves' rms orbital velocity at the bed (m/s: it stirs the bed friction). Contributors (the surf zone) add; the
 * registry sums them by contributor, then cell.
 */
export const SURFACE_WATER_FORCING_FIELD: FieldDescriptor = {
  name: 'surfaceWaterForcing',
  kind: 'uniformGrid',
  quantity: 'waveForcing',
  unit: 'm^2/s^2, m/s',
  centring: 'cell',
};
/**
 * The registry field of the forces on the water that are the gradient of a height (SEA-07): per cell a forcing potential
 * psi, m (f64), owned by {@link ShallowWaterSolver}. The water adds it to its bed in its hydrostatic reconstruction, so the
 * force is -g h grad(psi) and water at rest stands at -psi to rounding: the inverse barometer (p - p_ref) / (rho g) and minus
 * the equilibrium tide. Contributors (`SurgeSolver` of `@margoengine/physics/surge`) add; the registry sums them by
 * contributor, then cell.
 */
export const SURFACE_WATER_POTENTIAL_FIELD: FieldDescriptor = {
  name: 'surfaceWaterPotential',
  kind: 'uniformGrid',
  quantity: 'forcingPotential',
  unit: 'm',
  centring: 'cell',
};
/** f64 words of a cell's record in `surfaceWaterForcing`: force x, z over density, Stokes drift x, z, rms orbital velocity. */
export const FORCING_WORDS = 5;
/** Fresh water's density, kg/m^3. */
export const WATER_DENSITY = 1000;
