// Captures the golden outputs of the --current proofs into baselines/ (golden.js): each proof rebuilds its baseline from
// Git, must pass against the working tree, and only then stores what the baseline emitted. Run it on a checkout that
// has the reference commits, after `npm run build:packages`, when a proof's current reference advances (AGENTS.md:
// "advance that proof's current reference ... and say why in docs/whitepaper/claims.md"):
//   node examples/package-benchmarks/proofs/capture.mjs [--only=post-ssr,splats]
// It then runs the same proofs as `npm run proofs -- --current` does (from baselines/ alone) to show they pass there.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const here = import.meta.dirname,
  only = process.argv.filter((arg) => arg.startsWith('--only='));
const run = (env) =>
  spawnSync(process.execPath, [resolve(here, 'run.mjs'), '--current', ...only], {
    cwd: resolve(here, '../../..'),
    env: { ...process.env, ...env },
    stdio: 'inherit',
    timeout: 60 * 60_000,
    killSignal: 'SIGKILL',
  });
const captured = run({ PROOFS_GOLDEN_CAPTURE: '1' });
if (captured.status !== 0) {
  console.error(
    'capture: a proof failed against its reference commit; nothing was stored for it. Fix it, then capture again.',
  );
  process.exit(1);
}
const replayed = run({});
if (replayed.status !== 0) {
  console.error('capture: the stored golden outputs do not reproduce the run; see above.');
  process.exit(1);
}
console.log('capture: golden outputs stored in examples/package-benchmarks/proofs/baselines and replayed.');
