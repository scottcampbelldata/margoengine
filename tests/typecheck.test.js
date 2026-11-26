// npm run typecheck resolves @margoengine/* through each package's built dist/*.d.ts. GitHub CI's lint job ran it on an
// unbuilt tree for twelve days: hundreds of TS2307 errors in packages/animation that named no cause.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { unbuilt } from '../scripts/typecheck.js';

test('typecheck names the packages whose built declarations are missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'margo-typecheck-'));
  try {
    const add = async (name, manifest, built) => {
      await mkdir(join(root, 'packages', name, 'dist'), { recursive: true });
      await writeFile(join(root, 'packages', name, 'package.json'), JSON.stringify(manifest));
      if (built) await writeFile(join(root, 'packages', name, 'dist', 'index.d.ts'), 'export {};');
    };
    await add('built', { types: './dist/index.d.ts' }, true);
    await add('unbuilt', { exports: { '.': { types: './dist/index.d.ts' } } }, false);
    await add('sourceonly', { types: './src/index.ts' }, false);
    assert.deepEqual(await unbuilt(root), ['unbuilt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GitHub CI typechecks only after building the packages, in the same job', async () => {
  const ci = (await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const jobs = ci.split(/\n {2}(?=[a-z][\w-]*:\n)/);
  const checking = jobs.filter((job) => job.includes('npm run typecheck'));
  assert.ok(checking.length > 0, 'a CI job runs npm run typecheck');
  for (const job of checking) {
    const build = job.indexOf('npm run build:packages');
    assert.ok(build >= 0 && build < job.indexOf('npm run typecheck'), `this job typechecks an unbuilt tree:\n${job}`);
  }
});
