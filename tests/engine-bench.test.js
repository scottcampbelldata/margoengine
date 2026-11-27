// A worktree nested under the main checkout (.claude/worktrees/<name>) once looked for engine-bench inside the main
// checkout, so every outside sample was "missing" there (horse.ply, the README STL files) while the folder was full.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { engineBenchRoot, mainCheckout, repoRoot } from '../scripts/support/engine-bench.mjs';

function folders(t) {
  const projects = mkdtempSync(join(tmpdir(), 'margo-bench-root-'));
  t.after(() => rmSync(projects, { recursive: true, force: true }));
  const main = join(projects, 'engine');
  mkdirSync(join(main, '.git'), { recursive: true });
  const worktree = (path, gitdir) => {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, '.git'), `gitdir: ${gitdir}\n`);
    return path;
  };
  return { projects, main, worktree };
}

test('every kind of worktree reads the engine-bench beside the main checkout', (t) => {
  const { projects, main, worktree } = folders(t);
  const admin = (name) => join(main, '.git', 'worktrees', name).replaceAll('\\', '/');
  const roots = [
    main,
    worktree(join(projects, 'engine-lane'), admin('engine-lane')),
    worktree(join(main, '.claude', 'worktrees', 'nested'), admin('nested')),
    worktree(join(main, 'scratch', 'deeper', 'still'), admin('still')),
    // git's relative worktree paths.
    worktree(join(main, '.claude', 'worktrees', 'relative'), '../../../.git/worktrees/relative'),
  ];
  for (const root of roots) {
    assert.equal(mainCheckout(root), resolve(main), root);
    assert.equal(engineBenchRoot({}, root), join(projects, 'engine-bench'), root);
  }
});

test('a clone, a submodule and a folder without git keep engine-bench beside themselves', (t) => {
  const { projects, main, worktree } = folders(t);
  const bare = join(projects, 'archive');
  mkdirSync(bare);
  const submodule = worktree(join(main, 'vendor', 'sub'), '../../.git/modules/sub');
  for (const root of [bare, submodule]) {
    assert.equal(mainCheckout(root), resolve(root));
    assert.equal(engineBenchRoot({}, root), resolve(root, '../engine-bench'));
  }
});

test('MARGO_ENGINE_BENCH wins over every checkout layout', () => {
  assert.equal(engineBenchRoot({ MARGO_ENGINE_BENCH: 'test-results/bench' }), resolve('test-results/bench'));
});

test('no script resolves engine-bench by its own relative path', () => {
  // A quoted path that climbs to engine-bench, or the folder name joined onto a ".." step.
  const pattern = String.raw`['"\`](\.\./)+engine-bench|['"\`]\.\.['"\`], *['"\`]engine-bench`;
  let found = '';
  try {
    found = execFileSync(
      'git',
      ['grep', '-nE', pattern, '--', '*.js', '*.mjs', '*.cjs', '*.ts', ':!tests', ':!docs', ':!site'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 },
    );
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if (error.status !== 1) throw error;
  }
  assert.equal(found, '', 'import engineBenchRoot from scripts/support/engine-bench.mjs instead');
});
