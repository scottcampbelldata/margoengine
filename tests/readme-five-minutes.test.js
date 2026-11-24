// README "Build something in 5 minutes" is the first thing a new developer runs: clone, install, two commands, open a
// URL, edit one file. A fresh-clone run on 2026-11-12 found the printed server address answered a blank 404 and the
// install ended with an allow-scripts notice that read like a failure (tests/dev-examples.test.js and
// tests/install-scripts.test.js cover those). This keeps the section's commands, URL and edit step true to the repository.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { blocks } from '../scripts/support/doc-snippets.mjs';
import { QUICKSTART_PAGE } from '../vite.config.mjs';

const root = join(import.meta.dirname, '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const heading = '## Build something in 5 minutes';
const start = readme.indexOf(`${heading}\n`);
const section = readme.slice(start, readme.indexOf('\n## ', start + heading.length));
const commands = (code) =>
  code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^\$env:|^\w+=\S+$/.test(line))
    .map((line) => line.replace(/^\w+=\S+\s+/, ''));

test('the section comes before Install and has one shell block and its PowerShell twin with the same commands', () => {
  assert.ok(start > 0 && start < readme.indexOf('\n## Install\n'), 'the section is near the top, before Install');
  const found = blocks(section);
  assert.deepEqual(
    found.map((b) => b.lang),
    ['sh', 'powershell'],
  );
  assert.deepEqual(commands(found[1].code), commands(found[0].code));
  assert.match(found[0].code, /GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 /);
  assert.match(found[1].code, /^\$env:GIT_LFS_SKIP_SMUDGE=1$/m);
});

test('every npm command in the section exists, and the build needs no Rust toolchain', () => {
  const lines = commands(blocks(section)[0].code).filter((line) => line.startsWith('npm '));
  assert.deepEqual(lines, ['npm ci', 'npm run build:packages', 'npm run dev:examples']);
  for (const line of lines.slice(1)) {
    const name = line.slice('npm run '.length);
    assert.equal(typeof manifest.scripts[name], 'string', `package.json has the ${name} script`);
  }
  // Without --precompiled, scripts/build-modern.js rebuilds the Wasm kernels with cargo.
  assert.match(manifest.scripts['build:packages'], /--precompiled\b/);
});

test('the Node version, URL and file to edit match the repository', () => {
  const node = manifest.engines.node.replace(/^>=\s*/, '').replace(/\.0$/, '');
  assert.ok(section.includes(`Node.js ${node} or newer`), `the section asks for Node ${node}, as engines does`);
  assert.ok(section.includes('<http://127.0.0.1:5173/>'), 'the section opens the address the server prints');
  assert.equal(QUICKSTART_PAGE, '/examples/quickstart/');
  assert.ok(existsSync(join(root, 'examples/quickstart/index.html')), 'the page the root redirects to exists');
  const [, file, from, to] = section.match(/`([\w/.-]+\.ts)` in your editor, change the ball's colour `'(#\w+)'` to `'(#\w+)'`/);
  const source = readFileSync(join(root, file), 'utf8');
  assert.ok(source.includes(`color: '${from}'`), `${file} has the colour the section says to change`);
  assert.notEqual(from, to);
});
