// The merge gate's guard for deterministic maths: host transcendentals and ** are found in code, not in comments or strings.
import assert from 'node:assert/strict';
import test from 'node:test';
import { hostMath } from '../scripts/check-pinned-math.mjs';

test('host transcendentals and ** are flagged where the code uses them', () => {
  assert.deepEqual(hostMath('const a = Math.exp(x);\nconst b = 2 ** k;\nconst c = Math.hypot(x, y);'), [
    '1: Math.exp',
    '2: **',
    '3: Math.hypot',
  ]);
});

test('exact Math, comments, doc comments and strings pass', () => {
  assert.deepEqual(
    hostMath(
      "/** e ** x by Math.exp in prose */\nconst a = Math.floor(x) + Math.sqrt(y) + Math.imul(a, b);\n// Math.sin here\nconst s = 'Math.pow(2, 3) and 2 ** 3';",
    ),
    [],
  );
});
