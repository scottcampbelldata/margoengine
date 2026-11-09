// The named release speed suite. Default build phase prints its deferral without spawning any work.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deferSpeed, reportSpeedPhase, speedEnabled } from './support/speed-phase.mjs';
import { runLimited } from './support/run-limited.mjs';

const suites = JSON.parse(readFileSync(new URL('./speed/suites.json', import.meta.url), 'utf8'));
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
if (process.argv.includes('--release') && (only || process.argv.includes('--list')))
  throw new RangeError(
    'A release speed run must execute the whole manifest; --release cannot be combined with --only or --list.',
  );
const selected = suites.filter((suite) => !only || suite.id.includes(only));
if (!selected.length) throw new RangeError(`No speed suite matches ${JSON.stringify(only)}`);
if (process.argv.includes('--list')) {
  for (const suite of selected) console.log(`${suite.id}: ${suite.command}`);
} else {
  reportSpeedPhase('test:speed');
  if (process.argv.includes('--release') && !speedEnabled())
    throw Object.assign(
      new Error(
        'ERR_SPEED_PHASE_RELEASE_REQUIRED: Scott must end the build phase, then the full named speed suite must pass on a quiet machine before release.',
      ),
      {
        code: 'ERR_SPEED_PHASE_RELEASE_REQUIRED',
      },
    );
  if (!deferSpeed(`named speed suite (${selected.length} commands)`)) {
    for (const suite of selected) {
      console.log(`SPEED: ${suite.id}: ${suite.command}`);
      const result = await runLimited(suite.command, {
        cwd: resolve(import.meta.dirname, '..'),
        limitMs: suite.limitMinutes * 60000,
      });
      if (!result.ok) {
        process.exitCode = 1;
        break;
      }
    }
  }
}
