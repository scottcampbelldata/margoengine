import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

export function synopticError(message: string, code: MargoErrorCode = 'state', cause?: unknown): MargoError {
  const error = new MargoError(code, `${message} See https://margoengine.com/errors#synoptic`);
  return cause === undefined ? error : Object.assign(error, { cause });
}
