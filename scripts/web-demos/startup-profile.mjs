#!/usr/bin/env node
// Startup profile of one web demo: node scripts/web-demos/startup-profile.mjs <demo> [--backend=webgl2|webgpu] [--root=<demos dir>]
// [--cpu] [--trace=<file>] [--timeout=<ms>]
// Times every WebGL2 call that can wait on the GPU process, counts calls, records long tasks and time to data-ready,
// and (with --cpu) aggregates a sampled CPU profile of the page's main thread by function self time.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const demo = args.find((a) => !a.startsWith('--'));
const backend = opt('backend', 'webgl2');
const root = path.resolve(opt('root', path.resolve(import.meta.dirname, '../../demos')));
const timeout = Number(opt('timeout', 300000));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.bin': 'application/octet-stream', '.glb': 'model/gltf-binary', '.hdr': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file.startsWith(root) || !fs.existsSync(file)) return res.writeHead(404), res.end();
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.listen(0);
const port = server.address().port;

const instrument = () => {
  const stats = (window.__gl = { calls: {}, slow: [], programs: [], t0: performance.now(), longtasks: [] });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) stats.longtasks.push([Math.round(e.startTime), Math.round(e.duration)]);
  }).observe({ type: 'longtask', buffered: true });
  const P = WebGL2RenderingContext.prototype;
  const names = ['linkProgram', 'compileShader', 'getProgramParameter', 'getShaderParameter', 'getUniformBlockIndex',
    'getActiveUniformBlockParameter', 'getUniformLocation', 'getAttribLocation', 'getActiveUniform', 'texImage2D', 'texImage3D',
    'texSubImage2D', 'texSubImage3D', 'texStorage2D', 'texStorage3D', 'bufferData', 'bufferSubData', 'readPixels',
    'getBufferSubData', 'clientWaitSync', 'getSyncParameter', 'checkFramebufferStatus', 'getError', 'drawArrays',
    'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'finish', 'flush', 'useProgram', 'getProgramInfoLog',
    'getShaderInfoLog', 'shaderSource', 'isContextLost', 'getParameter', 'getExtension', 'copyBufferSubData', 'fenceSync',
    'getQueryParameter', 'generateMipmap', 'blitFramebuffer', 'framebufferTexture2D', 'framebufferTextureLayer', 'clearBufferfv'];
  for (const n of names) {
    const f = P[n];
    if (!f) continue;
    P[n] = function (...a) {
      const s = performance.now();
      const r = f.apply(this, a);
      const d = performance.now() - s;
      const k = n === 'getProgramParameter' ? `${n}:${a[1]}` : n;
      const c = (stats.calls[k] ??= [0, 0]);
      c[0]++;
      c[1] += d;
      if (d > 150) stats.slow.push([k, Math.round(s), Math.round(d), new Error().stack.split('\n').slice(2, 6).join(' | ')]);
      return r;
    };
  }
  const shaderSource = P.shaderSource;
  const sources = new WeakMap(), programInfo = new WeakMap(), drawn = new WeakSet();
  let current = null, fresh = [];
  P.shaderSource = function (s, src) {
    stats.programs.push(src.length);
    sources.set(s, src);
    return shaderSource.call(this, s, src);
  };
  const attach = P.attachShader;
  P.attachShader = function (p, s) {
    const src = sources.get(s) ?? '';
    const info = programInfo.get(p) ?? {};
    if (!/gl_Position/.test(src)) {
      info.fragment = src.length;
      info.outputs = (src.match(/layout\s*\(\s*location\s*=\s*\d+\s*\)\s*out/g) ?? []).length;
      info.names = [...src.matchAll(/uniform\s+(\w+)\s*\{/g)].map((m) => m[1]).slice(0, 4).join(',');
    } else info.vertex = src.length;
    programInfo.set(p, info);
    return attach.call(this, p, s);
  };
  const use = P.useProgram;
  P.useProgram = function (p) { current = p; return use.call(this, p); };
  for (const n of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
    const f = P[n];
    P[n] = function (...a) {
      if (current && !drawn.has(current)) { drawn.add(current); fresh.push(programInfo.get(current) ?? {}); }
      return f.apply(this, a);
    };
  }
  for (const n of ['checkFramebufferStatus', 'getBufferSubData', 'readPixels', 'getProgramParameter', 'getUniformBlockIndex', 'clientWaitSync']) {
    const f = P[n];
    P[n] = function (...a) {
      const s = performance.now(), r = f.apply(this, a), d = performance.now() - s;
      if (d > 150) stats.firstDraws = [...(stats.firstDraws ?? []), [n, Math.round(d), fresh]];
      fresh = [];
      return r;
    };
  }
};

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu', '--window-size=1500,1000', '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(instrument);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  let cdp;
  if (args.includes('--cpu')) {
    cdp = await context.newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cdp.send('Profiler.start');
  }
  if (opt('trace')) await browser.startTracing(page, { path: opt('trace'), categories: ['devtools.timeline', 'gpu', 'gpu.angle', 'toplevel', 'disabled-by-default-gpu.angle', 'gpu.service'] });
  const start = Date.now();
  await page.goto(`http://localhost:${port}/${demo}/${backend === 'webgl2' ? '?backend=webgl2' : ''}`);
  const marks = [];
  const deadline = start + timeout;
  let state = '';
  while (Date.now() < deadline) {
    state = await page.evaluate(() => document.body.dataset.ready ?? document.querySelector('[data-state]')?.dataset.state ?? '').catch(() => '');
    if (state === 'true' || state === 'ready' || state === 'error') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const ready = (Date.now() - start) / 1000;
  marks.push(['ready', ready, state]);
  const gl = await page.evaluate(() => {
    const s = window.__gl;
    return { firstDraws: s.firstDraws, calls: s.calls, slow: s.slow, shaders: s.programs.length, shaderChars: s.programs.reduce((a, b) => a + b, 0), biggest: [...s.programs].sort((a, b) => b - a).slice(0, 8), longtasks: s.longtasks };
  });
  if (opt('trace')) await browser.stopTracing();
  const out = { demo, backend, root, ready, state, errors: errors.slice(0, 5), shaders: gl.shaders, shaderChars: gl.shaderChars, biggest: gl.biggest };
  const top = Object.entries(gl.calls).sort((a, b) => b[1][1] - a[1][1]).slice(0, 18).map(([k, [n, ms]]) => `${k} x${n} ${Math.round(ms)} ms`);
  const lt = gl.longtasks;
  out.longtasks = { count: lt.length, totalMs: lt.reduce((a, b) => a + b[1], 0), top: [...lt].sort((a, b) => b[1] - a[1]).slice(0, 8) };
  out.glTop = top;
  out.firstDraws = gl.firstDraws;
  out.slow = gl.slow.sort((a, b) => b[2] - a[2]).slice(0, 15);
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    const self = new Map();
    const dt = new Map();
    const ids = profile.samples;
    for (let i = 0; i < ids.length; i++) dt.set(ids[i], (dt.get(ids[i]) ?? 0) + (profile.timeDeltas[i + 1] ?? 0));
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    for (const [id, us] of dt) {
      const n = byId.get(id), f = n.callFrame;
      const key = `${f.functionName || '(anon)'} ${path.basename(f.url || '')}:${f.lineNumber}`;
      self.set(key, (self.get(key) ?? 0) + us / 1000);
    }
    out.cpuSelf = [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, ms]) => `${Math.round(ms)} ms ${k}`);
    if (opt('cpuprofile')) fs.writeFileSync(opt('cpuprofile'), JSON.stringify(profile));
  }
  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
  server.close();
}
