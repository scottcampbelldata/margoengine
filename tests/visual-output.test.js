import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clearVisualOutput } from '../scripts/support/visual-output.js';

test('a visual check clears its own views and strays, not the views another run is writing', async () => {
  const out = await mkdtemp(join(tmpdir(), 'visual-out-'));
  try {
    for (const name of [
      'a-high.actual.png',
      'a-high.diff.png',
      'b-high.actual.png',
      'gone-high.actual.png',
      'index.html',
    ])
      await writeFile(join(out, name), 'x');
    await clearVisualOutput(out, { mine: ['a-high'], known: ['a-high', 'b-high'] });
    assert.deepEqual(await readdir(out), ['b-high.actual.png']);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
