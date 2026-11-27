// Coded errors of the joints, each with the joints' help link (docs/physics-parity-bar.md Part 1, item 3).
import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

const HELP = '; see https://margoengine.com/errors#physics-joints';

/** A coded {@link MargoError} whose message ends with the joints' help link. */
export function jointFault(code: MargoErrorCode, message: string): MargoError {
  return new MargoError(code, message + HELP);
}

/** A joint option or argument that cannot be used: code `unsupported`, the message naming it and its fix. */
export function jointInput(message: string): MargoError {
  return jointFault('unsupported', message);
}
