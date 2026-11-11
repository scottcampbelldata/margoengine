import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReferenceProof, viewerBudget } from '../scripts/reference-rendering/proof-contract.mjs';

const baseline = { margo: { primitives: 23 } };
const budget = { absolute: 2423418, square: 73048596, max: 255, foreground: 94387 };
const references = [{ name: 'viewer', budget }];
function proof(compat = false) {
  return {
    compat,
    runs: Array.from({ length: 3 }, (_, processIndex) => ({
      processIndex,
      rows: Array.from({ length: 24 }, (_, i) => ({
        device: Math.floor(i / 6),
        frame: i % 6,
        width: 512,
        height: 512,
        primitives: 23,
        sha256: 'a'.repeat(64),
        adapter: { vendor: 'amd', description: 'AMD Radeon(TM) Graphics' },
        metrics: { viewer: { ...budget, pixels: 512 * 512 } },
      })),
    })),
  };
}
const check = (report) => assertReferenceProof(report, baseline, references, 'amd');

test('NVIDIA proofs require the selected vendor on every capture', () => {
  for (const compat of [false, true]) {
    const p = proof(compat);
    for (const run of p.runs)
      for (const row of run.rows)
        row.adapter = { vendor: compat ? 'margo-webgl2' : 'nvidia', description: 'NVIDIA RTX A6000' };
    assertReferenceProof(p, baseline, references, 'nvidia');
    p.runs[2].rows[23].adapter = { vendor: 'amd', description: 'AMD Radeon' };
    assert.throws(() => assertReferenceProof(p, baseline, references, 'nvidia'), /NVIDIA/);
  }
});

test('repeat proof requires every process, device and frame, including the final capture', () => {
  check(proof());
  check(proof(true));
  for (const corrupt of [
    (p) => p.runs.pop(),
    (p) => (p.runs[2].processIndex = 1),
    (p) => p.runs[2].rows.pop(),
    (p) => (p.runs[2].rows[23].frame = 4),
    (p) => (p.runs[2].rows[23].device = 4),
    (p) => (p.runs[2].rows[23].sha256 = 'b'.repeat(64)),
    (p) => (p.runs[2].rows[23].sha256 = ''),
    (p) => (p.runs[2].rows[23].width = 256),
    (p) => p.runs[2].rows[23].primitives--,
    (p) => p.runs[2].rows[23].metrics.viewer.pixels--,
  ]) {
    const report = proof();
    corrupt(report);
    assert.throws(() => check(report));
  }
});

test('AMD proof refuses a different rendering adapter on either backend', () => {
  for (const compat of [false, true]) {
    const report = proof(compat);
    report.runs[2].rows[23].adapter = { vendor: 'nvidia', description: 'NVIDIA RTX A6000' };
    assert.throws(() => check(report), /render device/);
  }
});

test('every capture uses the frozen error and coverage budgets without tolerance', () => {
  for (const [key, increment] of [
    ['absolute', 1],
    ['square', 1],
    ['max', 1],
    ['foreground', -1],
  ]) {
    const report = proof();
    report.runs[2].rows[23].metrics.viewer[key] += increment;
    assert.throws(() => check(report));
  }
});

test('AMD proofs use the AMD measurement only when the record holds one from the Radeon adapter', () => {
  const frozen = { sourceSha256: 's', sceneSha256: 'c', referenceSha256: 'r' };
  const row = (metrics, hardware) => ({ ...frozen, metrics, hardware });
  const record = {
    ...frozen,
    metrics: { absolute: 1 },
    compat: { metrics: { absolute: 2 } },
    amd: {
      native: row({ absolute: 3 }, { webgpu: { vendor: 'amd' } }),
      compat: row(
        { absolute: 4 },
        { webgpu: { vendor: 'margo-webgl2' }, webglRenderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics)' },
      ),
    },
  };
  assert.deepEqual(
    [false, true].flatMap((compat) =>
      ['nvidia', undefined, 'amd'].map((v) => viewerBudget(record, compat, v).absolute),
    ),
    [1, 1, 3, 2, 2, 4],
  );
  const plain = { ...frozen, metrics: { absolute: 1 }, compat: { metrics: { absolute: 2 } } };
  assert.equal(viewerBudget(plain, true, 'amd').absolute, 2, 'Families without an AMD record keep their one budget');
  const moved = structuredClone(record);
  moved.amd.native.referenceSha256 = 'other';
  assert.throws(() => viewerBudget(moved, false, 'amd'), /referenceSha256/);
  const nvidia = structuredClone(record);
  nvidia.amd.compat.hardware.webglRenderer = 'ANGLE (NVIDIA, NVIDIA RTX A6000)';
  assert.throws(() => viewerBudget(nvidia, true, 'amd'), /Radeon/);
});
