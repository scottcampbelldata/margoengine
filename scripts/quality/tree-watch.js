// What git says is uncommitted in a checkout, taken before and after a gate run (KB-QUALITY-CROSSTREE1: another
// session's edits sat in a lane's tree while its gate measured package sizes, and the figures were wrong until the
// files were restored). A gate reads one tree; if that tree changes under it, its result says nothing.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const git = (root, args) =>
  execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });

/**
 * HEAD and every uncommitted path of the checkout at `root` (ignored files aside), each with its status, size and write
 * time, so a second write to an already changed file shows too. Paths under a prefix in `own` (what the gate itself
 * writes) are left out.
 */
export function treeState(root, { own = [] } = {}) {
  let head = '';
  try {
    head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).trim();
  } catch (error) {
    if (error.status !== 1) throw error; // 1: no commit yet
  }
  const files = new Map(),
    entries = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    const status = entries[i].slice(0, 2),
      path = entries[i].slice(3);
    // A rename or copy is followed by the path it came from.
    if (/[RC]/.test(status)) i++;
    if (own.some((prefix) => path.startsWith(prefix))) continue;
    const stat = statSync(join(root, path), { throwIfNoEntry: false });
    files.set(path, stat ? `${status} ${stat.size} ${stat.mtimeMs}` : status);
  }
  return { head, files };
}

/** What differs between two `treeState` results: one line a path, and one if HEAD moved. */
export function treeChanges(before, after) {
  const changes = before.head === after.head ? [] : [`HEAD moved from ${before.head} to ${after.head}`];
  for (const path of [...new Set([...before.files.keys(), ...after.files.keys()])].sort())
    if (before.files.get(path) !== after.files.get(path))
      changes.push(
        !before.files.has(path)
          ? `${path} was changed`
          : !after.files.has(path)
            ? `${path} was committed or restored`
            : `${path} was written again`,
      );
  return changes;
}
