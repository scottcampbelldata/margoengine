import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  browserLabel,
  chromiumLaunchOptions,
  LAUNCH_FAILED,
  launchBrowser,
  launchArgs,
  resolveBrowser,
  skipSuite,
  softwareAdapterReason,
  unsupportedReason,
} from '../scripts/lib/browser.mjs';

const pick = (env = {}, platform = 'win32', argv = []) => resolveBrowser({ env, platform, argv });

test('Windows defaults to Edge, as every browser check always did', () => {
  const browser = pick();
  assert.equal(browser.name, 'edge');
  assert.equal(browser.channel, 'msedge');
  assert.equal(browser.explicit, false);
  assert.deepEqual(launchArgs(browser, [], { gpu: () => undefined }), []);
  assert.equal(browserLabel({ env: {}, platform: 'win32', argv: [] }), 'msedge');
});

test('Linux and macOS default to Playwright chromium, never the msedge channel (regression: no /opt/microsoft/msedge)', () => {
  for (const platform of ['linux', 'darwin']) {
    const browser = pick({}, platform);
    assert.equal(browser.name, 'chromium');
    assert.equal(browser.channel, undefined);
    assert.ok(launchArgs(browser).includes('--enable-unsafe-webgpu'));
  }
  for (const flag of ['--enable-features=Vulkan', '--use-angle=vulkan'])
    assert.ok(launchArgs(pick({}, 'linux')).includes(flag), flag);
});

test('macOS asks ANGLE for Metal (regression: the headless shell got SwiftShader); Windows and Linux are unchanged', () => {
  assert.deepEqual(launchArgs(pick({}, 'darwin'), ['--x']), ['--enable-unsafe-webgpu', '--use-angle=metal', '--x']);
  assert.deepEqual(launchArgs(pick({ MARGO_BROWSER: 'chrome' }, 'darwin')), [
    '--enable-unsafe-webgpu',
    '--use-angle=metal',
  ]);
  assert.ok(!launchArgs(pick({ MARGO_SOFTWARE_GPU: '1' }, 'darwin')).includes('--use-angle=metal'));
  assert.deepEqual(launchArgs(pick({}, 'darwin'), [], { webgpu: false }), []);
  assert.ok(!launchArgs(pick({}, 'linux')).includes('--use-angle=metal'));
  assert.deepEqual(launchArgs(pick({}, 'linux')), [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--use-angle=vulkan',
  ]);
  assert.ok(!launchArgs(pick({ MARGO_BROWSER: 'chrome' }), [], { gpu: () => undefined }).includes('--use-angle=metal'));
});

test('a software or fallback WebGPU adapter is refused unless software was asked for', () => {
  const swift = { vendor: 'google', architecture: 'swiftshader', device: '', description: '', fallback: true };
  const metal = { vendor: 'apple', architecture: 'metal-3', device: '', description: '', fallback: false };
  const reason = softwareAdapterReason(pick({}, 'darwin'), swift);
  assert.match(reason, /software one .*swiftshader.* on darwin/);
  assert.match(softwareAdapterReason(pick({}, 'linux'), { ...swift, fallback: null }), /software/);
  assert.match(softwareAdapterReason(pick({}, 'linux'), { ...metal, fallback: true }), /software/);
  assert.equal(softwareAdapterReason(pick({}, 'darwin'), metal), null);
  assert.equal(softwareAdapterReason(pick({ MARGO_SOFTWARE_GPU: '1' }, 'linux'), swift), null);
  assert.equal(softwareAdapterReason(pick({}, 'linux'), null), null);
});

test('MARGO_BROWSER, --browser and the older BROWSER_CHANNEL pick the browser, in that order', () => {
  assert.equal(pick({ MARGO_BROWSER: 'chrome' }).channel, 'chrome');
  assert.equal(pick({ MARGO_BROWSER: 'FireFox' }).name, 'firefox');
  assert.equal(pick({ BROWSER_CHANNEL: 'msedge' }, 'linux').name, 'edge');
  assert.equal(pick({ BROWSER_CHANNEL: 'bundled' }).name, 'chromium');
  assert.equal(pick({ MARGO_BROWSER: 'chrome', BROWSER_CHANNEL: 'msedge' }).name, 'chrome');
  assert.equal(pick({ MARGO_BROWSER: 'chrome' }, 'win32', ['--browser=firefox']).name, 'firefox');
  assert.equal(resolveBrowser({ name: 'chrome', env: { MARGO_BROWSER: 'firefox' } }).name, 'chrome');
});

test('an unknown browser names the accepted values', () => {
  assert.throws(() => pick({ MARGO_BROWSER: 'safari' }), /MARGO_BROWSER to one of edge, chrome, chromium, firefox/);
});

const LUID = '--use-adapter-luid=0,79477';
const fakeGpu = () => LUID;

test('Edge on Windows adds only the adapter switch; Chrome and Chromium also get the WebGPU switch; BROWSER_EXECUTABLE passes through', () => {
  const gpu = fakeGpu;
  assert.deepEqual(launchArgs(pick({ MARGO_BROWSER: 'edge' }), ['--x'], { gpu }), [LUID, '--x']);
  assert.deepEqual(launchArgs(pick({ MARGO_BROWSER: 'chrome' }), ['--x'], { gpu }), [
    '--enable-unsafe-webgpu',
    LUID,
    '--x',
  ]);
  assert.deepEqual(launchArgs(pick({ MARGO_BROWSER: 'chromium' }), ['--x'], { gpu }), [
    '--enable-unsafe-webgpu',
    LUID,
    '--x',
  ]);
  assert.equal(pick({ BROWSER_EXECUTABLE: 'C:/b/chrome.exe' }).executablePath, 'C:/b/chrome.exe');
  assert.equal(pick({}).executablePath, undefined);
});

test('the adapter lookup runs only on Windows Chromium-family launches with WebGPU on and no SwiftShader (bug 33)', () => {
  let calls = 0;
  const gpu = () => (calls++, LUID);
  for (const platform of ['linux', 'darwin'])
    assert.ok(!launchArgs(pick({}, platform), [], { gpu }).includes(LUID), platform);
  assert.ok(!launchArgs(pick({ MARGO_SOFTWARE_GPU: '1' }), [], { gpu }).includes(LUID));
  assert.deepEqual(launchArgs(pick({}), ['--disable-gpu'], { webgpu: false, gpu }), ['--disable-gpu']);
  assert.deepEqual(launchArgs(pick({ MARGO_BROWSER: 'firefox' }), [], { gpu }), []);
  assert.equal(calls, 0, 'no lookup was made for any of those');
  assert.deepEqual(launchArgs(pick({}), [], { gpu: () => undefined }), [], 'no switch when there is nothing to choose');
  assert.deepEqual(chromiumLaunchOptions({ env: { MARGO_GPU_LUID: '0,79477' }, platform: 'win32', argv: [] }).args, [
    LUID,
  ]);
});

test('MARGO_GPU_LUID and MARGO_GPU=default need no lookup', () => {
  assert.deepEqual(launchArgs(pick({ MARGO_GPU_LUID: '0,90115' })), ['--use-adapter-luid=0,90115']);
  assert.deepEqual(launchArgs(pick({ MARGO_GPU: 'default' })), []);
});

test('MARGO_SOFTWARE_GPU=1 selects SwiftShader as the WebGPU adapter', () => {
  const args = launchArgs(pick({ MARGO_SOFTWARE_GPU: '1' }, 'linux'), ['--x']);
  for (const flag of ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--x'])
    assert.ok(args.includes(flag), flag);
  assert.equal(new Set(args).size, args.length, 'no repeated switch');
  assert.ok(!launchArgs(pick({}, 'linux')).includes('--use-webgpu-adapter=swiftshader'));
});

test('a caller that needs no GPU gets none of the WebGPU switches', () => {
  assert.deepEqual(launchArgs(pick({}, 'linux'), ['--disable-gpu'], { webgpu: false }), ['--disable-gpu']);
});

test('Firefox has no WebGPU: WebGPU steps and Chromium-only steps are reported unsupported, the rest run', () => {
  const firefox = pick({ MARGO_BROWSER: 'firefox' });
  assert.equal(unsupportedReason(firefox), 'no WebGPU in firefox');
  assert.match(unsupportedReason(firefox, 'chromium'), /needs a Chromium browser, not firefox/);
  assert.equal(unsupportedReason(firefox, 'none'), null);
  assert.deepEqual(launchArgs(firefox, ['--x']), []);
  for (const name of ['edge', 'chrome', 'chromium'])
    assert.equal(unsupportedReason(pick({ MARGO_BROWSER: name })), null);
});

test('skipSuite says "skipped" with the reason and exits 0, never printing a pass', () => {
  const lines = [];
  let code;
  skipSuite('no WebGPU in firefox', { suite: 'check-x.mjs', out: (l) => lines.push(l), exit: (c) => (code = c) });
  assert.deepEqual(lines, ['check-x.mjs: skipped: no WebGPU in firefox']);
  assert.equal(code, 0);
});

test('chromiumLaunchOptions carries channel, executable and args for a caller with its own Playwright', () => {
  const options = chromiumLaunchOptions({
    env: { MARGO_BROWSER: 'chrome', BROWSER_EXECUTABLE: '/b/chrome' },
    platform: 'linux',
    argv: [],
    args: ['--disable-gpu'],
    webgpu: false,
    headless: true,
  });
  assert.deepEqual(options, {
    headless: true,
    args: ['--disable-gpu'],
    channel: 'chrome',
    executablePath: '/b/chrome',
  });
});

test('a suite that needs WebGPU run with MARGO_BROWSER=firefox prints the skip and exits 0 without launching', () => {
  const script = `import { launchBrowser } from ${JSON.stringify(new URL('../scripts/lib/browser.mjs', import.meta.url).href)};
    await launchBrowser({ headless: true }); console.log('LAUNCHED');`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, MARGO_BROWSER: 'firefox' },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /skipped: no WebGPU in firefox/);
  assert.doesNotMatch(run.stdout, /LAUNCHED/);
});

const missing = (what) => ({
  launch: async () => {
    throw new Error(
      `browserType.launch: Executable doesn't exist at C:\\x\\${what}.exe\n    at stack frame 1\n    at stack frame 2`,
    );
  },
});
const attempt = async (env, launchers = { chromium: missing('chromium'), firefox: missing('firefox') }) => {
  const printed = [];
  let code;
  await launchBrowser({
    env,
    platform: 'linux',
    argv: [],
    needs: 'none',
    launchers,
    report: (text) => printed.push(text),
    exit: (c) => {
      code = c;
    },
  });
  return { text: printed.join('\n'), code };
};

test('a browser that cannot launch prints the browser, the install command and MARGO_BROWSER, with no stack trace (bug 28)', async () => {
  for (const [browser, command] of [
    ['firefox', 'npx playwright install firefox'],
    ['chromium', 'npx playwright install chromium'],
  ]) {
    const { text, code } = await attempt({ MARGO_BROWSER: browser });
    assert.equal(code, LAUNCH_FAILED);
    assert.notEqual(code, 0);
    assert.ok(text.includes(`cannot start ${browser}`), text);
    assert.ok(text.includes(command), text);
    assert.ok(text.includes('MARGO_BROWSER'), text);
    assert.doesNotMatch(text, /at stack frame|browserType\.launch/);
  }
  const chrome = await attempt({ MARGO_BROWSER: 'chrome' });
  assert.match(chrome.text, /install Google Chrome/);
});

test('a browser that launches is returned and nothing is reported', async () => {
  const browser = { fake: true };
  const { text, code } = await attempt({ MARGO_BROWSER: 'chromium' }, { chromium: { launch: async () => browser } });
  assert.equal(text, '');
  assert.equal(code, undefined);
});
