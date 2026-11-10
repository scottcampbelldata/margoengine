import { endTree } from '../../../scripts/support/shutdown.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
await mkdir('test-results/mtoon', { recursive: true });
for (const name of [
  'light',
  'replica',
  'matcap',
  'uv',
  'uv-animation',
  'expressions',
  'local-rim',
  'gbuffer',
  'outline',
  'avatar',
  'avatar-vrm1',
]) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        `packages/rigging/tests/mtoon-${name === 'avatar-vrm1' ? 'avatar' : name}.browser.mjs`,
        ...(name === 'avatar-vrm1' ? ['--vrm1'] : []),
        ...process.argv.slice(2),
      ],
      { stdio: 'inherit' },
    );
    let timedOut = false,
      ending = Promise.resolve([]);
    const timer = setTimeout(() => {
      timedOut = true;
      ending = endTree(child.pid);
    }, 120000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', async (code) => {
      clearTimeout(timer);
      await ending;
      if (timedOut) reject(new Error(`MToon ${name} exceeded its 120-second case deadline; process tree ended`));
      else resolve(code);
    });
  });
  if (code !== 0) process.exit(code ?? 1);
}
