// What a fresh clone runs, run in one (`npm run check:fresh-clone`, part of check:merge and the nightly job): the
// working tree (tracked and untracked, not ignored) is committed as a parentless snapshot, fetched with --depth 1 into a
// temporary folder, so the clone holds that one commit and no history at all, given this checkout's third-party
// node_modules offline (hard links; @margoengine/* are junctions to the clone's own packages); then `npm run verify` and the
// proof runner run in it.
// It fails when verify fails, and on any --current proof that fails, is HISTORICAL or prints a message about a
// missing commit, object or baseline (they read golden outputs from baselines/ only). A fresh clone of main once failed
// `npm run verify`: 14 of 20 --current proofs rebuilt their baselines from commits only this PC's pre-rewrite history
// held (examples/package-benchmarks/proofs/golden.js).
//   node scripts/fresh-clone-check.mjs [--pinned] [--keep]   --pinned: the pinned runs too, which must end PASS or
//   HISTORICAL (a claim whose commits the clone lacks), never FAIL; --keep: leave the folder (its path is printed)
// Every step has a hard time limit; the folder is removed in a detached process afterwards (Windows deletes slowly).
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { venvDir } from '../python/tests/venv.mjs';
import { externalAssetRoot } from './support/external-test-assets.mjs';

const root = resolve(import.meta.dirname, '..');

/** Lines of proof-runner output that show a dependence on history a fresh clone lacks. */
export const MISSING_HISTORY =
  /asked Git for|no stored baseline for|a commit only in the pre-rewrite history|Needed a single revision|unknown revision|bad revision|bad object|not a valid object name|does not exist at [0-9a-f]{7,}|fatal: /;

/**
 * The environment the clone's verify runs with. The clone sits in the temp folder, so the shared outside test inputs
 * (scripts/support/external-test-assets.mjs, found beside the checkout by default) and the Python venv are named as
 * this checkout's: verify failed in the clone with "Missing Required test fixture <temp>/engine-bench/..." (01047bfc5a).
 */
export function verifyEnv(env = process.env) {
  return { MARGO_JUPYTER_VENV: venvDir(), MARGO_SPLAT_SAMPLES: externalAssetRoot(env) };
}

/**
 * Problems in a proof-runner run (`out` is its stdout + stderr). `--current` (the ongoing guarantees, in verify): any
 * failed or HISTORICAL row and any missing-history message, since those proofs must run from baselines/ alone. Pinned
 * (`pinned` true): failed rows only; a pinned claim whose commits the clone lacks is HISTORICAL by design.
 */
export function problems(out, code, pinned = false) {
  const found = [];
  if (code !== 0) found.push(`the proof runner exited ${code}`);
  for (const [, name, result] of out.matchAll(/^(\S+) +\S.*? +(FAIL|HISTORICAL) +\d+ /gm))
    if (result === 'FAIL') found.push(`${name}: FAIL`);
    else if (!pinned) found.push(`${name}: HISTORICAL in --current (an ongoing guarantee must always run)`);
  if (!pinned)
    for (const line of out.split('\n')) if (MISSING_HISTORY.test(line)) found.push(`missing history: ${line.trim()}`);
  if (!/\d+ pass, \d+ historical, \d+ fail/.test(out)) found.push('the proof runner printed no summary');
  return [...new Set(found)];
}

const run = (command, args, { cwd = root, env = {}, minutes = 10, input } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    input,
    timeout: minutes * 60_000,
    killSignal: 'SIGKILL',
    maxBuffer: 1 << 28,
    shell: process.platform === 'win32' && command === 'npm',
  });
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL')
    throw new Error(`fresh-clone: \`${command} ${args.join(' ')}\` passed its ${minutes} min limit`);
  return result;
};
const must = (command, args, options) => {
  const result = run(command, args, options);
  if (result.status !== 0)
    throw new Error(
      `fresh-clone: \`${command} ${args.join(' ')}\` failed (${result.status}):\n${result.stderr || result.stdout}`,
    );
  return result.stdout;
};

/** A parentless commit of the working tree (tracked and untracked files, not ignored), made with a copy of the index
 * so the checkout's own index and refs are untouched. */
export function snapshot(scratch) {
  const index = join(scratch, 'index');
  copyFileSync(resolve(root, must('git', ['rev-parse', '--git-path', 'index']).trim()), index);
  const env = { GIT_INDEX_FILE: index };
  must('git', ['add', '-A'], { env, minutes: 10 });
  const tree = must('git', ['write-tree'], { env }).trim();
  const ident = { GIT_AUTHOR_NAME: 'fresh-clone', GIT_AUTHOR_EMAIL: 'fresh-clone@example.invalid' };
  return must('git', ['commit-tree', tree, '-m', 'fresh-clone check snapshot'], {
    env: { ...ident, GIT_COMMITTER_NAME: ident.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: ident.GIT_AUTHOR_EMAIL },
  }).trim();
}

/**
 * The folder the clone goes in: under the temporary folder by its real (long) path. On Windows os.tmpdir() can be a
 * short 8.3 path (a home folder named like ABCDEF~1), and Vite compares its allow list, built from the folder it starts in as given,
 * with each file's real path, so every dev server in a clone under the short path answered 403 (check:dev-servers in
 * the 2026-11-15 nightly). A developer's clone sits under its real path; so does this one.
 */
export function scratchFolder(tmp = tmpdir()) {
  return mkdtempSync(join(realpathSync.native(tmp), 'margo-fresh-clone-'));
}

/**
 * Gives `target` the tree at `source` as hard links (copies across volumes), keeping the directory links in it as
 * junctions to where they point. A junction to this checkout's package would put the package's real path outside the
 * clone, and a bundler that keeps to the project root (Next.js's Turbopack) then cannot read it: `next dev` and
 * `next build` in the clone failed with "Could not find the Next.js package" and, with next itself in the clone, with
 * "Can't resolve '@swc/helpers/...'". A hard link is the same file under a second name: nothing is copied, and
 * removing the clone removes only its names.
 */
export function linkTree(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name),
      to = join(target, entry.name);
    if (entry.isSymbolicLink()) {
      const real = realpathSync(from);
      if (lstatSync(real).isDirectory()) symlinkSync(real, to, 'junction');
      else copyFileSync(real, to);
    } else if (entry.isDirectory()) linkTree(from, to);
    else hardLink(from, to);
  }
}

/** `linkSync`, or a copy where the two folders are on different volumes (EXDEV: a hard link cannot cross one). */
function hardLink(from, to) {
  try {
    linkSync(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    copyFileSync(from, to);
  }
}

/** node_modules for the clone: third-party entries are hard-linked from this checkout's (linkTree), @margoengine/*
 * are junctions to the clone's own packages. */
export function linkModules(clone, source = join(root, 'node_modules')) {
  const target = join(clone, 'node_modules');
  if (!existsSync(source)) throw new Error('fresh-clone: run npm ci in this checkout first');
  mkdirSync(join(target, '@margoengine'), { recursive: true });
  for (const name of readdirSync(source))
    if (name !== '@margoengine' && name !== 'margoengine' && !name.startsWith('.'))
      linkTree(realpathSync(join(source, name)), join(target, name));
  if (existsSync(join(source, '.bin'))) linkTree(realpathSync(join(source, '.bin')), join(target, '.bin'));
  for (const dir of readdirSync(join(clone, 'packages'))) {
    const manifest = join(clone, 'packages', dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
    if (name.startsWith('@margoengine/') || name === 'margoengine')
      symlinkSync(join(clone, 'packages', dir), join(target, name), 'junction');
  }
}

/** Removes the clone: its junctions first (never what they point at), then the rest, in a detached process. */
function remove(folder) {
  const modules = join(folder, 'clone/node_modules');
  // Only the links; real folders the run made there (e.g. Vite's .vite-temp) go with the rest.
  const unlink = (dir) => {
    for (const name of readdirSync(dir)) if (lstatSync(join(dir, name)).isSymbolicLink()) rmSync(join(dir, name));
  };
  if (existsSync(modules)) {
    unlink(join(modules, '@margoengine'));
    unlink(modules);
  }
  spawn(
    process.execPath,
    ['-e', `require('node:fs').rmSync(${JSON.stringify(folder)}, { recursive: true, force: true })`],
    {
      detached: true,
      stdio: 'ignore',
    },
  ).unref();
}

async function main() {
  const pinned = process.argv.includes('--pinned'),
    keep = process.argv.includes('--keep'),
    started = Date.now();
  const folder = scratchFolder(),
    clone = join(folder, 'clone');
  try {
    // A side-by-side check:merge snapshots right after verify, as the serial order does, before any step beside this
    // one writes to the tree (build:site rewrites tracked records), and hands the commit over.
    const commit = process.env.MARGO_FRESH_CLONE_COMMIT || snapshot(folder);
    must('git', ['init', '-q', clone]);
    const url = pathToFileURL(root).href;
    must(
      'git',
      [
        '-C',
        clone,
        'fetch',
        '-q',
        '--depth',
        '1',
        '--upload-pack',
        'git -c uploadpack.allowAnySHA1InWant=true upload-pack',
        url,
        commit,
      ],
      { minutes: 10 },
    );
    // Git LFS files (test textures, models) are content a fresh clone downloads, not history: they are filled from this
    // checkout's LFS store, offline, as `git lfs pull` would fill them from GitHub.
    const media = /^LocalMediaDir=(.+)$/m.exec(must('git', ['lfs', 'env']))?.[1]?.trim();
    if (!media) throw new Error('fresh-clone: git lfs env names no LocalMediaDir; install Git LFS (git lfs install)');
    must('git', ['-C', clone, '-c', `lfs.storage=${dirname(media)}`, 'checkout', '-q', '--detach', 'FETCH_HEAD'], {
      minutes: 10,
    });
    const pointers = must('git', ['-C', clone, '-c', `lfs.storage=${dirname(media)}`, 'lfs', 'ls-files'])
      .split('\n')
      .filter((line) => / - /.test(line));
    if (pointers.length)
      throw new Error(
        `fresh-clone: ${pointers.length} LFS files stayed pointers, e.g. ${pointers[0]}; run git lfs fetch here`,
      );
    // The clone holds the snapshot and nothing else: not one stored baseline revision resolves in it.
    const count = must('git', ['-C', clone, 'rev-list', '--all', '--count']).trim();
    if (count !== '1') throw new Error(`fresh-clone: the clone holds ${count} commits, not 1`);
    const baselines = join(clone, 'examples/package-benchmarks/proofs/baselines');
    const stored = readdirSync(baselines)
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(join(baselines, file), 'utf8')).revision);
    const present = run('git', ['-C', clone, 'cat-file', '--batch-check'], { input: stored.join('\n') + '\n' })
      .stdout.split('\n')
      .filter((line) => line && !line.endsWith(' missing'));
    if (present.length) throw new Error(`fresh-clone: the clone holds baseline commits: ${present.join(', ')}`);
    linkModules(clone);
    // Everything every change must pass, as a fresh clone runs it (it builds the packages the proofs below read).
    // The Python venv and the outside test inputs are this checkout's (verifyEnv); making a venv is
    // python-venv.test.js's subject and fetching the inputs is fetch-skip-assets.mjs's, not this check's.
    const verify = run('npm', ['run', 'verify'], { cwd: clone, minutes: 40, env: verifyEnv() });
    if (verify.status !== 0)
      throw new Error(
        `fresh-clone: npm run verify failed in a clone without history (${verify.status}):
${`${verify.stdout}
${verify.stderr}`.slice(-8000)}`,
      );
    console.log('fresh-clone: npm run verify passed');
    const found = [];
    for (const mode of pinned ? [['--current'], []] : [['--current']]) {
      const result = run(process.execPath, ['examples/package-benchmarks/proofs/run.mjs', ...mode], {
        cwd: clone,
        minutes: pinned ? 120 : 30,
      });
      const out = `${result.stdout}\n${result.stderr}`;
      const label = mode.length ? 'proofs --current' : 'proofs (pinned)';
      console.log(
        `fresh-clone: ${label}: ${out.match(/\d+ pass, \d+ historical, \d+ fail[^\n]*/)?.[0] ?? 'no summary'}`,
      );
      for (const problem of problems(out, result.status, !mode.length)) found.push(`${label}: ${problem}`);
      if (found.length) console.log(out.slice(-6000));
    }
    if (found.length)
      throw new Error(
        `fresh-clone: a clone without history cannot run what this checkout runs:\n  ${found.join('\n  ')}`,
      );
    console.log(
      `fresh-clone: passed in ${Math.round((Date.now() - started) / 1000)} s (clone of ${commit.slice(0, 10)}, no history)`,
    );
  } finally {
    if (keep) console.log(`fresh-clone: kept ${clone}`);
    else remove(folder);
  }
}

// process.argv[1] is undefined under `node -e` or `node --input-type=module`, where importing this file must not throw.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
