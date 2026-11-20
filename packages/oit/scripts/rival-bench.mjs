// Starts the batch 168 OIT measurement. The rival import stays in scripts/.
import { deferSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killTree } from '../../../scripts/run-with-timeout.mjs';

if (!deferSpeedEntry(import.meta.url, 'packages/oit/scripts/rival-bench.mjs')) {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const child = spawn(process.execPath, ['scripts/rival-oit-run.mjs'], { cwd: root, stdio: 'inherit' });
  const timer = setTimeout(() => {
    console.error('OIT benchmark TIMEOUT after 300 s');
    killTree(child.pid);
  }, 300_000);
  child.on('error', (error) => {
    clearTimeout(timer);
    throw error;
  });
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}
