// The example type check (scripts/check-example-types.mjs): it fails on a wrong engine call planted in an example, it
// covers every example source file, and check:merge narrows it to the projects a change can reach. Needs
// `npm run build:packages` (verify builds before the tests run): the examples read the packages through their dist types.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { checkExampleTypes } from '../scripts/check-example-types.mjs';
import { planContext, planFiles } from '../scripts/check-merge.mjs';
import { exampleClosure, exampleScopes } from '../scripts/support/affected-packages.mjs';
import { PROJECTS } from '../scripts/support/example-projects.mjs';

const root = resolve(import.meta.dirname, '..');
const posix = (path) => path.replaceAll('\\', '/');

/** A throwaway project under test-results/ (inside the repository, so @margoengine/* resolves) holding `source`. */
function plant(source) {
  mkdirSync(join(root, 'test-results'), { recursive: true });
  const dir = mkdtempSync(join(root, 'test-results', 'example-types-'));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        lib: ['ES2022', 'DOM', 'DOM.Iterable', 'ESNext.Disposable'],
        types: [],
      },
      include: ['main.ts'],
    }),
  );
  writeFileSync(join(dir, 'main.ts'), source);
  return { dir, projects: [{ id: 'planted', config: posix(relative(root, join(dir, 'tsconfig.json'))) }] };
}

test('a wrong engine call planted in an example fails the check, and the same file with the call fixed passes', async () => {
  const right = plant(
    "import { Engine } from '@margoengine/core';\nexport const make = (canvas: HTMLCanvasElement) => Engine.create(canvas);\n",
  );
  const wrong = plant(
    "import { Engine } from '@margoengine/core';\nexport const make = () => Engine.create('#canvas', { backend: 'vulkan' });\n",
  );
  try {
    const [ok] = await checkExampleTypes({ ids: ['planted'], projects: right.projects });
    assert.equal(ok.ok, true, ok.output);
    const [bad] = await checkExampleTypes({ ids: ['planted'], projects: wrong.projects });
    assert.equal(bad.ok, false);
    assert.match(bad.output, /main\.ts\(2,\d+\): error TS2\d+/);
  } finally {
    rmSync(right.dir, { recursive: true, force: true });
    rmSync(wrong.dir, { recursive: true, force: true });
  }
});

test('a project that never finishes is ended at its time limit and reported as failed', async () => {
  const hung = plant('export {};\n');
  try {
    const [result] = await checkExampleTypes({ ids: ['planted'], projects: hung.projects, limitMs: 1 });
    assert.equal(result.ok, false);
    assert.match(result.message, /hung/);
  } finally {
    rmSync(hung.dir, { recursive: true, force: true });
  }
});

test('an unknown project name is refused with the names that exist', async () => {
  await assert.rejects(checkExampleTypes({ ids: ['nope'] }), /unknown example project nope; use some of examples, js/);
});

test('every example .ts and .tsx file is in a project, and every top-level .js demo is in the JavaScript one', () => {
  const listed = new Set();
  for (const { config } of PROJECTS) {
    const out = execFileSync(
      process.execPath,
      [join(root, 'node_modules/typescript/bin/tsc'), '-p', config, '--noEmit', '--listFilesOnly'],
      { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 },
    );
    for (const line of out.split(/\r?\n/)) if (line) listed.add(posix(relative(root, line)));
  }
  const missing = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (['node_modules', '.next', 'dist'].includes(entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !listed.has(path)) missing.push(path);
      else if (dir === 'examples' && entry.name.endsWith('.js') && !listed.has(path)) missing.push(path);
    }
  };
  walk('examples');
  assert.deepEqual(missing, [], 'add the folder to a project in scripts/support/example-projects.mjs');
});

test('check:merge runs the example projects a change can reach, all of them for the full run, none for a document', async () => {
  const ctx = await planContext(root);
  const ids = (files) => {
    const command = planFiles(ctx, files).planned.find((p) => p.command.includes('check:examples-types'));
    return command.skip ? [] : (/--projects=(\S+)/.exec(command.command)?.[1].split(',') ?? ['all']);
  };
  assert.deepEqual(ids(['docs/known-bugs.md']), []);
  assert.deepEqual(ids(['examples/scene-targets.ts']), ['examples']);
  assert.deepEqual(ids(['examples/tokyo-diorama.js']), ['js']);
  assert.deepEqual(ids(['examples/vite/src/main.tsx']), ['vite']);
  // A package an example imports runs that example; one nothing in examples/ imports runs none.
  assert.ok(ids(['packages/post/src/index.ts']).includes('examples'));
  assert.deepEqual(
    ids(['packages/dof/src/index.ts']).filter((id) => id === 'examples'),
    [],
  );
  // The check's own files, and anything that runs everything, run every project.
  assert.deepEqual(ids(['scripts/check-example-types.mjs']), ['all']);
  assert.deepEqual(ids(['packages/core/src/engine.ts']), ['all']);
  const full = planFiles(ctx, [], { MARGO_FULL: '1' }).planned.find((p) => p.command.includes('check:examples-types'));
  assert.equal(full.command, 'npm run check:examples-types');
});

test('exampleScopes reads imports and files, not the dependency lists of a starter', () => {
  const examples = [
    {
      id: 'a',
      config: 'examples/a/tsconfig.json',
      packages: new Set(['@margoengine/x']),
      files: new Set(['examples/a/m.ts']),
    },
    { id: 'b', config: 'examples/b/tsconfig.json', packages: new Set(['@margoengine/y']), files: new Set() },
  ];
  const decision = { mode: 'affected', affected: ['@margoengine/x'], hits: [] };
  assert.deepEqual(exampleScopes({ decision, files: [], examples }).ids, ['a']);
  assert.deepEqual(
    exampleScopes({ decision: { ...decision, affected: [] }, files: ['examples/b/tsconfig.json'], examples }).ids,
    ['b'],
  );
  assert.deepEqual(
    exampleScopes({ decision: { ...decision, affected: [] }, files: ['examples/a/m.ts'], examples }).ids,
    ['a'],
  );
  assert.deepEqual(exampleScopes({ decision: { ...decision, affected: [] }, files: ['docs/x.md'], examples }).ids, []);
  assert.equal(exampleScopes({ decision: { mode: 'full', reason: 'r' }, files: [], examples }).all, true);
  assert.equal(exampleClosure(root, [], []).length, 0);
});
