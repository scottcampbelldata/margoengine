// The ship entry's refusals (SEA-09): each a coded MargoError whose message names the fix and links to its entry on
// margoengine.com/errors, as the loads entry's are.
import { MargoError } from '@margoengine/math/errors';

/** A refusal of the ship entry: `unsupported` for an input it cannot use, `state` for a call the solver cannot answer now. */
export function shipError(message: string, code: 'unsupported' | 'state' = 'unsupported'): MargoError {
  return new MargoError(code, `${message} See https://margoengine.com/errors#ships`);
}
