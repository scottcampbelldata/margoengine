import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

export function surfError(code: MargoErrorCode, message: string): MargoError {
  return new MargoError(code, `${message} See https://margoengine.com/errors#nearshore-surf`);
}
