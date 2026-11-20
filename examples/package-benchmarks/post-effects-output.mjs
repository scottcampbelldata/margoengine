// Where post-effects-gpu.mjs writes a section's report. The tracked record, results/<section>-gpu.json (the one the
// post, terrain and water READMEs cite), is written only when the run is asked to record it (--record, as in
// packages/studio and packages/wfc). A plain run is a check (post's test:gpu:flare): its report goes to the ignored
// test-results/ folder, so a test run never rewrites the record with the machine, date and commit it ran on.

/** The report file of one section, relative to the repository root, and whether it is the tracked record. */
export function sectionReport(name, argv = process.argv) {
  const record = argv.includes('--record');
  return {
    record,
    path: record ? `examples/package-benchmarks/results/${name}-gpu.json` : `test-results/post-${name}-gpu.json`,
  };
}
