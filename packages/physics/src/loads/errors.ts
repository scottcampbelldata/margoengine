import { MargoError } from '@margoengine/math/errors';

export function invalidLoad(message: string): MargoError {
  return new MargoError('unsupported', `${message} See https://margoengine.com/errors#hydrodynamic-loads`);
}
