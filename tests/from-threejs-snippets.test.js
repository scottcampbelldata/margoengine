// Type-checks every Margo snippet (```ts block) in docs/from-threejs.md and docs/guides/*.md against the built
// packages, so a guide fails the unit run when an API it shows is renamed or removed. The migration guide's
// name-by-name tables are also checked against the committed API reports. Needs `npm run build:packages` first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { missingName } from '../scripts/support/api-names.mjs';
import { GUIDES, program } from '../scripts/support/doc-snippets.mjs';

const root = resolve(import.meta.dirname, '..');
const guides = [
  'docs/from-threejs.md',
  ...readdirSync(resolve(root, 'docs/guides'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/guides/${name}`),
];

// The task guides (scripts/support/doc-snippets.mjs GUIDES) are one program each: their blocks build on one another,
// so they are checked joined, as TSX when the guide is a React one. Every other page is checked block by block.
const taskGuides = new Map(GUIDES.map((guide) => [guide.file, guide]));

for (const file of guides)
  test(`${file} Margo snippets type-check against the built packages`, () => {
    const doc = readFileSync(resolve(root, file), 'utf8');
    const task = taskGuides.get(file);
    const snippets = task
      ? [{ code: program(doc, { all: true }), line: 1 }]
      : [...doc.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((match) => ({
          code: match[1],
          line: doc.slice(0, match.index).split('\n').length + 1,
        }));
    // The migration guide once dropped out of this test; its floor catches an empty read of it too.
    const floor = file === 'docs/from-threejs.md' ? 20 : 1;
    assert.ok(snippets.length >= floor, `expected the guide's snippets, found ${snippets.length}`);
    for (const { code, line } of snippets)
      for (const [, from] of code.matchAll(/from '([^']+)'/g))
        assert.match(
          from,
          task?.react
            ? /^(margoengine\/react(\/gltf)?|react|react-dom\/client)$/
            : /^(margoengine(\/[a-z0-9-]+){0,2}|@margoengine\/[a-z0-9-]+(\/[a-z0-9-]+)?)$/,
          `snippet at line ${line} imports ${from}`,
        );
    // Inside the repository so package resolution finds node_modules; test-results is git-ignored.
    const dir = resolve(root, 'test-results/snippets', file.replace(/[/.]/g, '-'));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'globals.d.ts'),
      [
        "import type {EngineKernel, Mesh} from '@margoengine/core';",
        "import type {PBRModel} from '@margoengine/gltf/pbr';",
        '// Names the guide uses without declaring them; a snippet that declares its own shadows these.',
        'declare global {const engine: EngineKernel; const canvas: HTMLCanvasElement; const mesh: Mesh; const model: PBRModel;}',
        'export {};',
        '',
      ].join('\n'),
    );
    snippets.forEach(({ code, line }) =>
      writeFileSync(resolve(dir, `line-${line}.${task?.react ? 'tsx' : 'ts'}`), code + 'export {};\n'),
    );
    writeFileSync(
      resolve(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: false,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          types: [],
          noEmit: true,
          skipLibCheck: true,
          jsx: 'react-jsx',
        },
        include: ['*.ts', '*.tsx'],
      }),
    );
    try {
      execFileSync(
        process.execPath,
        [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(dir, 'tsconfig.json')],
        { cwd: dir, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (error) {
      // Errors name line-<N>.ts, where N is the line of the snippet's first code line in the guide.
      assert.fail(`${file} snippets do not type-check:\n${error.stdout}${error.stderr}`);
    }
  });

const migration = () => readFileSync(resolve(root, 'docs/from-threejs.md'), 'utf8').split(/\r?\n/);

/** The rows of the "Name by name" tables: [{ line, margo, from }]. */
function nameRows(lines) {
  const rows = [];
  let inside = false;
  lines.forEach((text, index) => {
    if (/^## /.test(text)) inside = text === '## Name by name';
    if (!inside || !text.startsWith('|') || /^\| (three\.js \||---)/.test(text)) return;
    const [, , margo, from] = text.split('|').map((cell) => cell.trim());
    rows.push({ line: index + 1, margo, from });
  });
  return rows;
}

/** Why a row is wrong: a cell that is not `names` of one package (or `none`), or a name its API report does not hold. */
function rowProblems({ line, margo, from }) {
  if (margo === 'none' && from === '') return [];
  const specifier = /^`(@margoengine\/[a-z0-9/-]+)`$/.exec(from)?.[1];
  if (!specifier) return [`line ${line}: "Import from" is not one \`@margoengine/...\` package: ${from}`];
  if (!/^`[\w.]+`(, `[\w.]+`)*$/.test(margo))
    return [`line ${line}: the Margo cell must be \`Name\` or \`Name.member\` entries separated by commas: ${margo}`];
  return [...margo.matchAll(/`([\w.]+)`/g)].flatMap(([, symbol]) => {
    const why = missingName(root, specifier, symbol);
    return why ? [`line ${line}: ${why}`] : [];
  });
}

test('every Margo name in the migration guide mapping tables is in the API reports', () => {
  const rows = nameRows(migration());
  assert.ok(rows.length >= 180, `expected the name-by-name tables, found ${rows.length} rows`);
  assert.deepEqual(rows.flatMap(rowProblems), []);
});

test('the mapping check fails a name, a member or a package that does not exist', () => {
  const bad = (margo, from = '`@margoengine/controls/orbit`') => rowProblems({ line: 1, margo, from }).join();
  assert.equal(bad('`OrbitControls`, `OrbitControls.dispose`, `MapControls.enableDamping`'), '');
  assert.match(bad('`OrbitControl`'), /does not export OrbitControl/);
  assert.match(bad('`OrbitControls.orbitFaster`'), /has no orbitFaster/);
  assert.match(bad('`Controls.local`'), /has no local/, 'a protected member is not public');
  assert.match(bad('`OrbitControls`', '`@margoengine/orbit`'), /has no API report/);
  assert.match(bad('OrbitControls'), /must be/);
  assert.match(bad('`OrbitControls` and more'), /must be/);
});

test('every package the migration guide names is an entry some package exports', () => {
  const named = new Set(migration().flatMap((line) => line.match(/@margoengine\/[a-z0-9-]+(\/[a-z0-9-]+)*/g) ?? []));
  const exported = (specifier) => {
    const [, name, ...path] = specifier.split('/');
    const manifest = resolve(root, 'packages', name, 'package.json');
    if (!existsSync(manifest)) return false;
    return Object.hasOwn(JSON.parse(readFileSync(manifest, 'utf8')).exports, ['.', ...path].join('/'));
  };
  assert.ok(named.size > 50, `expected the guide to name its packages, found ${named.size}`);
  assert.deepEqual(
    [...named].filter((specifier) => !exported(specifier)),
    [],
  );
});
