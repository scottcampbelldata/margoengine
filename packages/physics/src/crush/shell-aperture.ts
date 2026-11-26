import type { FieldDescriptor } from '../world/solver.js';

export const SHELL_APERTURE_QUANTITY = 'shellSeamAperture';
export const SHELL_APERTURE_LAYOUT = 1;
/** Area in square metres, followed by four xyz vertices in the port's origin cell. */
export const SHELL_APERTURE_WORDS = 13;

export function shellApertureField(id: string): FieldDescriptor {
  return {
    name: `${id}:shellApertures`,
    kind: 'surfaceSampleSet',
    quantity: SHELL_APERTURE_QUANTITY,
    unit: 'm², m',
    centring: 'particle',
  };
}
