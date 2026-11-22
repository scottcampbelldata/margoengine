// `npm run check:readmes` (a step of verify) stops a README example with a type error. The bug this guards against:
// batch 85 job 1 reached main with a Float64Array where a Float32Array belongs, because the only check of README examples
// ran in check:merge and no landing runs check:merge.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { readmeTypeProblems, workspacePackages } from '../scripts/check-readme-types.mjs';
import {
  compareKnown,
  compile,
  packageMarkdown,
  parseErrors,
  readmeExamples,
  readmeScratch,
  standIns,
  tally,
  unclosedFences,
  writeExamples,
} from '../scripts/support/readme-types.mjs';

const root = resolve(import.meta.dirname, '..');

/** Runs the check's own steps on one README text, against the built packages. */
function check(t, tag, markdown) {
  const scratch = join(root, `test-results/readme-types-test-${tag}/readme-types`),
    folder = join(scratch, '..', 'fixture');
  mkdirSync(folder, { recursive: true });
  t.after(() => rmSync(join(scratch, '..'), { recursive: true, force: true }));
  writeFileSync(join(folder, 'README.md'), markdown);
  writeExamples(scratch, [{ name: 'fixture', folder }]);
  return parseErrors(compile(scratch), root);
}

const example = (buffer) =>
  [
    'Text.',
    '',
    '```ts',
    "import type { ElbowEvaluator } from '@margoengine/kinematics-constraints';",
    'declare const elbowAt: ElbowEvaluator;',
    '```',
    '',
    'A second block carries on.',
    '',
    '```ts',
    `const elbow = new ${buffer}(3);`,
    'elbowAt([0, 0, 0], [1, 0, 0], 1, elbow);',
    '```',
    '',
  ].join('\n');

test('every lightmap README example type-checks against its public API', { timeout: 120000 }, (t) => {
  // TypeScript Team, Handbook: Type Inference (contextual typing), and TypeScript 4.9 (2022).
  // https://www.typescriptlang.org/docs/handbook/type-inference.html
  // https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html
  // A standalone GPU options object needs context so direction stays a three-element tuple.
  const markdown = readFileSync(join(root, 'packages/lightmap/README.md'), 'utf8');
  assert.deepEqual(check(t, 'lightmap', markdown), []);
});

test('a Float64Array where a Float32Array belongs fails, and only it', (t) => {
  // The evaluator's out parameter is the type batch 85 job 1 got wrong. Whichever array it takes, the other one is an
  // error: a compiler pass on both would mean the examples are not really being checked.
  const passes = (buffer) => check(t, buffer, example(buffer));
  const wrong = passes('Float64Array');
  assert.equal(wrong.length, 1, wrong.map((e) => e.line).join('\n'));
  assert.equal(wrong[0].name, 'fixture');
  assert.match(wrong[0].key, /^TS2345: .*Float64Array/);
  assert.deepEqual(passes('Float32Array'), []);
});

test('an example does not see a name another example declares', (t) => {
  const errors = check(
    t,
    'isolation',
    [
      '```ts',
      "import '@margoengine/math';",
      'const shared = 1;',
      '```',
      '```ts',
      "import '@margoengine/math';",
      'shared;',
      '```',
    ].join('\n'),
  );
  assert.deepEqual(
    errors.map((e) => e.key),
    ["TS2304: Cannot find name 'shared'."],
  );
});

test('a block without an import carries on the example before it; ts, tsx and js are all examples', () => {
  const text =
    '```ts\nimport a from "a";\n```\n```ts\nuse(a);\n```\n```tsx\nimport b from "b";\n```\n```js\nb();\n```\n```sh\nls\n```';
  const examples = readmeExamples(text);
  assert.equal(examples.length, 2);
  assert.match(examples[0], /import a[\s\S]*use\(a\)/);
  assert.match(examples[1], /import b[\s\S]*b\(\)/);
  for (const code of examples) assert.match(code, /export \{\};\n$/);
});

test('an error off the known list fails, past its count too, and a fixed entry fails until the list shrinks', () => {
  const error = (key) => ({ name: 'p', key, line: key });
  const known = { p: { a: 2 } };
  assert.deepEqual(compareKnown([error('a'), error('a')], known), { fresh: [], gone: [] });
  assert.deepEqual(
    compareKnown([error('a'), error('a'), error('a')], known).fresh.map((e) => e.key),
    ['a'],
  );
  assert.deepEqual(
    compareKnown([error('b'), error('a'), error('a')], known).fresh.map((e) => e.key),
    ['b'],
  );
  assert.deepEqual(compareKnown([error('a')], known).gone, [{ name: 'p', key: 'a', count: 1 }]);
  // The same message in a package that is not listed for it is new.
  assert.deepEqual(compareKnown([{ name: 'q', key: 'a', line: 'a' }], known).fresh.length, 1);
  assert.deepEqual(tally([error('a'), error('a')]), known);
});

test('the place of an error does not count, so moving a line in a README moves nothing on the list', () => {
  const place = (at) => [`test-results/readme-types/p/readme-${at}.tsx(${at},3): error TS2304: Cannot find name 'x'.`];
  assert.deepEqual(tally(parseErrors(place(1), root)), tally(parseErrors(place(9), root)));
  assert.deepEqual(parseErrors([`packages/q/dist/a.d.ts(1,2): error TS1: ${root.replaceAll('\\', '/')}/x`], root)[0], {
    name: 'q',
    key: 'TS1: <root>/x',
    line: `packages/q/dist/a.d.ts(1,2): error TS1: ${root.replaceAll('\\', '/')}/x`,
  });
  // Output that is not an error line still counts as a failure.
  assert.equal(parseErrors(['tsc crashed'], root)[0].name, '(compiler)');
});

test('the check covers every package and runs in npm run quality, a step of every fast gate', () => {
  const names = workspacePackages().map((p) => p.name),
    declared = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces;
  assert.deepEqual(
    names.map((n) => `packages/${n}`),
    declared.filter((w) => w.startsWith('packages/')),
  );
  assert.ok(packageMarkdown(join(root, 'packages/tween')).length);
  // 2026-11-18: it ran only in verify, after the push, and a lane runs only its own package tests, so ten examples
  // broken by changes to their package or to another (a protected Scatter.options, a seek typed for a whole Engine)
  // reached main. The quality gate, which every fast gate runs, now holds it.
  const gate = readFileSync(join(root, 'scripts/quality-gate.mjs'), 'utf8');
  assert.match(gate, /import \{ readmeTypeProblems \} from '\.\/check-readme-types\.mjs'/);
  assert.match(gate, /'readme-types': \{\s+run: \(\) => readmeTypeProblems\(root\)\.problems/);
});

test('readmeTypeProblems fails an example that one package types break, and passes the fixed example', () => {
  // A throwaway repository under test-results, so node_modules resolves @margoengine/* from the real one.
  const fake = join(root, `test-results/readme-problems-${process.pid}`),
    readme = join(fake, 'packages/demo/README.md');
  rmSync(fake, { recursive: true, force: true });
  mkdirSync(join(fake, 'packages/demo'), { recursive: true });
  mkdirSync(join(fake, 'scripts/support'), { recursive: true });
  try {
    writeFileSync(join(fake, 'package.json'), JSON.stringify({ workspaces: ['packages/demo'] }));
    writeFileSync(
      join(fake, 'packages/demo/package.json'),
      JSON.stringify({ name: '@margoengine/demo', type: 'module' }),
    );
    writeFileSync(join(fake, 'scripts/support/readme-types-known.json'), '{}');
    const example = (call) =>
      ['# demo', '', '```js', "import { Vector3 } from '@margoengine/math';", call, '```', ''].join('\n');
    writeFileSync(readme, example("console.log(new Vector3('1', 0, 2));"));
    const broken = readmeTypeProblems(fake);
    assert.equal(broken.count, 1);
    assert.equal(broken.problems.length, 1, broken.problems.join('\n'));
    assert.match(broken.problems[0], /error TS2345/);
    writeFileSync(readme, example('console.log(new Vector3(1, 0, 2));'));
    assert.deepEqual(readmeTypeProblems(fake).problems, []);
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

// About 170 `declare const` lines passed the type check while their examples could not run as pasted.
test('a declared stand-in in an example is found, and no package README or guide holds one', () => {
  const fence = '```';
  assert.deepEqual(
    standIns(
      `${fence}ts\nimport {a} from 'b';\n  declare const mesh: Mesh;\ndeclare function use(): void;\n${fence}\n`,
    ),
    ['declare const mesh: Mesh;', 'declare function use(): void;'],
  );
  assert.deepEqual(standIns(`Passes declare const in prose.\n${fence}sh\ndeclare const x: 1;\n${fence}\n`), []);
  for (const { name, folder } of workspacePackages())
    for (const { document, markdown } of packageMarkdown(folder))
      assert.deepEqual(standIns(markdown), [], `${name} ${document}`);
});

// A package test's scratch folder sat in the package's own folder, so the port test's walk of packages/ listed a file in
// it and read it after it had gone: ENOENT stopped a landing that changed neither.
test('a package test keeps its example scratch folder under test-results', (t) => {
  const folder = join(root, `test-results/readme-scratch-test-${process.pid}`);
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(folder, { recursive: true });
  assert.equal(relative(folder, readmeScratch(folder)).split(sep)[0], 'test-results');
});

// The environment README closed a code block with "``` A compute pass ..." and the exporters README with "``` Quick
// Look ...": a viewer keeps such a block open and shows the rest of the document as code, while the examples reader
// closes on any three backticks, so check:readmes passed. It now fails on that line.
test('a closing code fence with text after it is reported, and a clean fence is not', () => {
  const clean = ['```js', 'a();', '```', 'Prose.', '  ```ts', '  b();', '  ```', '````md', '```js', '````'].join('\n');
  assert.deepEqual(unclosedFences(clean), []);
  const broken = ['Intro.', '```js', 'a();', '``` More prose.', '```', ''].join('\r\n');
  assert.deepEqual(unclosedFences(broken), ['line 4: ``` More prose.']);
  for (const { name, folder } of workspacePackages())
    for (const { document, markdown } of packageMarkdown(folder))
      assert.deepEqual(unclosedFences(markdown), [], `${name} ${document}`);
});
