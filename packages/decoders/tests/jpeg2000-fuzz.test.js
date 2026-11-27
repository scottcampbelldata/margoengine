// Fuzz of `@margoengine/decoders/jpeg2000` through its shipped Wasm: every malformed input must give a picture or a
// coded error, and never trap or hang. Cases and method: support/jpeg2000-fuzz.js. JPEG2000_FUZZ_CASES sets the number
// of random mutations (default 6,000) and JPEG2000_FUZZ_SEED their seed, for longer runs; a failing input is written
// to the system temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const mutations = Number(process.env.JPEG2000_FUZZ_CASES ?? 6000);
const seed = Number(process.env.JPEG2000_FUZZ_SEED ?? 1);
/** The longest one input may take, in milliseconds: the worker pool's own time limit is 10 s plus 4 s per MiB. */
const CASE_LIMIT = 10_000;

/** Runs the cases from `skip` on in one worker until they end or one overruns its limit. */
function run(skip, report) {
  const worker = new Worker(new URL('./support/jpeg2000-fuzz-worker.js', import.meta.url), {
    workerData: { mutations, seed, skip, maxPixels: 2 ** 20 },
  });
  return new Promise((resolve, reject) => {
    let timer;
    let current = { at: skip - 1, name: 'the first case' };
    const finish = (next) => {
      clearTimeout(timer);
      worker.removeAllListeners();
      worker.terminate().then(() => resolve(next), reject);
    };
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        report.failures.push(`${current.name}: no result within ${CASE_LIMIT / 1000} s`);
        finish(current.at + 1);
      }, CASE_LIMIT);
    };
    watch();
    worker.on('message', (message) => {
      if (message.done) return finish(undefined);
      current = message;
      watch();
      if (message.outcome === undefined) return;
      report.cases++;
      report.outcomes[message.outcome] = (report.outcomes[message.outcome] ?? 0) + 1;
      if (message.failure) {
        const file = join(tmpdir(), `margo-jpeg2000-fuzz-${seed}-${message.at}.bin`);
        writeFileSync(file, message.bytes);
        report.failures.push(`${message.name}: ${message.failure} (${file})`);
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code) => reject(new Error(`the fuzz worker exited with ${code} at ${current.name}`)));
  });
}

test('malformed JPEG 2000 input gives a picture or a coded error, never a trap or a hang', { timeout: 600_000 }, async (t) => {
  const report = { cases: 0, outcomes: {}, failures: [] };
  let skip = 0;
  while (skip !== undefined && report.failures.length < 40) skip = await run(skip, report);
  t.diagnostic(`${report.cases} cases: ${JSON.stringify(report.outcomes)}`);
  assert.deepEqual(report.failures, []);
  assert.ok(report.cases > mutations, 'every case ran');
  // The mutations reach past the header checks: some damaged files still decode.
  assert.ok(report.outcomes.decoded > mutations / 20, JSON.stringify(report.outcomes));
});
