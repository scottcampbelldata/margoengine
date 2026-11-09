import { spawn } from 'node:child_process';
import { endTree } from '../../../scripts/support/shutdown.mjs';

/** Bound a compiler and all descendants, without passing file paths through a shell. */
export async function runBuild(program, args, env = process.env) {
  const child = spawn(program, args, {
    stdio: 'inherit',
    env,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let timedOut = false,
    ended;
  const timer = setTimeout(() => {
    timedOut = true;
    ended = endTree(child.pid);
  }, 300000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    const survivors = (await ended) ?? [];
    if (timedOut || code !== 0)
      throw new Error(
        `${program} ${args[0]} ${timedOut ? `exceeded 5 minutes; remaining processes: ${survivors.join(', ') || 'none'}` : `exited ${code}`}`,
      );
  } finally {
    clearTimeout(timer);
  }
}
