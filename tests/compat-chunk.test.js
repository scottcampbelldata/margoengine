// A package build can hold two compat-*.js chunks, its WebGL2 route (src/compat.ts) and the shared
// packages/shared/compat.js once two of its entries import it; their content hashes decide which one a directory
// listing names first. Tests that took the first compat-*.js of a listing (scatter's order and audit-132 tests, the
// shadows allocation probe) or held every compat-*.js of a build (scatter's attributes check) picked the shared chunk
// once a build split it out. tests/support/compat-chunk.js picks the chunk by its export; this file holds every test to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatChunk, compatChunkFile } from './support/compat-chunk.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('compatChunk takes the chunk that exports the name, whichever the listing names first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compat-chunk-'));
  try {
    // The shared chunk sorts first, as a listing by name gives it.
    writeFileSync(join(dir, 'compat-AAAA1111.js'), 'export const compatTier = () => "webgpu";\n');
    writeFileSync(join(dir, 'compat-zzzz9999.js'), 'export class NearestRoute {}\n');
    writeFileSync(join(dir, 'index.js'), 'export const NearestRoute = 1;\n');
    assert.equal(await compatChunkFile(dir, 'NearestRoute'), 'compat-zzzz9999.js');
    assert.equal(typeof (await compatChunk(dir, 'NearestRoute')).NearestRoute, 'function');
    assert.equal(await compatChunkFile(dir, 'compatTier'), 'compat-AAAA1111.js');
    await assert.rejects(compatChunk(dir, 'ScatterRoute'), /exports ScatterRoute/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no test picks a compat-*.js chunk by listing order or holds every one of a build', () => {
  const files = execFileSync('git', ['ls-files', '-z', 'packages/*/test/**', 'packages/*/tests/**', 'tests/**'], {
      maxBuffer: 2 ** 28,
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(
        (f) => /\.(m?js|html)$/.test(f) && f !== 'tests/support/compat-chunk.js' && f !== 'tests/compat-chunk.test.js',
      ),
    found = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    // A pick by name is fine only where the same expression keeps the chunk the package imports lazily by import(),
    // as webgl2-compat's isolation and routes tests do: the shared chunk is imported statically.
    for (const m of text.matchAll(/\/\^compat-/g))
      if (!text.slice(m.index, m.index + 200).includes('import\\\\('))
        found.push(`${file}: picks a compat-*.js by its name; use compatChunk or compatChunkFile`);
    if (/dist\/compat-\*\.js/.test(text))
      found.push(`${file}: a glob over every compat-*.js; name the route chunk (compatChunkFile)`);
  }
  assert.deepEqual(found, []);
});
