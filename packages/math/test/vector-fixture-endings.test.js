import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// The Rust-written bit vectors that pinned.test.js, atmosphere.test.js and fft.test.js compare against are split on
// '\n'. A Windows checkout with core.autocrlf turned them CRLF and every last word on a line kept a '\r', so the
// twins "differed" by a carriage return; .gitattributes pins them to LF. Every vectors file must be LF on disk.
test('kernel-common bit vectors are checked out with LF line endings', () => {
  const dir = new URL('../../physics/kernel-common/tests/', import.meta.url),
    files = readdirSync(dir).filter((name) => name.endsWith('-vectors.txt'));
  assert.ok(files.length >= 3, `vectors files found: ${files}`);
  for (const name of files)
    assert.equal(readFileSync(new URL(name, dir), 'utf8').includes('\r'), false, `${name} has CR line endings`);
});
