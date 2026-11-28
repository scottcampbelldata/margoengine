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

// The audit found the vehicle code feeding the world hash through host maths (KB-PHYS-AUDIT1, DYN-04): Math.atan, Math.sin
// and Math.exp in the tyres, the suspension and the tracks, and an alias `const atan = Math.atan` that no name check sees.
test('the vehicle code that feeds a world is held to pinned maths, and passes', async () => {
  const { ALWAYS } = await import('../scripts/check-pinned-math.mjs'),
    { readFileSync } = await import('node:fs');
  for (const name of ['tyres', 'vehicle', 'motorcycle', 'tracked']) {
    const path = `packages/physics/src/${name}.ts`;
    assert.ok(ALWAYS.includes(path), `${path} is on the always-checked list`);
    assert.deepEqual(hostMath(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')), [], `${path} uses host maths`);
  }
  assert.deepEqual(hostMath('const atan = Math.atan,\n  sin = Math.sin;'), ['1: Math.atan', '2: Math.sin']);
});
