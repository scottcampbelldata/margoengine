import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// UTF-8 read as a Windows single-byte encoding, then saved as UTF-8, stays valid
// UTF-8 but corrupts text. A plain decode/encode round trip cannot detect that.
const artifacts = /\u00c2[\u0080-\u00bf]|\u00c3[\u0080-\u00bf]/;

test('limits and its generated LLM copy have no UTF-8 decoded as a single-byte encoding', () => {
  assert.match(Buffer.from('\u00b5', 'utf8').toString('latin1'), artifacts, 'the damaged micro sign is detected');
  assert.doesNotMatch('\u00b5 \u00d7 \u03c0', artifacts, 'the original Unicode is valid');
  for (const file of ['docs/limits.md', 'site/llms-full.txt'])
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), artifacts, file);
});
