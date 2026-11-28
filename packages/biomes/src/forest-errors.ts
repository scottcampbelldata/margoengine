import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

export function forestError(message: string, code: MargoErrorCode = 'state', cause?: unknown): MargoError {
  const error = new MargoError(code, `${message} See https://margoengine.com/errors#forest`);
  return cause === undefined ? error : Object.assign(error, { cause });
}
