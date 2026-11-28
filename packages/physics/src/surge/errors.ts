import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

export function surgeError(code: MargoErrorCode, message: string, cause?: unknown): MargoError {
  const error = new MargoError(code, `${message} See https://margoengine.com/errors#storm-surge`);
  if (cause !== undefined) error.cause = cause;
  return error;
}
