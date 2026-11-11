import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SCENES, caseId } from '../bench/scenes/catalog.js';
import { parityCases } from '../bench/scenes/parity.js';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
test('slower matrix rows retain a diagnosis and the one-call inventory retains every engine/case', () => {
  const matrix = readFileSync(new URL('../docs/whitepaper/perf-vs-threejs.md', import.meta.url), 'utf8');
  const causes = read('bench/parity-causes.json');
  for (const line of matrix.split('\n')) {
    const c = line.split('|').map((s) => s.trim());
    if (/^\d+\.\d+$/.test(c[1]) && c[4] === 'slower') {
      assert.ok(c[6], `Undiagnosed slower row ${c[1]}`);
      assert.ok(causes[c[1]], `No canonical cause for ${c[1]}`);
    }
  }
  const inventory = read('docs/whitepaper/results/bp-159-preflight.json');
  const expected = parityCases(SCENES).flatMap((c) =>
    ['margo', 'three-webgpu-parity', 'three-webgl-parity'].map((e) => `${caseId(c.scene, c.params)}@${e}`),
  );
  assert.deepEqual(
    inventory.cases.map((c) => `${c.id}@${c.engine}`),
    expected,
  );
  for (const c of inventory.cases) {
    if (c.status === 'ok') assert.equal(c.calls, 1);
    if (c.status === 'error') assert.ok(c.errors.length);
    assert.equal(c.metrics, undefined);
    assert.equal(c.throughput, undefined);
  }
});

test('retained CPU profiles contain one operation and portable call paths without timing records', () => {
  const profiles = read('docs/whitepaper/results/bp-159-task-profiles.json');
  assert.equal(profiles.records.length, 8);
  for (const r of profiles.records) {
    assert.equal(r.calls, 1);
    assert.ok(r.output);
    assert.ok(r.samples.length);
    assert.equal(r.startTime, undefined);
    assert.equal(r.endTime, undefined);
    for (const s of r.samples) {
      assert.ok(s.samples > 0);
      assert.ok(!s.url.startsWith('file:'), s.url);
      assert.equal(s.timeDeltas, undefined);
    }
  }
});

// Sweep L2 (KB6250d, KB6250e, KB6250f): a three.js backend that throws on a case Margo completes is a rival
// failure, not a Margo defect. Each such pair in the one-call inventory is recorded in bench/parity-causes.json with
// the measured error text, and the matrix shows the row as "rival unsupported" instead of a ratio or "not run".
test('every measured rival error is recorded as rival unsupported with its error text', async () => {
  const { spawnSync } = await import('node:child_process');
  const { copyFileSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const causes = read('bench/parity-causes.json');
  const inventory = read('docs/whitepaper/results/bp-159-preflight.json');
  const margoOk = new Set(inventory.cases.filter((c) => c.engine === 'margo' && c.status === 'ok').map((c) => c.id));
  const recorded = Object.values(causes).flatMap((c) => (typeof c === 'object' && c.rivalUnsupported) || []);
  const rivalErrors = inventory.cases.filter((c) => c.engine !== 'margo' && c.status === 'error' && margoOk.has(c.id));
  assert.ok(rivalErrors.length >= 5, 'the inventory still holds the measured rival errors');
  for (const c of rivalErrors) {
    const r = recorded.find((x) => x.scene === c.id && x.engine === c.engine);
    assert.ok(r, `rival error on ${c.id}@${c.engine} is not recorded`);
    assert.equal(r.error, c.errors[0], `${c.id}@${c.engine} keeps the measured error text`);
  }
  const matrix = readFileSync(new URL('../docs/whitepaper/perf-vs-threejs.md', import.meta.url), 'utf8');
  const row = (doc, id) => doc.split('\n').find((l) => l.startsWith(`| ${id} |`));
  // Render the matrix from a copy of the ledger with a run that adds no case, so only the causes file differs.
  const dir = mkdtempSync(join(tmpdir(), 'parity-rival-'));
  try {
    copyFileSync(new URL('../docs/whitepaper/perf-vs-threejs.json', import.meta.url), join(dir, 'perf.json'));
    const runFile = join(dir, 'run.json');
    writeFileSync(
      runFile,
      JSON.stringify({
        id: 'render-only',
        valid: true,
        invalid: [],
        options: { engines: ['margo', 'three-webgpu-parity', 'three-webgl-parity'], runs: 5, warmup: 1, frames: 300 },
        suites: { parity: { cases: {}, seconds: 0 } },
      }),
    );
    const result = spawnSync(
      process.execPath,
      ['bench/parity-report.mjs', runFile, `--out=${join(dir, 'perf.md')}`, '--partial'],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const rendered = readFileSync(join(dir, 'perf.md'), 'utf8');
    for (const doc of [rendered, matrix]) {
      // 10.14: both backends throw, so the row has no ratio; the first-run verdict stays as measured.
      assert.match(row(doc, '10.14'), /\| not run \| rival unsupported \|/);
      assert.match(row(doc, '10.14'), /reading 'isVector3'/);
      // 10.20: the DDS failure means the rival did less work; p-ies keeps the row slower, p-texture-formats
      // leaves the worst-gaps table.
      assert.match(row(doc, '10.20'), /Unsupported FourCC code {2}(\\u0000){4} \(/);
      assert.doesNotMatch(doc.split('## Every row')[0], /`p-texture-formats`/);
      // 5.8: only three's WebGPU backend refuses MeshDepthMaterial; the WebGL comparison stands.
      assert.match(row(doc, '5.8'), /\| slower \| faster \|/);
      assert.match(
        row(doc, '5.8'),
        /three-webgpu-parity on `p-depth-material`: THREE\.NodeBuilder: Material "MeshDepthMaterial" is not compatible\./,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
