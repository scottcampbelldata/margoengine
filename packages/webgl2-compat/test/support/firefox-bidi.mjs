// Clean-room W3C WebDriver BiDi transport for the shipped Firefox, not Playwright's patched build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { startDevServer } from '../../../../scripts/browser.js';
import { endTree } from '../../../../scripts/support/shutdown.mjs';
import { compatShim, compatRun } from '../../../../scripts/support/compat-shim.js';
import { trackPipelines } from '../../../../scripts/support/gpu-ready.js';
import { wgslGuard, settleWgslReports } from '../../../../scripts/support/wgsl-guard.js';
import { deviceLossGuard } from '../../../../scripts/support/device-loss.js';

export function bounded(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function decode(value) {
  if (value.type === 'undefined') return undefined;
  if (value.type === 'null') return null;
  if (value.type === 'number')
    return typeof value.value === 'string'
      ? { NaN, Infinity, '-Infinity': -Infinity, '-0': -0 }[value.value]
      : value.value;
  if (value.type === 'array') return value.value.map(decode);
  if (value.type === 'object') return Object.fromEntries(value.value.map(([key, entry]) => [key, decode(entry)]));
  if (['string', 'boolean'].includes(value.type)) return value.value;
  throw new Error(`Unsupported BiDi result type ${value.type}; return plain test data`);
}

export function logEvent(log) {
  // Firefox reports policy diagnostics as javascript entries even though no
  // uncaught ErrorEvent fired. Keep them visible as console errors, as in the
  // canonical browser harness, so the caller can check the expected CSP probe.
  if (log.type === 'javascript' && !log.text.startsWith('Content-Security-Policy:'))
    return ['pageerror', new Error(log.text)];
  return ['console', { type: () => (log.level === 'warn' ? 'warning' : log.level), text: () => log.text }];
}

export async function openBrowser({
  startPath = '/tests/modern.html',
  port = 'free',
  plugins = [],
  aliases = {},
  compat = compatRun(),
} = {}) {
  const executable = process.env.BROWSER_EXECUTABLE;
  assert.ok(executable, 'Set BROWSER_EXECUTABLE to the shipped Firefox executable');
  const root = resolve('test-results'),
    profile = await mkdtemp(resolve(root, 'firefox-matrix-'));
  assert.ok(profile.startsWith(root + sep));
  let child, socket, server, stopServer, page;
  const pending = new Map(),
    eventTargets = new Map();
  let next = 0;
  const close = async () => {
    try {
      if (page && socket?.readyState === WebSocket.OPEN) await settleWgslReports(page);
    } finally {
      socket?.close();
      for (const entry of pending.values()) entry.reject(new Error('Firefox closed'));
      if (child?.pid && child.exitCode === null) await bounded(Promise.all([endTree(child.pid)]), 10000, 'Firefox cleanup');
      try {
        await stopServer?.();
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    }
  };
  try {
    ({ server, close: stopServer } = await startDevServer({ startPath, port, plugins, aliases }));
    child = spawn(
      executable,
      ['-headless', '-no-remote', '--profile', profile, '--remote-debugging-port', '0', 'about:blank'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const endpoint = await bounded(
      new Promise((done, reject) => {
        let output = '';
        const read = (chunk) => {
          output += chunk.toString();
          const match = output.match(/WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/);
          if (match) done(match[1] + '/session');
        };
        child.stdout.on('data', read);
        child.stderr.on('data', read);
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`Firefox exited with ${code}`)));
      }),
      30000,
      'Firefox startup',
    );
    socket = new WebSocket(endpoint);
    await bounded(
      new Promise((done, reject) => {
        socket.addEventListener('open', done, { once: true });
        socket.addEventListener('error', reject, { once: true });
      }),
      10000,
      'BiDi connection',
    );
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data),
        entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        if (message.type === 'error') entry.reject(new Error(`${message.error}: ${message.message}`));
        else entry.resolve(message.result);
      } else if (message.method === 'log.entryAdded') {
        const log = message.params,
          events = eventTargets.get(log.source?.context);
        if (!events) return;
        events.emit(...logEvent(log));
      } else if (message.method === 'network.beforeRequestSent') {
        const request = message.params;
        eventTargets.get(request.context)?.emit('request', { url: () => request.request.url });
      }
    });
    const command = (method, params = {}, ms = 60000) => {
      const id = ++next;
      return bounded(
        new Promise((done, reject) => {
          pending.set(id, { resolve: done, reject });
          socket.send(JSON.stringify({ id, method, params }));
        }),
        ms,
        `BiDi ${method}`,
      ).finally(() => pending.delete(id));
    };
    const session = await command('session.new', { capabilities: {} });
    const makeContext = async () => {
      const { userContext } = await command('browser.createUserContext');
      const pages = [];
      const owner = {
        browser: () => ({ newContext: makeContext }),
        async newPage() {
          const { context } = await command('browsingContext.create', { type: 'tab', userContext });
          const page = await makePage(context, owner);
          pages.push(page);
          return page;
        },
        async close() {
          for (const page of pages) await settleWgslReports(page);
          await command('browser.removeUserContext', { userContext });
        },
      };
      return owner;
    };
    const makePage = async (context, owner) => {
      const events = new EventEmitter();
      eventTargets.set(context, events);
      await command('session.subscribe', { events: ['log.entryAdded', 'network.beforeRequestSent'], contexts: [context] });
      await command('browsingContext.setViewport', {
        context,
        viewport: { width: 1440, height: 1100 },
        devicePixelRatio: 1,
      });
      let currentURL = 'about:blank',
        defaultTimeout = 30000;
      const page = {
        context: () => owner,
        on: (name, fn) => {
          events.on(name, fn);
          return page;
        },
        setDefaultTimeout: (ms) => {
          defaultTimeout = ms;
        },
        url: () => currentURL,
        async evaluate(fn, arg) {
          const expression =
            typeof fn === 'string'
              ? fn
              : `(${fn.toString()})(${arg === undefined ? 'undefined' : JSON.stringify(arg)})`;
          const result = await command(
            'script.evaluate',
            {
              expression,
              target: { context },
              awaitPromise: true,
              serializationOptions: { maxObjectDepth: 32 },
            },
            180000,
          );
          if (result.type !== 'success') throw new Error(result.exceptionDetails?.text ?? JSON.stringify(result));
          return decode(result.result);
        },
        async goto(url) {
          currentURL = url;
          await command('browsingContext.navigate', { context, url, wait: 'complete' });
        },
        async addInitScript(fn, arg) {
          await command('script.addPreloadScript', {
            contexts: [context],
            functionDeclaration: `() => (${fn.toString()})(${arg === undefined ? 'undefined' : JSON.stringify(arg)})`,
          });
        },
        async waitForFunction(fn, arg, { timeout = defaultTimeout } = {}) {
          const end = Date.now() + timeout;
          while (!(await page.evaluate(fn, arg))) {
            if (Date.now() >= end) throw new Error(`Firefox page predicate exceeded ${timeout} ms`);
            await new Promise((done) => setTimeout(done, 20));
          }
        },
        locator(selector) {
          return {
            async screenshot({ path } = {}) {
              const box = await page.evaluate((selector) => {
                const element = document.querySelector(selector);
                if (!element) throw new Error(`Missing screenshot target ${selector}`);
                const r = element.getBoundingClientRect();
                return { type: 'box', x: r.x, y: r.y, width: r.width, height: r.height };
              }, selector);
              const { data } = await command('browsingContext.captureScreenshot', {
                context,
                origin: 'viewport',
                clip: box,
              });
              const bytes = Buffer.from(data, 'base64');
              if (path) await writeFile(path, bytes);
              return bytes;
            },
          };
        },
      };
      return page;
    };
    page = await (await makeContext()).newPage();
    for (const init of [wgslGuard, deviceLossGuard, trackPipelines]) await page.addInitScript(init);
    if (compat) await page.addInitScript(compatShim);
    await page.goto(`http://127.0.0.1:${server.config.server.port}${startPath}`);
    const hardware = await page.evaluate(async () => {
      const gl = new OffscreenCanvas(2, 2).getContext('webgl2', { powerPreference: 'high-performance' });
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      const adapter = await navigator.gpu?.requestAdapter();
      const out = {
        userAgent: navigator.userAgent,
        webglRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER),
        extensions: gl?.getSupportedExtensions(),
        webgpu: adapter?.info
          ? {
              vendor: adapter.info.vendor,
              architecture: adapter.info.architecture,
              device: adapter.info.device,
              fallback: adapter.info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
            }
          : null,
      };
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return out;
    });
    assert.doesNotMatch(hardware.webglRenderer ?? '', /swiftshader|llvmpipe|software/i);
    Object.assign(hardware, {
      browserName: 'firefox',
      browserVersion: session.capabilities.browserVersion,
      protocol: 'WebDriver BiDi',
      headless: true,
      hostPlatform: process.platform,
      compat,
    });
    await writeFile('test-results/firefox-matrix-hardware.json', JSON.stringify(hardware, null, 2) + '\n');
    return { page, server, hardware, close };
  } catch (error) {
    await close();
    throw error;
  }
}
