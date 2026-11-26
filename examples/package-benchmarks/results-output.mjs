// Where a *-gpu.mjs check writes its report. The tracked record, results/<file> (the one claims and READMEs cite), is
// written only when the run is asked to record it (--record, as in post-effects-output.mjs). A plain run is a check:
// its report goes to the ignored test-results/ folder, so a test run never rewrites a record with the machine, date
// and commit it ran on and the tree stays clean (KB-L4-trw).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Writes one report and returns its path relative to the repository root. */
export function writeReport(file, text, { argv = process.argv, root = join(import.meta.dirname, '../..') } = {}) {
  const path = argv.includes('--record') ? `examples/package-benchmarks/results/${file}` : `test-results/${file}`;
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  return path;
}
