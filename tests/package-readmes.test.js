// What a package README says about its package stays true: every `npm run` script it names exists where it says (the
// named workspace, or the package itself, or the repository root), and every `exports` subpath of a package is named
// in its README. The subpaths a README does not name yet are listed in scripts/support/readme-entries-known.json; the
// list only shrinks: a new undocumented entry fails here, and so does a listed entry the README now names.
// The README code blocks are type-checked by `npm run check:readmes` and the links by `npm run docs:links`.
//   node scripts/readme-entries.mjs --shrink   rewrites the known list down to what is still undocumented
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import test from 'node:test';
import { undocumentedEntries } from '../scripts/readme-entries.mjs';

const root = join(import.meta.dirname, '..');
const json = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const folders = readdirSync(join(root, 'packages')).filter((name) =>
  existsSync(join(root, 'packages', name, 'package.json')),
);
const scripts = Object.fromEntries(folders.map((name) => [name, json(`packages/${name}/package.json`)]));
const byName = Object.fromEntries(Object.entries(scripts).map(([folder, pkg]) => [pkg.name, folder]));
const rootScripts = json('package.json').scripts;
// Workspaces outside packages/ that a README may name, such as examples/react-viewer.
for (const name of readdirSync(join(root, 'examples')))
  if (existsSync(join(root, 'examples', name, 'package.json'))) {
    const pkg = json(`examples/${name}/package.json`);
    if (pkg.name) (scripts[`examples/${name}`] = pkg), (byName[pkg.name] = `examples/${name}`);
  }

/** The scripts a README line runs: [{ script, workspace }] for `npm run x`, `npm test` and their workspace flags. */
export function commandsOf(line) {
  if (/--prefix/.test(line)) return [];
  const found = [];
  for (const match of line.matchAll(/\bnpm (?:run |run-script )?([a-z][a-z0-9:_-]*)([^`\n]*)/g)) {
    const [, word, rest] = match;
    const runs = /\bnpm run(?:-script)? /.test(match[0]);
    if (!runs && word !== 'test') continue;
    const flag = /(?:--workspace|-w)[ =]([@\w/.-]*[@\w/-])/.exec(rest);
    found.push({ script: word.replace(/:$/, ''), workspace: flag?.[1] });
  }
  return found;
}

test('every npm script a package README names exists', () => {
  const wrong = [];
  for (const folder of folders) {
    const file = `packages/${folder}/README.md`;
    if (!existsSync(join(root, file))) continue;
    readFileSync(join(root, file), 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        for (const { script, workspace } of commandsOf(line)) {
          const target = workspace && (byName[workspace] ?? workspace.replace(/^packages\//, ''));
          const available = workspace ? scripts[target]?.scripts : { ...rootScripts, ...scripts[folder].scripts };
          if (!available?.[script])
            wrong.push(
              `${file}:${index + 1} npm script "${script}" ${workspace ? `in ${workspace}` : 'in the package or the root'}`,
            );
        }
      });
  }
  assert.deepEqual(wrong, [], `a README names a script that does not exist:\n${wrong.join('\n')}`);
});

test('every package entry is named in its README, or listed as owed', () => {
  const { fresh, gone } = undocumentedEntries();
  assert.deepEqual(
    fresh,
    [],
    `these package.json exports are not named in their README (add a line to it, naming the import path):\n${fresh.join('\n')}`,
  );
  assert.deepEqual(
    gone,
    [],
    `the README now names these entries; remove them from scripts/support/readme-entries-known.json (node scripts/readme-entries.mjs --shrink):\n${gone.join('\n')}`,
  );
});

test('the command finder reads workspace flags and ignores prose', () => {
  assert.deepEqual(commandsOf('Run `npm run test:gpu --workspace @margoengine/save.` then'), [
    { script: 'test:gpu', workspace: '@margoengine/save' },
  ]);
  assert.deepEqual(commandsOf('npm test -w packages/stage'), [{ script: 'test', workspace: 'packages/stage' }]);
  assert.deepEqual(commandsOf('npm run build:packages: then'), [{ script: 'build:packages', workspace: undefined }]);
  assert.deepEqual(commandsOf('npm install @margoengine/core'), []);
  assert.deepEqual(commandsOf('npm --prefix x run dev'), []);
});

// Package READMEs and package guides speak to a user of the package: no work-tracking labels (batch numbers, lanes,
// work lists, machine names, "needs Scott"), whose meaning lives in the maintainers' notes. Say the plain fact instead.
// Paths and link targets that merely contain "batch-NNN" are real file names and are not matched (no space or capital).
const internalLabels = [
  /\bbatch \d{2,}/i,
  /\bother lanes\b/i,
  /\blane [A-Z]\d?\b/,
  /\bcodex-/i,
  /\blist[ -][2-9]\b/i,
  /\bwork lists?\b/i,
  /\bAMD GPU hunt\b/,
  /\bBeelink\b/,
  /\bneeds? Scott\b/i,
  /(?<!-)\bScott(?:'s)?\b(?! Campbell\b)/,
  /\bSCOTT-DEV\b/,
  /\bhelper [A-Z]\d?\b/,
];
// Files the open cleanup pull request edits; its owner clears them. Remove each entry once its labels are gone.
const labelsOwnedElsewhere = new Set([
  'packages/biomes/docs/roads-and-paths.md',
  'packages/clustered/README.md',
  'packages/mcp/README.md',
  'packages/post/README.md',
  'packages/terrain/README.md',
  'packages/tonemap/README.md',
  'packages/voxel/README.md',
]);

test('package READMEs and guides carry no internal work-tracking labels', () => {
  const docs = [];
  for (const folder of folders) {
    const base = join('packages', folder);
    if (existsSync(join(root, base, 'README.md'))) docs.push(join(base, 'README.md'));
    const guides = join(root, base, 'docs');
    if (existsSync(guides))
      for (const name of readdirSync(guides)) if (name.endsWith('.md')) docs.push(join(base, 'docs', name));
  }
  const found = [];
  for (const file of docs) {
    const path = file.split(sep).join('/');
    if (labelsOwnedElsewhere.has(path)) continue;
    readFileSync(join(root, file), 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        for (const label of internalLabels) {
          const match = label.exec(line);
          if (match) found.push(`${path}:${index + 1}: "${match[0]}"`);
        }
      });
  }
  assert.deepEqual(found, [], `internal labels in package docs, reword as plain facts:\n${found.join('\n')}`);
});
