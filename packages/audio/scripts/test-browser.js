import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results');
await mkdir(results, { recursive: true });
const server = await createServer({
  configFile: resolve(root, 'vite.config.js'),
  logLevel: 'error',
  server: { port: 0 },
});
await server.listen();
let browser;
try {
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  // Sound must be able to start without a click for the live checks; the gesture check clicks for real anyway.
  if (!args.includes('--autoplay-policy=no-user-gesture-required'))
    args.push('--autoplay-policy=no-user-gesture-required');
  browser = await launchBrowser({
    headless: true,
    args,
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico'))
      errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`${server.resolvedUrls.local[0]}tests/audio.html`);
  await page.waitForFunction(() => typeof window.runOfflineTests === 'function');
  // Each page call has a hard limit and a name (KB5029b: a run sat 211 s in one of these with nothing named, until the
  // GPU monitor reclaimed it). Far past what each takes (9 s for the whole suite on the dev PC, 2026-11-11). On a
  // stall the AudioContext states the page can see are printed with the step's name.
  const CALL_LIMIT = 60_000;
  const call = async (name, run) => {
    let timer;
    try {
      return await Promise.race([
        page.evaluate(run),
        new Promise((_, reject) => {
          timer = setTimeout(async () => {
            const states = await Promise.race([
              page.evaluate(() => JSON.stringify(window.__audioStates?.() ?? 'no state probe')).catch((e) => String(e)),
              new Promise((resolve) => setTimeout(resolve, 5000, 'page did not answer')),
            ]);
            reject(new Error(`audio browser step ${name} took over ${CALL_LIMIT / 1000} s; page: ${states}`));
          }, CALL_LIMIT);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const report = { checks: [] };
  report.offline = await call('runOfflineTests', () => window.runOfflineTests());
  report.checks.push(...report.offline.checks);
  report.engine = await call('runEngineTests', () => window.runEngineTests());
  report.checks.push(...report.engine.checks);
  report.occlusion = await call('runOcclusionTests', () => window.runOcclusionTests());
  report.doppler = await call('runDopplerTests', () => window.runDopplerTests());
  report.events = await call('runEventTests', () => window.runEventTests());
  report.music = await call('runMusicTests', () => window.runMusicTests());
  report.zones = await call('runZoneTests', () => window.runZoneTests());
  report.ambisonics = await call('runAmbisonicTests', () => window.runAmbisonicTests());
  report.pan = await call('runPanTests', () => window.runPanTests());
  report.binaural = await call('runBinauralTests', () => window.runBinauralTests());
  report.voices = await call('runVoiceManagerTests', () => window.runVoiceManagerTests());
  report.sprites = await call('runSpriteTests', () => window.runSpriteTests());
  assert.equal(await call('prepareGesture', () => window.prepareGesture()), 'suspended');
  await page.mouse.click(20, 20);
  assert.equal(await call('checkGesture', () => window.checkGesture()), 'running');
  report.checks.push('A suspended context resumes on the first real pointer gesture');
  report.browser = browser.version();
  assert.deepEqual(errors, []);
  await writeFile(resolve(results, 'audio-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await closeAll({ browser, servers: [server] });
}
