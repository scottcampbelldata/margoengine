import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

export function leggedError(message: string, code: MargoErrorCode = 'state', cause?: unknown): MargoError {
  const error = new MargoError(code, `${message} See https://margoengine.com/errors#legged`);
  return cause === undefined ? error : Object.assign(error, { cause });
}
