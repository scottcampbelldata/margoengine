// The explosive entry's input errors: code `unsupported`, a message naming the input and its fix, and the help link.
import { MargoError } from '@margoengine/math/errors';

/** An explosive source, gun or hit input that cannot be used. */
export function invalidExplosive(message: string): MargoError {
  return new MargoError('unsupported', `${message} See https://margoengine.com/errors#explosives`);
}
