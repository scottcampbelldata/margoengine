// Every statement of the Node version this repository needs agrees with package.json "engines". The version users of the
// built packages need (22.12) is a different, deliberate number. Node 22 is not blocked here: CI runs `npm ci` and
// `npm run build:packages` on 22.12.0 and 22 as the end-user proof, so a Node below the engines range gets npm's one
// EBADENGINE warning naming the required version rather than a hard stop.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const minimum = JSON.parse(read('package.json')).engines.node.replace(/^>=/, '').split('.').slice(0, 2).join('.');

test('engines names a Node 24 minimum', () => {
  assert.match(minimum, /^24\.\d+$/);
});

test('README and CONTRIBUTING state the contributor Node minimum from engines', () => {
  const readme = read('README.md'), contributing = read('CONTRIBUTING.md');
  assert.ok(readme.includes(`Node.js ${minimum} or newer`), 'README quick start');
  assert.ok(readme.includes(`You need Node.js ${minimum}+`), 'README build from source');
  assert.ok(contributing.includes(`Node.js ${minimum}+`), 'CONTRIBUTING');
});

test('no document claims a different contributor minimum', () => {
  const stray = [];
  for (const file of ['README.md', 'CONTRIBUTING.md', 'docs/README.md']) {
    for (const [, version] of read(file).matchAll(/Node(?:\.js)? (2[0-9]\.\d+)(?:\+| or newer)/g)) {
      if (version !== minimum && version !== '22.12') stray.push(`${file}: ${version}`);
    }
  }
  assert.deepEqual(stray, []);
});
