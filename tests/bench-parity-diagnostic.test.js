// The parity report publishes only valid runs (docs/benchmarking.md, quiet speed-phase protocol step 6): a run the
// bench marked invalid, such as one with the quiet gate skipped (--no-gate), is diagnostic and must not reach the
// ledger or the whitepaper document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('parity report refuses a diagnostic run and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-diagnostic-')),
    out = join(dir, 'perf.md'),
    runFile = join(dir, 'run.json');
  try {
    for (const [run, flags] of [
      [{ valid: false, invalid: ['quiet gate skipped (--no-gate)'] }, []],
      [{ invalid: [] }, []], // not marked valid at all
      // --partial lets a run of some cases in, but not one with the gate skipped as well.
      [
        {
          valid: false,
          invalid: [
            'quiet gate skipped (--no-gate)',
            'official runs need the defaults: 5+ runs, 300+ frames, every case, the gate on',
          ],
        },
        ['--partial'],
      ],
    ]) {
      writeFileSync(
        runFile,
        JSON.stringify({
          id: 'diagnostic-run',
          ...run,
          options: { engines: ['margo', 'three-webgpu'], runs: 5 },
          suites: { parity: { cases: {} } },
        }),
      );
      const result = spawnSync(process.execPath, ['bench/parity-report.mjs', runFile, `--out=${out}`, ...flags], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /diagnostic/);
      assert.equal(existsSync(out), false, 'no document');
      assert.equal(existsSync(out.replace(/\.md$/, '.json')), false, 'no ledger');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
