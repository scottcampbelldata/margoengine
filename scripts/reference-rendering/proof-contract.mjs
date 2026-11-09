import assert from 'node:assert/strict';
import { assertBudget } from './compare.mjs';

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
      for (const ref of references) {
        assert.equal(row.metrics[ref.name].pixels, 512 * 512, 'Every pixel must be compared');
        assertBudget(row.metrics[ref.name], ref.budget);
      }
    }
    assert.equal(captures.size, 24, 'Every device/frame pair must appear exactly once');
  }
  assert.equal(hashes.size, 1, 'Every decoded RGBA byte must match across processes, devices and frames');
}
