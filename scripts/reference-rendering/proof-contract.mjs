import assert from 'node:assert/strict';
import { assertBudget } from './compare.mjs';

/**
 * The Sample Viewer budget for one backend. A result measured separately on the AMD adapter (an `amd` section with
 * the same scene and reference) gates AMD proofs; every other adapter uses the top-level NVIDIA measurement.
 */
export function viewerBudget(baseline, compat, vendor) {
  const own = vendor === 'amd' ? baseline.amd : undefined;
  if (!own) return compat ? baseline.compat.metrics : baseline.metrics;
  const row = compat ? own.compat : own.native;
  for (const key of ['sourceSha256', 'sceneSha256', 'referenceSha256'])
    assert.equal(row[key], baseline[key], `The AMD budget must use the frozen ${key}`);
  if (compat)
    assert.match(row.hardware.webglRenderer, /AMD Radeon/i, 'The AMD budget must come from the Radeon adapter');
  else assert.equal(row.hardware.webgpu.vendor, 'amd', 'The AMD budget must come from the AMD adapter');
  return row.metrics;
}

/** Validate every capture; an incomplete or repeating subset cannot establish a repeatability proof. */
export function assertReferenceProof(report, baseline, references, vendor) {
  assert.equal(report.runs.length, 3, 'Three fresh browser processes are required');
  const hashes = new Set();
  for (const [processIndex, run] of report.runs.entries()) {
    assert.equal(run.processIndex, processIndex, 'Each browser process must have its own index');
    assert.equal(run.rows.length, 24, 'Four devices times six frames are required per process');
    const captures = new Set();
    for (const row of run.rows) {
      assert.ok(Number.isInteger(row.device) && row.device >= 0 && row.device < 4, 'Invalid device index');
      assert.ok(Number.isInteger(row.frame) && row.frame >= 0 && row.frame < 6, 'Invalid frame index');
      captures.add(`${row.device}/${row.frame}`);
      assert.match(row.sha256, /^[a-f0-9]{64}$/, 'Decoded RGBA hash is required');
      hashes.add(row.sha256);
      assert.deepEqual([row.width, row.height], [512, 512], 'Every capture must retain the full image');
      assert.equal(row.primitives, baseline.margo.primitives, 'The complete reference model must be retained');
      if (vendor === 'amd') {
        if (report.compat)
          assert.match(row.adapter.description, /AMD Radeon/i, 'The render device must be the Radeon adapter');
        else assert.equal(row.adapter.vendor, 'amd', 'The render device must be the AMD adapter');
      }
      if (vendor === 'nvidia') {
        if (report.compat)
          assert.match(row.adapter.description, /NVIDIA/i, 'The render device must be the NVIDIA adapter');
        else assert.equal(row.adapter.vendor, 'nvidia', 'The render device must be the NVIDIA adapter');
      }
      for (const ref of references) {
        assert.equal(row.metrics[ref.name].pixels, 512 * 512, 'Every pixel must be compared');
        assertBudget(row.metrics[ref.name], ref.budget);
      }
    }
    assert.equal(captures.size, 24, 'Every device/frame pair must appear exactly once');
  }
  assert.equal(hashes.size, 1, 'Every decoded RGBA byte must match across processes, devices and frames');
}
