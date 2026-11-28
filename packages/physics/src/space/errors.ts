import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

export function celestialError(message: string, code: MargoErrorCode = 'state', cause?: unknown): MargoError {
  const error = new MargoError(code, `${message} See https://margoengine.com/errors#celestial`);
  return cause === undefined ? error : Object.assign(error, { cause });
}
