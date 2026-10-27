import { chromium, firefox } from '@playwright/test';

/**
 * Which browser the repository's browser checks drive, and how it is launched, in one place.
 *
 *   MARGO_BROWSER=edge|chrome|chromium|firefox   default: edge on Windows (the long-standing behaviour), chromium
 *                                                elsewhere (Playwright's own build, so a Linux server needs no Edge)
 *   --browser=<name> on a suite's command line   same values; the legacy names msedge and bundled still work
 *   BROWSER_CHANNEL=msedge|chrome|bundled        older spelling, used when MARGO_BROWSER is not set
 *   BROWSER_EXECUTABLE=<path>                    launch this binary instead of the named browser's install
 *   MARGO_SOFTWARE_GPU=1                         use SwiftShader (a software WebGPU adapter) on a machine without a
 *                                                real GPU; slow, and its pixels differ from a real GPU's
 *
 * Firefox has no WebGPU in Playwright's builds, so a step that needs it is reported as skipped (never passed).
 */

const ALIASES = {
  edge: 'edge',
  msedge: 'edge',
  chrome: 'chrome',
  chromium: 'chromium',
  bundled: 'chromium',
  firefox: 'firefox',
};

/** The WebGPU switch a Chromium-family browser needs where WebGPU is not already on. */
const WEBGPU_ARGS = ['--enable-unsafe-webgpu'];
const LINUX_ARGS = ['--enable-features=Vulkan', '--use-angle=vulkan'];
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
 * @returns {{ name: 'edge'|'chrome'|'chromium'|'firefox', engine: 'chromium'|'firefox', channel: string|undefined,
 *   executablePath: string|undefined, webgpu: boolean, software: boolean, explicit: boolean, platform: string }}
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
    engine = picked === 'firefox' ? 'firefox' : 'chromium';
  return {
    name: picked,
    engine,
    channel: picked === 'edge' ? 'msedge' : picked === 'chrome' ? 'chrome' : undefined,
    executablePath: env.BROWSER_EXECUTABLE || undefined,
    webgpu: engine === 'chromium',
    software: env.MARGO_SOFTWARE_GPU === '1' || env.MARGO_SOFTWARE_GPU === 'true',
    explicit,
    platform,
  };
}

/** Command-line switches for the browser: WebGPU on where it is not on already, SwiftShader when asked for, then `extra`. */
export function launchArgs(browser, extra = [], { webgpu = true } = {}) {
  if (browser.engine !== 'chromium') return [];
  const args = [];
  if (!webgpu) return [...extra];
  if (browser.software) args.push(...SOFTWARE_ARGS);
  else if (browser.platform !== 'win32' || browser.name !== 'edge') {
    args.push(...WEBGPU_ARGS);
    if (browser.platform === 'linux') args.push(...LINUX_ARGS);
  }
  return [...new Set([...args, ...extra])];
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
 * Launches the chosen browser. Playwright launch options (headless, args, ...) pass through; the channel, the
 * executable and the WebGPU switches come from {@link resolveBrowser}. A step the browser cannot run is skipped with a
 * clear line (see {@link skipSuite}). Options: `name` (force a browser), `needs` ('webgpu' | 'chromium' | 'none').
 * With nothing chosen on Windows and Edge missing, falls back to Playwright's Chromium as before.
 */
export async function launchBrowser({ name, needs = 'webgpu', args = [], env, platform, argv, ...options } = {}) {
  const browser = resolveBrowser({ name, env, platform, argv }),
    reason = unsupportedReason(browser, needs);
  if (reason) return skipSuite(reason);
  if (browser.engine === 'firefox') return firefox.launch({ ...options });
  const launch = (channel) =>
    chromium.launch({
      ...options,
      args: launchArgs(browser, args),
      ...(channel ? { channel } : {}),
      ...(browser.executablePath ? { executablePath: browser.executablePath } : {}),
    });
  try {
    return await launch(browser.channel);
  } catch (error) {
    if (browser.explicit || browser.channel !== 'msedge') throw error;
    return launch(undefined);
  }
}
