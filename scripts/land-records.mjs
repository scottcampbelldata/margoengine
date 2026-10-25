// Regenerates the generated records on the rebased tree and commits them once (AGENTS.md, "Generated records").
// Run it inside the landing lock, after `git pull --rebase`, from a clean worktree:
//   node scripts/land-records.mjs [--no-build] [--no-commit]
// 1. build every package (skipped with --no-build when verify just built them)
// 2. API reports and docs/api-surface.md (api-report.js --update), then site/llms.txt and site/llms-full.txt, which
//    are made from the READMEs, those reports and docs/ (build-llms.mjs)
// 3. quality baselines, shrink only (quality-gate.mjs --update; a baseline that would grow stops here and asks for a
//    reason, exactly as `npm run quality -- --update` does, so a landing never widens a limit by accident)
// 4. entry sizes, then the basic-scene network record (it takes the GPU lock only around its browser)
// 5. both size records must name the same commit; then one commit `records: ... at <short HEAD>` if anything changed.
// A tree with uncommitted changes is refused, so nothing hand-edited is overwritten or swept into the records commit.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedRecords, DERIVED, RATCHET } from './support/derived-records.mjs';

const root = resolve(import.meta.dirname, '..');
const AUTHOR = { name: 'Scott Campbell', email: '251750033+scottcampbelldata@users.noreply.github.com' };
const RESULTS = 'examples/package-benchmarks/results';

/** The commands, in order. `gpu` ones run without the landing lock's variable so they take the shared GPU lock. */
export const STEPS = [
  { name: 'build', command: ['npm', 'run', 'build:packages'], skippable: true },
  { name: 'api reports', command: ['node', 'scripts/api-report.js', '--update'] },
  { name: 'llms files', command: ['node', 'scripts/build-llms.mjs'] },
  { name: 'quality baselines', command: ['node', 'scripts/quality-gate.mjs', '--update'] },
  { name: 'entry sizes', command: ['node', 'examples/package-benchmarks/entry-sizes.mjs'] },
  { name: 'basic-scene network', command: ['node', 'scripts/basic-scene-network.mjs'], gpu: true },
];

/** Throws unless the two size records name the same commit (and the same dirty flag). Returns the commit. */
export function pairedRecords(dir = root) {
  const read = (file) => JSON.parse(readFileSync(join(dir, RESULTS, file), 'utf8'));
  const sizes = read('entry-sizes.json'),
    network = read('basic-scene-network.json');
  const name = (record) => `${record.commit}${record.dirty ? ' (dirty)' : ''}`;
  if (name(sizes) !== name(network))
    throw new Error(
      `basic-scene-network.json measured ${name(network)}, entry-sizes.json ${name(sizes)}: the records must name one commit; rerun node scripts/land-records.mjs`,
    );
  if (sizes.dirty) throw new Error('the records were measured on a dirty packages/ tree; commit first, then rerun');
  return sizes.commit;
}

function run(command, { gpu = false } = {}) {
  const env = { ...process.env };
  // The landing lock sets MARGO_GPU_LOCK to its own folder; the GPU step needs the shared GPU lock instead.
  if (gpu) delete env.MARGO_GPU_LOCK;
  const windows = process.platform === 'win32';
  const result = spawnSync(command[0], command.slice(1), { cwd: root, env, stdio: 'inherit', shell: windows });
  if (result.status !== 0) throw new Error(`${command.join(' ')} failed (exit ${result.status ?? result.signal})`);
}

const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

function main() {
  const skipBuild = process.argv.includes('--no-build'),
    noCommit = process.argv.includes('--no-commit');
  const dirty = git('status', '--porcelain').stdout.split('\n').filter(Boolean);
  if (dirty.length)
    throw new Error(`land-records needs a clean tree (commit or stash first):\n${dirty.slice(0, 10).join('\n')}`);
  const started = performance.now();
  for (const step of STEPS) {
    if (step.skippable && skipBuild) continue;
    console.log(`\n=== land-records: ${step.name}`);
    run(step.command, step);
  }
  const commit = pairedRecords(),
    head = git('rev-parse', '--short', 'HEAD').stdout.trim();
  if (commit !== head) throw new Error(`the records name ${commit} but HEAD is ${head}`);
  const changed = changedRecords(root);
  if (!changed.length) return console.log('\nland-records: records already current, nothing to commit');
  console.log(`\nland-records: ${changed.length} file(s) regenerated`);
  if (noCommit) return;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: AUTHOR.name,
    GIT_AUTHOR_EMAIL: AUTHOR.email,
    GIT_COMMITTER_NAME: AUTHOR.name,
    GIT_COMMITTER_EMAIL: AUTHOR.email,
  };
  for (const args of [
    ['add', '--', ...DERIVED, ...RATCHET],
    [
      'commit',
      '-m',
      `records: entry sizes, API reports and baselines at ${head}\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`,
    ],
  ]) {
    const result = spawnSync('git', args, { cwd: root, env, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  }
  console.log(`land-records: committed in ${Math.round((performance.now() - started) / 1000)} s`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`land-records: ${error.message}`);
    process.exitCode = 1;
  }
}
