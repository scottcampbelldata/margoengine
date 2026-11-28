import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

export function groundwaterError(message: string, code: MargoErrorCode = 'state', cause?: unknown): MargoError {
  const error = new MargoError(code, `${message} See https://margoengine.com/errors#groundwater`);
  return cause === undefined ? error : Object.assign(error, { cause });
}
