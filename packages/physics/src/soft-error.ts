import { MargoError } from '@margoengine/math/errors';

/**
 * The refusal of every soft-body call given what it cannot use (`@margoengine/physics/soft`): a `MargoError` with code
 * `unsupported`, the message naming the fix, and a link to its errors entry.
 */
export const softError = (message: string): MargoError =>
  new MargoError('unsupported', `${message} See https://margoengine.com/errors#soft-bodies`);
