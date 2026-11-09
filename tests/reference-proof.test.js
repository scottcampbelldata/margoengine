import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReferenceProof } from '../scripts/reference-rendering/proof-contract.mjs';

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
