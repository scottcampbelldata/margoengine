import assert from 'node:assert/strict';
export const CORE_STAGE_GZIP_LIMIT = 25_000;
export function checkCoreBudget(bytes) {
  assert.ok(Number.isSafeInteger(bytes) && bytes >= 0, 'Invalid core + stage gzip size');
  assert.ok(bytes < CORE_STAGE_GZIP_LIMIT, `Core + stage must be below ${CORE_STAGE_GZIP_LIMIT} bytes gzip: ${bytes}`);
}
