// Starts the batch 168 tiles measurement. The rival import stays in scripts/.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const child = spawn(process.execPath, ['scripts/rival-tiles-run.mjs'], { cwd: root, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
