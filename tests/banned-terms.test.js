// The banned-terms check catches the private kernel's names in public text, and its list never holds them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hitsInLine, scan, scanRepo } from '../scripts/check-banned-terms.mjs';

const word = (...codes) => String.fromCharCode(...codes);
const repo = `${word(109, 97, 114, 103, 111)}-${word(99, 97, 100)}-${word(107, 101, 114, 110, 101, 108)}`; // the private repo name
const pkg = `${word(109, 97, 114, 103, 111, 101, 110, 103, 105, 110, 101)}/${word(98, 114, 101, 112)}`;

test('the repo name, with or without hyphens, and the package path are reported', () => {
  assert.equal(hitsInLine(`see ${repo} for more`).length > 0, true);
  assert.equal(hitsInLine(repo.replaceAll('-', '')).length > 0, true);
  assert.equal(hitsInLine(`import x from '@${pkg}'`).length > 0, true);
  assert.equal(hitsInLine(`packages/${word(98, 114, 101, 112)}/src`).length > 0, true);
  assert.equal(hitsInLine(word(80, 97, 114, 97, 115, 111, 108, 105, 100)).length > 0, true);
});

test('ordinary text and OpenCascade names pass; binary data is skipped', () => {
  assert.deepEqual(hitsInLine('OpenCascade tessellates STEP and IGES files in a worker'), []);
  assert.deepEqual(scan(Buffer.concat([Buffer.from([0]), Buffer.from(repo)])), []);
  assert.equal(scan(Buffer.from(`ok\n${repo}\n`)).at(0).line, 2);
});

test('the list file holds hashes only', () => {
  const text = readFileSync(new URL('../scripts/banned-terms.json', import.meta.url), 'utf8').toLowerCase();
  assert.equal(text.includes(repo), false);
  assert.equal(text.includes(pkg), false);
});

test('no tracked file names the private kernel', () => {
  assert.deepEqual(scanRepo(), []);
});
