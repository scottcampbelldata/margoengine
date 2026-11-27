// The one place that says where engine-bench is: the folder of outside engines and standard samples beside the main
// checkout. Every worktree reads that folder, wherever the worktree itself lives (a sibling of the main checkout, or
// nested under it as <main>/.claude/worktrees/<name>).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dirname, '../..');

/**
 * The main checkout of the worktree at `root`. A linked worktree's `.git` is a file naming
 * `<main>/.git/worktrees/<name>` (relative to the worktree with git's relative worktree paths). The main checkout, a
 * plain clone, a submodule and a folder without git are their own answer.
 */
export function mainCheckout(root = repoRoot) {
  let text;
  try {
    text = readFileSync(resolve(root, '.git'), 'utf8');
  } catch (error) {
    // A directory (an ordinary checkout) or no git at all (a source archive); anything else is a real fault.
    if (error.code === 'EISDIR' || error.code === 'ENOENT') return resolve(root);
    throw error;
  }
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
  const linked = gitdir && /^(.+)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(resolve(root, gitdir));
  return linked ? resolve(linked[1]) : resolve(root);
}

/** The engine-bench folder: `MARGO_ENGINE_BENCH`, else the one beside the main checkout. */
export function engineBenchRoot(env = process.env, root = repoRoot) {
  return env.MARGO_ENGINE_BENCH
    ? resolve(env.MARGO_ENGINE_BENCH)
    : resolve(dirname(mainCheckout(root)), 'engine-bench');
}
