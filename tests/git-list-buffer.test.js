// KB-GIT-LISTBUF1: execFileSync and spawnSync keep at most 1 MiB of output by default (maxBuffer). The repository's
// file list passed 1 MiB on 2026-11-27 (1,048,627 B), and every script that listed the whole tree with `git ls-files`
// (the quality gate, hygiene, the fixture-skip check) failed with ENOBUFS. Every `git ls-files` call states a maxBuffer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const CALL = /\b(execFileSync|spawnSync)\(\s*['"`]git['"`]\s*,\s*\[[^\]]*['"`]ls-files['"`]/g;

/** The text of the call starting at `start` (the call name), up to its closing parenthesis. */
function callAt(text, start) {
  let depth = 0;
  for (let i = text.indexOf('(', start); i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/** `file:line` of every `git ls-files` call in `text` whose options name no maxBuffer. */
function unbuffered(text, file) {
  const found = [];
  for (const match of text.matchAll(CALL))
    if (!/\bmaxBuffer\b/.test(callAt(text, match.index)))
      found.push(`${file}:${text.slice(0, match.index).split('\n').length}`);
  return found;
}

test('the detector finds a git ls-files call without maxBuffer, inline or through an options variable', () => {
  assert.deepEqual(unbuffered("execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })", 'a.js'), ['a.js:1']);
  assert.deepEqual(unbuffered("x;\nspawnSync('git', ['ls-files'], options)", 'b.js'), ['b.js:2']);
  assert.deepEqual(
    unbuffered("execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 2 ** 28 })", 'c.js'),
    [],
  );
  assert.deepEqual(unbuffered("execFileSync('git', ['diff', '--name-only'], {})", 'd.js'), []);
});

test('every git ls-files call in tracked scripts and tests states a maxBuffer', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.js', '*.mjs', '*.cjs', '*.ts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 2 ** 28,
  })
    .split('\0')
    // This file holds unbuffered calls as detector samples.
    .filter((file) => file && !file.includes('/dist/') && file !== 'tests/git-list-buffer.test.js');
  const found = files.flatMap((file) => {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      return [];
    }
    return text.includes('ls-files') ? unbuffered(text, file) : [];
  });
  assert.deepEqual(found, [], 'these calls keep the 1 MiB default and fail with ENOBUFS once the list passes it');
});
