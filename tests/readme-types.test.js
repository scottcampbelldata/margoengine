// `npm run check:readmes` (a step of verify) stops a README example with a type error. The bug this guards against:
// batch 85 job 1 reached main with a Float64Array where a Float32Array belongs, because the only check of README examples
// ran in check:merge and no landing runs check:merge.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { workspacePackages } from '../scripts/check-readme-types.mjs';
import {
  compareKnown,
  compile,
  packageMarkdown,
  parseErrors,
  readmeExamples,
  tally,
  writeExamples,
} from '../scripts/support/readme-types.mjs';
import { PARALLEL } from '../scripts/verify.mjs';

const root = resolve(import.meta.dirname, '..');

/** Runs the check's own steps on one README text, against the built packages. */
function check(t, tag, markdown) {
  const scratch = join(root, `test-results/readme-types-test-${process.pid}-${tag}/readme-types`),
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
    ['```ts', "import '@margoengine/math';", 'const shared = 1;', '```', '```ts', "import '@margoengine/math';", 'shared;', '```'].join(
      '\n',
    ),
  );
  assert.deepEqual(
    errors.map((e) => e.key),
    ["TS2304: Cannot find name 'shared'."],
  );
});

test('a block without an import carries on the example before it; ts, tsx and js are all examples', () => {
  const text = '```ts\nimport a from "a";\n```\n```ts\nuse(a);\n```\n```tsx\nimport b from "b";\n```\n```js\nb();\n```\n```sh\nls\n```';
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

test('the check covers every package and runs in verify, the step every landing runs', () => {
  const names = workspacePackages().map((p) => p.name),
    declared = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces;
  assert.deepEqual(
    names.map((n) => `packages/${n}`),
    declared.filter((w) => w.startsWith('packages/')),
  );
  assert.ok(packageMarkdown(join(root, 'packages/tween')).length);
  assert.ok(PARALLEL.flat().includes('npm run check:readmes'));
});
