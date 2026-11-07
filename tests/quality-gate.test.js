// The quality gate's ratchet and detectors (scripts/quality-gate.mjs): baselines only shrink unless a reason is given,
// and each detector sees what it claims to see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanRoomGate, ENGINES } from '../scripts/quality/clean-room.js';
import { FAMILIES, normalise } from '../scripts/quality/duplicates.js';
import { BASELINES, compare, readBaseline, staleTotal, updateBaseline } from '../scripts/quality/ratchet.js';
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

test('a baseline total is the sum of its items, in the committed files too', () => {
  // A merge settled by hand once kept sizes.json's total by adding the growth: 22,126 B off the sum of its items.
  assert.equal(staleTotal({ total: 3, items: { a: 1, b: 2 } }), undefined);
  assert.equal(staleTotal({ total: 2, items: { a: 1, b: 2 } }), 3);
  assert.equal(staleTotal({ items: { a: 1 } }), undefined);
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const file of readdirSync(join(root, BASELINES)).filter((n) => n.endsWith('.json'))) {
    const baseline = readBaseline(root, file.slice(0, -5));
    assert.equal(staleTotal(baseline), undefined, `${file}: total ${baseline.total}; run npm run quality -- --update`);
  }
});

test('the gate refuses a bare gate name and growth with no gate, and writes nothing', () => {
  const script = fileURLToPath(new URL('../scripts/quality-gate.mjs', import.meta.url)),
    run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' }),
    bare = run('sizes', '--update', '--reason=x'),
    wide = run('--update', '--reason=x');
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /--gate=sizes/);
  assert.equal(wide.status, 2);
  assert.match(wide.stderr, /--gate=<gate>/);
});

test('clean-room patterns catch engines and libraries, not the word three', () => {
  const hits = (text) =>
    [...text.matchAll(ENGINES)].filter((m) => !/^three$/i.test(m[0]) || m[0] === 'THREE').map((m) => m[0]);
  assert.deepEqual(hits("import * as THREE from 'three';"), ['THREE', "'three'"]);
  assert.deepEqual(hits('like three.js and Babylon.js, ThreeJS'), ['three.js', 'Babylon', 'ThreeJS']);
  assert.deepEqual(hits("import { mat4 } from 'gl-matrix'; import 'pixi.js'"), ["'gl-matrix'", "'pixi.js'"]);
  assert.deepEqual(hits('three vertices per triangle; Three cameras'), []);
});

test('clean-room gate allows only noticed optional peers and absence-asserting tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-cr-'));
  try {
    writeFileSync(
      join(root, 'THIRD-PARTY-NOTICES.md'),
      [
        '| Package | Version (lock) | Licence | Kind | Used by | Why |',
        '| --- | --- | --- | --- | --- | --- |',
        '| `rapier` | 1.0.0 | Apache-2.0 | optional peer | @margoengine/physics, margoengine | solver |',
        '| `lodash` | 1.0.0 | MIT | dependency | @margoengine/physics | helpers |',
      ].join('\r\n'),
    );
    const pkg = (name, manifest) => ({ name, manifest });
    const peerMeta = { rapier: { optional: true } };
    const run = (packages, files = []) => cleanRoomGate({ root, files, packages }).items;
    // Optional peer with a notices row for this package: allowed.
    assert.deepEqual(
      run([pkg('@margoengine/physics', { peerDependencies: { rapier: '1' }, peerDependenciesMeta: peerMeta })]),
      {},
    );
    // Same peer, not optional / not noticed for this package / a runtime dependency / not in the notices: all counted.
    assert.deepEqual(run([pkg('@margoengine/physics', { peerDependencies: { rapier: '1' } })]), {
      'dependency @margoengine/physics rapier': 1,
    });
    assert.deepEqual(
      run([pkg('@margoengine/other', { peerDependencies: { rapier: '1' }, peerDependenciesMeta: peerMeta })]),
      { 'dependency @margoengine/other rapier': 1 },
    );
    assert.deepEqual(run([pkg('@margoengine/physics', { dependencies: { rapier: '1', lodash: '1' } })]), {
      'dependency @margoengine/physics rapier': 1,
      'dependency @margoengine/physics lodash': 1,
    });
    // A mention is counted, except in the one test that asserts the engine is absent.
    const file = 'packages/react/tests/subpaths.test.js';
    mkdirSync(join(root, 'packages/react/tests'), { recursive: true });
    mkdirSync(join(root, 'packages/other'), { recursive: true });
    writeFileSync(join(root, file), "assert.equal(name === 'three', false);");
    writeFileSync(join(root, 'packages/other/a.js'), "import 'three';");
    assert.deepEqual(run([], [file, 'packages/other/a.js']), { 'mention packages/other/a.js': 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  assert.ok(
    FAMILIES['hidden-ancestor'].test(
      'for (let id = node.id; id !== -1; id = engine.store.parents[id]) if (engine.store.hidden[id]) visible = false;',
    ),
  );
  assert.ok(
    FAMILIES['gltf-accessor'].test(
      'if (type === 5126) return data.getFloat32(at, true);\nif (type === 5125) return data.getUint32(at, true);\nif (type === 5123) return data.getUint16(at, true);\nreturn data.getInt16(at, true);',
    ),
  );
  assert.ok(FAMILIES['hex-colour'].test('/^#([0-9a-f]{3}|[0-9a-f]{6})$/i'));
  assert.ok(FAMILIES['partial-view'].test('r[0] !== 0 || r[1] !== 0 || r[2] !== c.width'));
});
