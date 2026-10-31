// Waiting for a page served by a Vite dev server to be ready, instead of a fixed time. A cold dev server transforms
// every module the page imports, and on a busy machine that takes as long as the machine is busy: the packed-browser
// step of `modern:test:packages` waited a fixed 30 s for `window.modern` and missed it under load (docs/known-bugs.md).
// What decides readiness is the dev server: while it is transforming requests the page cannot be ready yet, and once it
// is idle the page is ready within moments or something is wrong. A hard outer limit stays, so a real hang still fails.

/**
 * Resolves when `ready()` holds. Waits while `idle()` (the dev server's `waitForRequestsIdle`) is still pending, since
 * the server is then still serving the page's modules; once the server is idle the page has `graceMs` to be ready (its
 * last module runs after the last response), and then the wait fails naming that. Past `hardMs` it fails whatever the
 * server is doing, naming what it was waiting for. `describe()` adds the page's own state to either message.
 * @param {{ ready: () => Promise<boolean>, idle: () => Promise<unknown>, what: string, hardMs?: number, graceMs?: number, pollMs?: number, describe?: () => Promise<string> | string }} options
 * @returns {Promise<number>} milliseconds waited
 */
export async function waitForPageReady({
  ready,
  idle,
  what,
  hardMs = 10 * 60_000,
  graceMs = 10_000,
  pollMs = 100,
  describe = () => '',
}) {
  const begun = Date.now(),
    elapsed = () => Math.round((Date.now() - begun) / 1000),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let serverIdle = false,
    stopped = false;
  const watchIdle = async () => {
    while (!stopped) {
      serverIdle = false;
      await idle();
      serverIdle = true;
      await sleep(pollMs);
    }
  };
  const failure = async (message) =>
    new Error(`${what}: ${message} after ${elapsed()} s${(await describe()) ? `; ${await describe()}` : ''}`);
  let hard;
  const limit = new Promise((_, reject) => {
    hard = setTimeout(
      async () =>
        reject(
          await failure(
            `not ready within the hard limit of ${hardMs / 1000} s (dev server ${serverIdle ? 'idle' : 'still serving requests'}); the dev server or the page is hung`,
          ),
        ),
      hardMs,
    );
    hard.unref?.();
  });
  const wait = (async () => {
    watchIdle().catch(() => {});
    let idleSince = 0;
    while (!stopped) {
      if (await ready()) return Date.now() - begun;
      if (!serverIdle) idleSince = 0;
      else if (!idleSince) idleSince = Date.now();
      else if (Date.now() - idleSince > graceMs)
        throw await failure(
          `the dev server went idle but the page was still not ready (${Math.round(graceMs / 1000)} s)`,
        );
      await sleep(pollMs);
    }
    throw await failure('stopped');
  })();
  wait.catch(() => {});
  try {
    return await Promise.race([wait, limit]);
  } finally {
    stopped = true;
    clearTimeout(hard);
  }
}
