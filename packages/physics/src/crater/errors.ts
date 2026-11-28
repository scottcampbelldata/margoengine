// The crater entry's refusals (EARTH-06): each a coded MargoError whose message names the fix and links to its entry on
// margoengine.com/errors, as the ship entry's are.
import { MargoError } from '@margoengine/math/errors';

/** A refusal of the crater entry: `unsupported` for an input it cannot use, `state` for a call it cannot answer now. */
export function craterError(message: string, code: 'unsupported' | 'state' = 'unsupported'): MargoError {
  return new MargoError(code, `${message} See https://margoengine.com/errors#craters`);
}
