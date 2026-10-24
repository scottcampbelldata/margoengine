// The quality gate's ratchet and detectors (scripts/quality-gate.mjs): baselines only shrink unless a reason is given,
// and each detector sees what it claims to see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINES } from '../scripts/quality/clean-room.js';
import { FAMILIES, normalise } from '../scripts/quality/duplicates.js';
import { BASELINES, compare, readBaseline, updateBaseline } from '../scripts/quality/ratchet.js';
import { headroom } from '../scripts/quality/sizes.js';

test('compare fails on new and worse items and lists improvements', () => {
  const baseline = { items: { a: 2, b: 1, gone: 1 } };
  const { worse, better } = compare({ a: 3, b: 0, fresh: 1 }, baseline);
  assert.deepEqual(
    worse.map((w) => w.key),
    ['a', 'fresh'],
  );
  assert.deepEqual(better.map((b) => b.key).sort(), ['b', 'gone']);
  // Byte budgets: within the limit passes; a measurement whose own budget is tighter can shrink.
  const sizes = compare({ x: 1000 }, { items: { x: headroom(1000) + 10 } }, (v) => headroom(v));
  assert.deepEqual(sizes.worse, []);
  assert.equal(sizes.better.length, 1);
});

test('updateBaseline shrinks freely, grows only with a reason, and logs the reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-'));
  try {
    mkdirSync(join(root, BASELINES), { recursive: true });
    updateBaseline(root, 'demo', 'test', { a: 2 }, readBaseline(root, 'demo'), { reason: 'first' });
    assert.throws(
      () => updateBaseline(root, 'demo', 'test', { a: 3 }, readBaseline(root, 'demo')),
      /would grow the baseline .*--reason=/,
    );
    updateBaseline(root, 'demo', 'test', { a: 1 }, readBaseline(root, 'demo'));
    assert.deepEqual(readBaseline(root, 'demo').items, { a: 1 });
    updateBaseline(root, 'demo', 'test', { a: 1, b: 4 }, readBaseline(root, 'demo'), { reason: 'b is accepted' });
    const written = JSON.parse(readFileSync(join(root, BASELINES, 'demo.json'), 'utf8'));
    assert.deepEqual(written.items, { a: 1, b: 4 });
    assert.deepEqual(
      written.history.map((h) => h.reason),
      ['first', 'b is accepted'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean-room patterns catch engines and libraries, not the word three', () => {
  const hits = (text) =>
    [...text.matchAll(ENGINES)].filter((m) => !/^three$/i.test(m[0]) || m[0] === 'THREE').map((m) => m[0]);
  assert.deepEqual(hits("import * as THREE from 'three';"), ['THREE', "'three'"]);
  assert.deepEqual(hits('like three.js and Babylon.js, ThreeJS'), ['three.js', 'Babylon', 'ThreeJS']);
  assert.deepEqual(hits("import { mat4 } from 'gl-matrix'; import 'pixi.js'"), ["'gl-matrix'", "'pixi.js'"]);
  assert.deepEqual(hits('three vertices per triangle; Three cameras'), []);
});

test('normalise drops comments, blank lines, imports and dispose boilerplate', () => {
  const lines = normalise(
    [
      "import { a } from './a.js';",
      '/* block',
      '   comment */ const x = 1; // trailing',
      '',
      '  });',
      "const url = 'https://example.com';",
      '[(Symbol.dispose ?? Symbol()) as symbol](): void {',
    ].join('\n'),
  );
  assert.deepEqual(lines, [
    { text: 'const x = 1;', line: 3 },
    { text: "const url = 'https://example.com';", line: 6 },
  ]);
});

test('family signatures match the known copies', () => {
  assert.ok(FAMILIES['crc32-table'].test('c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1'));
  assert.ok(FAMILIES['ggx-ndf'].test('let k=nh*nh*(a2-1.0)+1.0;'));
  assert.ok(FAMILIES['hidden-ancestor'].test('if (engine.store.hidden[id]) visible = false;'));
  assert.ok(FAMILIES['hex-colour'].test('/^#([0-9a-f]{3}|[0-9a-f]{6})$/i'));
  assert.ok(FAMILIES['partial-view'].test('r[0] !== 0 || r[1] !== 0 || r[2] !== c.width'));
});
