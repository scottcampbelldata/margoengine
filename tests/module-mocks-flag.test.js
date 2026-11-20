// A test that calls `mock.module` (node:test module mocks) runs only under `node --experimental-test-module-mocks`;
// without the flag it dies with "mock.module is not a function". A run of such files in bulk, by hand or by a lane
// gate, lost the flag (browser-startup, compat-baselines, bench-size-plaza and others, 2026-11-16, KB-TEST-MODULEMOCKS1).
// `npm run test:files -- <files>` is the one command that runs chosen test files with the flag; this test pins it, and
// fails when any package script runs a file that mocks a module without the flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const FLAG = '--experimental-test-module-mocks';

/** Every script of every package.json that runs `node --test`, as [package.json path, name, command]. */
export function testScripts() {
  const manifests = ['package.json'];
  for (const name of readdirSync(join(root, 'packages')))
    if (existsSync(join(root, 'packages', name, 'package.json'))) manifests.push(`packages/${name}/package.json`);
  const found = [];
  for (const manifest of manifests) {
    const scripts = JSON.parse(readFileSync(join(root, manifest), 'utf8')).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) if (/\bnode\b[^&|]*\s--test(\s|$)/.test(command)) found.push([manifest, name, command]);
  }
  return found;
}

/** The files a script's command names, with one `*` in a path segment expanded. */
export function filesOf(manifest, command) {
  const base = dirname(join(root, manifest)),
    files = [];
  for (const token of command.split(/\s+/).filter((t) => /\.m?js$/.test(t))) {
    let paths = [base];
    for (const segment of token.split('/')) {
      paths = paths.flatMap((path) => {
        if (segment === '..' || !segment.includes('*')) return [join(path, segment)];
        if (!existsSync(path) || !statSync(path).isDirectory()) return [];
        const pattern = new RegExp(`^${segment.replace(/\./g, '\.').replace(/\*/g, '.*')}$`);
        return readdirSync(path).filter((entry) => pattern.test(entry)).map((entry) => join(path, entry));
      });
    }
    files.push(...paths.filter((path) => existsSync(path) && statSync(path).isFile()));
  }
  return files;
}

/** True when the file mocks a module in its own process (a probe string that spawns a child with the flag does not). */
export function mocksHere(source) {
  return /\bmock\.module\(/.test(source) && !source.includes(FLAG);
}

test('npm run test:files runs chosen test files with the module-mocks flag', () => {
  const command = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts['test:files'];
  assert.ok(command, 'package.json has no test:files script');
  assert.ok(command.includes(FLAG), `test:files drops ${FLAG}: ${command}`);
  assert.ok(/(^|\s)--test(\s|$)/.test(command), 'test:files does not run node --test');
});

test('mocksHere sees a file that mocks a module and not one that spawns a child with the flag', () => {
  assert.equal(mocksHere("import { mock } from 'node:test';\nmock.module('vite', {});"), true);
  assert.equal(mocksHere(`spawnSync(process.execPath, ['${FLAG}', '--eval', "mock.module('x', {})"]);`), false);
  assert.equal(mocksHere('export const x = 1;'), false);
});

test('no package script runs a file that mocks a module without the module-mocks flag', () => {
  const problems = [];
  for (const [manifest, name, command] of testScripts()) {
    if (command.includes(FLAG)) continue;
    for (const file of filesOf(manifest, command))
      if (mocksHere(readFileSync(file, 'utf8'))) problems.push(`${manifest} ${name} runs ${relative(root, file)} without ${FLAG}`);
  }
  assert.deepEqual(problems, []);
});
