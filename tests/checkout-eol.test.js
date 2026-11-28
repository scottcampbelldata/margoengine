// A checkout holds the bytes its .gitattributes rules give (KB-CI-EOL-STALE1). Git writes a file again only when its
// blob changes, so a long-lived checkout keeps the CRLF an earlier checkout wrote for a file whose rule became -text or
// eol=lf later. Byte-exact tests of such a file (licensed fixtures by SHA-256, pinned vectors) then fail on that machine
// only, with a misleading message. This test names those files: a tracked file whose rule forbids CRLF, whose working
// copy has CRLF and whose index copy does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

/** The paths `git ls-files --eol -z` output names as stale: rule -text or eol=lf, w/crlf, index not crlf. */
export function staleEol(listing) {
  return listing.split('\0').flatMap((line) => {
    const tab = line.indexOf('\t'),
      [index, work, ...attr] = line.slice(0, tab).trim().split(/\s+/);
    return tab > 0 && work === 'w/crlf' && index !== 'i/crlf' && /^attr\/(-text|.*eol=lf)/.test(attr.join(' '))
      ? [line.slice(tab + 1)]
      : [];
  });
}

test('staleEol picks only files whose rule forbids CRLF the working copy has', () => {
  const rows = [
    'i/lf    w/crlf  attr/-text            \tstale-binary.ifc',
    'i/lf    w/crlf  attr/text eol=lf      \tstale-lf.txt',
    'i/lf    w/crlf  attr/                 \tauto-crlf.js',
    'i/crlf  w/crlf  attr/-text            \tcrlf-blob.obj',
    'i/lf    w/lf    attr/-text            \tclean.ifc',
    'i/lf    w/crlf  attr/text             \ttext-crlf.md',
  ];
  assert.deepEqual(staleEol(rows.join('\0') + '\0'), ['stale-binary.ifc', 'stale-lf.txt']);
});

test('no tracked file keeps CRLF its .gitattributes rule forbids', () => {
  const listing = execFileSync('git', ['ls-files', '--eol', '-z'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    maxBuffer: 256 << 20,
  });
  assert.deepEqual(
    staleEol(listing),
    [],
    'stale line endings in this checkout; delete each file and run git checkout -- <file> to write it again',
  );
});
