// Scott's build-phase ruling: one checked-in default, shared by every gate and speed entry.
// MARGO_SPEED_PHASE=active is the explicit quiet-machine release run; no gate enables it itself.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const configuration = JSON.parse(readFileSync(new URL('../speed-phase.json', import.meta.url), 'utf8'));

export function speedPhase(env = process.env, configured = configuration.phase) {
  const phase = env.MARGO_SPEED_PHASE ?? configured;
  if (phase !== 'deferred' && phase !== 'active')
    throw Object.assign(new Error(`MARGO_SPEED_PHASE must be deferred or active, got ${JSON.stringify(phase)}`), {
      code: 'ERR_SPEED_PHASE',
    });
  return phase;
}

export const speedEnabled = () => speedPhase() === 'active';
export const isSpeedEntry = (url) => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
const announced = new Set();

/** True means the caller must return before any speed work, GPU request or child launch. */
export function deferSpeed(label, log = console.log) {
  if (speedEnabled()) return false;
  if (!announced.has(label)) {
    announced.add(label);
    log(
      `SPEED DEFERRED: ${label}; correctness and deterministic work counts remain enabled (scripts/speed-phase.json; npm run test:speed -- --list names the suite)`,
    );
  }
  return true;
}

const listingFlags = ['--help', '-h', '--list'];

/**
 * True when the module at `url` was started as the entry (not imported), the run is no --help, -h or --list run, and the
 * build phase defers its speed work (the deferral is announced under `label`). The entry wraps its body in
 * `if (!deferSpeedEntry(url, label)) { ... }`, `url` being its own import.meta.url, so a deferred run ends by its event
 * loop with exit code 0:
 * process.exit can hang a Node process for ever (KB-OWN-EXIT1, KB-OWN-EXIT2), and a top-level await that never settles
 * ends it with code 13.
 */
export function deferSpeedEntry(url, label, argv = process.argv) {
  return isSpeedEntry(url) && !argv.some((arg) => listingFlags.includes(arg)) && deferSpeed(label);
}

export function reportSpeedPhase(gate) {
  console.log(
    `${gate}: speed phase ${speedPhase()}; ${speedEnabled() ? 'speed suite enabled' : 'benchmarks and timing assertions deferred'} (scripts/speed-phase.json)`,
  );
}
