import type { FieldDescriptor } from '../world/solver.js';

export const SHELL_APERTURE_QUANTITY = 'shellSeamAperture';
/** Layout version of the shell seam aperture field. */
export const SHELL_APERTURE_LAYOUT = 1;
/** Area in square metres, followed by four xyz vertices in the port's origin cell. */
export const SHELL_APERTURE_WORDS = 13;

export const SHELL_PRESSURE_LAYOUT = 1;
/** Presence, exterior level, interior level, interior air overpressure and water specific weight. */
export const SHELL_PRESSURE_WORDS = 5;

export function shellApertureField(id: string): FieldDescriptor {
  return {
    name: `${id}:shellApertures`,
    kind: 'surfaceSampleSet',
    quantity: SHELL_APERTURE_QUANTITY,
    unit: 'm², m',
    centring: 'particle',
  };
}

export function shellPressureField(id: string): FieldDescriptor {
  return {
    name: `${id}:shellPressure`,
    kind: 'surfaceSampleSet',
    quantity: 'shellHydrostaticPressure',
    unit: 'm, Pa, N/m³',
    centring: 'particle',
  };
}
