import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedDeclarations, declarationStamps, missingDeclaration } from '../scripts/support/declaration-snapshot.mjs';

// KB6254a: a package build (vite emptyOutDir) beside hygiene gate 6 left an entry .d.ts out of the TypeScript project,
// and the async API threw "getNodeId requires a RemoteNode" for the undefined source file.
test('a declaration emptied and rewritten while hygiene reads it is named as a concurrent build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decl-')),
    a = join(dir, 'a.d.ts'),
    b = join(dir, 'b.d.ts');
  try {
    writeFileSync(a, 'export {};');
    writeFileSync(b, 'export {};');
    const files = [a, b],
      before = declarationStamps(files);
    rmSync(b);
    assert.deepEqual(declarationStamps(files), [before[0], -1]);
    writeFileSync(b, 'export {};');
    utimesSync(b, new Date(), new Date(Date.now() + 5000));
    const changed = changedDeclarations(files, before, declarationStamps(files));
    assert.deepEqual(changed, [b]);
    const error = missingDeclaration(b, changed);
    assert.match(error.message, /changed while hygiene read them/);
    assert.match(error.message, /package build ran beside it/);
    assert.doesNotMatch(error.message, /RemoteNode/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a declaration missing with no build beside the gate asks for build:packages', () => {
  assert.match(missingDeclaration('x.d.ts', []).message, /run npm run build:packages, then hygiene/);
});

test('hygiene gate 6 checks the source file before asking the checker for its symbol', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../scripts/hygiene.js', import.meta.url), 'utf8');
  assert.match(source, /const file = await program\.getSourceFile\(dts\);\s*\n[^\n]*\n\s*if \(!file\) throw missingDeclaration/);
  assert.doesNotMatch(source, /getSymbolAtLocation\(await program\.getSourceFile/);
});
