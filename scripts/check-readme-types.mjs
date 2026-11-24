// `npm run check:readmes`, and the readme-types step of `npm run quality` (so every fast gate): type-checks every example
// of every package README and guide against the built packages, all in one compiler run. An error that is not on the known list fails, and so does a known
// entry the examples no longer reach, so the list (scripts/support/readme-types-known.json) only ever shrinks.
//   npm run check:readmes                 the check; needs a build
//   npm run check:readmes -- --shrink     writes the known list down to what still fails; it never adds an entry
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareKnown, compile, packageMarkdown, parseErrors, standIns, tally, unclosedFences, writeExamples } from './support/readme-types.mjs';

const root = resolve(import.meta.dirname, '..'),
  knownFile = join(root, 'scripts/support/readme-types-known.json');

/** Every workspace package: { name, folder }. */
export const workspacePackages = (dir = root) =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    .workspaces.filter((path) => path.startsWith('packages/'))
    .map((path) => ({ name: path.slice('packages/'.length), folder: join(dir, path) }));

/**
 * Type-checks every example of every package README and guide in one compiler run: `problems` lists each line that
 * fails the check (an error past the known list, a known entry no longer reached, a declared stand-in, an unclosed
 * fence). `npm run check:readmes` prints them, and `npm run quality` (every fast gate) fails on them, so a change to
 * one package that breaks another package's README example stops before the push. Needs a build.
 */
export function readmeTypeProblems(dir = root) {
  // Under the repository, so node_modules resolves @margoengine/* as for a consumer; test-results is ignored by git.
  const scratch = join(dir, `test-results/readme-types-${process.pid}`);
  rmSync(scratch, { recursive: true, force: true });
  const packages = workspacePackages(dir);
  let count, errors;
  try {
    count = writeExamples(scratch, packages);
    errors = parseErrors(compile(scratch), dir);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const known = JSON.parse(readFileSync(join(dir, 'scripts/support/readme-types-known.json'), 'utf8')),
    { fresh, gone } = compareKnown(errors, known);
  const declared = packages.flatMap(({ name, folder }) =>
    packageMarkdown(folder).flatMap(({ markdown }) => standIns(markdown).map((line) => `${name}: ${line}`)),
  );
  const unclosed = packages.flatMap(({ name, folder }) =>
    packageMarkdown(folder).flatMap(({ document, markdown }) => unclosedFences(markdown).map((line) => `${name} ${document} ${line}`)),
  );
  const problems = [
    ...declared.map((line) => `Runs as pasted, so give it a real value: ${line}`),
    ...unclosed.map((line) => `Text after a closing code fence leaves the block open; move it to the next line: ${line}`),
    ...fresh.map(({ line }) => line),
    ...gone.map(({ name, key, count: left }) => `${name}: fixed ${left} time(s), still on the known list: ${key}`),
  ];
  return { count, packages: packages.length, errors, fresh, gone, problems };
}

function main() {
  const { count, packages, errors, fresh, gone, problems } = readmeTypeProblems();
  if (process.argv.includes('--shrink') && !fresh.length) {
    writeFileSync(knownFile, `${JSON.stringify(tally(errors), null, 2)}
`);
    console.log(`known list: ${gone.reduce((sum, g) => sum + g.count, 0)} removed, ${errors.length} left`);
    return;
  }
  for (const line of problems) console.error(line);
  if (gone.length) console.error('Fixed entries leave the known list: npm run check:readmes -- --shrink');
  console.log(
    `${count} examples of ${packages} packages: ${fresh.length} new errors, ` +
      `${errors.length - fresh.length} known (docs/known-bugs.md)`,
  );
  if (problems.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
