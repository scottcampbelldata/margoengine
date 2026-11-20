// `npm run test:changed`: the CPU tests of what the change can affect, for the fast gate before a push. The changed files
// are those since the merge base with origin/main, untracked included (changedFiles in scripts/check-merge.mjs). The
// packages are the ones check:merge decides on (planFiles: the changed packages and their dependents, and every package
// that reads a changed document, DOC_READERS in scripts/support/file-classes.mjs), so there is one copy of the logic. A
// change that makes check:merge run everything (core, stage, shared, the umbrella, build configuration, check code) runs
// every package's tests; more than MAX_AFFECTED affected packages does not (only those packages run). Each package runs `npm run test` in its folder under a hard timeout; any failure or timeout
// exits 1 after the rest have run.
//   node scripts/test-changed.mjs [--plan] [--files=a,b] [--base=<ref>] [--max=<minutes per package, default 15>]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedFiles, planContext, planFiles } from './check-merge.mjs';
import { runWithTimeout } from './run-with-timeout.mjs';

const root = resolve(import.meta.dirname, '..');
export const DEFAULT_PACKAGE_MINUTES = 15;

/**
 * The package directories (packages/<dir>) whose CPU tests a set of changed files selects, sorted, with the reason.
 * `ctx` is planContext().
 */
export function testPackages(ctx, files, env = {}, dir = root) {
  // No package-count cap: the CPU tests of the changed packages and their dependents are exact, however many there are.
  // MAX_AFFECTED (a full check:merge above 12) is a GPU step rule; a voxel-pathtracer change ran all 108 packages under it.
  const { decision, scope } = planFiles(ctx, files, env, Number.POSITIVE_INFINITY),
    hasTests = (w) => {
      const file = join(dir, w.dir, 'package.json');
      return (
        w.dir.startsWith('packages/') &&
        existsSync(file) &&
        Boolean(JSON.parse(readFileSync(file, 'utf8')).scripts?.test)
      );
    },
    all = ctx.workspaces.filter(hasTests),
    names = new Set(decision.affected),
    chosen = new Set(
      decision.mode === 'full' ? all.map((w) => w.dir) : all.filter((w) => names.has(w.name)).map((w) => w.dir),
    );
  for (const reader of scope.unitTests.dirs)
    if (all.some((w) => w.dir === `packages/${reader}`)) chosen.add(`packages/${reader}`);
  return {
    dirs: [...chosen].sort(),
    reason:
      decision.mode === 'full' ? `every package: ${decision.reason}` : `${decision.reason}; ${scope.unitTests.reason}`,
  };
}

async function main() {
  const args = process.argv.slice(2),
    value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3),
    minutes = Number(value('max') ?? DEFAULT_PACKAGE_MINUTES),
    given = value('files'),
    files = given ? given.split(',').filter(Boolean) : changedFiles(root, value('base')).files,
    { dirs, reason } = testPackages(await planContext(root), files, process.env);
  console.log(`test:changed: ${files.length} changed file${files.length === 1 ? '' : 's'}; ${reason}`);
  console.log(dirs.length ? `  packages: ${dirs.map((d) => d.slice(9)).join(', ')}` : '  no package tests to run');
  if (args.includes('--plan')) return 0;
  const failed = [];
  for (const dir of dirs) {
    console.log(`\n=== npm run test (${dir}, at most ${minutes} min)`);
    const { code, timedOut } = await runWithTimeout('npm run test', {
      cwd: join(root, dir),
      timeoutMs: minutes * 60_000,
    });
    if (code !== 0) failed.push(`${dir}${timedOut ? ' (timed out)' : ''}`);
  }
  if (failed.length) console.error(`\ntest:changed FAILED: ${failed.join(', ')}`);
  else console.log(`\ntest:changed: ${dirs.length} package${dirs.length === 1 ? '' : 's'} passed`);
  return failed.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
