// The hand-rolled mutation runner (scripts/mutation.mjs): which mutants it lists, that types and strings are left
// alone, that a mutant applies as one exact text change, that the choice of a sample is repeatable, and the score.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyMutant, markEquivalent, mutantsOf, pickMutants, scoreOf, testDirOf, TARGETS } from '../scripts/mutation.mjs';

const source = [
  'type T = 1 | 2;',
  "const note = 'a < b + 1';",
  '// x + y < 3',
  'export function f(a: number, b: number): boolean {',
  '  const k: Array<number> = [a + 7];',
  '  return !(a < b) && k.length === 2 && true;',
  '}',
].join('\n');

test('lists operator, constant, negation and boolean mutants, never types, strings or comments', () => {
  const m = mutantsOf(source, 'f.ts');
  const ops = m.map((x) => x.operator);
  for (const want of ['+ -> -', '7 -> 8', '< -> <=', '! removed', '&& -> ||', '=== -> !==', '2 -> 3', 'true -> false'])
    assert.ok(ops.includes(want), want);
  assert.ok(
    m.every((x) => x.line >= 5),
    'nothing on the type, string or comment lines',
  );
  assert.ok(
    m.every((x, i) => i === 0 || m[i - 1].start <= x.start),
    'source order',
  );
  assert.deepEqual(
    m.map((x) => x.id),
    m.map((_, i) => i),
  );
});

test('applying a mutant changes exactly its span', () => {
  for (const mutant of mutantsOf(source, 'f.ts')) {
    const out = applyMutant(source, mutant);
    assert.equal(out.slice(0, mutant.start), source.slice(0, mutant.start));
    assert.equal(out.slice(mutant.start, mutant.start + mutant.to.length), mutant.to);
    assert.equal(out.slice(mutant.start + mutant.to.length), source.slice(mutant.end));
    assert.notEqual(out, source);
  }
});

test('the sample is repeatable, ordered, bounded and seed dependent', () => {
  const all = mutantsOf(source, 'f.ts');
  const a = pickMutants(all, 4, 7);
  assert.equal(a.length, 4);
  assert.deepEqual(a, pickMutants(all, 4, 7));
  assert.ok(a.every((x, i) => i === 0 || a[i - 1].start < x.start));
  assert.deepEqual(pickMutants(all, 0), all);
  assert.notDeepEqual(
    a.map((x) => x.id),
    pickMutants(all, 4, 8).map((x) => x.id),
  );
});

test('the score counts killed over killed plus survived', () => {
  const s = scoreOf([{ status: 'killed' }, { status: 'killed' }, { status: 'killed' }, { status: 'survived' }]);
  assert.deepEqual([s.killed, s.survived, s.total, s.score], [3, 1, 4, 0.75]);
  assert.equal(scoreOf([]).score, 1);
});

test('every published target names a source file and test files that exist', () => {
  for (const [name, targets] of Object.entries(TARGETS))
    for (const t of Object.values(targets)) {
      assert.ok(existsSync(new URL(`../packages/${name}/${t.file}`, import.meta.url)), t.file);
      const dir = testDirOf(fileURLToPath(new URL(`../packages/${name}/`, import.meta.url)));
      for (const file of t.tests)
        assert.ok(existsSync(new URL(`../packages/${name}/${dir}/${file}`, import.meta.url)), file);
    }
});

test('equivalent mutants are named by line and change, carry a reason and leave the score', () => {
  const results = [
    { line: 3, from: '>', to: '>=', status: 'survived' },
    { line: 4, from: '1', to: '2', status: 'survived' },
    { line: 3, from: '>', to: '>=', status: 'killed' },
  ];
  const marked = markEquivalent(results, [{ line: 3, from: '>', to: '>=', reason: 'tie cannot occur' }]);
  assert.deepEqual(
    marked.map((r) => r.status),
    ['equivalent', 'survived', 'killed'],
  );
  assert.equal(marked[0].reason, 'tie cannot occur');
  const s = scoreOf(marked);
  assert.deepEqual([s.killed, s.survived, s.total], [1, 1, 2]);
  assert.equal(markEquivalent(results).length, 3);
});

test('every listed equivalent mutant exists in its source file and has a reason', () => {
  for (const [name, targets] of Object.entries(TARGETS))
    for (const [targetName, t] of Object.entries(targets))
      for (const e of t.equivalent ?? []) {
        const source = readFileSync(new URL(`../packages/${name}/${t.file}`, import.meta.url), 'utf8');
        assert.ok(e.reason && e.reason.length > 20, `${name}/${targetName} line ${e.line} needs a reason`);
        assert.ok(
          mutantsOf(source, t.file).some((m) => m.line === e.line && m.from === e.from && m.to === e.to),
          `${name}/${targetName} line ${e.line} ${e.from} -> ${e.to} is not a mutant`,
        );
      }
});
