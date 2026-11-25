// The browser matrix's own logic (scripts/browser-matrix.mjs and scripts/webdriver.mjs) without a browser: how results
// are classified, the page prelude, and the WebDriver client against a recorded fake driver.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  classifyError,
  thrownOf,
  trigError,
  compareImages,
  crop,
  differences,
  LAYER_PARAM,
  litPixels,
  pixelAt,
  prelude,
  SAFARI_CAPABILITIES,
  table,
  within,
  androidLaunchHint,
  FRAME_PROBE,
  requireFrames,
  androidDriver,
  CHROME_ANDROID_SOCKET,
  devtoolsVersion,
  CASES,
  canvasShotsWork,
  copyRules,
  refusalOf,
  NO_ADAPTER,
  UNSHOT,
} from '../scripts/browser-matrix.mjs';
import { asyncScript, command, ELEMENT_KEY, openSession, revive, WebDriverError } from '../scripts/webdriver.mjs';

test('a coded error with the help link is a refusal; anything else is a bug', () => {
  assert.deepEqual(
    classifyError({
      name: 'MargoError',
      code: 'unsupported',
      message: 'x needs WebGPU; see https://margoengine.com/errors#webgpu',
    }),
    {
      status: 'refusal',
      code: 'unsupported',
      message: 'x needs WebGPU; see https://margoengine.com/errors#webgpu',
    },
  );
  // A code without the help link, a link without a code and a plain crash are all bugs.
  assert.equal(classifyError({ name: 'MargoError', code: 'unsupported', message: 'no link' }).status, 'bug');
  assert.equal(
    classifyError({ name: 'Error', code: null, message: 'see https://margoengine.com/errors#x' }).status,
    'bug',
  );
  assert.equal(
    classifyError({ name: 'TypeError', message: 'undefined is not an object' }).message,
    'TypeError: undefined is not an object',
  );
});

const image = (width, height, fill) => ({
  width,
  height,
  data: Uint8Array.from({ length: width * height * 4 }, (_, i) => fill(i >> 2, i & 3)),
});

test('images compare by the largest RGB difference per pixel, as the compatibility check measures', () => {
  const a = image(10, 10, () => 100),
    b = image(10, 10, (p, c) => (p === 0 && c === 1 ? 110 : p === 1 && c === 3 ? 0 : 100));
  // One pixel 10 apart in green; alpha is not compared.
  assert.deepEqual(compareImages(a, b), { share: 0.01, mean: 0.1, max: 10 });
  assert.deepEqual(
    compareImages(
      a,
      image(5, 5, () => 0),
    ),
    { size: '10x10 vs 5x5' },
  );
  assert.equal(litPixels(image(4, 1, (p) => (p < 3 ? 41 : 40))), 3);
  assert.deepEqual(pixelAt(image(2, 2, (p, c) => p * 10 + c)), [30, 31, 32]);
});

test('a features probe thrown as text keeps the code its help link names', () => {
  assert.deepEqual(thrownOf('MargoError: no stencil; see https://margoengine.com/errors#compatibility-layer'), {
    name: 'MargoError',
    code: 'compatibility-layer',
    message: 'no stencil; see https://margoengine.com/errors#compatibility-layer',
  });
  assert.equal(
    classifyError(thrownOf('MargoError: no stencil; see https://margoengine.com/errors#compatibility-layer')).status,
    'refusal',
  );
  assert.equal(classifyError(thrownOf('TypeError: x is undefined')).status, 'bug');
});

test('the inverse trig measure reads each sweep against float64, signed zeros included', () => {
  // Pixel 0 of the atan2 sweep (row 3) holds y, x, atan2(y, x): atan2(-0, -1) is -pi, so -pi there is exact.
  const r = new Array(2048 * 10 * 4).fill(0);
  for (let p = 0; p < r.length; p += 4) {
    const row = Math.floor(p / 4 / 4096);
    if (row < 3) [r[p], r[p + 1], r[p + 2]] = [0.5, Math.acos(0.5), Math.asin(0.5)];
    else if (row === 3) [r[p], r[p + 1], r[p + 2]] = [1, 1, Math.atan2(1, 1)];
    else [r[p], r[p + 1]] = [1, Math.atan(1)];
  }
  const at = 3 * 4096 * 4;
  [r[at], r[at + 1], r[at + 2]] = [-0, -1, -Math.PI];
  assert.equal(trigError(r).max, 0);
  r[at + 2] = Math.PI;
  assert.equal(trigError(r).max, 2 * Math.PI);
  assert.deepEqual(trigError(r).at.index, 0);
});

test('crop cuts a CSS-pixel rectangle out of a device-pixel page shot, clamped to it', () => {
  const page = image(8, 6, (p, c) => (c === 0 ? p : 0));
  const part = crop(page, { x: 1, y: 1, width: 2, height: 1 }, 2);
  assert.equal(part.width, 4);
  assert.equal(part.height, 2);
  assert.deepEqual(
    [...part.data].filter((_, i) => i % 4 === 0),
    [18, 19, 20, 21, 26, 27, 28, 29],
  );
  const edge = crop(page, { x: 3, y: 2, width: 5, height: 5 }, 2);
  assert.deepEqual([edge.width, edge.height], [2, 2]);
});

test('differences counts every differing value and keeps the first few', () => {
  const d = differences({ a: 1, b: [1, 2, 3], c: 0.5, s: 'x' }, { a: 2, b: [1, 2, 4], c: 0.5 + 1e-7, s: 'y' });
  assert.equal(d.count, 3);
  assert.deepEqual(d.first, ['.a: native 1, layer 2', '.b[2]: native 3, layer 4', '.s: native "x", layer "y"']);
  assert.equal(differences([NaN], [NaN]).count, 0);
  assert.equal(differences([1, 2], [1]).first[0], ': length 2 vs 1');
});

/** Runs the prelude in a fake window whose query is `search`; returns the window and whether the shim ran. */
function runPrelude(search) {
  const listeners = {};
  // The shim goes into the page as source text, so it counts on the page's global, not in a closure.
  const window = {
    location: { search },
    URLSearchParams,
    addEventListener: (type, fn) => (listeners[type] = fn),
  };
  window.window = window;
  vm.runInNewContext(
    prelude(() => (globalThis.shimmed = (globalThis.shimmed ?? 0) + 1)),
    window,
  );
  return { window, listeners, shimmed: () => window.shimmed ?? 0 };
}

test('the prelude records page errors with their codes and installs the layer only when asked', () => {
  const plain = runPrelude('?mode=native');
  assert.equal(plain.shimmed(), 0);
  plain.listeners.error({ error: Object.assign(new Error('refused'), { name: 'MargoError', code: 'unsupported' }) });
  plain.listeners.unhandledrejection({ reason: new TypeError('crash') });
  plain.listeners.error({ message: 'Script error.' });
  assert.deepEqual(JSON.parse(JSON.stringify(plain.window.__matrixErrors)), [
    { name: 'MargoError', code: 'unsupported', message: 'refused' },
    { name: 'TypeError', code: null, message: 'crash' },
    { name: 'Error', code: null, message: 'Script error.' },
  ]);
  assert.equal(runPrelude(`?${LAYER_PARAM}=1`).shimmed(), 1);
  assert.equal(runPrelude(`?${LAYER_PARAM}=0`).shimmed(), 0);
});

test('the table puts each item on one row with its native and layer cells', () => {
  const text = table({
    rows: [
      { case: 'c', item: 'i', mode: 'native', status: 'pass' },
      { case: 'c', item: 'i', mode: 'layer', status: 'refusal', code: 'unsupported' },
      { case: 'c', item: 'j', mode: 'layer', status: 'difference', numbers: { max: 3 } },
      { case: 'd', item: 'run', mode: '-', status: 'bug', message: 'boom' },
    ],
  });
  assert.deepEqual(text.split('\n').slice(2), [
    '| c | i | pass | refusal `unsupported` |',
    '| c | j | not run | difference: {"max":3} |',
    '| d | run | bug: boom | bug: boom |',
  ]);
});

test('the iOS leg asks safaridriver for Safari in the iOS Simulator', () => {
  assert.deepEqual(SAFARI_CAPABILITIES['ios-simulator'], {
    browserName: 'safari',
    platformName: 'iOS',
    'safari:useSimulator': true,
    'safari:deviceType': 'iPhone',
  });
});

/** A fake WebDriver: answers from `routes` ("METHOD path" to a value or a function of the body) and records calls. */
function fakeDriver(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname,
      body = init.body ? JSON.parse(init.body) : undefined,
      key = `${init.method} ${path}`;
    calls.push({ key, body, signal: init.signal });
    const route = routes[key];
    if (route === undefined)
      return new Response(JSON.stringify({ value: { error: 'unknown command', message: key } }), { status: 404 });
    return new Response(JSON.stringify({ value: typeof route === 'function' ? route(body) : route }), { status: 200 });
  };
  return { calls, fetchImpl };
}

test('the WebDriver client opens a session, runs scripts, takes element shots and ends the session once', async () => {
  const png = Buffer.from([137, 80, 78, 71]);
  const { calls, fetchImpl } = fakeDriver({
    'POST /session': { sessionId: 's1', capabilities: { browserVersion: '27.2' } },
    'POST /session/s1/timeouts': null,
    'POST /session/s1/url': null,
    'POST /session/s1/execute/async': () => ({ ok: 42 }),
    'POST /session/s1/element': { [ELEMENT_KEY]: 'e7' },
    'GET /session/s1/element/e7/screenshot': png.toString('base64'),
    'DELETE /session/s1': null,
  });
  const session = await openSession('http://driver', { browserName: 'safari' }, { fetchImpl });
  assert.equal(session.capabilities.browserVersion, '27.2');
  assert.deepEqual(calls[0].body, { capabilities: { alwaysMatch: { browserName: 'safari' } } });
  await session.timeouts(1000, 2000);
  assert.deepEqual(calls.at(-1).body, { script: 1000, pageLoad: 2000 });
  await session.goto('http://page/');
  assert.deepEqual(await session.run('() => 42'), { ok: 42 });
  assert.match(calls.at(-1).body.script, /\(\(\) => 42\)\(null\)/);
  assert.deepEqual(await session.screenshot('canvas'), png);
  assert.deepEqual(calls.find((c) => c.key === 'POST /session/s1/element').body, {
    using: 'css selector',
    value: 'canvas',
  });
  await session.close();
  await session.close();
  assert.equal(calls.filter((c) => c.key === 'DELETE /session/s1').length, 1);
  // Every command carries a time limit.
  assert.ok(calls.every((c) => c.signal instanceof AbortSignal));
});

test('a WebDriver protocol error rejects with its code', async () => {
  const { fetchImpl } = fakeDriver({});
  await assert.rejects(command('http://driver', 'GET', '/nothing', undefined, { fetchImpl }), (error) => {
    assert.ok(error instanceof WebDriverError);
    assert.equal(error.code, 'unknown command');
    assert.equal(error.status, 404);
    return true;
  });
});

test('the async script wrapper returns a value or the thrown error with its code', async () => {
  const run = (source, arg) =>
    new Promise((resolve) =>
      vm.runInNewContext(`(function () { ${asyncScript(source, arg)} })(done)`, {
        done: (v) => resolve(JSON.parse(JSON.stringify(v))),
      }),
    );
  assert.deepEqual(await run('async (x) => x * 2', 21), { ok: 42 });
  assert.deepEqual(await run('() => undefined'), { ok: null });
  // JSON would turn -0 into 0 and NaN or an infinity into null: the inverse trig probe's signed zeros must survive.
  const special = revive(
    await run('() => ({ a: [-0, 0, NaN, Infinity, -Infinity, 1.5], t: new Float32Array([-0, 2]) })'),
  );
  assert.ok(Object.is(special.ok.a[0], -0) && Object.is(special.ok.a[1], 0));
  assert.deepEqual(special.ok.a.slice(2), [NaN, Infinity, -Infinity, 1.5]);
  assert.ok(Object.is(special.ok.t[0], -0));
  assert.equal(special.ok.t[1], 2);
  assert.deepEqual(
    await run("() => { throw Object.assign(new Error('no'), { name: 'MargoError', code: 'unsupported' }); }"),
    {
      thrown: { name: 'MargoError', code: 'unsupported', message: 'no' },
    },
  );
});

// Regression (2026-11-15): on the Pixel_8 emulator (Android 15, user build) Chrome stayed on its first-run screen and
// launchBrowser never returned, so the matrix hung until the outer timeout with no reason. It now fails in 180 s with one.
test('an Android launch that never opens its DevTools socket fails in time, naming the first-run screen', async () => {
  const focus =
    '  mCurrentFocus=Window{b177f68 u0 com.android.chrome/org.chromium.chrome.browser.firstrun.FirstRunActivity}';
  assert.match(androidLaunchHint('0\n', focus), /first-run screen is open.*ro\.debuggable=0/);
  assert.equal(
    androidLaunchHint('1\n', focus),
    null,
    'a debuggable image reads the command line, so something else is wrong',
  );
  assert.equal(
    androidLaunchHint('0', 'mCurrentFocus=Window{1 u0 com.android.chrome/com.google.android.apps.chrome.Main}'),
    null,
  );
  await assert.rejects(
    within(new Promise(() => {}), 20, () => new Error('no socket')),
    /no socket/,
  );
  assert.equal(await within(Promise.resolve(7), 1000, () => new Error('late')), 7);
});

// Regression (2026-11-15): with the Mac's screen locked Safari 27.2 fired no animation frames, the features page's
// canvasRead probe waited for one forever, and the run lost its WebDriver session ("fetch failed", then timeouts on
// every later case). The matrix now refuses at the start, naming the cause.
test('a browser that fires no animation frames is refused before any case runs, naming a locked screen', async () => {
  const driver = (answer) => ({ name: 'safari', run: async (source) => (assert.equal(source, FRAME_PROBE), answer) });
  await requireFrames(driver({ ok: true }));
  await assert.rejects(
    requireFrames(driver({ ok: false })),
    /safari fires no animation frames \(none in 5 s\).*locked or sleeping screen/,
  );
  await assert.rejects(requireFrames(driver({ thrown: { message: 'boom' } })), /\(boom\)/);
});

// Regression (2026-11-15): a failed Android start (Chrome on its first-run screen) closed the device but left the
// run's `adb reverse` port mapping on the emulator; only a clean close removed it.
test('a failed Android start removes its adb reverse mapping, with the reason in the error', async () => {
  const calls = [],
    spawn = (cmd, args) => (
      calls.push(args.join(' ')),
      {
        status: 0,
        stdout: args.includes('ro.debuggable')
          ? '0\n'
          : 'mCurrentFocus=Window{1 u0 com.android.chrome/org.chromium.chrome.browser.firstrun.FirstRunActivity}',
      }
    ),
    device = {
      launchBrowser: () => new Promise(() => {}),
      close: async () => calls.push('close'),
      model: () => 'sdk_gphone64_arm64',
      serial: () => 'emulator-5554',
    },
    android = { devices: async () => [device] };
  await assert.rejects(
    androidDriver(4321, { android, spawn, launchMs: 20 }),
    /sdk_gphone64_arm64 cannot be driven: Chrome's first-run screen/,
  );
  assert.equal(calls[0], 'reverse tcp:4321 tcp:4321');
  assert.deepEqual(calls.slice(-2), ['close', 'reverse --remove tcp:4321']);
  calls.length = 0;
  await assert.rejects(androidDriver(4321, { android: { devices: async () => [] }, spawn }), /no Android device/);
  assert.deepEqual(calls, ['reverse tcp:4321 tcp:4321', 'reverse --remove tcp:4321']);
});

// Regression (2026-11-15, matrix-273c): on the Pixel_8 emulator (Android 15 user build, ro.debuggable=0) with Chrome's
// first run finished, Playwright's launchBrowser still timed out after 180 s: Chrome ignores the command line that
// names Playwright's DevTools socket on a user build, while its own `chrome_devtools_remote` socket was open. A user
// build is now driven over CDP through that socket, and the forward is removed on close.
test('Chrome on a user-build Android image is driven over its own DevTools socket, and every mapping is removed on close', async () => {
  const calls = [],
    spawn = (cmd, args) => (
      calls.push(args.join(' ')),
      {
        status: 0,
        stdout: args.includes('ro.debuggable')
          ? '0\n'
          : args.includes('dumpsys')
            ? 'mCurrentFocus=Window{1 u0 com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity}'
            : '',
      }
    ),
    device = {
      launchBrowser: () => assert.fail('a user build ignores the command line launchBrowser writes'),
      close: async () => calls.push('close'),
      model: () => 'sdk_gphone64_arm64',
      serial: () => 'emulator-5554',
    },
    page = { evaluate: async () => 'Mozilla/5.0 Chrome/124.0.0.0 Mobile', close: async () => calls.push('page close') },
    chromium = {
      connectOverCDP: async (endpoint) => (
        calls.push(`cdp ${endpoint}`),
        { contexts: () => [{ newPage: async () => page }], close: async () => calls.push('browser close') }
      ),
    },
    fetch = async (url) => (
      calls.push(`get ${url}`), { ok: true, json: async () => ({ Browser: 'Chrome/124.0.6367.219' }) }
    );
  const driver = await androidDriver(4321, {
    android: { devices: async () => [device] },
    chromium,
    spawn,
    fetch,
    localPort: async () => 9333,
  });
  assert.equal(driver.version, '124.0.6367.219', 'the full build from /json/version, not the reduced user agent');
  assert.equal(driver.platform, 'sdk_gphone64_arm64 (serial emulator-5554)');
  assert.ok(calls.includes(`-s emulator-5554 forward tcp:9333 localabstract:${CHROME_ANDROID_SOCKET}`));
  assert.ok(calls.includes('cdp http://127.0.0.1:9333'));
  calls.length = 0;
  await driver.close();
  assert.deepEqual(calls, [
    'page close',
    'browser close',
    '-s emulator-5554 forward --remove tcp:9333',
    'close',
    'reverse --remove tcp:4321',
  ]);
});

test('a DevTools socket that never answers fails in time with the last error, and the forward is removed', async () => {
  await assert.rejects(
    devtoolsVersion(
      'http://127.0.0.1:1/json/version',
      async () => Promise.reject(new Error('ECONNRESET')),
      20,
      'Chrome on x',
    ),
    /Chrome on x opened no DevTools socket \(chrome_devtools_remote\) in 0.02 s \(ECONNRESET\)/,
  );
  const calls = [],
    spawn = (cmd, args) => (
      calls.push(args.join(' ')),
      {
        status: 0,
        stdout: args.includes('ro.debuggable')
          ? '0'
          : 'mCurrentFocus=Window{1 u0 com.android.chrome/x.ChromeTabbedActivity}',
      }
    ),
    device = { close: async () => calls.push('close'), model: () => 'm', serial: () => 's' };
  await assert.rejects(
    androidDriver(4321, {
      android: { devices: async () => [device] },
      spawn,
      fetch: async () => ({ ok: false, status: 404 }),
      launchMs: 20,
      localPort: async () => 9333,
    }),
    /HTTP 404/,
  );
  assert.deepEqual(calls.slice(-3), ['-s s forward --remove tcp:9333', 'close', 'reverse --remove tcp:4321']);
});
// Regression (2026-11-15, matrix-273c): Chrome 124 in the Android emulator has navigator.gpu but no adapter, and
// composites every WebGL canvas empty (readPixels reads it; screenshots, drawImage and toDataURL do not). The matrix
// recorded 46 bug rows: the engine's coded refusal plus an empty screenshot as a bug, the features page's native leg
// throwing on a null adapter for every layer probe, and every layer picture as wrong colours.
test('a coded start-up refusal is a refusal, and a browser that shows no WebGL2 canvas leaves picture rows unmeasured', async () => {
  const refusal = refusalOf([
    'MargoError: WebGPU adapter unavailable; see https://margoengine.com/errors#webgpu\n    at e (x.js:1:28)',
  ]);
  assert.equal(refusal.status, 'refusal');
  assert.equal(refusal.code, 'webgpu');
  assert.equal(refusalOf(['TypeError: boom']), null);
  assert.equal(refusalOf([]), null);
  const shots = (pixel) => ({
    run: async (source) => ({ ok: /getContext/.test(source) ? true : null }),
    shot: async () => ({ width: 1, height: 1, data: new Uint8Array([...pixel, 255]) }),
  });
  assert.equal(await canvasShotsWork(shots([255, 0, 0])), true);
  assert.equal(await canvasShotsWork(shots([255, 255, 255])), false);
  const rows = [];
  let mode = 'native';
  await CASES['basic-scene']({
    shotsWork: false,
    nativeAdapter: false,
    row: (item, m, result) => rows.push({ item, mode: m, ...result }),
    load: async (path, params) => ((mode = params.mode), {}),
    call: async (source) =>
      /info/.test(source)
        ? {
            ok: {
              vendor: mode === 'native' ? '' : 'margo-webgl2',
              errors:
                mode === 'native'
                  ? ['MargoError: WebGPU adapter unavailable; see https://margoengine.com/errors#webgpu']
                  : [],
            },
          }
        : { ok: 0 },
    shot: async () => assert.fail('no screenshot is judged when shots show nothing'),
  });
  assert.equal(rows.length, 6);
  assert.ok(rows.filter((r) => r.mode === 'native').every((r) => r.status === 'refusal' && r.code === 'webgpu'));
  assert.ok(
    rows.filter((r) => r.mode === 'layer').every((r) => r.status === 'unmeasured' && r.message === UNSHOT.message),
  );
});

test('without a native adapter the layer feature probes run alone, judged by their own bars', async () => {
  const rows = [],
    blank = Array(8 * 8 * 4).fill(0),
    good = blank.slice();
  good.splice(17 * 4, 4, 11, 200, 7, 0);
  const results = {
    inverseTrig: { result: [] },
    bitmapCopies: { result: { 'none/1/whole/up/straight': good, 'none/1/whole/up/premultiplied': blank } },
    bundles: { result: [1] },
  };
  assert.equal(copyRules(results.bitmapCopies), true);
  assert.equal(
    copyRules({ result: { 'none/1/whole/up/straight': blank, 'none/1/whole/up/premultiplied': blank } }),
    false,
  );
  await CASES.features({
    nativeAdapter: false,
    shotsWork: true,
    row: (item, mode, result) => rows.push({ item, mode, ...result }),
    load: async () => ({}),
    call: async (source) => {
      if (/names/.test(source)) return { ok: Object.keys(results) };
      assert.match(source, /runCompat/, 'the page run that needs a native device is not called');
      const name = Object.keys(results).find((n) => source.includes(JSON.stringify(n)));
      return { ok: { native: null, compat: { ...results[name], errors: [], gl: 0 } } };
    },
  });
  const native = rows.filter((r) => r.mode === 'native'),
    layer = Object.fromEntries(rows.filter((r) => r.mode === 'layer').map((r) => [r.item, r]));
  assert.equal(native.length, 3);
  assert.ok(native.every((r) => r.status === 'unmeasured' && r.message === NO_ADAPTER.message));
  assert.equal(layer.inverseTrig.status, 'pass');
  assert.equal(layer.inverseTrig.numbers.nativeError, null);
  assert.equal(layer.bitmapCopies.status, 'pass');
  assert.equal(layer.bundles.status, 'pass');
  assert.equal(layer.bundles.note, 'no native result to compare');
});
