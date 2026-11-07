// `npm run check:readmes`, a step of `npm run verify`: type-checks every example of every package README and guide
// against the built packages, all in one compiler run. An error that is not on the known list fails, and so does a known
// entry the examples no longer reach, so the list (scripts/support/readme-types-known.json) only ever shrinks.
//   npm run check:readmes                 the check; needs a build
//   npm run check:readmes -- --shrink     writes the known list down to what still fails; it never adds an entry
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareKnown, compile, packageMarkdown, parseErrors, standIns, tally, writeExamples } from './support/readme-types.mjs';

const root = resolve(import.meta.dirname, '..'),
  knownFile = join(root, 'scripts/support/readme-types-known.json');

/** Every workspace package: { name, folder }. */
export const workspacePackages = (dir = root) =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    .workspaces.filter((path) => path.startsWith('packages/'))
    .map((path) => ({ name: path.slice('packages/'.length), folder: join(dir, path) }));

function main() {
  // Under the repository, so node_modules resolves @margoengine/* as for a consumer; test-results is ignored by git.
  const scratch = join(root, 'test-results/readme-types');
  rmSync(scratch, { recursive: true, force: true });
  const packages = workspacePackages(),
    count = writeExamples(scratch, packages),
    errors = parseErrors(compile(scratch), root),
    known = JSON.parse(readFileSync(knownFile, 'utf8')),
    { fresh, gone } = compareKnown(errors, known);
  rmSync(scratch, { recursive: true, force: true });
  if (process.argv.includes('--shrink') && !fresh.length) {
    writeFileSync(knownFile, `${JSON.stringify(tally(errors), null, 2)}\n`);
    console.log(`known list: ${gone.reduce((sum, g) => sum + g.count, 0)} removed, ${errors.length} left`);
    return;
  }
  const declared = packages.flatMap(({ name, folder }) =>
    packageMarkdown(folder).flatMap(({ markdown }) => standIns(markdown).map((line) => `${name}: ${line}`)),
  );
  for (const line of declared) console.error(`Runs as pasted, so give it a real value: ${line}`);
  for (const { line } of fresh) console.error(line);
  for (const { name, key, count: left } of gone)
    console.error(`${name}: fixed ${left} time(s), still on the known list: ${key}`);
  if (gone.length) console.error('Fixed entries leave the known list: npm run check:readmes -- --shrink');
  console.log(
    `${count} examples of ${packages.length} packages: ${fresh.length} new errors, ` +
      `${errors.length - fresh.length} known (docs/known-bugs.md)`,
  );
  if (fresh.length || gone.length || declared.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
