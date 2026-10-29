// Cold loads of the production site's demos (formerly scripts/benchmark-demo-loads.js), for the startup suite: a fresh
// browser per sample, cache disabled, CPU and network throttled by a load profile (LOAD_PROFILE, default
// phone-layout-cold), measured by scripts/demo-load-audit.js in the page. Phone layouts still use the host GPU, not a
// physical phone. Needs site/dist (`npm run build:site`); a snapshot is served so a concurrent rebuild cannot race it.
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { launchBrowser } from '../../scripts/lib/browser.mjs';
import { preview } from 'vite';
import { installDemoLoadAudit } from '../../scripts/demo-load-audit.js';
import { root } from './env.mjs';
import { closeAll } from '../../scripts/support/shutdown.mjs';

export const DEMOS = [
  '/night-citadel/',
  '/gameplay-sandbox/',
  '/demos/flight-helmet.html',
  '/demos/character-animation.html',
  '/demos/robot-expressive.html',
  '/demos/windy-meadow.html',
  '/demos/earth/',
  '/demos/dof/',
  '/demos/tonemap/',
];
export const PROFILES = {
  'phone-layout-cold': {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    cpuSlowdown: 4,
    latencyMs: 40,
    downloadMbps: 10,
    headless: true,
    mobile: true,
    channel: 'msedge',
  },
  'native-chrome-cold': {
    viewport: null,
    cpuSlowdown: 1,
    latencyMs: 40,
    downloadMbps: 10,
    headless: false,
    mobile: false,
    channel: 'chrome',
  },
  'android-layout-fast-4g': {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    cpuSlowdown: 1,
    latencyMs: 150,
    downloadMbps: 1.6,
    headless: true,
    mobile: true,
    channel: 'chrome',
  },
};

/** Serves a snapshot of site/dist; null when the site is not built. */
export async function serveSite() {
  if (!existsSync(resolve(root, 'site/dist/index.html'))) return null;
  const output = resolve(root, 'test-results'),
    snapshot = await mkdtemp(resolve(output, 'demo-load-site-'));
  if (!snapshot.startsWith(output + sep)) throw new Error('demo loads: snapshot outside test-results');
  await cp(resolve(root, 'site/dist'), snapshot, { recursive: true });
  const server = await preview({
    configFile: false,
    root: snapshot,
    build: { outDir: '.' },
    logLevel: 'error',
    preview: { host: '127.0.0.1', port: 0 },
  });
  return {
    origin: server.resolvedUrls.local[0],
    async close() {
      await closeAll({ servers: [server] });
      await rm(snapshot, { recursive: true, force: true });
    },
  };
}

/** One cold load of `path` under `profile`: first frame, ready and full-scene times (ms from navigation). */
export async function loadDemo(origin, path, profile) {
  const browser = await launchBrowser({
    name: process.env.MARGO_BROWSER ?? process.env.BROWSER_CHANNEL ?? profile.channel,
    headless: profile.headless,
    args: profile.headless
      ? []
      : [
          '--start-maximized',
          '--disable-features=CalculateNativeWinOcclusion',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-background-timer-throttling',
        ],
  });
  try {
    const context = await browser.newContext({
      viewport: profile.viewport,
      ...(profile.mobile
        ? {
            deviceScaleFactor: profile.deviceScaleFactor,
            isMobile: true,
            hasTouch: true,
            userAgent:
              'Mozilla/5.0 (Linux; Android 15; Test layout) AppleWebKit/537.36 Chrome/154.0.0.0 Mobile Safari/537.36',
          }
        : {}),
    });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
    await page.addInitScript(installDemoLoadAudit);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuSlowdown });
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: profile.latencyMs,
      downloadThroughput: profile.downloadMbps * 125000,
      uploadThroughput: 625000,
    });
    await page.goto(new URL(path, origin).href);
    await page
      .waitForFunction(() => window.demoLoad.principalScenePresentedOpportunity > 0, null, { timeout: 60000 })
      .catch(async (reason) => {
        const state = await page.evaluate(() => ({
          ...window.demoLoad,
          status: document.querySelector('#status')?.textContent,
          error: document.querySelector('#error')?.textContent,
        }));
        throw new Error(`${path} failed to render: ${JSON.stringify({ errors, state })}`, { cause: reason });
      });
    const timing = await page.evaluate(() => ({
      ...window.demoLoad,
      external: performance
        .getEntriesByType('resource')
        .filter((r) => new URL(r.name).origin !== location.origin)
        .map((r) => r.name),
      transferBytes: performance.getEntriesByType('resource').reduce((s, r) => s + r.transferSize, 0),
    }));
    if (errors.length) throw new Error(`${path} reported a browser error: ${errors[0]}`);
    if (timing.external.length) throw new Error(`${path} fetched an external resource: ${timing.external[0]}`);
    return timing;
  } finally {
    await browser.close();
  }
}
