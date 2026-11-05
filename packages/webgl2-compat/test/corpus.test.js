// The WGSL corpus (test/corpus, recorded by `npm run record:wgsl-corpus`): its files agree, every module has an entry
// point and the pipelines built from it, and it covers every package whose source holds WGSL. A package that gains
// shaders fails this test until the corpus is recorded again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classify, entryPoints, flagsOf, readCorpus, recordsOf, writeCorpus } from './corpus/store.mjs';

const root = resolve(import.meta.dirname, '..', '..', '..');
const { manifest, modules } = readCorpus();

test('the manifest matches the sources and lists each module once', () => {
  assert.equal(manifest.count, modules.length);
  assert.equal(new Set(modules.map((m) => m.key)).size, modules.length);
  assert.equal(
    manifest.bytes,
    modules.reduce((n, m) => n + Buffer.byteLength(m.code), 0),
  );
  for (const m of modules) {
    assert.equal(typeof m.code, 'string', `${m.key}: source missing`);
    assert.deepEqual(
      m.entryPoints,
      Object.fromEntries(Object.entries(entryPoints(m.code)).filter(([, l]) => l.length)),
    );
    assert.deepEqual(m.flags, flagsOf(m.code));
  }
});

test('the corpus covers every package whose source holds WGSL', () => {
  // One git process lists the files, so the test opens no package sources itself.
  const files = execFileSync(
    'git',
    ['grep', '-l', '-E', '@(vertex|fragment|compute)\\b', '--', 'packages/*/src/**', 'packages/shared/*.js'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  const withShaders = new Set(
    files
      .split('\n')
      .filter(Boolean)
      .map((f) => f.split('/')[1]),
  );
  const covered = new Set(modules.flatMap((m) => [m.package, ...m.packages]));
  const missing = [...withShaders].filter((p) => !covered.has(p) && p !== 'webgl2-compat');
  assert.deepEqual(
    missing,
    [],
    `record the corpus again (npm run record:wgsl-corpus); not covered: ${missing.join(', ')}`,
  );
});

test('a recording added to the corpus keeps every module, its pipelines and its owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wgsl-corpus-add-'));
  try {
    const code = '@compute @workgroup_size(1) fn added() {}';
    writeCorpus([...recordsOf({ manifest, modules }), { key: 'page', code, errors: 0, packages: ['biomes'] }], { dir });
    const again = readCorpus(dir).modules,
      strip = ({ key, package: owner, packages, pipelines }) => ({ key, owner, packages, pipelines: pipelines.length });
    assert.equal(again.length, modules.length + 1);
    assert.equal(again.find((m) => m.code === code).package, 'biomes');
    assert.deepEqual(
      again.filter((m) => m.code !== code).map(strip),
      modules.map(strip),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every stage appears, with pipelines and binding types recorded', () => {
  const stages = new Set(modules.flatMap((m) => Object.keys(m.entryPoints)));
  assert.deepEqual([...stages].sort(), ['compute', 'fragment', 'vertex']);
  const withPipelines = modules.filter((m) => m.pipelines.length).length;
  assert.ok(withPipelines > modules.length / 2, `only ${withPipelines} of ${modules.length} modules have pipelines`);
  const layout = modules.flatMap((m) => m.pipelines).find((p) => Array.isArray(p.layout));
  assert.ok(layout, 'some pipeline has an explicit layout with binding types');
});

test('classify keeps fragment-only and compute-only modules (regression: only vertex modules were kept)', () => {
  // `!a.length + b.length + c.length` dropped every module whose first stage list was empty.
  const at = (code, errors = 0) => classify({ code, errors });
  assert.equal(at('@fragment fn f() -> @location(0) vec4f { return vec4f(1); }'), 'keep');
  assert.equal(at('@compute @workgroup_size(1) fn c() {}'), 'keep');
  assert.equal(at('@vertex fn v() -> @builtin(position) vec4f { return vec4f(0); }'), 'keep');
  assert.equal(at('fn helper() {}'), 'fragment');
  assert.equal(at('@compute @workgroup_size(1) fn c() {}', 1), 'fragment');
  assert.equal(classify({ code: '@compute @workgroup_size(1) fn c() {}' }), 'unknown');
});

test('writeCorpus and readCorpus round-trip, and a changed source fails the hash check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wgsl-corpus-'));
  try {
    const records = [
      {
        key: 'a',
        code: '@fragment fn f() -> @location(0) vec4f { return vec4f(1); }',
        errors: 0,
        packages: ['post'],
        labels: [],
        pages: ['/x'],
      },
      { key: 'b', code: 'fn part() {}', errors: 1, packages: ['post'], labels: [], pages: ['/x'] },
    ];
    const summary = writeCorpus(records, { dir, date: '2026-01-01' });
    assert.equal(summary.kept, 1);
    assert.equal(summary.fragments, 1);
    const back = readCorpus(dir);
    assert.equal(back.modules[0].code, records[0].code);
    assert.equal(back.modules[0].package, 'post');
    const manifestFile = join(dir, 'manifest.json'),
      changed = JSON.parse(readFileSync(manifestFile, 'utf8'));
    changed.sha256 = '0'.repeat(64);
    writeFileSync(manifestFile, JSON.stringify(changed));
    assert.throws(() => readCorpus(dir), /does not match manifest\.json; run npm run record:wgsl-corpus/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
