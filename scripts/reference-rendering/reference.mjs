import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

/** Validate a recapture before replacing the frozen picture, so a deployment change cannot destroy it. */
export function saveReference(path, picture, expectedHash) {
  const hash = createHash('sha256').update(picture).digest('hex');
  if (expectedHash !== undefined)
    assert.equal(hash, expectedHash, 'Outside reference changed; frozen picture preserved');
  writeFileSync(path, picture);
  return hash;
}
