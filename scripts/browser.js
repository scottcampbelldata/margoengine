import { firefox, webkit } from '@playwright/test';
import { launchBrowser, resolveBrowser, softwareAdapterReason } from './lib/browser.mjs';
import { createServer } from 'vite';
import { realpathSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { settleWgslReports, watchWgsl, wgslGuard } from './support/wgsl-guard.js';
import { trackPipelines } from './support/gpu-ready.js';
import { deviceLossGuard, watchDeviceLoss } from './support/device-loss.js';
import { compatRun, compatShim } from './support/compat-shim.js';
import { closeAll, traceShutdown } from './support/shutdown.mjs';

/**
 * Starts a server on a fixed port with `start` (for example `() => server.listen()`), waiting while something else holds
 * the port: GPU suites share the GPU (scripts/gpu-lock.mjs, 3 slots), so two suites that use the same port can run at
 * once and the second waits for the first to close its server. Other errors are thrown as they are; past `waitMs`
 * (default 20 min, a shared GPU hold's limit) it throws naming the port.
 */
export async function listenWhenFree(start, { port, waitMs = 20 * 60_000, poll = 1000, log = console.error } = {}) {
  const begun = Date.now();
  for (let told = false; ; ) {
    try {
      return await start();
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' && !/already in use/i.test(error?.message ?? '')) throw error;
      // wall-clock: a bound on the wait for the browser port, far from normal.
      if (Date.now() - begun > waitMs)
        throw new Error(
          `port ${port} stayed in use for ${Math.round((Date.now() - begun) / 1000)} s; find what holds it (netstat -ano | findstr :${port}) and stop it`,
          { cause: error },
        );
      if (!told) log(`port ${port} is in use, most likely by another GPU suite sharing the GPU; waiting for it`);
      told = true;
      await new Promise((resolve) => setTimeout(resolve, poll));
    }
  }
}

/**
 * A port nothing holds now (the system picks one). A suite that passes `port: 'free'` to `openBrowser` or
 * `startDevServer` never waits for another suite's port: a fixed port held by a helper's 7-minute run of the same suite
 * made a 5-second check sit silent in listenWhenFree until the harness's time limit killed it (bug 38).
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/** Folder holding each running dev server's own dependency cache (`startDevServer`), one `<pid>-<random>` folder each. */
export const DEV_CACHE_ROOT = 'test-results/vite-cache';

/**
 * Starts the Vite dev server a browser suite loads `startPath` from, on `port` (waiting while another suite holds it,
 * listenWhenFree; `'free'` takes any free port, see freePort), with a dependency optimizer cache of its own: a fresh folder under DEV_CACHE_ROOT that `close()`
 * removes. Vite's default cache (node_modules/.vite) is shared by every server of a checkout, and by every worktree
 * whose node_modules/.vite links to the main checkout's; a server with another root or other aliases re-optimizes into
 * it and replaces the files a second server's page is importing, which then answers 504 "Outdated Optimize Dep" and
 * the page never finishes loading (bug 26). Folders left by a killed run (their process is gone) are removed here.
 */
export async function startDevServer({
  startPath = '/tests/modern.html',
  aliases = {},
  plugins = [],
  port = 5193,
} = {}) {
  if (port === 'free') port = await freePort();
  // The working directory's real path: Vite refuses to serve a file named by a Windows short (8.3) path, so a checkout
  // reached through one (os.tmpdir() is C:\Users\\... here, where check:fresh-clone clones) would answer every
  // page with 403 "outside of Vite serving allow list".
  const root = realpathSync.native(process.cwd()),
    caches = join(root, DEV_CACHE_ROOT);
  await mkdir(caches, { recursive: true });
  for (const name of await readdir(caches)) {
    const pid = Number(name.split('-')[0]);
    if (Number.isInteger(pid) && pid > 0 && !alive(pid)) await rm(join(caches, name), { recursive: true, force: true });
  }
  const cacheDir = await mkdtemp(join(caches, `${process.pid}-`));
  let server;
  // Bounded (bug 70): a browser's keep-alive and event-stream connections made a plain `server.close()` wait for ever, so the
  // connections are dropped first and a close that still does not finish throws SHUTDOWN_TIMEOUT naming the server.
  const close = async () => {
    try {
      await closeAll({ servers: [server] });
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  };
  try {
    server = await createServer({
      root,
      resolve: { alias: aliases },
      plugins,
      cacheDir,
      optimizeDeps: { entries: [startPath.replace(/^\//, '')] },
      // No file watcher: its first crawl of the repository (and every worktree under it) blocked this process for
      // 30-140 s on a busy machine, so the first page load timed out ("Preparing the citadel...", gate 9).
      server: { host: '127.0.0.1', port, strictPort: true, watch: null },
      logLevel: 'error',
    });
    await listenWhenFree(() => server.listen(), { port });
  } catch (error) {
    await close();
    throw error;
  }
  return { server, cacheDir, close };
}

/** True while process `pid` runs (signal 0 tests for it; EPERM means it runs as another user). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Page init script for a slow shader compiler: `createRenderPipelineAsync` and `createComputePipelineAsync` resolve
 * `ms` later than the GPU finishes them, and `createRenderPipeline` and `createComputePipeline` hold the calling thread
 * `ms` longer (the real pipelines, unchanged; errors pass through). An integrated GPU's driver can take far longer
 * than this PC's to compile, so a check that waits a fixed time or number of frames for a pipeline, instead of its
 * readiness, fails here too. `openBrowser({ pipelineDelayMs })`, MARGO_PIPELINE_DELAY_MS or `--pipeline-delay=<ms>` on
 * the suite's command line (the `test:gpu:slow-compile` scripts).
 */
export function delayPipelines(ms) {
  // Compatibility installs its device lazily, after this init script. Keep the
  // same instrumenter available for that prototype instead of timing only the
  // native GPUDevice that the page subsequently replaces.
  const wrapped = new WeakSet();
  const apply = (prototype) => {
    if (wrapped.has(prototype)) return;
    wrapped.add(prototype);
    for (const name of ['createRenderPipelineAsync', 'createComputePipelineAsync']) {
      const original = prototype[name];
      prototype[name] = function (...args) {
        return original
          .apply(this, args)
          .then((pipeline) => new Promise((resolve) => setTimeout(() => resolve(pipeline), ms)));
      };
    }
    for (const name of ['createRenderPipeline', 'createComputePipeline']) {
      const original = prototype[name];
      prototype[name] = function (...args) {
        const pipeline = original.apply(this, args),
          until = performance.now() + ms;
        while (performance.now() < until) {
          // Busy: a synchronous compile blocks the thread that asked for it.
        }
        return pipeline;
      };
    }
  };
  globalThis.__margoDelayPipelines = apply;
  if (typeof GPUDevice !== 'undefined') apply(GPUDevice.prototype);
}

/**
 * Page init script for a GPU whose builtin maths is as far off as WGSL allows: every shader module's calls of the
 * builtins below are rewritten to return a value off by `scale` times the specification's error bound (WGSL 15.8,
 * "Floating point accuracy"), deterministically: sin and cos 2^-11 absolute, tan the same relatively (within the bound
 * it inherits from sin / cos), asin and acos 6.77e-5 absolute, atan and atan2 4095 ulp, exp and exp2 3 ulp, log and
 * log2 2^-23 absolute, sqrt and inverseSqrt 4 and 2 ulp. An Intel Arc 140V is 1.1e-5 off for sin near 1.5
 * where this PC's RTX A6000 is within 3e-7, so a check that leans on one GPU's builtins passes here and fails there;
 * with this it fails here too. `openBrowser({ mathErrorScale })`, MARGO_SPEC_MATH_ERROR or `--spec-math-error=<scale>`
 * (the `:spec-math` scripts; 1 = the bound).
 */
export function perturbBuiltinMath(scale) {
  if (typeof GPUDevice === 'undefined') return;
  globalThis.__margoSpecMathError = scale;
  const u = 2 ** -24,
    // name -> [factor, absolute term]: the result becomes builtin * factor + absolute.
    rules = {
      sin: [1 - scale * 2 ** -11, 0],
      cos: [1 - scale * 2 ** -11, 0],
      tan: [1 + scale * 2 ** -11, 0],
      asin: [1 - (scale * 6.77e-5) / (Math.PI / 2), 0],
      acos: [1 - (scale * 6.77e-5) / Math.PI, 0],
      atan: [1 + scale * 4095 * u, 0],
      atan2: [1 + scale * 4095 * u, 0],
      exp: [1 + scale * 3 * u, 0],
      exp2: [1 + scale * 3 * u, 0],
      // 2^-23 absolute: inside 2^-21 on [0.5, 2] and inside 3 ulp elsewhere (|log x| >= 0.69 there).
      log: [1, scale * 2 ** -23],
      log2: [1, scale * 2 ** -23],
      sqrt: [1 + scale * 4 * u, 0],
      inverseSqrt: [1 + scale * 2 * u, 0],
    };
  const pattern = new RegExp(`(?<![\\w.])(${Object.keys(rules).join('|')})\\s*\\(`, 'g');
  const literal = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));
  const rewrite = (code) => {
    // Comments go first, so a parenthesis in one cannot pair with code.
    const src = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
    let out = '',
      last = 0;
    pattern.lastIndex = 0;
    for (let m = pattern.exec(src); m; m = pattern.exec(src)) {
      if (/\bfn\s+$/.test(src.slice(Math.max(0, m.index - 8), m.index))) continue;
      let depth = 1,
        j = m.index + m[0].length;
      for (; j < src.length && depth > 0; j++) depth += src[j] === '(' ? 1 : src[j] === ')' ? -1 : 0;
      const call = src.slice(m.index, j),
        [factor, absolute] = rules[m[1]],
        // The call's arguments are rewritten too (nested builtins).
        inner = rewrite(call.slice(m[0].length, -1));
      out += `${src.slice(last, m.index)}(${m[1]}(${inner}) * ${literal(factor)}${absolute ? ` + ${literal(absolute)}` : ''})`;
      last = j;
      pattern.lastIndex = j;
    }
    return out + src.slice(last);
  };
  const original = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (descriptor) {
    return original.call(this, { ...descriptor, code: rewrite(descriptor.code) });
  };
}

/**
 * Page init script for a compiler that reassociates floating-point sums, which WGSL allows ("An implementation may
 * reassociate operations", 15.7.5): every shader module's code has each sum that one of its own operands cancels
 * folded, as AMD's D3D12 compiler (Radeon 680M) does with (1.0 + x) - 1.0 and Mesa's Intel compiler with (a + b) - a.
 * After `let u = 1.0 + x;` `u - 1.0` becomes `x`; after `let s = a + b;` `s - a` becomes `b`; after `let t = 1.0 - h;`
 * `1.0 - t` becomes `h`; an inline `(1.0 + x) - 1.0` becomes `x`. An error-free transform written that way loses its
 * error term here as on those GPUs. Each sum is also factored by a term of its own, as Mesa's Intel compiler does:
 * `h + (l * c + (h * w) * p)` becomes `h * (1.0 + w * p) + l * c`. Comments are dropped.
 * `openBrowser({ reassociate: true })`, MARGO_REASSOCIATE_MATH=1 or `--reassociate-math` (the `:reassociate` scripts).
 */
export function reassociateMath() {
  if (typeof GPUDevice === 'undefined') return;
  globalThis.__margoReassociateMath = true;
  const num = String.raw`(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?f?`,
    literal = new RegExp(`^${num}$`),
    value = (s) => Number(s.replace(/f$/, '')),
    simple = /^[A-Za-z_][\w.]*$/,
    same = (a, b) => (literal.test(a) && literal.test(b) ? value(a) === value(b) : a === b),
    token = (s) => (literal.test(s) ? num : simple.test(s) ? s.replace(/\./g, '\\.') : '(?!)'),
    // A whole operand: after `(`, `,`, `=` or `return`, before `)`, `,` or `;`.
    before = String.raw`(?<=(?:[(,=]|\breturn)\s*)`,
    after = String.raw`(?=\s*[),;])`;
  /** [left, op, right] at the last top-level + or - of an expression, or null. */
  const splitSum = (e) => {
    let depth = 0,
      at = -1;
    for (let i = 0; i < e.length; i++) {
      const ch = e[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (
        depth === 0 &&
        (ch === '+' || ch === '-') &&
        /[\w.)\]]\s*$/.test(e.slice(0, i)) &&
        !/(?<![\w.])[\d.]+[eE]$/.test(e.slice(0, i))
      )
        at = i;
    }
    return at < 0 ? null : [e.slice(0, at).trim(), e[at], e.slice(at + 1).trim()];
  };
  const foldFunction = (code) => {
    let out = code;
    for (const m of code.matchAll(/\blet\s+(\w+)\s*(?::\s*\w+)?\s*=\s*([^;]+);/g)) {
      const sum = splitSum(m[2]);
      if (!sum) continue;
      const [l, op, r] = sum,
        name = m[1];
      // n = a + b: n - a is b and n - b is a. n = a - b: a - n is b and n + b is a. The operand that cancels is a
      // constant or a name; the other may be any expression.
      const rules = [];
      if (op === '+')
        rules.push([`\\b${name}\\s*-\\s*(${token(l)})`, l, r], [`\\b${name}\\s*-\\s*(${token(r)})`, r, l]);
      else rules.push([`(${token(l)})\\s*-\\s*${name}\\b`, l, r], [`\\b${name}\\s*\\+\\s*(${token(r)})`, r, l]);
      const start = out.indexOf(m[0]) + m[0].length;
      let rest = out.slice(start);
      for (const [pattern, cancelled, kept] of rules)
        if (literal.test(cancelled) || simple.test(cancelled))
          rest = rest.replace(new RegExp(`${before}${pattern}${after}`, 'g'), (whole, c) =>
            same(c, cancelled) ? `(${kept})` : whole,
          );
      out = out.slice(0, start) + rest;
    }
    // Inline: (L + e) - L and (e + L) - L for a name or literal e.
    return out.replace(
      new RegExp(
        String.raw`${before}\(\s*(?:(${num})\s*\+\s*([\w.]+)|([\w.]+)\s*\+\s*(${num}))\s*\)\s*-\s*(${num})${after}`,
        'g',
      ),
      (whole, l1, e1, e2, l2, c) => (value(l1 ?? l2) === value(c) ? `(${e1 ?? e2})` : whole),
    );
  };
  // Factoring: a sum with a term that is a name x and another term that is a product with x as a factor becomes
  // x * (1.0 + the rest of the product), as Mesa's Intel compiler factored h + (l (1 - w / 2) + (h w) p) in
  // preciseSin's kernel into h (1 + w p) + l (1 - w / 2) and so lost the low bits of the polynomial term (bug 29).
  // Sums in parentheses are flattened first (the compiler reassociates them), every parenthesised group and call
  // argument is factored too, and only one pair per sum. Sums with an integer literal, or with a comparison, logical,
  // bitwise or select operator at their level, are left alone.
  const binary = (e, i) => /[\w.)\]]\s*$/.test(e.slice(0, i)) && !/(?<![\w.])[\d.]+[eE]$/.test(e.slice(0, i));
  /** The top-level pieces of `e` between the operators in `ops`: [operator ('' first), text]. */
  const pieces = (e, ops) => {
    const out = [];
    let depth = 0,
      start = 0,
      op = '';
    for (let i = 0; i < e.length; i++) {
      const ch = e[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0 && ops.includes(ch) && binary(e, i)) {
        out.push([op, e.slice(start, i).trim()]);
        op = ch;
        start = i + 1;
      }
    }
    out.push([op, e.slice(start).trim()]);
    return out;
  };
  /** `e` without the parentheses around all of it, or `e`. */
  const unwrap = (e) => {
    if (e[0] !== '(') return e;
    let depth = 0;
    for (let i = 0; i < e.length; i++) {
      depth += e[i] === '(' ? 1 : e[i] === ')' ? -1 : 0;
      if (depth === 0) return i === e.length - 1 ? e.slice(1, -1).trim() : e;
    }
    return e;
  };
  const topLevel = (e) => {
    let depth = 0,
      s = '';
    for (const ch of e) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0) s += ch;
    }
    return s;
  };
  /** The factors of a product term (products in parentheses flattened), or [] when it is not one. */
  const factorsOf = (t) => {
    const parts = pieces(unwrap(t), '*');
    if (parts.length < 2) return [];
    return parts.flatMap(([, p]) => {
      const inner = unwrap(p);
      return inner !== p && pieces(inner, '+-').length === 1 && pieces(inner, '*').length > 1 ? factorsOf(inner) : [p];
    });
  };
  const name = /^[A-Za-z_][\w.]*$/;
  const factorSum = (e) => {
    if (/[<>=!&|^%?]/.test(topLevel(e)) || /(?<![\w.])\d+[ui]\b/.test(e)) return e;
    const terms = [];
    for (const [op, t] of pieces(e, '+-')) {
      const inner = unwrap(t),
        sum = inner !== t && op !== '-' ? pieces(inner, '+-') : [];
      if (sum.length > 1) terms.push(...sum.map(([o, s], k) => [k ? o : op, s]));
      else terms.push([op, t]);
    }
    for (let i = 0; i < terms.length; i++) {
      if (terms[i][0] === '-' || !name.test(terms[i][1])) continue;
      for (let j = 0; j < terms.length; j++) {
        const factors = j === i ? [] : factorsOf(terms[j][1]),
          k = factors.indexOf(terms[i][1]);
        if (k < 0) continue;
        const rest = factors.filter((_, n) => n !== k).join(' * '),
          sign = terms[j][0] === '-' ? '-' : '+',
          at = Math.min(i, j);
        terms[at] = [terms[at][0], `${terms[i][1]} * (1.0 ${sign} ${rest})`];
        terms.splice(Math.max(i, j), 1);
        return terms.map(([op, t], n) => (n ? ` ${op} ${t}` : op === '-' ? `-${t}` : t)).join('');
      }
    }
    return e;
  };
  /** `e` with every parenthesised group (each call argument alone) factored, then its own sum. */
  const factorExpression = (e) => {
    let out = '',
      last = 0;
    for (let i = 0; i < e.length; i++) {
      if (e[i] !== '(') continue;
      let depth = 0,
        j = i;
      for (; j < e.length; j++) {
        depth += e[j] === '(' ? 1 : e[j] === ')' ? -1 : 0;
        if (depth === 0) break;
      }
      const inner = e.slice(i + 1, j),
        args = pieces(inner, ',').map(([, a]) => a),
        done = args.map(factorExpression);
      if (done.some((a, n) => a !== args[n])) {
        out += `${e.slice(last, i)}(${done.join(', ')})`;
        last = j + 1;
      }
      i = j;
    }
    const nested = out ? out + e.slice(last) : e;
    return factorSum(nested.trim()) === nested.trim() ? nested : factorSum(nested.trim());
  };
  const factor = (code) =>
    code.replace(/(\breturn\b|(?<![<>=!+\-*/%&|^])=(?!=))([^;{}]+);/g, (whole, head, e) => {
      const done = factorExpression(e.trim());
      return done === e.trim() ? whole : `${head} ${done};`;
    });
  const fold = (code) =>
    code
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, '')
      .split(/(?=\bfn\s)/)
      .map((f) => factor(foldFunction(f)))
      .join('');
  const original = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (descriptor) {
    return original.call(this, { ...descriptor, code: fold(descriptor.code) });
  };
}

/**
 * Page init script for a slow CPU: every message a Worker posts to the page arrives `ms` later (the `onmessage` and
 * `addEventListener('message')` handlers run late; the messages are unchanged). A check that waits a fixed number of
 * frames for meshes or decodes from workers fails here as it would on a slower machine. `openBrowser({
 * workerDelayMs })`, MARGO_WORKER_DELAY_MS or `--worker-delay=<ms>` (the `:slow-mesh` scripts).
 */
export function delayWorkerMessages(ms) {
  if (typeof Worker === 'undefined') return;
  const proto = Worker.prototype,
    property = Object.getOwnPropertyDescriptor(proto, 'onmessage'),
    handlers = new WeakMap(),
    late = (target, handler) => (event) => setTimeout(() => handler.call(target, event), ms);
  if (property?.set)
    Object.defineProperty(proto, 'onmessage', {
      configurable: true,
      enumerable: property.enumerable,
      get() {
        return handlers.get(this) ?? null;
      },
      set(handler) {
        handlers.set(this, handler);
        property.set.call(this, typeof handler === 'function' ? late(this, handler) : handler);
      },
    });
  const add = proto.addEventListener;
  proto.addEventListener = function (type, listener, options) {
    if (type !== 'message' || typeof listener !== 'function') return add.call(this, type, listener, options);
    return add.call(this, type, late(this, listener), options);
  };
}

export async function openBrowser({
  browserName = 'chromium',
  channel,
  args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [],
  powerPreference = process.env.GPU_POWER ?? 'high-performance',
  firefoxUserPrefs = {},
  startPath = '/tests/modern.html',
  aliases = {},
  plugins = [],
  headless = true,
  port = 5193,
  pipelineDelayMs = Number(
    process.env.MARGO_PIPELINE_DELAY_MS ??
      process.argv.find((a) => a.startsWith('--pipeline-delay='))?.slice('--pipeline-delay='.length) ??
      0,
  ),
  workerDelayMs = Number(
    process.env.MARGO_WORKER_DELAY_MS ??
      process.argv.find((a) => a.startsWith('--worker-delay='))?.slice('--worker-delay='.length) ??
      0,
  ),
  mathErrorScale = Number(
    process.env.MARGO_SPEC_MATH_ERROR ??
      process.argv.find((a) => a.startsWith('--spec-math-error='))?.slice('--spec-math-error='.length) ??
      0,
  ),
  reassociate = process.env.MARGO_REASSOCIATE_MATH === '1' || process.argv.includes('--reassociate-math'),
  compat = compatRun(),
  // A caller that tests the browser harness or the page, not the GPU (tests/page-ready.test.js), runs on whatever adapter
  // the machine has, including a software one on a runner without a GPU.
  softwareAdapterOk = false,
} = {}) {
  await mkdir('test-results', { recursive: true });
  const { server, close: stopServer } = await startDevServer({ startPath, aliases, plugins, port }),
    serverErrors = [];
  const closeServer = async () => {
    await stopServer();
    if (serverErrors.length)
      console.error(`dev server errors the page received:\n  ${serverErrors.slice(0, 20).join('\n  ')}`);
  };
  let browser;
  try {
    if (!['chromium', 'firefox', 'webkit'].includes(browserName)) throw new TypeError('Unsupported browser');
    if (browserName === 'chromium') {
      // MARGO_BROWSER / --browser / BROWSER_CHANNEL pick the browser (scripts/lib/browser.mjs); `channel` overrides them.
      browser = await launchBrowser({ name: channel, args, headless });
    } else
      browser = await { firefox, webkit }[browserName].launch({
        headless,
        ...(browserName === 'firefox' ? { firefoxUserPrefs } : {}),
      });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(30000);
    // Every shader module the page creates is compiled for diagnostics; close() fails on a WGSL error.
    await page.addInitScript(wgslGuard);
    // A device the driver takes away (a GPU reset) fails the next wait at once, naming the loss (support/device-loss.js).
    await page.addInitScript(deviceLossGuard);
    const deviceLoss = watchDeviceLoss(page);
    if (pipelineDelayMs > 0) await page.addInitScript(delayPipelines, pipelineDelayMs);
    if (mathErrorScale > 0) await page.addInitScript(perturbBuiltinMath, mathErrorScale);
    if (reassociate) await page.addInitScript(reassociateMath);
    if (workerDelayMs > 0) await page.addInitScript(delayWorkerMessages, workerDelayMs);
    // After the delay, so the count of pipelines in flight includes it (scripts/support/gpu-ready.js).
    await page.addInitScript(trackPipelines);
    // Forced compatibility: the page's WebGPU runs on the WebGL2 layer (scripts/support/compat-shim.js).
    if (compat) await page.addInitScript(compatShim);
    const wgsl = watchWgsl(page);
    let reloads = 0,
      handledReloads = 0;
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        try {
          if (JSON.parse(String(payload)).type === 'full-reload') reloads++;
        } catch {
          // Other application sockets may send non-JSON messages.
        }
      }),
    );
    // A module the dev server fails to serve stops the page's imports with no page error, and the suite only sees a
    // wait time out (bug 26): every 5xx the dev server answers is printed when the suite closes.
    const origin = `http://127.0.0.1:${server.config.server.port}`;
    page.on('response', (response) => {
      if (response.status() >= 500 && response.url().startsWith(origin))
        serverErrors.push(`${response.status()} ${response.statusText()} ${response.url()}`);
    });
    await page.goto(`${origin}${startPath}`);
    const probeHardware = () =>
      page.evaluate(async (powerPreference) => {
        const canvas = document.createElement('canvas'),
          gl = canvas.getContext('webgl2', { powerPreference }),
          ext = gl?.getExtension('WEBGL_debug_renderer_info');
        const webgl = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference });
        const gpu = adapter?.info;
        return {
          webglRenderer: webgl,
          webgpu: gpu
            ? {
                vendor: gpu.vendor,
                architecture: gpu.architecture,
                device: gpu.device,
                description: gpu.description,
                fallback: gpu.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
              }
            : null,
          userAgent: navigator.userAgent,
        };
      }, powerPreference);
    let hardware;
    for (let attempt = 0; ; attempt++) {
      try {
        hardware = await probeHardware();
        break;
      } catch (error) {
        // Vite may finish a newly discovered dependency batch after the initial load event.
        // Retry only that confirmed startup reload, never product navigation or adapter errors.
        if (attempt >= 2 || reloads === handledReloads || !String(error).includes('Execution context was destroyed'))
          throw error;
        handledReloads = reloads;
        await page.waitForLoadState('load');
        await server.waitForRequestsIdle();
      }
    }
    if (browserName === 'chromium' && !softwareAdapterOk) {
      // A real-GPU check never runs on SwiftShader by accident (MARGO_SOFTWARE_GPU=1 or an explicit
      // --use-webgpu-adapter=swiftshader in BROWSER_ARGS asks for it).
      const refusal = softwareAdapterReason(resolveBrowser({ name: channel }), hardware.webgpu, { args });
      if (refusal) throw new Error(refusal);
    }
    // MARGO_BROWSER=webkit or firefox reaches a non-Chromium engine through the default 'chromium' launch path, so
    // the engine resolved from the environment is the one named here (it said 'chromium' for WebKit before 2026-11-10).
    hardware.browserName = browserName === 'chromium' ? resolveBrowser({ name: channel }).engine : browserName;
    hardware.browserVersion = browser.version();
    hardware.requestedChannel =
      browserName === 'chromium' ? (resolveBrowser({ name: channel }).channel ?? 'bundled') : null;
    hardware.launchArgs = browserName === 'chromium' ? args : [];
    hardware.powerPreference = powerPreference;
    hardware.hostPlatform = process.platform;
    hardware.headless = headless;
    if (compat) hardware.compat = true;
    if (pipelineDelayMs > 0) hardware.pipelineDelayMs = pipelineDelayMs;
    if (mathErrorScale > 0) hardware.mathErrorScale = mathErrorScale;
    if (reassociate) hardware.reassociateMath = true;
    if (workerDelayMs > 0) hardware.workerDelayMs = workerDelayMs;
    if (browserName === 'firefox') hardware.firefoxUserPrefs = firefoxUserPrefs;
    if (process.env.GPU_VENDOR) {
      assert.ok(
        hardware.webglRenderer?.toLowerCase().includes(process.env.GPU_VENDOR.toLowerCase()),
        'WebGL used the wrong physical adapter',
      );
      assert.equal(
        hardware.webgpu?.vendor,
        process.env.GPU_VENDOR.toLowerCase(),
        'WebGPU used the wrong physical adapter',
      );
      assert.equal(hardware.webgpu.fallback, false, 'Software WebGPU adapter selected');
    }
    return {
      page,
      server,
      hardware,
      wgsl,
      deviceLoss,
      async close() {
        // Compilation info arrives asynchronously: wait for every report (wgsl-guard keeps them) before reading them.
        // Bounded: a report that never arrives fails the close naming its module, after the browser and server close.
        let unsettled;
        try {
          await traceShutdown('WGSL compile reports', async () => {
            await settleWgslReports(page);
          });
        } catch (error) {
          unsettled = error;
        }
        try {
          await closeAll({ browser });
        } finally {
          await closeServer();
        }
        if (unsettled) throw unsettled;
        if (wgsl.modules.size)
          console.log(`WGSL: ${wgsl.modules.size} distinct shader modules compiled, ${wgsl.errors.length} errors`);
        if (wgsl.errors.length) throw new Error(`WGSL compile errors:\n${wgsl.errors.slice(0, 20).join('\n')}`);
        if (wgsl.unexpected.length)
          throw new Error(`WGSL modules labelled expect-error compiled cleanly: ${wgsl.unexpected.join(', ')}`);
      },
    };
  } catch (error) {
    try {
      await closeAll({ browser });
    } finally {
      await closeServer();
    }
    throw error;
  }
}
