import { execFileSync } from 'node:child_process';

// AGENTS.md "Bugs: fix the cause, properly": a commit typed `fix` or `fix(scope)` must change a test file (under a
// tests/ or test/ folder, or *.test.*) or carry a body line `Regression: <repo path>` naming a test that exists.
// Checked here because the rule was only written down: 0840c07e9b named packages/post/tests/heat-haze.test.js (the
// file is packages/post/test/heat-haze.test.js) and nothing caught it.
const FIX = /^fix(\([^)]*\))?!?:/;
const isTestFile = (file) => /(^|\/)tests?\//.test(file) || /\.test\.[^/]+$/.test(file);

/** The commits of `range` (default HYGIENE_COMMIT_RANGE, else origin/main..HEAD) that break the rule, as messages. */
export function fixCommitsWithoutRegression(root, range = process.env.HYGIENE_COMMIT_RANGE || 'origin/main..HEAD') {
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
      maxBuffer: 32 << 20,
    });
  let shas;
  try {
    shas = git('rev-list', '--no-merges', range).split('\n').filter(Boolean);
  } catch {
    return []; // no such range (no origin/main in this checkout): nothing to check
  }
  const problems = [];
  for (const sha of shas) {
    const message = git('show', '-s', '--format=%B', sha);
    const subject = message.split('\n', 1)[0];
    if (!FIX.test(subject)) continue;
    const short = sha.slice(0, 10);
    const changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', sha).split('\0');
    if (changed.some(isTestFile)) continue;
    const paths = [...message.matchAll(/^Regression:[ \t]*(\S+)[ \t]*$/gm)].map((m) => m[1]);
    if (!paths.length) {
      problems.push(`${short} "${subject}" changes no test file and has no "Regression: <repo path>" body line`);
      continue;
    }
    for (const path of paths) {
      let exists = true;
      try {
        exists = git('cat-file', '-t', `${sha}:${path}`).trim() === 'blob';
      } catch {
        exists = false;
      }
      if (!exists)
        problems.push(`${short} "${subject}" names "Regression: ${path}", which is not a file in that commit`);
      else if (!isTestFile(path))
        problems.push(`${short} "${subject}" names "Regression: ${path}", which is not a test file`);
    }
  }
  return problems;
}

export function assertFixCommitsHaveRegression(root, range) {
  const problems = fixCommitsWithoutRegression(root, range);
  if (problems.length)
    throw new Error(
      `Fix commits break the rule in AGENTS.md "Bugs: fix the cause, properly" (a fix commit changes a test file under tests/ or test/, or has a "Regression: <path>" body line naming an existing test):\n  ${problems.join('\n  ')}\n` +
        'Reword the unpushed commit (git commit --amend) or add the regression test. Commits already on origin/main are never rewritten.',
    );
}
