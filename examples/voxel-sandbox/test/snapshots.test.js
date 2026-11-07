// writeWhole on disk: a file another process holds open, two writes of one path at once, a crash between the renames.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hasWhole, readWhole, readWholeSync, removeWhole, writeWhole } from '../server/snapshots.mjs';

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'plaza-whole-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// An on-access scanner, a backup or an editor opens a file just written. Windows refuses a rename over a file any handle
// has open, so writing state.json over its open self failed with EPERM there, and the shard stopped.
test('writeWhole replaces a file another handle holds open, and that handle still reads the old bytes', async (t) => {
  const dir = folder(t),
    path = join(dir, 'state.json');
  await writeWhole(path, 'old');
  const held = await open(path, 'r');
  t.after(() => held.close());
  await writeWhole(path, 'new');
  await writeWhole(path, 'newer');
  assert.equal(readFileSync(path, 'utf8'), 'newer');
  assert.equal(await held.readFile('utf8'), 'old');
  assert.deepEqual(readdirSync(dir), ['state.json'], 'nothing left beside it');
});

test('writes of one path at once land in call order and leave no temporary file', async (t) => {
  const dir = folder(t),
    path = join(dir, 'index.json');
  await Promise.all(['a', 'b', 'c', 'd'].map((text) => writeWhole(path, text)));
  assert.equal(readFileSync(path, 'utf8'), 'd');
  assert.deepEqual(readdirSync(dir), ['index.json']);
});

test('a crash between the two renames leaves the old file aside: it is read, counted, and the next write replaces it', async (t) => {
  const dir = folder(t),
    path = join(dir, 'state.json');
  assert.equal(hasWhole(path), false);
  assert.equal(await readWhole(path, 'utf8'), undefined);
  await writeWhole(path, 'whole');
  // The state after the first rename of a write that stopped there: the new file was still a temporary one.
  renameSync(path, `${path}.old`);
  writeFileSync(`${path}.4242-1.tmp`, '{"half":');
  assert.equal(hasWhole(path), true);
  assert.equal(await readWhole(path, 'utf8'), 'whole');
  assert.equal(readWholeSync(path, 'utf8'), 'whole');
  await writeWhole(path, 'next');
  assert.equal(await readWhole(path, 'utf8'), 'next');
  assert.deepEqual(readdirSync(dir).sort(), ['state.json', 'state.json.4242-1.tmp']);
  await removeWhole(path);
  assert.equal(hasWhole(path), false);
});

test('removeWhole takes the file aside too, so a removed state never comes back', async (t) => {
  const dir = folder(t),
    path = join(dir, 'state.json');
  writeFileSync(`${path}.old`, 'aside');
  writeFileSync(path, 'in place');
  await removeWhole(path);
  assert.equal(hasWhole(path), false);
  assert.deepEqual(readdirSync(dir), []);
});
