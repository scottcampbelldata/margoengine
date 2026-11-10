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
 * Runs in the page (JupyterLab 4 or Notebook 7, served with `expose_app_in_browser`): true once the notebook at `path`
 * holds its own connection to the kernel `kernelId`, the state in which Run All runs the cells. Before it, Run All asks
 * "Select Kernel" and runs nothing. The server's connection count is not this state: JupyterLab's help menu connects to
 * every running kernel to read its banner and closes that connection again, and the server counts it before the
 * notebook has connected (a check that ran the cells on that count stalled on the dialog under load).
 */
export function notebookHasKernel({ path, kernelId }) {
  const app = globalThis.jupyterapp;
  if (!app) return false;
  const panel = [...app.shell.widgets('main')].find((widget) => widget.context?.path === path);
  const context = panel?.sessionContext;
  const kernel = context?.session?.kernel;
  return Boolean(context?.isReady && !context.hasNoKernel && kernel?.id === kernelId && kernel.connectionStatus === 'connected');
}

/** The port a Jupyter server serves on, from its log (it moves on from a port in use), or undefined before it says. */
export function serverPort(log) {
  const port = /http:\/\/127\.0\.0\.1:(\d+)\/(?:lab|tree)\b/.exec(log)?.[1];
  return port && Number(port);
}

/** Waits for the server's actual port announcement, or fails on exit, spawn error or deadline. */
export function waitForServerPort(server, readLog, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.stdout.off('data', check);
      server.stderr.off('data', check);
      server.off('exit', exited);
      server.off('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const failed = (error) => { cleanup(); reject(error); };
    const exited = () => failed(new Error(`Jupyter server exited before announcing its port:\n${readLog()}`));
    const aborted = () => failed(signal.reason);
    const check = () => {
      const port = serverPort(readLog());
      if (port) { cleanup(); resolve(port); }
    };
    server.stdout.on('data', check);
    server.stderr.on('data', check);
    server.once('exit', exited);
    server.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else if (server.exitCode !== null || server.signalCode !== null) exited();
    else check();
  });
}
