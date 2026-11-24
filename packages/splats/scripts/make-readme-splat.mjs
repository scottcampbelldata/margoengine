// Test-only derivative of the documented real capture excerpt, not an independent .splat encoder oracle.
// Run from the repository root after building packages. No training or geometry generation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { requiredFixture } from '../../../scripts/support/required-fixture.mjs';
import { encodeSplat, parsePly, validateSplats } from '../dist/data.js';

const source = requiredFixture(new URL('../test/fixtures/raccoon-v2.ply', import.meta.url), 'git lfs pull');
assert.equal(createHash('sha256').update(source).digest('hex'),
  'a0f8332242dd99f6b8a8c8aff6df829bafef0eb0e557d4e531ffc031906cd9a6');
const data = parsePly(source);
assert.equal(validateSplats(data), 8385);
const bytes = encodeSplat(data);
writeFileSync(new URL('../test/fixtures/raccoon-v2.splat', import.meta.url), bytes);
console.log(`README .splat: ${bytes.length} bytes, SHA-256 ${createHash('sha256').update(bytes).digest('hex')}`);
