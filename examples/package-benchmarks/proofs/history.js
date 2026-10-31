// The Git history a proof builds its baseline from. Pinned runs (the commit where a claim was made) rebuild packages at
// commits that exist only in the pre-rewrite history of one checkout; a clone without them (a fresh clone, CI, a
// contributor) cannot rerun those claims, so such a proof prints `HISTORICAL: <commit and reason>` and exits 0, as the
// runner documents. Ongoing guarantees (`--current`) never come here for their baseline: they read the golden outputs
// in baselines/ (golden.js), which every clone has. A golden-mode proof that still asks Git for a missing revision is a
// bug in the proof and fails instead.
//
// HISTORICAL passes, so only Git's own answer "no such commit" may lead to it. Git that did not answer (it could not start
// on a loaded machine, or could not read a file another process was replacing) throws here and fails the proof, with
// Git's message: it says nothing about what this clone holds. The same goes for a missing file in show() and a
// non-ancestor in isAncestor(), which would otherwise read the working tree or decide a claim on a guess.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const run = (args) =>
  spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
const failed = (args, result) =>
  new Error(
    `git ${args.join(' ')} gave no answer (${result.error?.code ?? `status ${result.status}`}): ${result.stderr?.trim() || result.error?.message}`,
  );
/** Git's output, or undefined where `no` is the exit status this command answers "no" with; anything else throws. */
const git = (args, no) => {
  const result = run(args);
  if (result.status === 0) return result.stdout;
  if (no !== undefined && result.status === no) return undefined;
  throw failed(args, result);
};
/** The object id of `name`, or undefined when Git answers that it has none (--verify --quiet: status 1, no message). */
const object = (name) => git(['rev-parse', '--verify', '--quiet', '--end-of-options', name], 1)?.trim();
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

/** Whether this clone holds commit `ref`. Throws when Git gives no answer. */
export const holds = (ref) => object(`${ref}^{commit}`) !== undefined;

// Each ref a run names is resolved once: one proof reads one commit throughout, whatever HEAD does meanwhile, and the
// hundreds of show() calls of a build do not each ask Git the same question again.
const revisions = new Map();

/** The full commit id of `ref`, or HISTORICAL (historical()) when this clone does not hold it. */
export function revision(ref) {
  // Golden mode reads nothing from Git, even where this clone holds the commit, so every clone runs the same thing.
  if (strict.value) return historical(ref);
  if (!revisions.has(ref)) {
    const id = object(`${ref}^{commit}`);
    if (id === undefined) return historical(ref);
    revisions.set(ref, id).set(id, id);
  }
  return revisions.get(ref);
}

/** A repository file's text at commit `ref` (`path` relative to the repository, forward slashes), or undefined when the
 * commit has no such file. */
export function show(ref, path) {
  const name = `${revision(ref)}:${path}`,
    args = ['show', name],
    result = run(args);
  if (result.status === 0) return result.stdout;
  // `git show` has one status for every failure, so a missing file is what Git answers when asked about the file alone.
  if (object(name) === undefined) return;
  throw failed(args, result);
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
  return git(['merge-base', '--is-ancestor', of, id], 1) !== undefined;
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
