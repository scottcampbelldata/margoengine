// The records a new package must bring with it, checked by scripts/hygiene.js so the fast gate catches a stale one
// before the push. Bug (2026-11-16): @margoengine/scenes landed with four pages still stating 104 packages, no
// entry-sizes.json row (margoengine.com/sizes.html could not be built), THIRD-PARTY-NOTICES.md a package behind and its
// example folder in no type-check project; only local CI's full root tests saw any of it, after the push.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readSizesInputs, sizesPage } from '../build-sizes.js';
import { collect, noticeAddenda, OUTPUT, render } from '../supply-chain.mjs';
import { EXAMPLE_FOLDERS, PROJECTS } from './example-projects.mjs';
import { packageCountFiles, packageCountProblems } from './public-truth.mjs';

const SKIP = new Set(['node_modules', 'dist', '.next']);
const holdsTypeScript = (dir) =>
  readdirSync(dir, { withFileTypes: true }).some((entry) =>
    SKIP.has(entry.name)
      ? false
      : entry.isDirectory()
        ? holdsTypeScript(join(dir, entry.name))
        : /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts'),
  );

/**
 * Top-level folders of examples/ that hold TypeScript but belong to no project of scripts/support/example-projects.mjs:
 * not in EXAMPLE_FOLDERS and holding no project's tsconfig, so no example type check reads them.
 * tests/check-example-types.test.js then checks every file with the compiler.
 */
export function foldersInNoProject(root) {
  const configs = PROJECTS.map((project) => project.config);
  return readdirSync(join(root, 'examples'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIP.has(entry.name))
    .map((entry) => entry.name)
    .filter(
      (name) =>
        !EXAMPLE_FOLDERS.includes(name) &&
        !configs.some((config) => config.startsWith(`examples/${name}/`)) &&
        holdsTypeScript(join(root, 'examples', name)),
    );
}

const RUNTIME_EXPORT = /^export (?:declare )?(?:abstract )?(?:async )?(?:function|class|const|let|var|enum)\s+([\w$]+)/gm;

/**
 * Runtime exports that a package's api/<id>.api.md declares but its docs/catalog.json entry does not list.
 * Bug (2026-11-21): materials gained `noteEngine` and every `npm run build:packages` then rewrote the tracked catalog,
 * because the catalog's export lists come from dist and nothing compared them before the build.
 */
export function catalogExportProblems(root) {
  const problems = [];
  for (const entry of JSON.parse(readFileSync(join(root, 'docs/catalog.json'), 'utf8'))) {
    const report = join(root, `api/${entry.id}.api.md`);
    if (!existsSync(report)) continue;
    const missing = [...readFileSync(report, 'utf8').matchAll(RUNTIME_EXPORT)]
      .map((match) => match[1])
      .filter((name) => !entry.exports.includes(name));
    if (missing.length)
      problems.push(
        `docs/catalog.json: ${entry.id} lacks exports ${missing.join(', ')}: run npm run build:packages and commit docs/catalog.json`,
      );
  }
  return problems;
}

/**
 * Problems with the records under `root` that every package adds to: the stated package counts, the measured entry
 * sizes behind margoengine.com/sizes.html and the example projects. Each names the command that brings it up to date.
 */
export function packageRecordProblems(root) {
  const catalog = JSON.parse(readFileSync(join(root, 'docs/catalog.json'), 'utf8'));
  const files = Object.fromEntries(
    packageCountFiles(root).map((path) => [path, readFileSync(join(root, path), 'utf8')]),
  );
  const problems = [...packageCountProblems(files, catalog.length), ...catalogExportProblems(root)];
  try {
    sizesPage(readSizesInputs(root));
  } catch (error) {
    problems.push(`site/sizes.html cannot be built: ${error.message}`);
  }
  for (const name of foldersInNoProject(root))
    problems.push(`examples/${name} is in no type-check project: add it in scripts/support/example-projects.mjs`);
  return problems;
}

/** Throws unless the package records and THIRD-PARTY-NOTICES.md (scripts/supply-chain.mjs) are current. */
export function assertPackageRecordsCurrent(root) {
  const problems = packageRecordProblems(root);
  const current = readFileSync(join(root, OUTPUT), 'utf8').replaceAll('\r\n', '\n'),
    record = collect();
  if (render(record, noticeAddenda(current)) !== current)
    problems.push(`${OUTPUT} is stale: run node scripts/supply-chain.mjs`);
  problems.push(...record.problems.map((problem) => `supply-chain: ${problem}`));
  if (problems.length) throw new Error(`package records are not current:\n  ${problems.join('\n  ')}`);
}
