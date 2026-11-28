import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

export function hullError(code: MargoErrorCode, message: string): MargoError {
  return new MargoError(code, message + ' See https://margoengine.com/errors#ship-seakeeping');
}
