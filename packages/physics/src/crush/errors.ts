import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

export function crushError(code: MargoErrorCode, message: string): MargoError {
  return new MargoError(code, `${message} See https://margoengine.com/errors#ductile-crush`);
}
