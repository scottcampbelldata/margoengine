// Starts the batch 168 tiles measurement. The rival import stays in scripts/.
import { deferSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!deferSpeedEntry(import.meta.url, 'packages/tiles/scripts/rival-bench.mjs')) {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const child = spawn(process.execPath, ['scripts/rival-tiles-run.mjs'], { cwd: root, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}
