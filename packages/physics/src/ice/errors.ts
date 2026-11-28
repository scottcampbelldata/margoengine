import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

export function iceError(message: string, code: MargoErrorCode = 'state', cause?: unknown): MargoError {
  const error = new MargoError(code, `${message} See https://margoengine.com/errors#ice-thermal`);
  return cause === undefined ? error : Object.assign(error, { cause });
}
