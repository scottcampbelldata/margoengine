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
import { FAMILIES, normalise, duplicatesGate } from '../scripts/quality/duplicates.js';
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

// Bug (2026-11-11): after a rebase onto another lane's raised video/record budget (1,996 B), a lane whose video dist
// was still the old build ran `--update` and wrote 1,460, so main's sizes gate failed at 1,740 for everyone.
test('updateBaseline keeps the budgets of items measured from a stale build', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-'));
  try {
    mkdirSync(join(root, BASELINES), { recursive: true });
    updateBaseline(root, 'demo', 'test', { mine: 100, theirs: 1996 }, readBaseline(root, 'demo'), { reason: 'first' });
    const frozen = (key) => key === 'theirs';
    // A stale, smaller measurement of theirs leaves its budget alone while mine still shrinks.
    updateBaseline(root, 'demo', 'test', { mine: 90, theirs: 1460 }, readBaseline(root, 'demo'), { frozen });
    assert.deepEqual(readBaseline(root, 'demo').items, { mine: 90, theirs: 1996 });
    // A stale, larger one is not growth to accept either.
    updateBaseline(root, 'demo', 'test', { mine: 90, theirs: 3000 }, readBaseline(root, 'demo'), { frozen });
    assert.equal(readBaseline(root, 'demo').items.theirs, 1996);
    assert.equal(readBaseline(root, 'demo').total, 90 + 1996);
    // A stale build cannot set a first budget.
    assert.throws(
      () =>
        updateBaseline(root, 'demo', 'test', { mine: 90, theirs: 1996, newer: 5 }, readBaseline(root, 'demo'), {
          reason: 'x',
          frozen: (key) => key === 'newer',
        }),
      /stale build .*npm run build:packages/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the sizes gate names the package each item measures, so stale builds can be kept', async () => {
  const { sizesGate } = await import('../scripts/quality/sizes.js');
  const { packageList, repoFiles } = await import('../scripts/quality/packages.js');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const packages = packageList(root, repoFiles(root));
  const result = await sizesGate({ root, packages });
  assert.equal(result.owner('@margoengine/video/record'), 'video');
  assert.equal(result.owner('@margoengine/core'), 'core');
  for (const key of Object.keys(result.items)) assert.ok(result.owner(key), `no owner for ${key}`);
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

test('multiline imports and re-exports are excluded as complete declarations, while implementation stays', () => {
  const source = [
    'import {',
    '  engineRuntime,',
    '  type Engine,',
    '  type EnginePlugin,',
    '  type FrameGraph,',
    '  type PassContext,',
    "} from '@margoengine/core/extension';",
    'export {',
    '  thing,',
    "} from './other.js';",
    'export function sharedWork() {',
    '  const rows = [];',
    '  for (let i = 0; i < 10; i++) {',
    '    rows.push(i * i);',
    '  }',
    '  return rows;',
    '}',
  ].join('\n');
  const lines = normalise(source);
  assert.equal(lines[0].line, 11);
  assert.ok(lines.every((l) => !/engineRuntime|EnginePlugin|FrameGraph|PassContext|thing/.test(l.text)));
  assert.ok(lines.some((l) => l.text === 'rows.push(i * i);'));
  assert.ok(lines.some((l) => l.text.startsWith('export function sharedWork')));
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

test('GGX family requires the squared-cosine term and excludes convolution output geometry', () => {
  for (const code of [
    'let denominator = cosine * cosine * (alphaSquared - 1) + 1;',
    'let denominator = pow(cosine, 2.0) * (alphaSquared - 1.0) + 1.0;',
    'let d=a2/(3.14159265*pow(nh*nh*(a2-1.0)+1.0,2.0));',
  ])
    assert.ok(FAMILIES['ggx-ndf'].test(code), code);
  for (const code of [
    '(h - 1) * sh - 2 * ph + dh * (kh - 1) + 1',
    '(w - 1) * sw - 2 * pw + dw * (kw - 1) + 1',
    '(a + 2) * t * t * t - (a + 3) * t * t + 1',
  ])
    assert.equal(FAMILIES['ggx-ndf'].test(code), false, code);
});

test('reexports distinguish package boundaries from shared name prefixes', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-prefix-'));
  assert.ok(root.startsWith(join(tmpdir(), 'quality-prefix-')));
  const src = 'packages/webgl/src/index.ts';
  try {
    mkdirSync(join(root, 'packages/webgl/src'), { recursive: true });
    writeFileSync(
      join(root, src),
      [
        "export { webglRenderer } from '@margoengine/webgl2-compat/preview';",
        "export * from '@margoengine/webgl2-compat/pick';",
        "export type { PreviewOptions } from '@margoengine/webgl2-compat/preview';",
        "export { local } from '@margoengine/webgl/local';",
        "export * from '@margoengine/webgl';",
      ].join('\n'),
    );
    const { items } = duplicatesGate({
      root,
      files: [src],
      packages: [{ name: '@margoengine/webgl', entries: [{ src }] }],
    });
    assert.deepEqual(items, {
      [`reexport ${src} webglRenderer from @margoengine/webgl2-compat/preview`]: 1,
      [`reexport ${src} * from @margoengine/webgl2-compat/pick`]: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
