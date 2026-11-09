import { chromium, firefox, webkit } from '@playwright/test';
import { gpuAdapterArg } from './gpu-adapter.mjs';
import { closeAll, endTree, waitSignaled, SHUTDOWN_BUDGET_MS, SHUTDOWN_STEPS } from '../support/shutdown.mjs';

const ownedBrowserServers = new WeakMap();
const ownedProcessCloses = new WeakMap();

/**
 * Which browser the repository's browser checks drive, and how it is launched, in one place.
 *
 *   MARGO_BROWSER=edge|chrome|chromium|firefox|webkit   default: edge on Windows (the long-standing behaviour), chromium
 *                                                elsewhere (Playwright's own build, so a Linux server needs no Edge)
 *   --browser=<name> on a suite's command line   same values; the legacy names msedge and bundled still work
 *   BROWSER_CHANNEL=msedge|chrome|bundled        older spelling, used when MARGO_BROWSER is not set
 *   BROWSER_EXECUTABLE=<path>                    launch this binary instead of the named browser's install
 *   MARGO_GPU=default|nvidia|amd|intel           which GPU on a Windows PC with two (see gpu-adapter.mjs); unset picks the
 *                                                hardware adapter with the most video memory, default adds no flag
 *   MARGO_GPU_LUID=high,low                      use exactly this adapter (decimal)
 *   MARGO_SOFTWARE_GPU=1                         use SwiftShader (a software WebGPU adapter) on a machine without a
 *                                                real GPU; slow, and its pixels differ from a real GPU's
 *
 * Firefox has no WebGPU in Playwright's builds, so a step that needs it is reported as skipped (never passed).
 * webkit is Playwright's own WebKit build, which has WebGPU on macOS. It is not Safari: Safari needs safaridriver.
 */

const ALIASES = {
  edge: 'edge',
  msedge: 'edge',
  chrome: 'chrome',
  chromium: 'chromium',
  bundled: 'chromium',
  firefox: 'firefox',
  webkit: 'webkit',
};

/** The WebGPU switch a Chromium-family browser needs where WebGPU is not already on. */
const WEBGPU_ARGS = ['--enable-unsafe-webgpu'];
const LINUX_ARGS = ['--enable-features=Vulkan', '--use-angle=vulkan'];
/** macOS: Playwright's headless shell otherwise gets SwiftShader (software); ANGLE on Metal gives the real GPU. */
const DARWIN_ARGS = ['--use-angle=metal'];
/** SwiftShader as the WebGPU adapter (the switches scripts/screenshot-example.mjs already used). */
const SOFTWARE_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-angle=swiftshader',
  '--use-webgpu-adapter=swiftshader',
];

/**
 * Picks the browser. `name` overrides the environment (an explicit call such as `openBrowser({ channel: 'chrome' })`).
 * Throws a TypeError naming the accepted values for an unknown name.
 * @returns {{ name: 'edge'|'chrome'|'chromium'|'firefox'|'webkit', engine: 'chromium'|'firefox'|'webkit', channel: string|undefined,
 *   executablePath: string|undefined, webgpu: boolean, chooseGpu: boolean, env: object, software: boolean, explicit: boolean, platform: string }}
 */
export function resolveBrowser({ name, env = process.env, platform = process.platform, argv = process.argv } = {}) {
  const flag = argv.find((a) => a.startsWith('--browser='))?.slice('--browser='.length),
    requested = name ?? flag ?? env.MARGO_BROWSER ?? env.BROWSER_CHANNEL,
    wanted = String(requested ?? '')
      .trim()
      .toLowerCase(),
    explicit = wanted !== '',
    key = explicit ? wanted : platform === 'win32' ? 'edge' : 'chromium';
  if (!(key in ALIASES))
    throw new TypeError(
      `Unknown browser "${requested}"; set MARGO_BROWSER to one of ${[...new Set(Object.values(ALIASES))].join(', ')}`,
    );
  const picked = ALIASES[key],
    engine = picked === 'firefox' || picked === 'webkit' ? picked : 'chromium';
  return {
    name: picked,
    engine,
    channel: picked === 'edge' ? 'msedge' : picked === 'chrome' ? 'chrome' : undefined,
    executablePath: env.BROWSER_EXECUTABLE || undefined,
    webgpu: engine !== 'firefox',
    chooseGpu: engine === 'chromium' && platform === 'win32',
    env,
    software: env.MARGO_SOFTWARE_GPU === '1' || env.MARGO_SOFTWARE_GPU === 'true',
    explicit,
    platform,
  };
}

/** Command-line switches for the browser: WebGPU on where it is not on already, SwiftShader when asked for, then `extra`. */
export function launchArgs(browser, extra = [], { webgpu = true, gpu = gpuAdapterArg } = {}) {
  if (browser.engine !== 'chromium') return [];
  const args = [];
  if (!webgpu) return [...extra];
  if (browser.software) args.push(...SOFTWARE_ARGS);
  else if (browser.platform !== 'win32' || browser.name !== 'edge') {
    args.push(...WEBGPU_ARGS);
    if (browser.platform === 'linux') args.push(...LINUX_ARGS);
    if (browser.platform === 'darwin') args.push(...DARWIN_ARGS);
  }
  if (browser.chooseGpu && !browser.software) {
    const arg = gpu({ env: browser.env });
    if (arg) args.push(arg);
  }
  return [...new Set([...args, ...extra])];
}

/**
 * The reason a GPU check must not run on the adapter the browser gave it, or null. A software or fallback adapter
 * (SwiftShader) is refused unless software was asked for (MARGO_SOFTWARE_GPU=1). `adapter` is the probe's `hardware.webgpu`.
 */
export function softwareAdapterReason(browser, adapter, { args = [] } = {}) {
  // Asked for on purpose: MARGO_SOFTWARE_GPU=1, or a launch argument that names the SwiftShader adapter (the Windows
  // runners in .github/workflows/browser.yml pass one through BROWSER_ARGS).
  if (browser.software || args.includes('--use-webgpu-adapter=swiftshader') || !adapter) return null;
  const soft =
    adapter.fallback === true || /swiftshader/i.test(`${adapter.architecture ?? ''} ${adapter.description ?? ''}`);
  if (!soft) return null;
  return `WebGPU adapter is a software one (${JSON.stringify(adapter)}) on ${browser.platform}; this check needs a real GPU. Fix the browser launch, or set MARGO_SOFTWARE_GPU=1 to run on SwiftShader on purpose`;
}

/**
 * The reason a step cannot run in this browser, or null. `needs` is 'webgpu' (default), 'chromium' (Chromium-only
 * Playwright features such as page.pdf) or 'none'.
 */
export function unsupportedReason(browser, needs = 'webgpu') {
  if (needs === 'webgpu' && !browser.webgpu) return `no WebGPU in ${browser.name}`;
  if (needs === 'chromium' && browser.engine !== 'chromium') return `needs a Chromium browser, not ${browser.name}`;
  return null;
}

/**
 * Prints "<suite>: skipped: <reason>" and ends the process with exit code 0. A skip is loud, never a silent pass:
 * the line names the browser and the reason, and the suite's own pass message is never printed.
 */
export function skipSuite(
  reason,
  { suite = process.argv[1]?.split(/[\\/]/).pop() ?? 'suite', out = console.log, exit = process.exit } = {},
) {
  out(`${suite}: skipped: ${reason}`);
  return exit(0);
}

/** The browser's name for reports, in the spelling the records always used: "msedge", "chrome", "chromium" or "firefox". */
export function browserLabel(options) {
  const browser = resolveBrowser(options);
  return browser.channel ?? browser.name;
}

/**
 * Launch options (channel, executablePath, args) for a Chromium `launch()` the caller makes with its own Playwright
 * copy, for example one installed in a throwaway fixture project. Skips the suite like {@link launchBrowser} when the
 * browser is not Chromium-based. `webgpu: false` leaves the WebGPU switches out.
 */
export function chromiumLaunchOptions({ name, args = [], webgpu = true, env, platform, argv, ...options } = {}) {
  const browser = resolveBrowser({ name, env, platform, argv }),
    reason = unsupportedReason(browser, 'chromium');
  if (reason) return skipSuite(reason);
  return {
    ...options,
    args: launchArgs(browser, args, { webgpu }),
    ...(browser.channel ? { channel: browser.channel } : {}),
    ...(browser.executablePath ? { executablePath: browser.executablePath } : {}),
  };
}

/**
 * Ends a Chromium-family browser's processes. Its own shutdown runs on low-priority threads, which a busy machine starves:
 * 68 to 146 s beside CPU hogs, past the shared budget, against 7 to 17 s for this. A suite's browser has a throwaway
 * profile, so nothing is lost by not waiting for it. Firefox has no such route and closes the ordinary way. Playwright only
 * finishes a context's videos and traces in `context.close()`, so a suite that records them closes that first, as it must.
 */
async function endChromium(browser, end) {
  if (browser.browserType?.().name() !== 'chromium' || !browser.isConnected()) return;
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  await end(processInfo.find((process) => process.type === 'browser').id);
}

/** How long an owned browser may take to list its processes at close before the helper route ends its tree instead. */
export const LIST_PROCESSES_MS = 5_000;

/** Whether `pid` is still running (Windows: its exit code is not set yet). */
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** The pids Chromium lists for itself (browser, renderers, GPU, utilities) over CDP. */
async function chromiumPids(browser) {
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  return processInfo.map((process) => process.id);
}

async function listOwnedPids(browser, listMs) {
  let timer;
  const listed = await Promise.race([
    typeof browser?.newBrowserCDPSession === 'function' ? chromiumPids(browser).catch(() => null) : null,
    new Promise((resolve) => (timer = setTimeout(resolve, listMs, null))),
  ]);
  clearTimeout(timer);
  return listed;
}

/**
 * Ends an owned Chromium and the processes it lists for itself, with no helper program: the browser process through
 * the handle Node holds (`TerminateProcess` on Windows), each listed child by its pid, then waits until the listed
 * children have exited. Some Edge utility processes outlive their browser by more than 10 s, so they are ended too.
 * Only a browser that does not list its processes within `listMs` falls back to `end` (taskkill /T and a handle wait),
 * and its browser process is still ended through its handle after that. A refused kill (the child's 'error' event,
 * which `kill()` raises synchronously) is thrown, never left as an unhandled event.
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ newBrowserCDPSession?: () => Promise<{ send(method: string): Promise<any> }> }} browser
 * @param {{ end: (pid: number) => Promise<number[]>, listMs?: number, pids?: number[]|null, settle?: typeof waitSignaled|null, alive?: (pid: number) => boolean, kill?: (pid: number) => void }} options
 */
export async function stopOwned(
  child,
  browser,
  { end, listMs = LIST_PROCESSES_MS, pids, settle = process.platform === 'win32' ? waitSignaled : null, alive = running, kill = (pid) => process.kill(pid, 'SIGKILL') },
) {
  const begun = Date.now();
  const listed = pids === undefined ? await listOwnedPids(browser, listMs) : pids;
  let remaining = [];
  if (!listed) remaining = (await end(child.pid)) ?? [];
  let failure;
  const refused = (error) => (failure = error);
  child.once('error', refused);
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  } finally {
    child.removeListener('error', refused);
  }
  if (failure) throw failure;
  let children = (listed ?? []).filter((pid) => pid !== child.pid);
  for (const pid of children) {
    try {
      kill(pid);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  // Windows can reuse a PID immediately. Check creation time before waiting so a
  // replacement process cannot consume the old process's shutdown budget.
  if (settle && children.length) {
    remaining.push(...await settle(children, SHUTDOWN_BUDGET_MS - (Date.now() - begun), begun));
  } else {
    while ((children = children.filter(alive)).length) {
      if (Date.now() - begun >= SHUTDOWN_BUDGET_MS) { remaining.push(...children); break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  if (remaining.length)
    throw Object.assign(new Error(`Chromium processes did not exit: ${remaining.join(', ')}`), {
      code: 'SHUTDOWN_TIMEOUT',
      open: remaining.map((pid) => `Chromium process ${pid}`),
    });
}

/**
 * Makes `browser.close()` a bounded teardown (bug 70): it throws `SHUTDOWN_TIMEOUT` naming the browser if the close has
 * not finished within the shared budget (scripts/support/shutdown.mjs), instead of leaving a suite that has passed every
 * assertion hanging on its cleanup. A Chromium-family browser's processes are ended first (see `endChromium`); one this
 * module launched (`launchBrowser`) is ended through its own process handle (`stop`, default `stopOwned`).
 */
export function withBoundedClose(
  browser,
  { end = endTree, server = ownedBrowserServers.get(browser), platform = process.platform, stop = stopOwned, budgetMs = SHUTDOWN_BUDGET_MS } = {},
) {
  if (typeof browser?.close !== 'function') return browser;
  const close = browser.close.bind(browser);
  browser.close = (...args) => {
    const pending = new Set();
    browser[SHUTDOWN_STEPS] = pending;
    const step = async (name, run) => {
      pending.add(name);
      try { return await run(); } finally { pending.delete(name); }
    };
    return closeAll({
      budgetMs,
      browser: {
        [SHUTDOWN_STEPS]: pending,
        close: async () => {
          if (server) {
            const child = server.process?.();
            // Listing needs a connected client. Finish this read before close() can
            // disconnect its CDP session, then terminate and clean up concurrently.
            const pids = platform === 'win32' && child?.pid && child.exitCode === null && child.signalCode === null
              ? await step('Chromium process listing', () => listOwnedPids(browser, LIST_PROCESSES_MS)) : undefined;
            // Windows driver kill uses synchronous taskkill: calling it on a live process blocks even
            // the shutdown timer. End the owned process first, then finish driver cleanup.
            const terminate = async () => {
              if (platform === 'win32' && child?.pid) {
                const running = child.exitCode === null && child.signalCode === null;
                let onClose;
                const tracked = ownedProcessCloses.get(server);
                const closed = tracked ?? new Promise((resolve) => child.once('close', (onClose = resolve)));
                try {
                  // Ended through the process handle this Node process holds (TerminateProcess, via libuv) and the
                  // pids Chromium lists, never through a helper program started at close time: taskkill.exe reads
                  // the process table through WMI and PowerShell needs a console, both of which stall or fail on
                  // this PC under load and around GPU driver resets. A helper that could not run reported nothing
                  // killed, the browser kept running, and the close waited the whole budget. See `stopOwned`.
                  // ChildProcess 'exit' does not close its stdio. Playwright's kill API is safe only
                  // after 'close', which marks the driver process closed. Release every owned pipe,
                  // including Chromium's two CDP pipes, then wait for 'close' (the process handle signalled).
                  const pipes = child.stdio ?? [child.stdin, child.stdout, child.stderr];
                  const openPipes = pipes.some((pipe) => pipe && !pipe.closed);
                  let stopped;
                  try {
                    // Termination completion can depend on canceling pending pipe I/O. Request it,
                    // release the pipes, then await it; waiting before release creates a circular wait.
                    stopped = running ? step(`Chromium process termination (${child.pid}; children ${(pids ?? []).filter(pid => pid !== child.pid).join(', ')})`, () => stop(child, browser, { end, pids })) : undefined;
                  } finally {
                    for (const pipe of pipes) pipe?.destroy();
                  }
                  await stopped;
                  if (tracked || running || openPipes) await step(`Chromium process/stdio close (${child.pid})`, () => closed);
                } finally {
                  if (onClose) child.removeListener('close', onClose);
                }
              }
              await step('Playwright server kill', () => server.kill());
            };
            const results = await Promise.allSettled([
              Promise.resolve().then(terminate),
              Promise.resolve().then(() => step('Playwright client close', () => close(...args))),
            ]);
            for (const result of results) if (result.status === 'rejected') throw result.reason;
            return;
          }
          // An end that fails (its CDP session refused, say) still closes the ordinary way, then throws: a browser left
          // running holds its suite's process open after the last check, and the run around it never ends.
          let failed;
          try {
            await endChromium(browser, end);
          } catch (error) {
            failed = { error };
          }
          await close(...args);
          if (failed) throw failed.error;
        },
      },
    });
  };
  return browser;
}

/** Exit code when the requested browser cannot be started (not a test failure, not a skip). */
export const LAUNCH_FAILED = 3;

/** The command or step that makes `browser` available, for the launch-failure message. */
function installHint(browser) {
  if (browser.executablePath)
    return `check that BROWSER_EXECUTABLE=${browser.executablePath} points at a working browser`;
  if (browser.name === 'firefox') return 'run: npx playwright install firefox';
  if (browser.name === 'webkit') return 'run: npx playwright install webkit';
  if (browser.name === 'chromium') return 'run: npx playwright install chromium';
  if (browser.name === 'chrome')
    return 'install Google Chrome (https://www.google.com/chrome/), or run: npx playwright install chrome';
  return 'install Microsoft Edge (https://www.microsoft.com/edge), or run: npx playwright install msedge';
}

/** One short message for a browser that would not start: which browser, how to install it, and how to pick another. No stack trace. */
export function launchFailureMessage(browser, error, { suite } = {}) {
  const first = String(error?.message ?? error)
    .split('\n')[0]
    .replace(/^browserType\.launch:\s*/, '');
  return [
    `${suite ? `${suite}: ` : ''}cannot start ${browser.name}: ${first}`,
    `To fix it, ${installHint(browser)}. To use another browser, set MARGO_BROWSER to edge, chrome, chromium, firefox or webkit (or pass --browser=<name>).`,
  ].join('\n');
}

/**
 * Launches the chosen browser. Playwright launch options (headless, args, ...) pass through; the channel, the
 * executable and the WebGPU switches come from {@link resolveBrowser}. A step the browser cannot run is skipped with a
 * clear line (see {@link skipSuite}). Options: `name` (force a browser), `needs` ('webgpu' | 'chromium' | 'none').
 * With nothing chosen on Windows and Edge missing, falls back to Playwright's Chromium as before.
 */
export async function launchBrowser({
  name,
  needs = 'webgpu',
  args = [],
  env,
  platform,
  argv,
  launchers = { chromium, firefox, webkit },
  report = console.error,
  exit = process.exit,
  ...options
} = {}) {
  const browser = resolveBrowser({ name, env, platform, argv }),
    reason = unsupportedReason(browser, needs);
  if (reason) return skipSuite(reason);
  try {
    if (browser.engine !== 'chromium') return withBoundedClose(await launchers[browser.engine].launch({ ...options }));
    const launch = async (channel) => {
      const settings = {
        ...options,
        args: launchArgs(browser, args),
        ...(channel ? { channel } : {}),
        ...(browser.executablePath ? { executablePath: browser.executablePath } : {}),
      };
      // launchServer exposes explicit process ownership and an immediate kill API.
      if (typeof launchers.chromium.launchServer === 'function') {
        const server = await launchers.chromium.launchServer({...settings, host: '127.0.0.1'});
        const child = server.process?.();
        if (child && child.exitCode === null && child.signalCode === null)
          ownedProcessCloses.set(server, new Promise((resolve) => child.once('close', resolve)));
        let browser;
        try {
          browser = await launchers.chromium.connect(server.wsEndpoint(), {timeout: 30_000});
        } catch (error) {
          await server.kill();
          throw error;
        }
        ownedBrowserServers.set(browser, server);
        return browser;
      }
      return await launchers.chromium.launch(settings);
    };
    try {
      return withBoundedClose(await launch(browser.channel));
    } catch (error) {
      if (browser.explicit || browser.channel !== 'msedge') throw error;
      return withBoundedClose(await launch(undefined));
    }
  } catch (error) {
    report(launchFailureMessage(browser, error, { suite: process.argv[1]?.split(/[\\/]/).pop() }));
    return exit(LAUNCH_FAILED);
  }
}
