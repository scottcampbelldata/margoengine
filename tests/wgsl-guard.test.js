// The browser checks' WGSL guard (scripts/support/wgsl-guard.js): any shader that fails to compile is reported as an
// error; a shader a check labels `expect-error:<name>` is excused only when it does fail, and reported as an
// unexpected success when it compiles cleanly. Runs the guard against a stand-in GPUDevice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { settleWgslReports, watchWgsl, wgslGuard } from '../scripts/support/wgsl-guard.js';

async function compile(modules) {
  const lines = [],
    original = { debug: console.debug, error: console.error };
  console.debug = (text) => lines.push(text);
  console.error = (text) => lines.push(text);
  globalThis.GPUDevice = class {
    createShaderModule({ code }) {
      return {
        getCompilationInfo: async () => ({
          messages: code.includes('broken')
            ? [{ type: 'error', lineNum: 1, linePos: 1, message: 'unresolved value' }]
            : [],
        }),
      };
    }
  };
  try {
    wgslGuard();
    const device = new GPUDevice();
    for (const m of modules) device.createShaderModule(m);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    Object.assign(console, original);
    delete globalThis.GPUDevice;
  }
  const listeners = [];
  const watched = watchWgsl({ on: (_event, listener) => listeners.push(listener) });
  for (const text of lines) for (const listener of listeners) listener({ text: () => text });
  return watched;
}

test('a shader that fails to compile is an error', async () => {
  const watched = await compile([
    { code: 'broken a', label: 'normal' },
    { code: 'fine', label: 'ok' },
  ]);
  assert.equal(watched.errors.length, 1);
  assert.match(watched.errors[0], /^normal 1:1 unresolved value/);
  assert.equal(watched.modules.size, 2);
});

// A page stand-in that runs page functions in this realm, where the guard ran.
const here = { evaluate: async (fn) => fn() };

test('settleWgslReports waits for reports that arrive', async () => {
  delete globalThis.__margoWgslReports;
  delete globalThis.__margoWgslPending;
  await compile([{ code: 'fine', label: 'ok' }]);
  await settleWgslReports(here, { budgetMs: 1000 });
  assert.equal(globalThis.__margoWgslPending.size, 0, 'a settled report leaves the pending list');
});

// Regression: biomes test:gpu on an Intel Arc laptop printed every check OK, then the suite never ended and the runner
// killed it after 600 s. close() waited for the compilation reports with a bare page.evaluate, which has no time
// limit, so a report the GPU process never sent (or a page that never answered) held the suite for ever, silently.
test('a compilation report that never arrives fails within the budget, naming its module', async () => {
  delete globalThis.__margoWgslReports;
  delete globalThis.__margoWgslPending;
  const original = console.debug;
  console.debug = () => {};
  globalThis.GPUDevice = class {
    createShaderModule({ code }) {
      return {
        getCompilationInfo: () => (code === 'stuck' ? new Promise(() => {}) : Promise.resolve({ messages: [] })),
      };
    }
  };
  try {
    wgslGuard();
    const device = new GPUDevice();
    device.createShaderModule({ code: 'fine', label: 'terrain' });
    device.createShaderModule({ code: 'stuck', label: 'objects scatter' });
  } finally {
    console.debug = original;
    delete globalThis.GPUDevice;
  }
  const begun = Date.now();
  await assert.rejects(settleWgslReports(here, { budgetMs: 200 }), (error) => {
    assert.equal(error.code, 'SHUTDOWN_TIMEOUT');
    assert.match(error.message, /1 shader module\(s\) never arrived within 200 ms: objects scatter\b/);
    assert.deepEqual(error.open, ['compilation info of objects scatter']);
    return true;
  });
  assert.ok(Date.now() - begun < 1500, `took ${Date.now() - begun} ms`);
});

test('a page that never answers fails within the budget, saying so', async () => {
  const silent = { evaluate: () => new Promise(() => {}) },
    begun = Date.now();
  await assert.rejects(settleWgslReports(silent, { budgetMs: 200 }), (error) => {
    assert.equal(error.code, 'SHUTDOWN_TIMEOUT');
    assert.match(error.message, /the page did not answer within 200 ms/);
    assert.deepEqual(error.open, ['page']);
    return true;
  });
  assert.ok(Date.now() - begun < 3500, `took ${Date.now() - begun} ms`);
});

test('a page that is gone has no reports left to wait for', async () => {
  await settleWgslReports({
    evaluate: () => Promise.reject(new Error('Target page, context or browser has been closed')),
  });
});

test('the browser harness waits for compilation reports only through the bounded settleWgslReports', async () => {
  const source = await readFile(new URL('../scripts/browser.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /__margoWgslReports/, 'a bare page.evaluate on the reports has no limit');
  assert.match(source, /await settleWgslReports\(page\)/);
});

test('expect-error excuses only the labelled shader, and only when it fails', async () => {
  const watched = await compile([
    { code: 'broken b', label: 'expect-error:bad kernel' },
    { code: 'compiles', label: 'expect-error:should fail' },
    { code: 'broken c', label: 'other' },
  ]);
  assert.deepEqual(watched.expected, ['expect-error:bad kernel']);
  assert.deepEqual(watched.unexpected, ['expect-error:should fail'], 'a declared failure that compiles is reported');
  assert.equal(watched.errors.length, 1, 'other shaders still fail');
  assert.match(watched.errors[0], /^other /);
});

// Regression: modern:test:extensions sat until its 30 minute lock limit. material-extension-tests.js asked
// getCompilationInfo() for its 41 modules after the device had gone idle, and Chromium (Edge 156 on the RTX A6000 PC)
// left every one of those requests pending until another GPU request ran; the same request made when a module is
// created is answered. The guard asks once per module at creation and answers every later call with it.
test('a compilation info asked for after the device went idle gets the answer asked for at creation', async () => {
  delete globalThis.__margoWgslReports;
  delete globalThis.__margoWgslPending;
  const original = console.debug;
  console.debug = () => {};
  let creating = false,
    asks = 0;
  // A stand-in for that Chromium behaviour: answered while its module is being created, never once idle.
  globalThis.GPUDevice = class {
    createShaderModule({ code }) {
      creating = true;
      queueMicrotask(() => (creating = false));
      return {
        getCompilationInfo: () => {
          asks++;
          return creating ? Promise.resolve({ messages: [], code }) : new Promise(() => {});
        },
      };
    }
  };
  let modules;
  try {
    wgslGuard();
    const device = new GPUDevice();
    // The second module repeats the first one's source: the guard reports it once, but still answers for it.
    modules = [device.createShaderModule({ code: 'fine a' }), device.createShaderModule({ code: 'fine a' })];
  } finally {
    console.debug = original;
    delete globalThis.GPUDevice;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  const late = modules.map((module) => module.getCompilationInfo());
  const outcome = await Promise.race([
    Promise.all(late).then((infos) => infos.map((info) => info.code)),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 500)),
  ]);
  assert.deepEqual(outcome, ['fine a', 'fine a']);
  assert.equal(asks, 2, 'one request per module, made at its creation');
});
