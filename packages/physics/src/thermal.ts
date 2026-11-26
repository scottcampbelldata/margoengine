export { HeatConduction, type HeatConductionLoadOptions } from './thermal/solver.js';
export type {
  HeatConductionOptions,
  ThermalAxes,
  ThermalBoundary,
  ThermalFace,
  ThermalMaterial,
} from './thermal/grid.js';
export {
  Thermoelasticity,
  type ThermoelasticityLoadOptions,
  type ThermoelasticityOptions,
  type ThermoelasticMaterial,
  type ThermoelasticRestraint,
} from './thermal/stress.js';
