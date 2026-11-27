import assert from 'node:assert/strict';
// 25,000 until 2026-11-27; raised for the three core features Scott approved that day ("Yes to all"): snapshot
// rendering took core + stage from 24,989 to 25,099 B gzip. Never above 30,000 (AGENTS.md).
export const CORE_STAGE_GZIP_LIMIT = 25_100;
export function checkCoreBudget(bytes) {
  assert.ok(Number.isSafeInteger(bytes) && bytes >= 0, 'Invalid core + stage gzip size');
  assert.ok(bytes < CORE_STAGE_GZIP_LIMIT, `Core + stage must be below ${CORE_STAGE_GZIP_LIMIT} bytes gzip: ${bytes}`);
}
