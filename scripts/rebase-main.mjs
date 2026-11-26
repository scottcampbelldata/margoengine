// Rebases the current branch onto origin/main and settles conflicts in generated files, which every concurrent landing
// otherwise hits. While the rebase runs, each such file takes the upstream copy (sizes.json is merged by key: the
// replayed commit's budget changes go onto upstream's) and no generator runs, since a half-rebased tree gives wrong
// figures. On the finished tree the generators run once and their output is committed on its own. An API report run
// costs minutes, so it is only for a report both sides changed; every other report replays as it is, and
// docs/api-surface.md is merged row by row (KB-REBASE-SLOW1: reports for every touched package took 7 to 9 minutes,
// main moved meanwhile and push:main refused every round). api:check after the rebase stays the check. Any other conflict
// stops with the file names and leaves the rebase for you; run the script again after resolving it. It also resumes a
// rebase already in progress. It writes no git config.
// The commits are first replayed without a checkout (git merge-tree and commit-tree), then the branch moves once: git
// rebase ran the post-checkout and post-commit hooks for every commit, which took git-lfs 5 to 30 s each, so a rebase
// outlasted the time between two landings (KB-REBASE-HOOKS1). Generated conflicts are settled the same way there. Any
// other conflict, a merge commit, signed commits, changed tracked files or a git older than 2.40 leave the branch
// untouched for git rebase, which stops for you as before. The pre-push hook is not involved.
//   npm run rebase:main
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mergeApiSurfaceRows } from './api-report-scope.mjs';
import { historyMissing, historyRepeated } from './quality/ratchet.js';
import { conflictMarkers } from './support/conflict-markers.mjs';

const SIZES = 'scripts/quality/baselines/sizes.json';
const SURFACE = 'docs/api-surface.md';
const API = /^(api\/[^/]+\.api\.md|docs\/api-surface\.md|examples\/all-entries\/.+)$/;
const GENERATED = [
  API,
  /^docs\/guides\/imports\.md$/,
  /^site\/llms[^/]*\.txt$/,
  /^package-lock\.json$/,
  /^scripts\/quality\/baselines\/sizes\.json$/,
  /^site\/sizes\.html$/,
];

let root = process.cwd();
function run(command, args, { allowFail = false, shell = false, input, env } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell,
    input,
    timeout: 900_000,
    maxBuffer: 1 << 28,
    env: { ...process.env, GIT_EDITOR: 'true', ...env },
  });
  if (!allowFail && result.status !== 0)
    stop(`${command} ${args.join(' ')} failed:\n${result.stdout ?? ''}${result.stderr || result.error || ''}`);
  return result;
}
const git = (args, options) => run('git', args, options);
const lines = (args) => git(args).stdout.split('\n').filter(Boolean);
const script = (...args) => run(process.execPath, args);
const unresolved = () => lines(['diff', '--name-only', '--diff-filter=U']);

/** The stop of a run: `main` ends there and the script ends by its event loop with code 1 (KB-OWN-EXIT2). */
class Stopped extends Error {}
function stop(message) {
  throw new Stopped(message);
}

const gitPath = (name) => resolve(root, git(['rev-parse', '--git-path', name]).stdout.trim());
const rebasing = () => existsSync(gitPath('rebase-merge')) || existsSync(gitPath('rebase-apply'));

/** Upstream's sizes.json with the replayed commit's own budget changes applied; each argument is the file's text. */
function mergeSizes(...texts) {
  const [base, ours, theirs] = texts.map((text) => JSON.parse(text));
  const items = { ...ours.items };
  for (const key of new Set([...Object.keys(base.items), ...Object.keys(theirs.items)])) {
    if (theirs.items[key] === base.items[key]) continue;
    if (theirs.items[key] === undefined) delete items[key];
    else items[key] = theirs.items[key];
  }
  // By identity, and against upstream too: a row the commit carries that upstream already has (the same change landed
  // twice, or a commit made on a file taken from main) came back a second time (KB-REBASE-HISTORYDUP1).
  const fresh = historyMissing(theirs.history ?? [], [...(base.history ?? []), ...(ours.history ?? [])]);
  const twice = new Set(historyRepeated(fresh));
  const added = fresh.filter((entry) => !twice.has(entry));
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
  return JSON.stringify(merged, null, 2) + '\n';
}

// What to regenerate, kept in the git directory so a run stopped by your own conflict still knows it afterwards.
const ledger = () => gitPath('rebase-main.json');
const owed = () => ({ conflicts: [], ...(existsSync(ledger()) ? JSON.parse(readFileSync(ledger(), 'utf8')) : {}) });

function settle(conflicts) {
  const unmerged = lines(['ls-files', '-u']);
  const [onto, head] = ['onto', 'orig-head'].map((name) =>
    readFileSync(gitPath(`rebase-merge/${name}`), 'utf8').trim(),
  );
  writeFileSync(ledger(), JSON.stringify({ onto, head, conflicts: [...new Set([...owed().conflicts, ...conflicts])] }));
  for (const file of conflicts) {
    const stages = new Set(unmerged.filter((l) => l.endsWith(`\t${file}`)).map((l) => l.split(/\s+/)[2]));
    if (file === SIZES && stages.size === 3)
      writeFileSync(
        resolve(root, SIZES),
        mergeSizes(...[1, 2, 3].map((stage) => git(['show', `:${stage}:${SIZES}`]).stdout)),
      );
    // During a rebase "ours" is upstream (with the commits already replayed on it).
    else if (stages.has('2')) git(['checkout', '--ours', '--', file]);
    else git(['rm', '-q', '--force', '--', file]);
    if (existsSync(resolve(root, file))) git(['add', '--', file]);
  }
}

function regenerate() {
  const { onto, head, conflicts } = owed();
  // What each side changed since they parted, not just the conflicted files.
  const branch = onto ? lines(['diff', '--name-only', `${onto}...${head}`]) : [];
  const upstream = new Set(onto ? lines(['diff', '--name-only', `${head}...${onto}`]) : []);
  const touched = [...conflicts, ...branch];
  const hit = (pattern) => touched.some((file) => pattern.test(file) && GENERATED.some((g) => g.test(file)));
  if (hit(/^package-lock\.json$/))
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
      shell: process.platform === 'win32',
    });
  if (hit(/^docs\/guides\/imports\.md$/)) script('scripts/umbrella.mjs');
  if (branch.includes(SURFACE) && upstream.has(SURFACE)) {
    const base = git(['merge-base', onto, head]).stdout.trim();
    const [before, theirs, mine] = [base, onto, head].map((rev) => git(['show', `${rev}:${SURFACE}`]).stdout);
    writeFileSync(resolve(root, SURFACE), mergeApiSurfaceRows(before, theirs, mine));
  }
  // A report only one side changed is already right. One both sides changed is built again, for its package alone, so
  // a re-export package (margoengine, a kit) only when its own report changed on both sides.
  const packages = new Set(
    [...conflicts, ...branch.filter((file) => upstream.has(file))]
      .map((file) => /^api\/([^./]+)[^/]*\.api\.md$/.exec(file)?.[1])
      .filter((name) => name && existsSync(resolve(root, 'packages', name, 'package.json'))),
  );
  console.log(`rebase:main: API reports to build: ${[...packages].sort().join(', ') || 'none'}`);
  for (const name of [...packages].sort()) script('scripts/api-report.js', '--update', `--package=${name}`);
  if (hit(API)) script('scripts/generate-all-entries.mjs');
  // Last: llms-full.txt is built from the READMEs, api reports and docs settled above.
  if (hit(/^(api\/|docs\/|site\/llms)/)) script('scripts/build-llms.mjs');
  git(['add', '-u']);
  if (existsSync(resolve(root, 'api'))) git(['add', '--', 'api']);
  if (git(['diff', '--cached', '--quiet'], { allowFail: true }).status !== 0) {
    const commit = commitTree(
      rev('HEAD'),
      git(['write-tree']).stdout.trim(),
      'chore: generated files after the rebase\n',
    );
    git(['update-ref', '-m', 'rebase:main: generated files', 'HEAD', commit]);
  }
  rmSync(ledger(), { force: true });
}

const rev = (name) => git(['rev-parse', '--verify', name]).stdout.trim();
const commitTree = (parent, tree, message, env) =>
  git(['commit-tree', tree, '-p', parent, '-F', '-'], { input: message, env }).stdout.trim();
const isGenerated = (file) => GENERATED.some((pattern) => pattern.test(file));

/** `tree`, a merge result holding conflicts in generated files only, settled as `settle` does, in an index of its own. */
function settleTree(tree, entries) {
  const index = { env: { GIT_INDEX_FILE: gitPath('rebase-main.index') } };
  git(['read-tree', tree], index);
  const blob = (oid) => git(['cat-file', 'blob', oid]).stdout;
  for (const file of new Set(entries.map((entry) => entry.file))) {
    const stages = new Map(entries.filter((entry) => entry.file === file).map((entry) => [entry.stage, entry]));
    // Stage 2 is upstream with the commits already replayed on it.
    const upstream = stages.get('2');
    if (file === SIZES && stages.size === 3) {
      const merged = mergeSizes(...['1', '2', '3'].map((stage) => blob(stages.get(stage).oid)));
      const oid = git(['hash-object', '-w', '--stdin', `--path=${file}`], { input: merged }).stdout.trim();
      git(['update-index', '--add', '--cacheinfo', `${upstream.mode},${oid},${file}`], index);
    } else if (upstream)
      git(['update-index', '--add', '--cacheinfo', `${upstream.mode},${upstream.oid},${file}`], index);
    else git(['update-index', '--force-remove', '--', file], index);
  }
  const settled = git(['write-tree'], index).stdout.trim();
  rmSync(index.env.GIT_INDEX_FILE, { force: true });
  return settled;
}

/**
 * Replays the branch's commits onto origin/main without a checkout and moves the branch there once, so no hook runs per
 * commit. Returns false, having changed nothing, when git rebase has to do it (see the head of this file).
 */
function replay() {
  const onto = rev('origin/main'),
    head = rev('HEAD');
  const commits = lines(['rev-list', '--reverse', `${onto}..${head}`]);
  const behind = lines(['rev-list', '--max-count=1', `${head}..${onto}`]).length;
  const signs = git(['config', '--bool', 'commit.gpgsign'], { allowFail: true }).stdout.trim() === 'true';
  if (!commits.length || !behind || signs) return false;
  if (git(['status', '--porcelain', '--untracked-files=no']).stdout) return false;
  if (lines(['rev-list', '--merges', `${onto}..${head}`]).length) return false;
  let parent = onto;
  const settled = [];
  for (const commit of commits) {
    // Exit 1 is a merge with conflicts; any other failure (an older git has no --merge-base) is git rebase's work.
    const merged = git(['merge-tree', '--write-tree', `--merge-base=${commit}^`, parent, commit], { allowFail: true });
    if (merged.status !== 0 && merged.status !== 1) return false;
    const output = merged.stdout.split('\n');
    let tree = output[0];
    if (merged.status === 1) {
      const entries = output
        .slice(1, output.indexOf('', 1))
        .map((line) => /^(\d+) ([0-9a-f]+) ([123])\t(.+)$/.exec(line))
        .map((match) => match && { mode: match[1], oid: match[2], stage: match[3], file: match[4] });
      if (!entries.length || entries.some((entry) => !entry || !isGenerated(entry.file))) return false;
      console.log(`rebase:main: taking upstream's ${[...new Set(entries.map((entry) => entry.file))].join(', ')}`);
      tree = settleTree(tree, entries);
      settled.push(...entries.map((entry) => entry.file));
    }
    // As git rebase does: a commit whose change is already upstream is dropped, one made empty on purpose is kept.
    if (tree === rev(`${parent}^{tree}`) && rev(`${commit}^{tree}`) !== rev(`${commit}^^{tree}`)) continue;
    const [name, email, date, message] = git(['log', '-1', '--format=%an%x00%ae%x00%aD%x00%B', commit]).stdout.split(
      '\0',
    );
    parent = commitTree(parent, tree, `${message.trimEnd()}\n`, {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
    });
  }
  // --keep refuses rather than overwrite an untracked file or lose a change, and runs no checkout hook.
  git(['reset', '-q', '--keep', parent]);
  if (settled.length) writeFileSync(ledger(), JSON.stringify({ onto, head, conflicts: [...new Set(settled)] }));
  console.log(`rebase:main: replayed ${commits.length} commit(s) without a checkout`);
  return true;
}

/**
 * margoengine.com/errors (site/errors.html) is built from scripts/errors/entries.js, and a commit that lists a message there
 * without running scripts/errors/page.mjs leaves the page stale, which fails hygiene on main (e6b371f6f, the React post
 * components). Every lane runs this script right before it pushes, so a branch that changed either file gets the page built
 * again here, as its own commit, when it no longer matches.
 */
function refreshErrorsPage() {
  const page = resolve(root, 'scripts/errors/page.mjs');
  if (!existsSync(page)) return;
  const changed = lines(['diff', '--name-only', 'origin/main...HEAD']);
  if (!changed.some((file) => file === 'scripts/errors/entries.js' || file === 'site/errors.html')) return;
  if (run(process.execPath, [page, '--check'], { allowFail: true }).status === 0) return;
  script('scripts/errors/page.mjs');
  git(['add', '--', 'site/errors.html']);
  if (git(['diff', '--cached', '--quiet'], { allowFail: true }).status === 0) return;
  const commit = commitTree(
    rev('HEAD'),
    git(['write-tree']).stdout.trim(),
    'chore: site/errors.html matches scripts/errors/entries.js\n',
  );
  git(['update-ref', '-m', 'rebase:main: errors page', 'HEAD', commit]);
  console.log('rebase:main: site/errors.html was stale for scripts/errors/entries.js; built again and committed');
}

/**
 * margoengine.com/sizes.html (site/sizes.html) is built from the size records, the catalog and the package manifests,
 * and hygiene fails when it is not what they build. A branch that changed one of them, or took upstream's page in a
 * conflict, gets the page built again here, as its own commit, when it no longer matches.
 */
function refreshSizesPage() {
  const page = resolve(root, 'scripts/build-sizes.js');
  if (!existsSync(page)) return;
  const changed = lines(['diff', '--name-only', 'origin/main...HEAD']);
  if (
    !changed.some((file) =>
      /^(site\/sizes\.html|docs\/catalog\.json|examples\/package-benchmarks\/results\/(entry-sizes|basic-scene-network)\.json|scripts\/(build-sizes|lazy-files)\.js|packages\/[^/]+\/package\.json)$/.test(
        file,
      ),
    )
  )
    return;
  if (run(process.execPath, [page, '--check'], { allowFail: true }).status === 0) return;
  script('scripts/build-sizes.js');
  git(['add', '--', 'site/sizes.html']);
  if (git(['diff', '--cached', '--quiet'], { allowFail: true }).status === 0) return;
  const commit = commitTree(
    rev('HEAD'),
    git(['write-tree']).stdout.trim(),
    'chore: site/sizes.html matches the size records\n',
  );
  git(['update-ref', '-m', 'rebase:main: sizes page', 'HEAD', commit]);
  console.log('rebase:main: site/sizes.html was stale for its records; built again and committed');
}

function main() {
  root = git(['rev-parse', '--show-toplevel']).stdout.trim();
  if (!rebasing() && !existsSync(ledger())) {
    git(['fetch', '-q', 'origin', 'main']);
    if (!replay()) {
      const result = git(['rebase', 'origin/main'], { allowFail: true });
      if (result.status !== 0 && !rebasing()) stop(`git rebase origin/main failed:\n${result.stdout}${result.stderr}`);
    }
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
  if (existsSync(ledger())) regenerate();
  refreshErrorsPage();
  refreshSizesPage();
  const markers = conflictMarkers(root);
  if (markers.length) stop(`Conflict markers are left in:\n  ${markers.join('\n  ')}\nRemove them before you push.`);
  // The commits to push must not delete or revert on a mass scale (the ff88a70e7 sync); a failure stops before "push".
  const mass = run(
    process.execPath,
    [resolve(import.meta.dirname, 'check-mass-deletion.mjs'), '--range', 'origin/main..HEAD'],
    {
      allowFail: true,
    },
  );
  if (mass.status !== 0) stop(`${mass.stderr || mass.stdout}Do not push these commits.`);
  console.log(
    'rebase:main: done, no conflict markers. Run your checks, then push at once with git push origin HEAD:main.',
  );
}

try {
  main();
} catch (error) {
  if (!(error instanceof Stopped)) throw error;
  console.error(`rebase:main stopped. ${error.message}`);
  process.exitCode = 1;
}
