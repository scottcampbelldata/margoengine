// `npm run lint`: Biome lint over the tree, then Biome check (format and lint, warnings fail) over the files changed
// since the merge base with origin/main, committed or not, untracked included.
//   npm run lint                       both steps
//   node scripts/lint.mjs --base=<ref> diff against that ref instead of origin/main
// Why the second step: `biome lint` never checks formatting and passes on warnings, and the tree holds thousands of
// files Biome would reformat (hygiene scores them, warn mode), so unformatted files and unused imports landed on main
// with a green gate. The changed files are held to the full rule; the rest of the tree is not run twice.
// suspicious/noExplicitAny stays out of the changed-file step: hygiene gate 3 grants justified survivors per file.
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

/** Changed files since the merge base with `base`, committed or not, untracked included. Throws without git. */
export function changedFiles(cwd = root, base = 'origin/main') {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  const mergeBase = git('merge-base', 'HEAD', base).trim();
  const lines = (text) => text.split('\0').filter(Boolean);
  const tracked = lines(git('diff', '--name-only', '--no-renames', '--diff-filter=d', '-z', mergeBase)),
    untracked = lines(git('ls-files', '--others', '--exclude-standard', '-z'));
  return { base: mergeBase, files: [...new Set([...tracked, ...untracked])] };
}

/** Biome's command line entry, resolved from the repository's devDependency. */
export const biomeBin = (cwd = root) => createRequire(join(cwd, 'package.json')).resolve('@biomejs/biome/bin/biome');

/**
 * Runs `biome check` on `files` (repository paths) in `cwd`: a file Biome would reformat, a lint error or a lint warning
 * other than noExplicitAny fails. Files Biome does not cover (biome.json `files.includes`, unknown kinds) are skipped.
 * Returns the exit status; Biome's report goes to the inherited stdio.
 */
export function checkChanged(files, { cwd = root, bin = biomeBin(), stdio = 'inherit' } = {}) {
  if (!files.length) return 0;
  const args = [
    bin,
    'check',
    '--error-on-warnings',
    '--skip=suspicious/noExplicitAny',
    '--no-errors-on-unmatched',
    '--files-ignore-unknown=true',
    ...files,
  ];
  const run = spawnSync(process.execPath, args, { cwd, stdio, encoding: 'utf8', timeout: 5 * 60_000 });
  if (run.error) throw run.error;
  return run.status ?? 1;
}

async function main() {
  const base = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'origin/main';
  const bin = biomeBin();
  const tree = spawnSync(process.execPath, [bin, 'lint'], { cwd: root, stdio: 'inherit', timeout: 5 * 60_000 });
  if (tree.error) throw tree.error;
  const { base: mergeBase, files } = changedFiles(root, base);
  console.log(`lint: Biome check on ${files.length} changed file(s) since ${mergeBase.slice(0, 10)} (${base})`);
  const changed = checkChanged(files, { bin });
  return tree.status || changed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
