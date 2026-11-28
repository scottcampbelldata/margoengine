import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

export function floodError(code: MargoErrorCode, message: string): MargoError {
  return new MargoError(code, message + ' See https://margoengine.com/errors#hull-flooding');
}
