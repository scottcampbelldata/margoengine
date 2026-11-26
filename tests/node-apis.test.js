// Shipped code must run on Node 22.12, the packages' engines minimum (bug 39, 2026-10-27): scripts/check-node-apis.mjs
// fails on a use of a JavaScript or Node API that Node 22.12 lacks unless it sits behind a feature test. A missing API
// passes every parse and import check and throws only when the line runs (a server render, a CLI, an exporter).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import * as zlib from 'node:zlib';
import { API, check, scan, shippedFiles } from '../scripts/check-node-apis.mjs';
import { config, testFiles } from '../scripts/node22-tests.mjs';

test('no shipped source uses an API newer than Node 22.12 without a feature test', async () => {
  assert.deepEqual(await check(), []);
});

test('every API in the table is really missing on Node 22.12 and present where the table says', (t) => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const present = API.filter((row) => row.probe()).map((row) => row.name);
  if (major === 22 && minor === 12) assert.deepEqual(present, [], 'a row lists an API Node 22.12 has; remove it');
  else {
    // Above 22.12 a row is present exactly when this Node is at least its `has` version.
    const at = (v) => v.split('.').map(Number);
    const reached = (row) =>
      row.has !== 'none of them' && (major > at(row.has)[0] || (major === at(row.has)[0] && minor >= at(row.has)[1]));
    assert.deepEqual(
      present,
      API.filter(reached).map((row) => row.name),
    );
    t.diagnostic(`Node ${process.version}: ${present.length} of ${API.length} listed APIs present`);
  }
});

// KB-NODE22-HALF1: a TIFF test writer called DataView.setFloat16, which failed only on CI's Node 22 job.
// KB-NODE22-TESTS1: test files imported registerHooks and the zstd functions by name, which fails the whole file at link
// time on Node 22.12; they take them from scripts/support/node-compat.mjs.
test('the Node 22 test files and their helpers use no API newer than Node 22.12 without a feature test', async () => {
  const root = resolve(import.meta.dirname, '..'),
    listed = [...config().sharedTests, ...testFiles().flatMap((group) => group.files)],
    files = new Set(listed.map((file) => resolve(root, file))),
    found = [];
  // The set grows while it is walked: every helper a listed test imports from a test or support folder.
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const [, from] of source.matchAll(/\b(?:from|import)\s+'(\.{1,2}\/[^']+\.(?:m?js|ts))'/g)) {
      const helper = resolve(dirname(file), from);
      if (/[\\/](?:tests?|support)[\\/]/.test(helper) && existsSync(helper)) files.add(helper);
    }
    for (const { name, line } of await scan(source, file)) found.push(`${relative(root, file)}:${line} ${name}`);
  }
  assert.ok(files.has(resolve(root, 'scripts/support/node-compat-hooks.mjs')), 'the helpers were walked');
  assert.deepEqual(found, []);
});

test('the stand-ins for registerHooks and zstd work, on this Node and as on Node 22.12', () => {
  // A stored Zstandard frame of 'abc', one the stand-in writes, a rule of each kind, and a TypeScript source behind a
  // './name.js' specifier.
  const script = `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    import { moduleHooks, zstdCompressSync, zstdConstants, zstdDecompressSync } from './scripts/support/node-compat.mjs';
    const frame = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x20, 3, 0x19, 0, 0, 97, 98, 99);
    assert.equal(Buffer.from(zstdDecompressSync(frame)).toString(), 'abc');
    assert.equal(zstdCompressSync.name === 'zstdStoreSync' ? 'stored' : 'native', process.argv[1]);
    const stored = zstdCompressSync(Buffer.from('abc'), { params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 } });
    assert.equal(Buffer.from(zstdDecompressSync(stored)).toString(), 'abc');
    await moduleHooks([
      { specifier: 'margo:value', url: 'data:text/javascript,export default 7;' },
      { pattern: '^margo:miss', error: 'no such module here' },
      { specifier: 'margo:gone', error: 'not installed', code: 'ERR_MODULE_NOT_FOUND' },
      { pattern: '^margo:echo/', module: 'export default %s;' },
      { resolved: 'data:text/javascript,export default 1;', except: 'margo:none', url: 'data:text/javascript,export default 2;' },
      { source: pathToFileURL('packages/biomes/').href },
    ]);
    assert.equal((await import('margo:value')).default, 7);
    await assert.rejects(import('margo:missing'), /no such module here/);
    await assert.rejects(import('margo:gone'), { message: 'not installed', code: 'ERR_MODULE_NOT_FOUND' });
    assert.equal((await import('margo:echo/a')).default, 'margo:echo/a');
    assert.equal((await import('data:text/javascript,export default 1;')).default, 2);
    assert.equal(typeof (await import('./packages/biomes/src/fixed.js')), 'object');
    console.log('ok');
  `;
  const run = (mode, compress) =>
    execFileSync(
      process.execPath,
      [
        ...(process.features.typescript ? [] : ['--experimental-strip-types']),
        '--input-type=module',
        '-e',
        script,
        compress,
      ],
      {
        cwd: resolve(import.meta.dirname, '..'),
        env: { ...process.env, MARGO_NODE_COMPAT: mode },
        encoding: 'utf8',
        timeout: 60_000,
      },
    ).trim();
  assert.equal(run('fallback', 'stored'), 'ok');
  assert.equal(run('', zlib.zstdCompressSync ? 'native' : 'stored'), 'ok');
});

// The class, closed (2026-11-26): the test above reads the Node 22 list only, so tests of stage, voxel-pathtracer and
// react, a Firefox driver and a data script still imported registerHooks or a zstd function by name, and would fail
// to load the day their package joined the list. Every tracked source file that is not shipped (tests, scripts,
// examples, tools) is read here for the rows of Node's own modules, as code and as text: a test may write the import
// into a script it runs in a child process, where no parser sees it. The JavaScript rows (Float16Array and the like)
// stay with the Node 22 list, because browser test drivers use them in the browser.
test('no test or script anywhere names a node: API that Node 22.12 lacks without a feature test', async () => {
  const root = resolve(import.meta.dirname, '..'),
    shipped = new Set(shippedFiles().map((file) => relative(root, file).replaceAll('\\', '/'))),
    names = API.filter((row) => row.kind === 'node').map((row) => row.name),
    named = new RegExp(String.raw`\bimport\s*\{[^}]*\b(${names.join('|')})\b[^}]*\}\s*from\s*\\?['"]node:`, 'g'),
    constants = /\bimport\s*\{[^}]*\bconstants\b[^}]*\}\s*from\s*\\?['"]node:zlib/,
    files = execFileSync('git', ['ls-files', '--', '*.js', '*.mjs', '*.cjs', '*.ts', '*.tsx'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    })
      .split('\n')
      .filter((file) => file && !/\.d\.[mc]?ts$/.test(file) && !shipped.has(file) && existsSync(resolve(root, file))),
    found = [];
  for (const file of files) {
    const source = readFileSync(resolve(root, file), 'utf8');
    for (const { name, line } of await scan(source, file))
      if (names.includes(name)) found.push(`${file}:${line} ${name}`);
    // This file holds the sample lines of the two tests below.
    if (file === 'tests/node-apis.test.js') continue;
    for (const match of source.matchAll(named))
      found.push(`${file}:${source.slice(0, match.index).split('\n').length} ${match[1]} (in text)`);
    // zlib.constants has no ZSTD_c_* numbers on Node 22.12: a parameter keyed by one is keyed by 'undefined'.
    if (constants.test(source) && /\bZSTD_[a-z]_/.test(source)) found.push(`${file} ZSTD_* from zlib.constants`);
  }
  assert.ok(
    files.length > 3000 && files.includes('packages/webgl2-compat/test/firefox-matrix.mjs'),
    'the tree was read',
  );
  assert.deepEqual([...new Set(found)], [], 'take these from scripts/support/node-compat.mjs');
});

// KB-NODE22-BUILD1: CI builds the packages on Node 22.12, and a named import of an API it lacks fails before a line runs.
test('build:packages and the scripts it imports use no API newer than Node 22.12 without a feature test', async () => {
  const root = resolve(import.meta.dirname, '..'),
    seen = new Set(),
    todo = [resolve(root, 'scripts/build-modern.js')],
    found = [];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, spec] of source.matchAll(/^(?:import|export)\s[^;]*?from\s+'(\.[^']+)';/gms))
      todo.push(resolve(dirname(file), spec));
    for (const { name, line } of await scan(source, file)) found.push(`${relative(root, file)}:${line} ${name}`);
  }
  assert.ok(seen.size > 10, 'the import graph was walked');
  assert.deepEqual(found, []);
});

test('unguarded uses are reported with their line', async () => {
  const source = [
    'const a = new Float16Array(4);',
    'const b = Promise.try(() => 1);',
    'const c = bytes.toHex();',
    "import { zstdCompressSync } from 'node:zlib';",
    "import { registerHooks } from 'node:module';",
    'const d = /(?i:abc)/;',
    'const e = Uint8Array.fromBase64(text);',
  ].join('\n');
  assert.deepEqual(
    (await scan(source, 'a.ts')).map(({ name, line }) => `${line} ${name}`),
    [
      '1 Float16Array',
      '2 Promise.try',
      '3 toHex',
      '4 zstdCompressSync',
      '5 registerHooks',
      '6 regular expression modifiers (?i:...)',
      '7 Uint8Array.fromBase64',
    ],
  );
});

test('feature-tested uses, type positions and plain names pass', async () => {
  const source = `
    const F16 = (globalThis as { Float16Array?: typeof Float16Array }).Float16Array;
    const half: Float16Array | undefined = F16 ? new F16(4) : undefined;
    if (typeof Float16Array === 'function') new Float16Array(2);
    const run = typeof Promise.try === 'function' ? Promise.try(f) : Promise.resolve().then(f);
    const hex = bytes.toHex?.() ?? slowHex(bytes);
    const b64 = Uint8Array.fromBase64 ? Uint8Array.fromBase64(text) : decode(text);
    function toHex(n: number) { return n.toString(16); }
    const colour = toHex(255);
    const o = { toBase64: 1, Float16Array: 2 };
    interface X { f(): Float16Array }
    declare const y: Float16Array;
    import type { Z } from 'node:zlib';
    const s = 'Float16Array, Promise.try(), x.toHex()';
  `;
  assert.deepEqual(await scan(source, 'b.ts'), []);
});
