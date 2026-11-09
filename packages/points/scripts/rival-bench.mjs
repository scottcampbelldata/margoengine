import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('packages/points/scripts/rival-bench.mjs')
)
  process.exit(0);
// Starts the batch 168 points measurement. The rival import stays in scripts/.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const child = spawn(process.execPath, ['scripts/rival-points-run.mjs'], { cwd: root, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
