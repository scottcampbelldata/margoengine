// Bug 70 follow-up: the bug 70 change added `await closeAll(...)` to bundler-matrix.mjs and profile-pbr-locked-drag.mjs
// without importing it (the import went into a generated page's source instead), so `modern:test:bundlers` died with
// `ReferenceError: closeAll is not defined` only after an hour-long full check. Node reports a
// missing name only when the line runs; Biome's `noUndeclaredVariables` rule reports it from the source. This runs
// the rule over every tracked .mjs file (scripts, tests, tools, examples) and every .js file under scripts/, and fails
// on a name that is neither imported, declared, nor a global. Page code that a script sends to the browser is declared in
// biome.json `overrides`. The .js files joined after the same slip reached gltf-ktx2-production-tests.js and
// gltf-compression-browser-tests.js, where the `closeAll` import sat inside the consumer page's source: the first died
// in modern:test:extensions, and its Vite build could not resolve the import either.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const biome = fileURLToPath(new URL('../node_modules/@biomejs/biome/bin/biome', import.meta.url));

/** Undeclared-name diagnostics Biome reports for `files`, as `path:line name`. */
export function undeclaredNames(files) {
  const found = [];
  for (let at = 0; at < files.length; at += 60) {
    let output;
    try {
      output = execFileSync(
        process.execPath,
        [
          biome,
          'lint',
          '--only=correctness/noUndeclaredVariables',
          '--reporter=json',
          '--max-diagnostics=500',
          ...files.slice(at, at + 60),
        ],
        { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch (error) {
      output = error.stdout ?? '';
    }
    const json = output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1);
    for (const item of JSON.parse(json).diagnostics) {
      const name = item.message.match(/^The (\S+) variable is undeclared/)?.[1];
      if (name) found.push(`${item.location.path.file ?? item.location.path}:${item.location.start.line} ${name}`);
    }
  }
  return found.map((entry) => entry.split(String.fromCharCode(92)).join('/'));
}

test('no tracked .mjs file or .js script uses a name it does not import or declare (bug 70)', () => {
  const files = execFileSync('git', ['ls-files', '*.mjs', 'scripts/**/*.js', 'scripts/*.js'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter((file) => file && !/(^|\/)(node_modules|dist|vendor)\//.test(file));
  const found = undeclaredNames(files);
  assert.deepEqual(found, [], `these names are used without an import or declaration:\n  ${found.join('\n  ')}`);
});

test('the checker reports a call to closeAll that is not imported, and accepts the imported one', () => {
  const file = `scripts/zz-undeclared-fixture-${process.pid}.mjs`;
  try {
    writeFileSync(new URL(`../${file}`, import.meta.url), 'await closeAll({ servers: [] });\n');
    assert.deepEqual(undeclaredNames([file]), [`${file}:1 closeAll`]);
    writeFileSync(
      new URL(`../${file}`, import.meta.url),
      "import { closeAll } from './support/shutdown.mjs';\nawait closeAll({ servers: [] });\n",
    );
    assert.deepEqual(undeclaredNames([file]), []);
  } finally {
    rmSync(new URL(`../${file}`, import.meta.url), { force: true });
  }
});
