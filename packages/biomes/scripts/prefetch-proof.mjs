// Full default-world work/output A/B. GPU correctness, not a wall-clock speed claim.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { build } from 'vite';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { openBrowser } from '../../../scripts/browser.js';
import { runLimited } from '../../../scripts/support/run-limited.mjs';

async function prove() {
  const parent = 'fc1ed452f';
  const folder = resolve('test-results/biomes-prefetch-proof/parent');
  const files = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', parent, 'packages/biomes/src', 'packages/shared'],
    { encoding: 'utf8', timeout: 30000 },
  )
    .trim()
    .split('\n');
  for (const file of files) {
    const target = resolve(folder, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, execFileSync('git', ['show', `${parent}:${file}`], { timeout: 30000 }));
  }
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      outDir: resolve(folder, 'dist'),
      lib: { entry: resolve(folder, 'packages/biomes/src/view.ts'), formats: ['es'], fileName: () => 'view.js' },
      rollupOptions: { external: (id) => id.startsWith('@margoengine/') },
    },
  });
  const context = await openBrowser({ startPath: '/packages/biomes/tests/prefetch-proof.html', port: 'free' });
  const errors = [];
  context.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    const before = await context.page.evaluate(() => window.run(true));
    const after = await context.page.evaluate(() => window.run(false));
    assert.deepEqual(errors, []);
    assert.deepEqual(before.errors, []);
    assert.deepEqual(after.errors, []);
    const unique = (records) => {
      const map = new Map();
      for (const { key, output } of records) {
        if (map.has(key)) assert.deepEqual(output, map.get(key), `duplicate ${key} has identical bytes`);
        map.set(key, output);
      }
      return [...map].sort(([a], [b]) => a.localeCompare(b));
    };
    const output = unique(after.records);
    assert.deepEqual(
      output,
      unique(before.records),
      'every worker result field and typed-array hash matches the parent',
    );
    assert.equal(after.records.length, output.length, 'each key is generated once in the current view');
    assert(before.records.length > after.records.length, 'the original workload performs duplicate jobs');
    assert.equal(after.counts.view, 144);
    assert.equal(after.counts.place, 144);
    const result = {
      parent,
      evidence:
        'Full 4 km default world, three workers, exact worker output parity and deterministic job reduction; no speed ratio',
      world: after.world,
      before: before.counts,
      after: after.counts,
      output,
    };
    writeFileSync('test-results/biomes-prefetch-proof/result.json', JSON.stringify(result, null, 2) + '\n');
    console.log(
      JSON.stringify({ before: before.counts, after: after.counts, unique: output.length, exactOutput: true }),
    );
  } finally {
    await context.close();
  }
}
process.chdir(resolve(import.meta.dirname, '../../..'));
if (process.argv.includes('--child')) await prove();
else {
  const release = await acquire({ owner: 'codex-missing', mode: 'exclusive', max: 6, waitMax: 10 });
  try {
    const result = await runLimited('node packages/biomes/scripts/prefetch-proof.mjs --child', {
      cwd: process.cwd(),
      limitMs: 300000,
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
  } finally {
    release();
  }
}
