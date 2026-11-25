// A small W3C WebDriver client (https://www.w3.org/TR/webdriver2/) for the browser matrix (browser-matrix.mjs): plain
// fetch, no dependency. It drives Safari through Apple's safaridriver, which ships with macOS (/usr/bin/safaridriver);
// remote automation must be allowed once in Safari's Develop menu (or `safaridriver --enable`, which asks for a password).
// Every request has a hard time limit; `close()` ends the session (its automation window) and the driver process.
import { spawn } from 'node:child_process';

/** The W3C key of an element reference in a WebDriver response. */
export const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/** Error of a WebDriver command: the protocol's `error` code (for example `javascript error`) and its message. */
export class WebDriverError extends Error {
  constructor(command, status, value) {
    super(`${command}: ${value?.error ?? `HTTP ${status}`}: ${value?.message ?? ''}`.trim());
    this.name = 'WebDriverError';
    this.code = value?.error ?? 'http';
    this.status = status;
  }
}

/**
 * One WebDriver command: `method` on `path` below `base`, with `body` as JSON. Resolves with the response's `value`;
 * rejects with WebDriverError on a protocol error, or with a TimeoutError past `timeoutMs`.
 */
export async function command(base, method, path, body, { timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new WebDriverError(`${method} ${path}`, response.status, {
      error: 'invalid response',
      message: text.slice(0, 200),
    });
  }
  if (!response.ok || parsed?.value?.error)
    throw new WebDriverError(`${method} ${path}`, response.status, parsed.value);
  return parsed.value;
}

/**
 * The in-page wrapper for an asynchronous script: runs `source` (an expression giving a function) with `arg` and
 * returns `{ok: value}` or `{thrown: {name, code, message}}`, so a page's coded error comes back as data with its code.
 */
export function asyncScript(source, arg) {
  return (
    'const done = arguments[arguments.length - 1];' +
    `Promise.resolve().then(() => (${source})(${JSON.stringify(arg ?? null)}))` +
    // JSON has no -0, NaN or infinities: they travel tagged ({"~n": "-0"}) and `revive` puts them back.
    ".then((v) => done({ ok: v === undefined ? null : JSON.parse(JSON.stringify(v, (k, x) => typeof x === 'number' && (!Number.isFinite(x) || Object.is(x, -0)) ? { '~n': Object.is(x, -0) ? '-0' : String(x) } : ArrayBuffer.isView(x) && !(x instanceof DataView) ? Array.from(x) : x)) })," +
    ' (e) => done({ thrown: { name: String(e && e.name), code: e && e.code !== undefined ? String(e.code) : null, message: String(e && e.message !== undefined ? e.message : e) } }));'
  );
}

/** Undoes the page side's tagging of -0, NaN and the infinities in a script's result. */
export function revive(value) {
  return JSON.parse(JSON.stringify(value), (k, x) =>
    x && typeof x === 'object' && Object.keys(x).length === 1 && typeof x['~n'] === 'string' ? Number(x['~n']) : x,
  );
}

/** A WebDriver session at `base` (for example http://127.0.0.1:4444) asking for `capabilities`. */
export async function openSession(base, capabilities, { timeoutMs = 120_000, fetchImpl } = {}) {
  const value = await command(
    base,
    'POST',
    '/session',
    { capabilities: { alwaysMatch: capabilities } },
    { timeoutMs, fetchImpl },
  );
  const id = value.sessionId,
    at = `/session/${id}`,
    send = (method, path, body, limit = 60_000) =>
      command(base, method, at + path, body, { timeoutMs: limit, fetchImpl });
  let closed = false;
  return {
    id,
    capabilities: value.capabilities ?? {},
    /** Script and page load limits, in milliseconds. */
    timeouts: (script, pageLoad) => send('POST', '/timeouts', { script, pageLoad }),
    goto: (url, limit = 180_000) => send('POST', '/url', { url }, limit),
    /** Runs `source` (an expression giving a function, sync or async) with `arg`: `{ok}` or `{thrown}`. */
    run: async (source, arg, limit = 15 * 60_000) =>
      revive(await send('POST', '/execute/async', { script: asyncScript(source, arg), args: [] }, limit)),
    /** PNG bytes of the viewport, as the browser shows it. */
    pageScreenshot: async () => Buffer.from(await send('GET', '/screenshot', undefined, 120_000), 'base64'),
    /**
     * PNG bytes of the first element matching `selector`. Safari 27 returns a WebGPU canvas's element shot all black
     * (the page shot shows it), so the browser matrix crops the page shot instead (browser-matrix.mjs `crop`).
     */
    async screenshot(selector = 'canvas') {
      const element = await send('POST', '/element', { using: 'css selector', value: selector });
      const data = await send('GET', `/element/${element[ELEMENT_KEY]}/screenshot`, undefined, 120_000);
      return Buffer.from(data, 'base64');
    },
    /** Ends the session, closing its automation window; a second call does nothing. */
    async close() {
      if (closed) return;
      closed = true;
      await send('DELETE', '', undefined, 30_000);
    },
  };
}

/** Polls GET /status at `base` until the driver says it is ready, up to `timeoutMs`. */
export async function waitReady(base, { timeoutMs = 30_000, fetchImpl, poll = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  for (let last; ; ) {
    try {
      const status = await command(base, 'GET', '/status', undefined, { timeoutMs: 5_000, fetchImpl });
      if (status?.ready !== false) return status;
      last = new Error(status?.message ?? 'not ready');
    } catch (error) {
      last = error;
    }
    // wall-clock: a bound on the driver's start, far from normal.
    if (Date.now() > end) throw new Error(`WebDriver at ${base} was not ready in ${timeoutMs} ms: ${last?.message}`);
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
}

/**
 * Starts `/usr/bin/safaridriver -p <port>` and waits for it. Returns `{base, stop}`; `stop()` ends the process
 * (SIGTERM, then SIGKILL after 5 s).
 */
export async function startSafariDriver(port, { executable = '/usr/bin/safaridriver', spawnProcess = spawn } = {}) {
  const child = spawnProcess(executable, ['-p', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(kill);
  };
  const base = `http://127.0.0.1:${port}`;
  try {
    await Promise.race([
      waitReady(base),
      exited.then((code) => {
        throw new Error(`safaridriver exited with ${code}: ${stderr.trim()}`);
      }),
    ]);
  } catch (error) {
    await stop();
    throw error;
  }
  return { base, stop };
}
