// Determinism rule (spec 3.6): a raw integer `/` or `%` gives different bytes on the CPU and in WGSL when the divisor is
// 0 (WGSL: x / 0 is x and x % 0 is 0; JavaScript: (x / 0) | 0 is 0) or for -2^31 / -1. So in this package every `/`
// and `%` divides by a non-zero constant (a number, an UPPER_CASE constant, 2 ** n, or a product of those); any other
// divisor goes through idiv, imod, udiv, umod, divWide, divFloor or qdiv, which follow WGSL's rules. The helpers themselves are
// the only exception, and a float division outside the decision path that says `float division` on its line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/utils';

const src = new URL('../src/', import.meta.url);
const HELPERS = new Set(['idiv', 'imod', 'udiv', 'umod', 'divWide', 'divWider', 'divFloor']);

/** A divisor that is a non-zero constant. */
function constant(node) {
  if (!node) return false;
  if (node.type === 'ParenthesizedExpression') return constant(node.expression);
  if (node.type === 'Literal') return typeof node.value === 'number' && node.value !== 0;
  if (node.type === 'Identifier') return /^[A-Z][A-Z0-9_]*$/.test(node.name);
  if (node.type === 'BinaryExpression' && node.operator === '**')
    return node.left.type === 'Literal' && node.left.value === 2;
  if (node.type === 'BinaryExpression' && node.operator === '*') return constant(node.left) && constant(node.right);
  return false;
}

/** Every raw division whose divisor is not a constant, as `file:line`. */
function offenders(file, text) {
  const found = [],
    lines = text.split('\n'),
    lineOf = (offset) => text.slice(0, offset).split('\n').length;
  const visit = (node, inHelper) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, inHelper);
      return;
    }
    if (node.type === 'FunctionDeclaration' && HELPERS.has(node.id?.name)) inHelper = true;
    const division =
      (node.type === 'BinaryExpression' && (node.operator === '/' || node.operator === '%')) ||
      (node.type === 'AssignmentExpression' && (node.operator === '/=' || node.operator === '%='));
    if (division && !inHelper && !constant(node.right)) {
      // A deliberate float division outside the decision path (metres to tile indices) says so on its line.
      const line = lineOf(node.start);
      if (!lines[line - 1].includes('float division')) found.push(`${file}:${line}`);
    }
    for (const key of Object.keys(node)) if (key !== 'parent') visit(node[key], inHelper);
  };
  visit(parseSync(file, text).program, false);
  return found;
}

test('biomes sources divide only by non-zero constants or through the WGSL-rule helpers', () => {
  // stats.ts measures patterns in floats and decides nothing (its header says so).
  const files = readdirSync(src).filter((f) => f.endsWith('.ts') && f !== 'stats.ts');
  assert.ok(files.length >= 4);
  const all = files.flatMap((file) => offenders(file, readFileSync(new URL(file, src), 'utf8')));
  assert.deepEqual(all, [], 'use idiv, imod, udiv, umod, divWide or qdiv for these divisions');
});

test('the division check itself catches raw divisions and accepts constants', () => {
  assert.deepEqual(offenders('a.ts', 'const q = a / b;\nconst r = a % n;\nx /= y;'), ['a.ts:1', 'a.ts:2', 'a.ts:3']);
  assert.deepEqual(offenders('b.ts', 'const q = a / 65536 + a % ONE + a / 2 ** k + a / (3 * ONE);'), []);
  assert.deepEqual(offenders('c.ts', 'const q = a / 0;'), ['c.ts:1']);
  assert.deepEqual(offenders('d.ts', 'function idiv(a, b) { return a / b; }'), []);
  assert.deepEqual(offenders('e.ts', 'const t = metres / size; // float division: view only'), []);
});
