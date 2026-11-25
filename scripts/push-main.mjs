// `npm run push:main`: the one way a lane pushes to main. It refuses while a rebase, merge, cherry-pick or revert is
// stopped, while any file is unmerged or holds a conflict marker, or when HEAD does not contain origin/main; then it
// runs the quick pre-push checks (whitespace, banned terms of the changed files, mass deletion) and pushes HEAD to main.
// Three lanes pushed from a stopped rebase on 2026-11-25; this makes that impossible rather than a rule to remember.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();

/** Why HEAD must not be pushed now, or null. `state` is injectable for tests. */
export function blockReason(state) {
  if (state.inProgress) return `a ${state.inProgress} is in progress; finish it (or abort it) before pushing`;
  if (state.unmerged.length) return `unmerged files: ${state.unmerged.join(', ')}; resolve and add them first`;
  if (state.markers.length) return `conflict markers in: ${state.markers.join(', ')}; remove them first`;
  if (!state.containsUpstream) return 'HEAD does not contain origin/main; rebase onto origin/main first';
  if (state.dirty)
    return 'the working tree has uncommitted changes to tracked files; commit or discard them so the checks see what is pushed';
  return null;
}

function readState() {
  const dir = git(['rev-parse', '--git-dir']);
  const kinds = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
  ];
  const inProgress = kinds.find(([file]) => existsSync(join(dir, file)))?.[1] ?? null;
  const unmerged = git(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
  let markers = [];
  try {
    // Scoped to HEAD, the content that is pushed. A bare ======= is left out: Markdown uses it to underline headings.
    markers = git(['grep', '-lE', '^(<<<<<<<|>>>>>>>|[|]{7})( |$)', 'HEAD', '--', '.'])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.replace(/^HEAD:/, ''));
  } catch (error) {
    if (error.status !== 1) throw error; // 1 means no match; anything else refuses the push
  }
  let containsUpstream = true;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
  } catch {
    containsUpstream = false;
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).length > 0;
  return { inProgress, unmerged, markers, containsUpstream, dirty };
}

function main() {
  git(['fetch', '-q', 'origin']);
  const reason = blockReason(readState());
  if (reason) {
    console.error(`push:main refused: ${reason}`);
    return 1;
  }
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
  if (!existsSync('scripts/check-mass-deletion.mjs') || !existsSync('scripts/check-banned-terms.mjs')) {
    console.error('push:main refused: scripts/check-mass-deletion.mjs or scripts/check-banned-terms.mjs is missing');
    return 1;
  }
  // The tree is clean (blockReason refuses a dirty one), so the working tree is HEAD: the checks see what is pushed.
  run('git', ['diff', '--check', 'origin/main...HEAD']);
  run('node', ['scripts/check-banned-terms.mjs', '--changed']);
  run('node', ['scripts/check-mass-deletion.mjs']);
  run('git', ['push', 'origin', 'HEAD:main']);
  console.log(`push:main: pushed ${git(['rev-parse', '--short', 'HEAD'])}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
