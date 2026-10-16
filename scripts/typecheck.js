import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const compiler = resolve(repository, 'node_modules/typescript/bin/tsc');
let checked = 0;

for (const entry of await readdir(resolve(repository, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const config = resolve(repository, 'packages', entry.name, 'tsconfig.json');
  try {
    await readFile(config, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  execFileSync(process.execPath, [compiler, '-p', config, '--noEmit', '--strict'], {
    cwd: repository,
    stdio: 'inherit',
  });
  checked++;
}

console.log(`Strict TypeScript checks passed for all ${checked} packages.`);
