// The Git history a proof builds its baseline from. Pinned runs (the commit where a claim was made) rebuild packages at
// commits that exist only in the pre-rewrite history of one checkout; a clone without them (a fresh clone, CI, a
// contributor) cannot rerun those claims, so such a proof prints `HISTORICAL: <commit and reason>` and exits 0, as the
// runner documents. Ongoing guarantees (`--current`) never come here for their baseline: they read the golden outputs
// in baselines/ (golden.js), which every clone has. A golden-mode proof that still asks Git for a missing revision is a
// bug in the proof and fails instead.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const git = (args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });
const proof = () => basename(process.argv[1] ?? 'proof').replace(/\.proof\.js$|\.m?js$/, '');

/** True while a --current proof reads golden outputs (golden.js): then a missing revision is an error, not HISTORICAL. */
export const strict = { value: false };

/** A revision this clone does not hold: HISTORICAL and exit 0 for a pinned claim, an error in golden mode. */
export function historical(ref) {
  const message = `${ref}, a commit only in the pre-rewrite history (this clone does not hold it)`;
  if (strict.value)
    throw new Error(
      `${proof()} --current asked Git for ${ref}; a --current run reads its baseline from baselines/ only (golden.js), so a fresh clone runs it too.`,
    );
  const result = resolve(import.meta.dirname, 'results', `${proof()}.json`);
  console.log(
    `HISTORICAL: ${proof()} is pinned to ${message}; its recorded result is ${existsSync(result) ? `results/${proof()}.json` : 'in docs/whitepaper/claims.md'}. Its ongoing guarantee, if it has one, runs with --current.`,
  );
  process.exit(0);
}

/** The full commit id of `ref`, or HISTORICAL (historical()) when this clone does not hold it. */
export function revision(ref) {
  // Golden mode reads nothing from Git, even where this clone holds the commit, so every clone runs the same thing.
  if (strict.value) return historical(ref);
  try {
    return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  } catch {
    return historical(ref);
  }
}

/** A repository file's text at commit `ref` (`path` relative to the repository, forward slashes), or undefined when the
 * commit has no such file. */
export function show(ref, path) {
  const id = revision(ref);
  try {
    return git(['show', `${id}:${path}`]);
  } catch {
    return;
  }
}

/** The names directly inside directory `dir` at commit `ref`, as `git ls-tree --name-only`. */
export const list = (ref, dir) =>
  git(['ls-tree', '--name-only', `${revision(ref)}:${dir}`])
    .split('\n')
    .filter(Boolean);

/** Whether commit `ancestor` is an ancestor of commit `ref` (`git merge-base --is-ancestor`). */
export function isAncestor(ancestor, ref) {
  const id = revision(ref),
    of = revision(ancestor);
  try {
    git(['merge-base', '--is-ancestor', of, id]);
    return true;
  } catch {
    return false;
  }
}

/** Git's blob id of a working-tree file's text (LF line ends), as `git hash-object` gives it in a checkout. */
const blobId = (text) => {
  const bytes = Buffer.from(text.replaceAll('\r\n', '\n'));
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};

/** Files under `dirs` present at both `base` and `other` whose content differs, sorted
 * (`git diff --name-only --diff-filter=M base other -- dirs`). `other` undefined: the working tree. */
export function modified(base, other, dirs) {
  const files = (ref) =>
    new Map(
      git(['ls-tree', '-r', revision(ref), '--', ...dirs])
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [meta, path] = line.split('\t');
          return [path, meta.split(' ')[2]];
        }),
    );
  const before = files(base),
    after = other && files(other);
  const now = (path) => {
    if (after) return after.get(path);
    const file = resolve(root, path);
    return existsSync(file) ? blobId(readFileSync(file, 'utf8')) : undefined;
  };
  return [...before]
    .filter(([path, id]) => now(path) !== undefined && now(path) !== id)
    .map(([path]) => path)
    .sort();
}
