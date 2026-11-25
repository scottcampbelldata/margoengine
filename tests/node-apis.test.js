// Shipped code must run on Node 22.12, the packages' engines minimum (bug 39, 2026-10-27): scripts/check-node-apis.mjs
// fails on a use of a JavaScript or Node API that Node 22.12 lacks unless it sits behind a feature test. A missing API
// passes every parse and import check and throws only when the line runs (a server render, a CLI, an exporter).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { API, check, scan } from '../scripts/check-node-apis.mjs';

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
      '5 regular expression modifiers (?i:...)',
      '6 Uint8Array.fromBase64',
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
