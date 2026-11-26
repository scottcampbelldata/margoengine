// margo-convert mobile: a tiny built app becomes a Capacitor project (config JSON, package.json with the Capacitor
// packages named and not installed, webDir with the app, viewport-fit=cover and the runtime injected); a bad appId is
// refused with a coded error; the safe-area runtime fits the canvas inside emulated insets in headless Chromium; the CLI
// writes the same project.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { buildMobile, injectMobile, isAppId } from '../tools/margo-convert/pipeline/mobile.js';
import { launchBrowser } from '../scripts/lib/browser.mjs';
import { closeAll } from '../scripts/support/shutdown.mjs';

const dir = mkdtempSync(join(tmpdir(), 'margo-mobile-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const write = (/** @type {string} */ path, /** @type {string} */ data) => {
  mkdirSync(resolve(dir, path, '..'), { recursive: true });
  writeFileSync(resolve(dir, path), data);
};
write(
  'app/index.html',
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fixture</title></head><body><canvas id="c"></canvas><script type="module" src="./main.js"></script></body></html>`,
);
write('app/main.js', 'document.body.dataset.app = "ran";\n');
write('app/assets/level.json', '{"level":7}');
write('app/main.js.map', '{}');
write('app/.secret', 'no');
write('icon.png', 'png-bytes');
const out = join(dir, 'out');
const options = { input: join(dir, 'app'), out, appId: 'com.example.game', appName: 'Space Game' };
const json = (/** @type {string} */ p) => JSON.parse(readFileSync(resolve(out, p), 'utf8'));

test('the project has the config, a package.json that is not installed, and the app in webDir', async () => {
  const report = await buildMobile({
    ...options,
    orientation: 'landscape',
    backgroundColor: '#123',
    statusBar: { style: 'dark', backgroundColor: '#000' },
    splash: { duration: 900 },
    icon: join(dir, 'icon.png'),
  });
  const config = json('capacitor.config.json');
  assert.equal(config.appId, 'com.example.game');
  assert.equal(config.appName, 'Space Game');
  assert.equal(config.webDir, 'www');
  assert.equal(config.backgroundColor, '#112233');
  assert.deepEqual(config.plugins.StatusBar, { style: 'DARK', backgroundColor: '#000000' });
  assert.deepEqual(config.plugins.SplashScreen, { backgroundColor: '#112233', launchShowDuration: 900 });
  assert.equal(config.margo.orientation, 'landscape');
  assert.equal(config.margo.androidScreenOrientation, 'sensorLandscape');
  const pkg = json('package.json');
  for (const n of ['core', 'cli', 'android', 'ios']) assert.match(pkg.dependencies[`@capacitor/${n}`], /^\^\d/);
  assert.equal(existsSync(resolve(out, 'node_modules')), false, 'nothing is installed');
  assert.equal(existsSync(resolve(out, 'android')) || existsSync(resolve(out, 'ios')), false, 'no native folders');
  for (const f of ['index.html', 'main.js', 'assets/level.json', 'margo-mobile-runtime.js'])
    assert.ok(existsSync(resolve(out, 'www', f)), f);
  assert.equal(existsSync(resolve(out, 'www', 'main.js.map')) || existsSync(resolve(out, 'www', '.secret')), false);
  assert.equal(readFileSync(resolve(out, 'resources/icon.png'), 'utf8'), 'png-bytes');
  const html = readFileSync(resolve(out, 'www/index.html'), 'utf8');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(html, /startMobile\(\{ orientation: "landscape"/);
  assert.match(readFileSync(resolve(out, 'README.md'), 'utf8'), /cap add android[\s\S]*UIInterfaceOrientationLandscapeLeft/);
  assert.ok(report.files.includes('capacitor.config.json') && report.files.includes('www/index.html'));
});

test('a bad appId, orientation or input is refused with a coded error', async () => {
  for (const appId of ['game', 'com.1bad.game', 'com..game', 'com.example.my-game', '', undefined])
    await assert.rejects(buildMobile({ ...options, appId }), (error) => {
      assert.equal(error.name, 'MargoError');
      assert.equal(error.code, 'failed');
      assert.match(error.message, /margoengine\.com\/errors#mobile/);
      return true;
    });
  assert.ok(isAppId('com.example.game_2') && !isAppId('com.example'.concat('.')));
  await assert.rejects(buildMobile({ ...options, orientation: 'sideways' }), RangeError);
  await assert.rejects(buildMobile({ ...options, backgroundColor: 'red' }), RangeError);
  await assert.rejects(buildMobile({ ...options, input: join(dir, 'nope') }), { code: 'failed' });
  await assert.rejects(buildMobile({ ...options, out: join(dir, 'app', 'inside') }), { code: 'failed' });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(buildMobile({ ...options, signal: ac.signal }), { name: 'AbortError' });
});

test('viewport-fit=cover replaces an old value and is added where no viewport meta exists', () => {
  assert.match(
    injectMobile('<head><meta name=viewport content="width=device-width, viewport-fit=auto"></head><body></body>', 'any', false),
    /content="width=device-width, viewport-fit=cover"/,
  );
  const bare = injectMobile('<p>hi</p>', 'portrait', 'canvas');
  assert.match(bare, /viewport-fit=cover/);
  assert.match(bare, /document\.querySelector\("canvas"\)/);
});

test('the runtime fits the canvas inside the safe area and follows rotation, in Chromium', { timeout: 120_000 }, async () => {
  const www = resolve(out, 'www');
  const browser = await launchBrowser({ headless: true, needs: 'none' });
  const contexts = [];
  try {
    const context = await browser.newContext({ viewport: { width: 400, height: 800 }, deviceScaleFactor: 2 });
    contexts.push(context);
    await context.route('https://mobile.test/**', (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/$/, '/index.html');
      const file = resolve(www, `.${path}`);
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const type = { '.html': 'text/html', '.js': 'text/javascript' }[extname(file)] ?? 'application/octet-stream';
      return route.fulfill({ body: readFileSync(file), contentType: type });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 40, bottom: 30, left: 10, right: 20 } });
    await page.goto('https://mobile.test/');
    await page.waitForFunction(() => document.body.dataset.app === 'ran');
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--safe-area-top') !== '');
    const read = () =>
      page.evaluate(() => {
        const c = document.getElementById('c');
        const s = document.documentElement.style;
        return {
          vars: ['top', 'right', 'bottom', 'left'].map((k) => s.getPropertyValue(`--safe-area-${k}`)),
          css: [c.style.left, c.style.top, c.style.width, c.style.height],
          buffer: [c.width, c.height],
        };
      });
    assert.deepEqual(await read(), {
      vars: ['40px', '20px', '30px', '10px'],
      css: ['10px', '40px', '370px', '730px'],
      buffer: [740, 1460],
    });
    assert.deepEqual(await page.evaluate(async () => (await import('./margo-mobile-runtime.js')).getSafeArea()), {
      top: 40,
      right: 20,
      bottom: 30,
      left: 10,
    });
    // Rotation: a wider viewport and landscape insets.
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 20, left: 44, right: 44 } });
    await page.setViewportSize({ width: 800, height: 400 });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--safe-area-left') === '44px');
    assert.deepEqual(await read(), {
      vars: ['0px', '44px', '20px', '44px'],
      css: ['44px', '0px', '712px', '380px'],
      buffer: [1424, 760],
    });
    assert.deepEqual(errors, []);
  } finally {
    await closeAll({ context: contexts.pop(), browser });
  }
});

test('the CLI writes the project and rejects a bad appId', () => {
  const cli = resolve('tools/margo-convert/cli.js'),
    cliOut = join(dir, 'cli-out');
  execFileSync(process.execPath, [
    cli, 'mobile', join(dir, 'app'), '--app-id', 'org.margo.demo', '--out', cliOut, '--orientation', 'portrait', '--quiet',
  ]);
  assert.equal(JSON.parse(readFileSync(join(cliOut, 'capacitor.config.json'), 'utf8')).appId, 'org.margo.demo');
  assert.throws(
    () => execFileSync(process.execPath, [cli, 'mobile', join(dir, 'app'), '--app-id', 'nope', '--out', cliOut], { stdio: 'pipe' }),
    (error) => error.status === 1 && /not a reverse-DNS id/.test(String(error.stderr)),
  );
});
