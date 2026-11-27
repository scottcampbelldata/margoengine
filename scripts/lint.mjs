// `npm run lint`: Biome lint over the tree, then Biome check (format and lint, warnings fail) over the files changed
// since the merge base with origin/main, committed or not, untracked included, then Biome check over the tree against
// the recorded debt in scripts/lint-debt.json.
//   npm run lint                       all three steps
//   node scripts/lint.mjs --base=<ref> diff against that ref instead of origin/main
//   node scripts/lint.mjs --shrink     also drop listed failures that are fixed (the list only ever shrinks)
// Why the second step: `biome lint` never checks formatting and passes on warnings, so unformatted files and unused
// imports landed on main with a green gate. The changed files are held to the full rule.
// Why the third: on a commit that is already on main (every local CI run) nothing differs from origin/main, so the
// second step checked 0 files and hundreds of files drifted. A file, or a kind of failure in a listed file, that is not
// in the debt list fails wherever the gate runs.
// suspicious/noExplicitAny stays out of both checks: hygiene gate 3 grants justified survivors per file.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
/** The failures the tree already held when the tree step landed: { file: [category, ...] }. */
export const DEBT = 'scripts/lint-debt.json';
const RULES = ['--error-on-warnings', '--skip=suspicious/noExplicitAny'];

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
  const args = [bin, 'check', ...RULES, '--no-errors-on-unmatched', '--files-ignore-unknown=true', ...files];
  const run = spawnSync(process.execPath, args, { cwd, stdio, encoding: 'utf8', timeout: 5 * 60_000 });
  if (run.error) throw run.error;
  return run.status ?? 1;
}

/** Every file under `cwd` that `biome check` fails, with what fails there ('format' or a lint rule), sorted. */
export function treeProblems({ cwd = root, bin = biomeBin(cwd) } = {}) {
  const args = [bin, 'check', ...RULES, '--reporter=json', '--max-diagnostics=1000000'];
  const run = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 5 * 60_000 });
  if (run.error) throw run.error;
  const report = JSON.parse(run.stdout);
  if (report.summary.diagnosticsNotPrinted) throw new Error('Biome left diagnostics out of its report');
  const found = new Map();
  for (const { severity, category, location } of report.diagnostics) {
    if (severity === 'information' || severity === 'info' || severity === 'hint') continue;
    if (!location?.path) throw new Error(`Biome reported ${category} with no file; run npx biome check`);
    const file = location.path.replaceAll('\\', '/');
    found.set(file, (found.get(file) ?? new Set()).add(category));
  }
  return Object.fromEntries([...found.keys()].sort().map((file) => [file, [...found.get(file)].sort()]));
}

/** What `found` holds beyond the `debt` list (`fresh`), and what the list holds that is fixed (`fixed`). */
export function compareDebt(found, debt) {
  const beyond = (a, b) =>
    Object.entries(a).flatMap(([file, kinds]) =>
      kinds.filter((kind) => !b[file]?.includes(kind)).map((kind) => `${file}: ${kind}`),
    );
  return { fresh: beyond(found, debt), fixed: beyond(debt, found) };
}

/** The tree step: 0 when nothing fails beyond the debt list. `shrink` removes the fixed failures from the list. */
export function checkTree({ cwd = root, bin = biomeBin(cwd), shrink = false, log = console.log } = {}) {
  const file = join(cwd, DEBT),
    debt = JSON.parse(readFileSync(file, 'utf8')),
    found = treeProblems({ cwd, bin }),
    { fresh, fixed } = compareDebt(found, debt);
  if (shrink && fixed.length) {
    const kept = Object.entries(debt)
      .map(([name, kinds]) => [name, kinds.filter((kind) => found[name]?.includes(kind))])
      .filter(([, kinds]) => kinds.length);
    writeFileSync(file, `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`);
  }
  log(`lint: ${Object.keys(found).length} file(s) in the tree fail Biome check; ${fresh.length} failure(s) are new`);
  if (fixed.length && !shrink) log(`lint: ${fixed.length} listed failure(s) are fixed: node scripts/lint.mjs --shrink`);
  for (const line of fresh) log(`  ${line}`);
  if (fresh.length) log(`lint: fix them with npx biome check --write <file>; ${DEBT} never grows`);
  return fresh.length ? 1 : 0;
}

async function main() {
  const base = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'origin/main';
  const bin = biomeBin();
  const tree = spawnSync(process.execPath, [bin, 'lint'], { cwd: root, stdio: 'inherit', timeout: 5 * 60_000 });
  if (tree.error) throw tree.error;
  const { base: mergeBase, files } = changedFiles(root, base);
  console.log(`lint: Biome check on ${files.length} changed file(s) since ${mergeBase.slice(0, 10)} (${base})`);
  const changed = checkChanged(files, { bin });
  const debt = checkTree({ bin, shrink: process.argv.includes('--shrink') });
  return tree.status || changed || debt ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
