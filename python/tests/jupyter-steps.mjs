// Helpers for python/tests/jupyter-browser.mjs: every step has a hard time limit that names the step, and a timeout
// ends the whole process tree (Jupyter server, its kernels, the browser) instead of leaving them behind.
import { spawnSync } from 'node:child_process';

/** Ends `pid` and every process it started: taskkill /T /F on Windows (a plain kill stops only the launcher). */
export function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

/** Thrown when a step passes its time limit; `step` is the step's name. */
export class StepTimeout extends Error {
  constructor(step, ms) {
    super(`step "${step}" hung: no result after ${Math.round(ms / 1000)} s`);
    this.name = 'StepTimeout';
    this.step = step;
  }
}

/** Runs `work()` and rejects with a StepTimeout naming `name` if it takes longer than `ms`. */
export async function step(name, ms, work) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(name, ms)), ms);
  });
  try {
    return await Promise.race([work(), limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts the notebook's kernel through the server's REST API (POST /api/sessions) and returns its id, so the
 * notebook opens onto a kernel that exists instead of asking for one. (The server reports the state `starting` until a
 * client connects, so idle is not awaited here.)
 */
export async function startKernel(base, path, signal) {
  // The server refuses a POST without its XSRF token: a first GET hands out the cookie, which is sent back as the header.
  const hello = await fetch(`${base}/lab`, { signal });
  const xsrf = /_xsrf=([^;]+)/.exec(hello.headers.getSetCookie().join(';'))?.[1];
  const made = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', cookie: `_xsrf=${xsrf}`, 'x-xsrftoken': xsrf ?? '' },
    body: JSON.stringify({ path, name: path, type: 'notebook', kernel: { name: 'python3' } }),
  });
  if (!made.ok) throw new Error(`starting the kernel for ${path}: HTTP ${made.status} ${await made.text()}`);
  return (await made.json()).kernel.id;
}

/**
 * Waits until a browser page holds a connection to the kernel (the server counts them in `connections`). Running cells
 * before that makes the app ask which kernel to use, and the run never starts.
 */
export async function pageConnected(base, kernelId, signal) {
  for (;;) {
    const state = await (await fetch(`${base}/api/kernels/${kernelId}`, { signal })).json();
    if (state.connections > 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
