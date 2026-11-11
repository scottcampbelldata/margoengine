import { chromium, firefox, webkit } from '@playwright/test';
import { gpuAdapterArg } from './gpu-adapter.mjs';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { closeAll, endTree, traceShutdown, SHUTDOWN_BUDGET_MS, SHUTDOWN_STEPS } from '../support/shutdown.mjs';
import { HOST_LOG, HOST_PATH, REAP_MS } from '../support/browser-host.mjs';

/** The browser host (startHost) of each browser this module launched. */
const ownedHosts = new WeakMap();

/**
 * Which browser the repository's browser checks drive, and how it is launched, in one place.
 *
 *   MARGO_BROWSER=edge|chrome|chromium|firefox|webkit   default: edge on Windows (the long-standing behaviour), chromium
 *                                                elsewhere (Playwright's own build, so a Linux server needs no Edge)
 *   --browser=<name> on a suite's command line   same values; the legacy names msedge and bundled still work
 *   BROWSER_CHANNEL=msedge|chrome|bundled        older spelling, used when MARGO_BROWSER is not set
 *   BROWSER_EXECUTABLE=<path>                    launch this binary instead of the named browser's install (Chromium
 *                                                family and Firefox)
 *   MARGO_GPU=default|nvidia|amd|intel           which GPU on a Windows PC with two (see gpu-adapter.mjs); unset picks the
 *                                                hardware adapter with the most video memory, default adds no flag
 *   MARGO_GPU_LUID=high,low                      use exactly this adapter (decimal)
 *   MARGO_SOFTWARE_GPU=1                         use SwiftShader (a software WebGPU adapter) on a machine without a
 *                                                real GPU; slow, and its pixels differ from a real GPU's
 *
 * Firefox is Playwright's own Firefox build. Its WebGPU is off by default and blocklisted on many GPUs, so it is launched
 * with FIREFOX_WEBGPU_PREFS, and headed for a step that needs WebGPU: headless, it answers requestAdapter() with null
 * ("WebGPU is disabled by blocklist") whatever the prefs say. A forced-compatibility run (MARGO_COMPAT=1) runs too.
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
    webgpu: true,
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
 * How long a close waits for the host's word that the ended processes are gone before it moves on without it. Not a
 * budget: nothing fails when it runs out. The host keeps waiting (`REAP_MS`) and records any survivor in `HOST_LOG`.
 * Measured exits after `TerminateProcess` on the dev PC: 65 ms to 1.2 s beside the batches, 8.7 s beside `verify`.
 */
export const TEARDOWN_GRACE_MS = 2_000;

/**
 * Starts a browser host (scripts/support/browser-host.mjs) with Playwright's launch `settings` and resolves once it
 * reports the server's endpoint. The host owns every wait on the browser process (its handle, pipes, WebSocket server
 * and temporary profile), so this process never waits on the kernel's teardown of a browser it has ended; see the
 * host for the measurements. Resolves to `{ pid, wsEndpoint, process, end(children), finished(), release() }`:
 * `end` tells the host to end the browser and its listed `children` (`null`: the whole tree by helper program) and
 * resolves once each has been told to; `finished` resolves to the host's result (`survivors`); `release` lets this
 * process end without the host. A host that ends before it answers rejects with code `HOST_GONE`.
 */
export async function startHost(settings, { spawnProcess = spawn, hostPath = HOST_PATH, env = process.env } = {}) {
  const child = spawnProcess(process.execPath, [hostPath, JSON.stringify(settings)], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
    env,
  });
  const waiting = [];
  let gone = null,
    released = false;
  const next = () =>
    new Promise((resolve, reject) => {
      if (gone) reject(gone);
      else if (released) resolve(null);
      else waiting.push({ resolve, reject });
    });
  const fail = (reason) => {
    gone = reason;
    for (const waiter of waiting.splice(0)) waiter.reject(reason);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    waiting.shift()?.resolve(message);
  });
  // A host that is gone has ended its stdout; its process 'exit' can arrive before its last line has been read.
  let ended = null;
  child.once('exit', (code, signal) => (ended = signal ?? code));
  lines.once('close', () => {
    if (!released)
      fail(Object.assign(new Error(`browser host ${child.pid} ended (${ended ?? 'stdout closed'}) before it answered`), { code: 'HOST_GONE' }));
  });
  child.once('error', (error) => fail(error));
  const release = () => {
    released = true;
    for (const waiter of waiting.splice(0)) waiter.resolve(null);
    lines.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.unref();
  };
  let ready;
  try {
    ready = await next();
  } catch (error) {
    release();
    throw error;
  }
  if (!ready?.ready) {
    release();
    throw new Error(ready?.error ?? 'browser host answered without an endpoint');
  }
  return {
    pid: ready.pid,
    wsEndpoint: ready.wsEndpoint,
    process: child,
    async end(children) {
      child.stdin.write(`${JSON.stringify({ end: true, children })}\n`);
      const answer = await next();
      if (!answer?.terminated) throw new Error(`browser host ${child.pid} did not acknowledge the end: ${JSON.stringify(answer)}`);
      return answer.terminated;
    },
    finished: next,
    release,
  };
}

/**
 * Makes `browser.close()` a bounded teardown (bug 70): it throws `SHUTDOWN_TIMEOUT` naming the step still open if the
 * close has not finished within the shared budget (scripts/support/shutdown.mjs), instead of leaving a suite that has
 * passed every assertion hanging on its cleanup. A Chromium-family browser's processes are ended first (see
 * `endChromium`); one this module launched (`launchBrowser`) is ended through its host (`startHost`): the processes
 * Chromium lists are read while the client is still connected, the host ends them all and acknowledges, the client
 * disconnects, and the kernel's teardown of the ended processes is waited for only up to `graceMs`. Past that the
 * host carries on alone (it records a survivor after `REAP_MS`) and the suite moves on: a browser process the kernel
 * is still tearing down after `TerminateProcess` can hold nothing of the suite's any more.
 */
export function withBoundedClose(
  browser,
  { end = endTree, host = ownedHosts.get(browser), graceMs = TEARDOWN_GRACE_MS, listMs = LIST_PROCESSES_MS, budgetMs = SHUTDOWN_BUDGET_MS, report = console.error } = {},
) {
  if (typeof browser?.close !== 'function') return browser;
  const close = browser.close.bind(browser);
  // One close per browser, as Playwright's own close: a second call gets the first one's outcome. A second call used to
  // ask a host the first had already released to end again, and threw `did not acknowledge the end: null` (KB1898,
  // check:readme-run after an example's deadline close and its shared browser's close at the end of the run).
  let closing;
  browser.close = (...args) => (closing ??= boundedClose(...args));
  const boundedClose = (...args) => {
    const pending = new Set();
    browser[SHUTDOWN_STEPS] = pending;
    const step = async (name, run) => {
      pending.add(name);
      try {
        return await traceShutdown(name, run);
      } finally {
        pending.delete(name);
      }
    };
    return closeAll({
      budgetMs,
      browser: {
        [SHUTDOWN_STEPS]: pending,
        close: async () => {
          if (host) {
            let outcome;
            try {
              // Listing needs a connected client: read it before close() can disconnect its CDP session.
              const pids = await step('Chromium process listing', () => listOwnedPids(browser, listMs));
              const children = pids ? pids.filter((pid) => pid !== host.pid) : null;
              const results = await Promise.allSettled([
                step(`Chromium process termination (${host.pid}; children ${children ? children.join(', ') || 'none' : 'unlisted, whole tree'})`, () =>
                  host.end(children),
                ),
                step('Playwright client close', () => close(...args)),
              ]);
              for (const result of results) if (result.status === 'rejected') throw result.reason;
              let timer;
              outcome = await step(`Chromium process teardown (${host.pid})`, () =>
                Promise.race([host.finished(), new Promise((resolve) => (timer = setTimeout(resolve, graceMs, null)))]),
              );
              clearTimeout(timer);
            } finally {
              // On every path: a host left referenced would hold the suite open after its last check.
              host.release();
            }
            if (!outcome)
              report(
                `browser host ${host.process?.pid}: Chromium ${host.pid} was ended but the kernel had not finished tearing it down ${graceMs} ms later; the host waits up to ${REAP_MS} ms and records a survivor in ${HOST_LOG}`,
              );
            else if (outcome.survivors?.length)
              throw Object.assign(new Error(`Chromium processes did not exit: ${outcome.survivors.join(', ')}`), {
                code: 'SHUTDOWN_TIMEOUT',
                open: outcome.survivors.map((pid) => `Chromium process ${pid}`),
              });
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

/** The prefs that turn Firefox's WebGPU on and past its GPU blocklist (Playwright's Firefox has it off by default). */
export const FIREFOX_WEBGPU_PREFS = Object.freeze({ 'dom.webgpu.enabled': true, 'gfx.webgpu.ignore-blocklist': true });

/**
 * The real path of Playwright's Firefox, or undefined. A process of an MSIX-packaged app on Windows (the Claude
 * desktop app, for one) sees %LOCALAPPDATA% through the package's file-system redirection: Playwright installed the
 * browser into the package's private LocalCache folder, and every path under %LOCALAPPDATA%\ms-playwright opens there.
 * Windows builds Firefox's side-by-side activation context (firefox.exe names mozglue as a private assembly) from the
 * path it was started with, outside that redirection, finds no mozglue.dll beside it and refuses to start it:
 * `spawn UNKNOWN`, event log "Dependent Assembly mozglue ... could not be found". Started by its real path it runs.
 * Elsewhere the real path is the same path.
 */
export function firefoxExecutable(launcher, { realpath = realpathSync.native } = {}) {
  let path;
  try {
    path = launcher?.executablePath?.();
  } catch {
    return undefined;
  }
  if (!path) return undefined;
  try {
    return realpath(path);
  } catch {
    // Not installed: Playwright's own launch reports the missing executable and launchFailureMessage names the install.
    return path;
  }
}

/**
 * Launch options for Playwright's Firefox: the caller's options with FIREFOX_WEBGPU_PREFS under the caller's own
 * `firefoxUserPrefs`, headed when the step needs WebGPU (headless Firefox has none), and the executable: the caller's
 * `executablePath`, else BROWSER_EXECUTABLE, else Playwright's install by its real path (see firefoxExecutable).
 */
export function firefoxLaunchOptions(browser, options = {}, { needs = 'webgpu', launcher, realpath } = {}) {
  const executablePath = options.executablePath ?? browser.executablePath ?? firefoxExecutable(launcher, { realpath });
  return {
    ...options,
    ...(needs === 'webgpu' ? { headless: false } : {}),
    firefoxUserPrefs: { ...FIREFOX_WEBGPU_PREFS, ...options.firefoxUserPrefs },
    ...(executablePath ? { executablePath } : {}),
  };
}

/**
 * The real path of Playwright's full Chromium, for a headed start, or undefined (see firefoxExecutable for the cause:
 * chrome.exe fails the same way from a packaged app's redirected %LOCALAPPDATA%). Used only when nothing else names the
 * executable and no channel is chosen; headless Playwright keeps its own headless shell, which starts there.
 */
export function chromiumExecutable(launcher, options) {
  return firefoxExecutable(launcher, options);
}

/**
 * The launch settings' `executablePath` for Playwright's own Chromium: the caller's or BROWSER_EXECUTABLE (already in
 * `browser.executablePath`) first; else, when headed with no channel, the real path of Playwright's install.
 */
export function chromiumExecutablePath(browser, channel, options = {}, { launcher, realpath } = {}) {
  if (options.executablePath) return options.executablePath;
  if (browser.executablePath) return browser.executablePath;
  if (channel || options.headless !== false) return undefined;
  return chromiumExecutable(launcher, { realpath });
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
  hosting = startHost,
  report = console.error,
  exit = process.exit,
  ...options
} = {}) {
  const browser = resolveBrowser({ name, env, platform, argv }),
    reason = unsupportedReason(browser, needs);
  if (reason) return skipSuite(reason);
  try {
    if (browser.engine === 'firefox')
      return withBoundedClose(
        await launchers.firefox.launch(firefoxLaunchOptions(browser, options, { needs, launcher: launchers.firefox })),
      );
    if (browser.engine !== 'chromium') return withBoundedClose(await launchers[browser.engine].launch({ ...options }));
    const launch = async (channel) => {
      const settings = {
        ...options,
        args: launchArgs(browser, args),
        ...(channel ? { channel } : {}),
      };
      const executablePath = chromiumExecutablePath(browser, channel, options, { launcher: launchers.chromium });
      if (executablePath) settings.executablePath = executablePath;
      // A Chromium this module owns runs under a browser host of its own (scripts/support/browser-host.mjs), which holds
      // the process and everything that waits on it; this process only connects to it.
      if (hosting && typeof launchers.chromium.connect === 'function') {
        const host = await hosting({ ...settings, host: '127.0.0.1' });
        let browser;
        try {
          browser = await launchers.chromium.connect(host.wsEndpoint, { timeout: 30_000 });
        } catch (error) {
          let ending;
          try {
            await host.end(null);
          } catch (endError) {
            ending = endError;
          } finally {
            host.release();
          }
          throw ending ? new Error(`${error.message}; and ending its host failed: ${ending.message}`, { cause: error }) : error;
        }
        ownedHosts.set(browser, host);
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

