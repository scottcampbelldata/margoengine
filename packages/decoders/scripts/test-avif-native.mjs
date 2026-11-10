// Direct Node process lookup matches the package build on Windows, where cmd's bare cargo lookup may differ.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { endTree } from '../../../scripts/support/shutdown.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const jobs = [
  ['cargo', ['test', '--offline', '--locked', '--manifest-path', 'native/avif/Cargo.toml'], 180000],
  ...['pixels', 'wasm-pixels', 'wasm-transform'].map((name) => [
    process.execPath,
    [`native/avif/tests/${name}.mjs`],
    180000,
  ]),
];
for (const [command, args, timeout] of jobs) {
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
  let expired = false,
    ended = Promise.resolve([]);
  const timer = setTimeout(() => {
    expired = true;
    if (child.pid) ended = endTree(child.pid);
  }, timeout);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const survivors = await ended;
    if (expired || code !== 0 || survivors.length)
      throw new Error(
        `AVIF native check ${args.join(' ')} failed (${code}); inspect the reported error before landing`,
      );
  } finally {
    clearTimeout(timer);
  }
}
