// Starts the batch 168 OIT measurement. The rival import stays in scripts/.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killTree } from '../../../scripts/gpu-lock.mjs';

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
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
