// Regression (KB-BUILD-ATOMIC1, 2026-11-16): build:packages removed packages/<name>/dist and wrote the new build in its
// place, so a process reading the checkout meanwhile failed: the Film Studio app's test runs twice died on ENOENT for
// packages/core/dist while the engine checkout rebuilt. A build now writes into dist-next and moves each file into dist
// with one rename (scripts/support/dist-dir.mjs), so a reader sees every file whole, old or new, and never missing.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DIST_DIR_ENV, STAGING_DIR, distDir, swapDist, tsconfigFor } from '../scripts/support/dist-dir.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const hash = (text) => createHash('sha256').update(text).digest('hex');
const scratch = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'margo-dist-swap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const put = (file, text) => {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((ok) => setTimeout(ok, 5));
  }
};

// A separate process that reads the given files in a tight loop until the stop file appears (or 120 s pass), then
// prints what it saw: how many reads, which failed and with what code, and the hash of every content it read.
const READER = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [stop, ...files] = process.argv.slice(1);
const seen = Object.fromEntries(files.map((file) => [file, { reads: 0, errors: {}, hashes: {} }]));
const end = Date.now() + 120_000;
while (!existsSync(stop) && Date.now() < end)
  for (const file of files) {
    const entry = seen[file];
    entry.reads++;
    try {
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
      entry.hashes[digest] = (entry.hashes[digest] ?? 0) + 1;
    } catch (error) {
      entry.errors[error.code] = (entry.errors[error.code] ?? 0) + 1;
    }
    if (files.indexOf(file) === files.length - 1 && entry.reads === 1) writeFileSync(stop + '.ready', '');
  }
process.stdout.write(JSON.stringify(seen));
`;
function startReader(stop, files) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', READER, stop, ...files], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const ready = until(() => existsSync(stop + '.ready'));
  let out = '';
  child.stdout.on('data', (data) => (out += data));
  const done = new Promise((ok, fail) => {
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? ok(JSON.parse(out)) : fail(new Error(`reader exited ${code}`))));
  });
  return {
    ready,
    async stop() {
      writeFileSync(stop, '');
      return done;
    },
  };
}

test('distDir is dist unless build:packages names dist-next, and rejects any other folder', () => {
  assert.equal(distDir('/p', undefined), resolve('/p', 'dist'));
  assert.equal(distDir('/p', 'dist'), resolve('/p', 'dist'));
  assert.equal(distDir('/p', STAGING_DIR), resolve('/p', 'dist-next'));
  assert.throws(() => distDir('/p', '../elsewhere'), new RegExp(DIST_DIR_ENV));
});

test('swapDist moves new files in, keeps unchanged ones, removes stale ones and handles a file that became a folder', async (t) => {
  const root = scratch(t);
  put(join(root, 'package.json'), JSON.stringify({ exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } } }));
  put(join(root, 'dist/index.js'), 'old entry');
  put(join(root, 'dist/same.js'), 'same bytes');
  put(join(root, 'dist/stale.js'), 'gone in the new build');
  put(join(root, 'dist/old-folder/a.js'), 'gone too');
  put(join(root, 'dist/workers'), 'a file the new build makes a folder');
  put(join(root, 'dist-next/index.js'), 'new entry');
  put(join(root, 'dist-next/same.js'), 'same bytes');
  put(join(root, 'dist-next/chunk-new.js'), 'new chunk');
  put(join(root, 'dist-next/workers/w.js'), 'worker');
  const before = statSync(join(root, 'dist/same.js')).mtimeMs;
  const counts = await swapDist(root);
  assert.deepEqual(counts, { moved: 3, unchanged: 1, removed: 2 });
  assert.equal(readFileSync(join(root, 'dist/index.js'), 'utf8'), 'new entry');
  assert.equal(readFileSync(join(root, 'dist/chunk-new.js'), 'utf8'), 'new chunk');
  assert.equal(readFileSync(join(root, 'dist/workers/w.js'), 'utf8'), 'worker');
  assert.equal(statSync(join(root, 'dist/same.js')).mtimeMs, before, 'an unchanged file is left alone');
  assert.equal(existsSync(join(root, 'dist/stale.js')), false);
  assert.equal(existsSync(join(root, 'dist/old-folder')), false);
  assert.equal(existsSync(join(root, 'dist-next')), false);
  await assert.rejects(swapDist(root), /Nothing to swap in/);
});

test('a reader polling dist during 60 swaps never misses a file and only ever reads a whole old or new one', async (t) => {
  const root = scratch(t);
  put(join(root, 'package.json'), JSON.stringify({ exports: { '.': { import: './dist/index.js' } } }));
  // Large enough that a file written in place would be read half written now and then.
  const versions = ['a', 'b'].map((tag) => `export const v = '${tag}';\n` + `// ${tag.repeat(200)}\n`.repeat(2000));
  put(join(root, 'dist/index.js'), versions[0]);
  put(join(root, 'dist/chunk.js'), versions[0]);
  const reader = startReader(join(root, 'stop'), [join(root, 'dist/index.js'), join(root, 'dist/chunk.js')]);
  await reader.ready;
  for (let round = 1; round <= 60; round++) {
    put(join(root, 'dist-next/index.js'), versions[round % 2]);
    put(join(root, 'dist-next/chunk.js'), versions[round % 2]);
    await swapDist(root);
  }
  const seen = await reader.stop();
  const allowed = new Set(versions.map(hash));
  for (const [file, entry] of Object.entries(seen)) {
    assert.ok(entry.reads > 0, `${file} was read`);
    assert.deepEqual(entry.errors, {}, `${file} could always be read`);
    for (const digest of Object.keys(entry.hashes)) assert.ok(allowed.has(digest), `${file} was read half written`);
  }
});

test('build:packages never leaves a reader without a package dist file while it rebuilds the package', async (t) => {
  // taa takes build-modern's own pipeline (Vite + tsc in process); fsm runs its package build script
  // (scripts/build-optional.js) with MARGOENGINE_DIST_DIR=dist-next. Both used to delete their dist first.
  const files = ['taa/dist/index.js', 'taa/dist/index.d.ts', 'fsm/dist/index.js', 'fsm/dist/index.d.ts'].map((file) =>
    join(repository, 'packages', file),
  );
  for (const file of files) assert.ok(existsSync(file), `${file} is built before the test (npm run build:packages)`);
  const before = new Map(files.map((file) => [file, hash(readFileSync(file))]));
  const stop = join(scratch(t), 'stop');
  const reader = startReader(stop, files);
  await reader.ready;
  const build = spawnSync(
    process.execPath,
    ['scripts/build-modern.js', '--precompiled', '--only=taa,fsm'],
    { cwd: repository, encoding: 'utf8', timeout: 600_000, env: { ...process.env, [DIST_DIR_ENV]: '' } },
  );
  const seen = await reader.stop();
  assert.equal(build.status, 0, build.stderr);
  for (const file of files) {
    const entry = seen[file],
      allowed = new Set([before.get(file), hash(readFileSync(file))]);
    assert.ok(entry.reads > 0, `${file} was read during the build`);
    assert.deepEqual(entry.errors, {}, `${file} could be read throughout the build`);
    for (const digest of Object.keys(entry.hashes)) assert.ok(allowed.has(digest), `${file} was read half written`);
  }
  for (const name of ['taa', 'fsm']) {
    const dist = join(repository, 'packages', name, 'dist');
    assert.equal(existsSync(join(repository, 'packages', name, STAGING_DIR)), false, `${name}/dist-next was swapped in`);
    // Nothing built names the staging folder (a worker once took its published name from it).
    for (const file of readdirSync(dist, { recursive: true }))
      if (statSync(join(dist, file)).isFile())
        assert.ok(!readFileSync(join(dist, file), 'utf8').includes(STAGING_DIR), `${name}/dist/${file} names dist-next`);
  }
});

test('tsconfigFor emits into dist-next and keeps the package own entry names on its sources', (t) => {
  const root = join(scratch(t), 'packages', 'demo');
  put(join(root, 'tsconfig.json'), '{}');
  put(join(root, 'src/index.ts'), '');
  put(join(root, 'src/extra.tsx'), '');
  put(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@margoengine/demo',
      exports: { '.': { import: './dist/index.js' }, './extra': { import: './dist/extra.js' }, './data': './data.json' },
    }),
  );
  assert.equal(tsconfigFor(root, join(root, 'dist')), join(root, 'tsconfig.json'));
  const config = JSON.parse(readFileSync(tsconfigFor(root, join(root, STAGING_DIR)), 'utf8'));
  assert.equal(config.extends, join(root, 'tsconfig.json'));
  assert.equal(config.compilerOptions.outDir, join(root, STAGING_DIR));
  assert.deepEqual(config.compilerOptions.paths, {
    '@margoengine/demo': [join(root, 'src/index.ts')],
    '@margoengine/demo/extra': [join(root, 'src/extra.tsx')],
  });
});

test('no package build script or build helper writes a literal dist folder; they all go through distDir', () => {
  const workspaces = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).workspaces.filter((dir) =>
    dir.startsWith('packages/'),
  );
  const scripts = new Set(
    [
      'build-modern.js',
      'build-optional.js',
      'build-postfx.js',
      'build-workers.js',
      'compact-package.js',
      'package-declarations.js',
      'react-server-entries.js',
      'core-requirements.mjs',
      'shader-comments.mjs',
    ].map((file) => join(repository, 'scripts', file)),
  );
  for (const dir of workspaces) {
    const command = JSON.parse(readFileSync(join(repository, dir, 'package.json'), 'utf8')).scripts?.build ?? '';
    for (const [, script] of command.matchAll(/node\s+(\S+\.m?js)/g)) scripts.add(resolve(repository, dir, script));
  }
  assert.ok(scripts.size >= 30, `found the package build scripts (${scripts.size})`);
  const literal = /(?:root|directory|packageRoot|import\.meta\.dirname)\s*,\s*['"`]dist(?:['"`/])|['"`]\.\.\/dist(?:['"`/])/;
  const offenders = [];
  for (const file of scripts) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!line.trim().startsWith('//') && literal.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
