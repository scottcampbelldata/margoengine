import {invertMatrixStable} from '@margoengine/math/mat4';
export {finiteVector} from '@margoengine/math/validate';
export function invert(out, matrix, offset = 0, workspace) {
  if (!matrix || !Number.isSafeInteger(offset) || offset < 0 || matrix.length < offset + 16) return false;
  const source = offset === 0 ? matrix : typeof matrix.subarray === 'function'
    ? matrix.subarray(offset, offset + 16) : Array.prototype.slice.call(matrix, offset, offset + 16);
  return invertMatrixStable(source, out, workspace) !== null;
}
