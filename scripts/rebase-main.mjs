// Rebases the current branch onto origin/main and settles conflicts in generated files, which every concurrent landing
// otherwise hits. While the rebase runs, each such file takes the upstream copy (sizes.json is merged by key: the
// replayed commit's budget changes go onto upstream's) and no generator runs, since a half-rebased tree gives wrong
// figures. On the finished tree the generators run once and their output is committed on its own. Any other conflict
// stops with the file names and leaves the rebase for you; run the script again after resolving it. It also resumes a
// rebase already in progress. It writes no git config.
//   npm run rebase:main
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { conflictMarkers } from './support/conflict-markers.mjs';

const SIZES = 'scripts/quality/baselines/sizes.json';
const API = /^(api\/[^/]+\.api\.md|docs\/api-surface\.md|examples\/all-entries\/.+)$/;
const GENERATED = [
  API,
  /^docs\/guides\/imports\.md$/,
  /^site\/llms[^/]*\.txt$/,
  /^package-lock\.json$/,
  /^scripts\/quality\/baselines\/sizes\.json$/,
];

let root = process.cwd();
function run(command, args, { allowFail = false, shell = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell,
    timeout: 900_000,
    maxBuffer: 1 << 28,
    env: { ...process.env, GIT_EDITOR: 'true' },
  });
  if (!allowFail && result.status !== 0)
    stop(`${command} ${args.join(' ')} failed:\n${result.stdout ?? ''}${result.stderr || result.error || ''}`);
  return result;
}
const git = (args, options) => run('git', args, options);
const lines = (args) => git(args).stdout.split('\n').filter(Boolean);
const script = (...args) => run(process.execPath, args);
const unresolved = () => lines(['diff', '--name-only', '--diff-filter=U']);

function stop(message) {
  console.error(`rebase:main stopped. ${message}`);
  process.exit(1);
}

root = git(['rev-parse', '--show-toplevel']).stdout.trim();
const gitPath = (name) => resolve(root, git(['rev-parse', '--git-path', name]).stdout.trim());
const rebasing = () => existsSync(gitPath('rebase-merge')) || existsSync(gitPath('rebase-apply'));

/** Upstream's sizes.json with the replayed commit's own budget changes applied. */
function mergeSizes() {
  const [base, ours, theirs] = [1, 2, 3].map((stage) => JSON.parse(git(['show', `:${stage}:${SIZES}`]).stdout));
  const items = { ...ours.items };
  for (const key of new Set([...Object.keys(base.items), ...Object.keys(theirs.items)])) {
    if (theirs.items[key] === base.items[key]) continue;
    if (theirs.items[key] === undefined) delete items[key];
    else items[key] = theirs.items[key];
  }
  const known = new Set((base.history ?? []).map((entry) => JSON.stringify(entry)));
  const added = (theirs.history ?? []).filter((entry) => !known.has(JSON.stringify(entry)));
  const sorted = Object.fromEntries(
    Object.keys(items)
      .sort()
      .map((key) => [key, items[key]]),
  );
  const merged = {
    ...ours,
    total: Object.values(sorted).reduce((sum, value) => sum + value, 0),
    history: [...(ours.history ?? []), ...added],
    items: sorted,
  };
  writeFileSync(resolve(root, SIZES), JSON.stringify(merged, null, 2) + '\n');
}

// What to regenerate, kept in the git directory so a run stopped by your own conflict still knows it afterwards.
const ledger = gitPath('rebase-main.json');
const owed = () => (existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')) : []);

function settle(conflicts) {
  const unmerged = lines(['ls-files', '-u']);
  // Every file the branch changes, not just this commit's: a generated-only commit must still name its packages.
  const [onto, head] = ['onto', 'orig-head'].map((name) =>
    readFileSync(gitPath(`rebase-merge/${name}`), 'utf8').trim(),
  );
  const changed = lines(['diff', '--name-only', `${onto}...${head}`]);
  writeFileSync(ledger, JSON.stringify([...new Set([...owed(), ...conflicts, ...changed])]));
  for (const file of conflicts) {
    const stages = new Set(unmerged.filter((l) => l.endsWith(`\t${file}`)).map((l) => l.split(/\s+/)[2]));
    if (file === SIZES && stages.size === 3) mergeSizes();
    // During a rebase "ours" is upstream (with the commits already replayed on it).
    else if (stages.has('2')) git(['checkout', '--ours', '--', file]);
    else git(['rm', '-q', '--force', '--', file]);
    if (existsSync(resolve(root, file))) git(['add', '--', file]);
  }
}

function regenerate() {
  const touched = owed();
  const hit = (pattern) => touched.some((file) => pattern.test(file) && GENERATED.some((g) => g.test(file)));
  if (hit(/^package-lock\.json$/))
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
      shell: process.platform === 'win32',
    });
  if (hit(/^docs\/guides\/imports\.md$/)) script('scripts/umbrella.mjs');
  if (hit(API)) {
    // One full api:update on the finished tree, never one per package: a dependent's report changes too.
    script('scripts/api-report.js', '--update');
    script('scripts/generate-all-entries.mjs');
  }
  // Last: llms-full.txt is built from the READMEs, api reports and docs settled above.
  if (hit(/^(api\/|docs\/|site\/llms)/)) script('scripts/build-llms.mjs');
  git(['add', '-u']);
  if (existsSync(resolve(root, 'api'))) git(['add', '--', 'api']);
  if (git(['diff', '--cached', '--quiet'], { allowFail: true }).status !== 0)
    git(['commit', '-q', '-m', 'chore: generated files after the rebase']);
  rmSync(ledger, { force: true });
}

if (!rebasing() && !existsSync(ledger)) {
  git(['fetch', '-q', 'origin', 'main']);
  const result = git(['rebase', 'origin/main'], { allowFail: true });
  if (result.status !== 0 && !rebasing()) stop(`git rebase origin/main failed:\n${result.stdout}${result.stderr}`);
}
while (rebasing()) {
  const conflicts = unresolved();
  const own = conflicts.filter((file) => !GENERATED.some((pattern) => pattern.test(file)));
  if (own.length)
    stop(
      `Conflicts outside the generated files:\n  ${own.join('\n  ')}\n` +
        'Resolve and `git add` them, then run npm run rebase:main again.',
    );
  if (conflicts.length) {
    console.log(`rebase:main: taking upstream's ${conflicts.join(', ')}`);
    settle(conflicts);
  }
  if (git(['diff', '--quiet'], { allowFail: true }).status !== 0)
    stop('The working tree has changes that are not added; add or undo them, then run it again.');
  const empty = git(['diff', '--cached', '--quiet'], { allowFail: true }).status === 0;
  const result = git(['rebase', empty ? '--skip' : '--continue'], { allowFail: true });
  // A failure with new conflicts is the next commit's stop; one with none would loop for ever.
  if (result.status !== 0 && !unresolved().length)
    stop(`git rebase could not go on:\n${result.stdout}${result.stderr}`);
}
if (existsSync(ledger)) regenerate();
const markers = conflictMarkers(root);
if (markers.length) stop(`Conflict markers are left in:\n  ${markers.join('\n  ')}\nRemove them before you push.`);
console.log(
  'rebase:main: done, no conflict markers. Run your checks, then push at once with git push origin HEAD:main.',
);
