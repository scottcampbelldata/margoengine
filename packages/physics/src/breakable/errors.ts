import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

const HELP_URL = 'https://margoengine.com/errors#physics-breakable';

/** A coded {@link MargoError} with the breakable help link: `disposed` or `state` for use, `unsupported` for input. */
export function breakableFault(code: MargoErrorCode, message: string): MargoError {
  return new MargoError(code, `${message}; see ${HELP_URL}`);
}

/** A breakable input that cannot be used: code `unsupported`, the message naming the input and its fix. */
export function breakableInput(message: string): MargoError {
  return breakableFault('unsupported', message);
}
