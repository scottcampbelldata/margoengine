import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

export function growthError(message: string, code: MargoErrorCode = 'state', cause?: unknown): MargoError {
  const error = new MargoError(code, `${message} See https://margoengine.com/errors#plant-growth`);
  return cause === undefined ? error : Object.assign(error, { cause });
}
