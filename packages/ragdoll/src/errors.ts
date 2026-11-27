import { MargoError } from '@margoengine/math/errors';

/** A coded error for bad input to a ragdoll, its debug lines or its character bridge, linked to its help entry. */
export const ragdollError = (message: string): MargoError =>
  new MargoError('unsupported', `${message} See https://margoengine.com/errors#ragdolls`);
