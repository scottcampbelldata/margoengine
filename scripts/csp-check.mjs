// Serves built apps with the headers from their own _headers file (Cloudflare Pages / Netlify syntax) and loads each
// page in a real browser, failing on any CSP violation, page error or failed feature. Checks docs/deploying.md.
// After `npm run build:packages` and `npm run build:site`, on AC power, under the GPU lock:
//   node scripts/gpu-lock.mjs run --owner=<id> -- node scripts/csp-check.mjs     harness, create-margo app, site/dist
//   node scripts/csp-check.mjs harness    any subset of: harness app site
// CSP_OVERRIDE='<policy>' replaces the CSP on every response (to show what a missing directive breaks).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {extname, join, resolve, sep} from 'node:path';
import {chromium} from '@playwright/test';
import {build} from 'vite';
import {onAC} from './quiet-gate.mjs';

const root = resolve(import.meta.dirname, '..'), out = join(root, 'test-results/csp-check');
const only = process.argv.slice(2), want = name => !only.length || only.includes(name);
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.ktx2': 'image/ktx2', '.hdr': 'image/vnd.radiance',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml', '.stp': 'application/octet-stream'};

/** _headers rules: [pattern RegExp, [[name, value] | ['!', name]]]. `*` is a splat, `:name` one path segment. */
export function parseHeaders(text) {
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {rules.push([new RegExp('^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:\w+/g, '[^/]+') + '$'), []]); continue;}
    const entry = line.trim(), detach = entry.startsWith('!');
    rules.at(-1)[1].push(detach ? ['!', entry.slice(1).trim()] : [entry.slice(0, entry.indexOf(':')).trim(), entry.slice(entry.indexOf(':') + 1).trim()]);
  }
  return rules;
}
/** Cloudflare Pages semantics: every matching rule applies in order; repeats join with ", "; `! Name` removes. */
export function headersFor(rules, pathname) {
  const headers = new Map();
  for (const [pattern, entries] of rules) if (pattern.test(pathname)) for (const [name, value] of entries) {
    const key = (name === '!' ? value : name).toLowerCase();
    if (name === '!') headers.delete(key); else headers.set(key, headers.has(key) ? `${headers.get(key)}, ${value}` : value);
  }
  return headers;
}

function serve(dir) {
  const rules = existsSync(join(dir, '_headers')) ? parseHeaders(readFileSync(join(dir, '_headers'), 'utf8')) : [];
  const server = createServer((request, response) => {
    let pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname), file = resolve(dir, '.' + pathname);
    if (!file.startsWith(resolve(dir) + sep) && file !== resolve(dir)) {response.writeHead(404).end(); return;}
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {response.writeHead(404).end('Not found'); return;}
    const headers = {'Content-Type': types[extname(file)] ?? 'application/octet-stream', ...Object.fromEntries(headersFor(rules, pathname))};
    if (process.env.CSP_OVERRIDE) headers['content-security-policy'] = process.env.CSP_OVERRIDE; // negative checks: one policy on every file
    response.writeHead(200, headers).end(readFileSync(file));
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done(server)));
}

async function visit(browser, origin, path, ready) {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}}), problems = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Log.enable');
  cdp.on('Log.entryAdded', ({entry}) => {if (entry.source === 'security' || /Content.Security.Policy|Refused to/i.test(entry.text)) problems.push(`log: ${entry.text}`);});
  const watch = source => m => {if (/Content.Security.Policy|Refused to/i.test(m.text())) problems.push(`${source}: ${m.text()}`);};
  page.on('console', watch('console'));
  page.on('worker', worker => worker.on('console', watch(`worker ${worker.url().split('/').pop()}`)));
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => addEventListener('securitypolicyviolation', e => console.error(`Refused to load (Content Security Policy) ${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`)));
  const response = await page.goto(origin + path);
  const csp = response.headers()['content-security-policy'] ?? '(none)';
  const result = await ready(page).catch(error => ({ok: false, error: error.message}));
  await page.waitForTimeout(500);
  await page.close();
  return {path, csp, result, problems: [...new Set(problems)]};
}

const builds = [];
if (want('harness')) {
  const dist = join(out, 'harness');
  await build({configFile: false, root: join(root, 'scripts/csp-check'), base: './', logLevel: 'warn', build: {outDir: dist, emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0}});
  // The harness ships the create-margo headers plus the eval-worker rules docs/deploying.md gives for Draco/KTX2 and STEP/IGES.
  copyFileSync(join(root, 'tools/create-margo/template/public/_headers'), join(dist, '_headers'));
  appendFileSync(join(dist, '_headers'), readFileSync(join(root, 'scripts/csp-check/eval-workers.headers')));
  builds.push({name: 'harness', dist, pages: [['/', page => page.waitForFunction(() => window.cspCheck, null, {timeout: 120_000}).then(h => h.jsonValue())]]});
}
if (want('app')) {
  const app = join(out, 'app'); rmSync(app, {recursive: true, force: true}); mkdirSync(out, {recursive: true});
  execFileSync(process.execPath, [join(root, 'tools/create-margo/index.js'), app]);
  const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  mkdirSync(join(app, 'node_modules/@margoengine'), {recursive: true});
  for (const name of [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)]) symlinkSync(join(root, 'node_modules', name), join(app, 'node_modules', name), 'junction');
  await build({configFile: false, root: app, logLevel: 'warn'});
  builds.push({name: 'app', dist: join(app, 'dist'), pages: [['/', async page => {
    await page.waitForTimeout(4000);
    const error = await page.locator('#error').textContent();
    return {ok: !error && await page.evaluate(() => [...document.body.children].some(e => e.tagName === 'DIV' && /FPS|ms/.test(e.textContent))), error};
  }]]});
}
if (want('site')) {
  const dist = join(root, 'site/dist');
  assert.ok(existsSync(join(dist, '_headers')), 'run npm run build:site first');
  const settle = ms => async page => {await page.waitForTimeout(ms); return {ok: true};};
  builds.push({name: 'site', dist, pages: ['/', '/catalog/', '/night-citadel/', '/gameplay-sandbox/', '/demos/flight-helmet.html', '/demos/character-animation.html',
    '/demos/robot-expressive.html', '/demos/windy-meadow.html', '/demos/tokyo-diorama.html', '/demos/earth/', '/demos/dof/', '/demos/tonemap/'].map(path => [path, settle(path === '/' || path === '/catalog/' ? 1500 : 8000)])});
}

if (!onAC()) throw new Error('On battery: refusing to start a browser run');
let failed = 0;
const report = {date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), override: process.env.CSP_OVERRIDE ?? null, pages: []};
{
  const browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true, args: ['--enable-unsafe-webgpu']});
  report.browser = `${process.env.BROWSER_CHANNEL ?? 'msedge'} ${browser.version()}`;
  try {
    for (const {name, dist, pages} of builds) {
      const server = await serve(dist), origin = `http://127.0.0.1:${server.address().port}`;
      try {
        for (const [path, ready] of pages) {
          const r = await visit(browser, origin, path, ready), ok = r.result?.ok !== false && !r.problems.length;
          if (!ok) failed++;
          report.pages.push({build: name, ok, ...r});
          console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${path}\n  CSP: ${r.csp}\n  result: ${JSON.stringify(r.result)}${r.problems.map(p => '\n  ' + p).join('')}`);
        }
      } finally {server.close();}
    }
  } finally {await browser.close();}
  if (!onAC()) throw new Error('Lost AC power during the run: discard it');
}
report.acPower = 'before and after';
// The full default run is the committed evidence for docs/deploying.md (docs/whitepaper/claims.md DOC-072).
if (!only.length && !report.override) writeFileSync(join(root, 'examples/package-benchmarks/results/csp-check.json'), JSON.stringify(report, null, 1) + '\n');
console.log(failed ? `${failed} page(s) failed` : 'csp-check passed: zero CSP violations');
process.exitCode = failed ? 1 : 0;
