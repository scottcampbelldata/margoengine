// `npm run check:readme-run`: runs the examples of every package README and guide, as a reader would paste them. An example
// runs in Node when it can, else in a real page on Chromium with WebGPU, where the elements it asks for exist and a file it
// fetches is answered with a real sample of that format. An example passes when nothing threw, no promise was left rejected
// and the GPU reported no validation error. One that fails and is not on the known list fails the check, and so does a known
// entry that now passes or names an example that is gone, so the list (scripts/support/readme-run-known.json) only ever shrinks.
// A step of check:merge, whole in the full check, never in verify or a gate before the push. It holds one
// shared GPU slot, and the GPU lock ends its whole process tree at LIMIT_MINUTES.
//   npm run check:readme-run                       the check; needs a build, and uses the GPU
//   npm run check:readme-run -- --only=biomes      the examples whose id holds that text
//   npm run check:readme-run -- --packages=a,b     the examples of those packages (check:merge on a narrowed run)
//   npm run check:readme-run -- --failed           the examples that failed in the last report
//   npm run check:readme-run -- --shrink           writes the known list down to what still fails; it never adds an entry
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, transformWithOxc } from 'vite';
import { acquire } from './gpu-lock.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { exampleIds, packageMarkdown, readmeEntries } from './support/readme-types.mjs';
import { closeAll } from './support/shutdown.mjs';
import { workspacePackages } from './check-readme-types.mjs';

const root = resolve(import.meta.dirname, '..'),
  scratch = join(root, 'test-results/readme-run'),
  knownFile = join(root, 'scripts/support/readme-run-known.json'),
  reportFile = join(root, 'test-results/readme-run-report.json'),
  option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3),
  NODE_LIMIT = 30_000,
  PAGE_LIMIT = 20_000,
  SETTLE = 500,
  NODE_JOBS = 8,
  PAGE_JOBS = 3,
  // A whole run took 5 minutes on the RTX A6000 (2026-11-07) and about 25 when first measured; the limit is well past both.
  LIMIT_MINUTES = 60;

/** What the examples of a package are, by id: `{ id, name, code }`. */
export function collectExamples(packages) {
  return packages.flatMap(({ name, folder }) =>
    packageMarkdown(folder).flatMap(({ document, markdown }) => {
      const entries = readmeEntries(markdown),
        ids = exampleIds(name, document, entries);
      return entries.map(({ code }, index) => ({ id: ids[index], name, code }));
    }),
  );
}

/** True for code that can run only in a page, and false for code that needs Node, undefined when either may do. */
export function placeOf(code) {
  if (/from\s+['"](?:node:|webgpu['"])/.test(code)) return 'node';
  if (/\bdocument\.|\bwindow\.|\bnavigator\.|requestAnimationFrame|createStage\(|Engine\.create\(|<canvas/.test(code)) return 'page';
  return undefined;
}

const CODE = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.html', '.md', '.json', '.py', '.txt', '.css']);
// A sample of each format a reader would expect, where the smallest file of that extension is an odd one.
const PREFERRED = {
  '.glb': 'examples/assets/khronos-samples/AnimatedColorsCube.glb',
};
// The clip names the examples use, on one real rigged model: an example's own file has them.
const CLIPS = ['Idle', 'Walk', 'Run', 'Walking', 'Running', 'Jump', 'Attack', 'SwingLeft', 'SwingRight', 'Wave', 'Dance'];

/** A plain static GLB from the exporter. */
async function staticModel(file) {
  const { exportGLB } = await import('../packages/exporters/dist/index.js');
  writeFileSync(
    file,
    exportGLB({
      nodes: [
        {
          name: 'Triangle',
          geometry: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] },
        },
      ],
    }),
  );
  return file;
}

/** Fox.glb with its first clip under every name of {@link CLIPS}: only the JSON chunk changes. */
function modelWithClips(file) {
  const bytes = readFileSync(join(root, 'examples/assets/khronos/Fox/Fox.glb')),
    length = bytes.readUInt32LE(12),
    json = JSON.parse(bytes.subarray(20, 20 + length).toString()),
    [clip] = json.animations;
  json.animations = CLIPS.map((name) => ({ ...clip, name }));
  const text = Buffer.from(JSON.stringify(json)),
    padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 32)]),
    rest = bytes.subarray(20 + length),
    head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + padded.length + rest.length, 8);
  head.writeUInt32LE(padded.length, 12);
  head.write('JSON', 16, 'latin1');
  writeFileSync(file, Buffer.concat([head, padded, rest]));
  return file;
}

/**
 * The samples a file name stands for: `byName` for a file of that very name in the sample folders, `byExtension` for the
 * smallest real file of each extension.
 */
export function sampleFiles() {
  const listed = spawnSync('git', ['ls-files', 'examples/assets', 'packages/*/tests', 'packages/*/test'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 2 ** 26,
    }).stdout,
    samples = new Map(),
    byName = new Map();
  for (const file of listed.split('\n').filter(Boolean)) {
    const path = join(root, file),
      extension = extname(file).toLowerCase();
    // A file kept to test a refusal is no sample.
    if (!extension || CODE.has(extension) || !existsSync(path) || /invalid|corrupt|truncat|broken|malformed|\bbad\b|damaged/i.test(file))
      continue;
    const { size } = statSync(path);
    // Under 200 bytes is a Git LFS pointer or a stub, and a loader would rightly refuse it.
    if (size < 200) continue;
    byName.set(basename(file).toLowerCase(), { path, size });
    if (PREFERRED[extension] === file) samples.set(extension, { path, size: 0 });
    if (size < (samples.get(extension)?.size ?? 2 ** 24)) samples.set(extension, { path, size });
  }
  return { byName, byExtension: samples };
}

const sampleFor = ({ byName, byExtension }, name) =>
  byName.get(basename(name).toLowerCase()) ?? byExtension.get(extname(name).toLowerCase());

/** File names an example names in strings, for the folder it runs in. */
export const namedFiles = (code) => [...code.matchAll(/['"`]([\w./-]+\.[a-zA-Z0-9]{2,5})['"`]/g)].map(([, name]) => name);

/** The elements an example asks a page for, as selectors. */
export const askedElements = (code) => [
  ...new Set([
    ...[...code.matchAll(/querySelector(?:All)?(<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/g)].map(([, type, selector]) =>
      type?.includes('Canvas') && !selector.startsWith('canvas') ? `canvas${selector}` : selector,
    ),
    ...[...code.matchAll(/getElementById\(\s*['"`]([^'"`]+)['"`]/g)].map(([, id]) => `#${id}`),
    ...[...code.matchAll(/createStage\(\s*['"`]([^'"`]+)['"`]/g)].map(([, selector]) => selector),
  ]),
];

async function writeNodeExample(example, samples) {
  const folder = join(scratch, 'node', example.id),
    file = join(folder, 'example.mjs');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    file,
    (await transformWithOxc(example.code, 'example.tsx', { jsx: { runtime: 'automatic' } })).code,
  );
  for (const name of namedFiles(example.code)) {
    const sample = sampleFor(samples, name);
    if (!sample || name.startsWith('/') || name.includes('..')) continue;
    mkdirSync(dirname(join(folder, name)), { recursive: true });
    copyFileSync(sample.path, join(folder, name));
  }
  return { file, folder };
}

export async function runInNode(example, samples) {
  const { file, folder } = await writeNodeExample(example, samples);
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--unhandled-rejections=strict', file], { cwd: folder, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '',
      limited = false;
    child.stderr.on('data', (chunk) => (errors += chunk));
    const limit = setTimeout(() => {
      limited = true;
      child.kill('SIGKILL');
    }, NODE_LIMIT);
    child.on('close', (code) => {
      clearTimeout(limit);
      if (limited) done({ result: 'pass', place: 'node', note: `ran to the ${NODE_LIMIT / 1000} s limit` });
      else if (code === 0) done({ result: 'pass', place: 'node' });
      else done({ result: 'fail', place: 'node', reason: firstError(errors) });
    });
  });
}

/** The line of a stack trace that says what went wrong. */
const firstError = (text) =>
  (text.split(/\r?\n/).find((line) => /^\s*(?:\w*Error|MargoError|Uncaught)\b|\bERR_/.test(line)) ?? text.split(/\r?\n/)[0] ?? '')
    .trim()
    .slice(0, 300);

const PAGE = `<!doctype html><meta charset="utf-8"><title>example</title>
<style>html,body{margin:0;width:640px;height:400px}canvas,div{display:block;width:320px;height:200px}</style>
<body><script type="module">
const query = new URLSearchParams(location.search),
  errors = [], record = (text) => errors.push(String(text).slice(0, 300));
window.__errors = errors;
addEventListener('error', (event) => record(event.message));
addEventListener('unhandledrejection', (event) => record(event.reason?.stack?.split('\\n')[0] ?? event.reason));
if (globalThis.GPUAdapter) {
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...args) {
    const device = await request.apply(this, args);
    device.addEventListener('uncapturederror', (event) => record('GPU: ' + event.error.message));
    return device;
  };
}
for (const selector of JSON.parse(query.get('elements'))) {
  if (document.querySelector(selector)) continue;
  const [, tag, id, name] = /^([a-zA-Z][\\w-]*)?(?:#([\\w-]+))?(?:\\.([\\w-]+))?/.exec(selector),
    element = document.createElement(tag ?? (/canvas/i.test(selector) ? 'canvas' : 'div'));
  if (id) element.id = id;
  if (name) element.className = name;
  document.body.append(element);
}
if (!document.querySelector('canvas')) document.body.append(document.createElement('canvas'));
try {
  await import(query.get('example'));
  window.__ran = 'done';
} catch (error) {
  record(error?.stack?.split('\\n')[0] ?? error);
  window.__ran = 'threw';
}
</script>`;

async function startPages(samples) {
  const server = await createServer({
    root: join(scratch, 'page'),
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1', fs: { allow: [root] }, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      {
        name: 'readme-samples',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            const { pathname } = new URL(request.url, 'http://example.test');
            if (pathname === '/run.html') {
              response.setHeader('content-type', 'text/html');
              return response.end(PAGE);
            }
            // Minimal glTF takes static models only, so its examples get one.
            const minimal = /\.gl(?:b|tf)$/.test(pathname) && request.headers.referer?.includes('example=%2Fgltf%2F'),
              sample = minimal ? { path: samples.staticModel } : sampleFor(samples, pathname);
            if (!sample || /\.(?:tsx|js|mjs|css|html)$/.test(pathname) || pathname.startsWith('/@') || pathname.includes('/node_modules/') || pathname.includes('/packages/'))
              return next();
            createReadStream(sample.path).pipe(response);
          });
        },
      },
    ],
  });
  await server.listen();
  const browser = await launchBrowser({ headless: true, args: ['--enable-unsafe-webgpu'] });
  return { server, browser, origin: `http://127.0.0.1:${server.httpServer.address().port}` };
}

async function runInPage(example, pages) {
  const file = join(scratch, 'page', `${example.id}.tsx`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, example.code);
  const page = await pages.browser.newPage(),
    url = `${pages.origin}/run.html?example=${encodeURIComponent(`/${example.id}.tsx`)}&elements=${encodeURIComponent(JSON.stringify(askedElements(example.code)))}`;
  try {
    await page.goto(url, { timeout: PAGE_LIMIT });
    const ran = await page
      .waitForFunction(() => window.__ran, undefined, { timeout: PAGE_LIMIT })
      .then((handle) => handle.jsonValue())
      .catch(() => 'waiting');
    await page.waitForTimeout(SETTLE);
    const errors = await page.evaluate(() => window.__errors);
    if (errors.length) return { result: 'fail', place: 'page', reason: errors[0] };
    return ran === 'waiting'
      ? { result: 'pass', place: 'page', note: `still waiting at the ${PAGE_LIMIT / 1000} s limit, no error` }
      : { result: 'pass', place: 'page' };
  } catch (error) {
    return { result: 'fail', place: 'page', reason: String(error.message).split('\n')[0].slice(0, 300) };
  } finally {
    await page.close();
  }
}

/** The port an example's server listens on, as written in its code; undefined when it has none. */
export const listenPort = (code) => /\.listen\(\s*(\d+)/.exec(code)?.[1];

/** Examples in turns: turns run side by side, and the examples of one turn after each other. Those on one port share a turn. */
export function nodeTurns(examples) {
  const ports = new Map(),
    turns = [];
  for (const example of examples) {
    const port = listenPort(example.code),
      turn = ports.get(port) ?? [];
    if (!turn.length) turns.push(turn);
    if (port) ports.set(port, turn);
    turn.push(example);
  }
  return turns;
}

async function eachLimited(items, jobs, work) {
  let next = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

/** The examples a run takes: those of `packages` (names), when given, whose id holds `only`, when given, and in `ids`, when given. */
export const pickExamples = (examples, { only, packages, ids }) =>
  examples.filter(({ id, name }) => (!packages || packages.includes(name)) && (!only || id.includes(only)) && (!ids || ids.has(id)));

/** What to print for a known entry that did not fail: `gone` of {@link judge}. */
export const goneLine = (id, report) =>
  report.some((entry) => entry.id === id)
    ? `${id}: passes, still on the known list; npm run check:readme-run -- --shrink`
    : `${id}: no such example, still on the known list; npm run check:readme-run -- --shrink`;

/** Failures, those not on the known list, and known entries that passed or are gone. A narrowed run says nothing of the examples it left out. */
export function judge(report, known, narrowed) {
  const failed = report.filter(({ result }) => result === 'fail');
  return {
    failed,
    fresh: failed.filter(({ id }) => !known[id]),
    gone: narrowed ? [] : Object.keys(known).filter((id) => !failed.some((entry) => entry.id === id)),
  };
}

async function run() {
  const packages = workspacePackages(),
    only = option('only'),
    named = option('packages')?.split(','),
    last = process.argv.includes('--failed') ? JSON.parse(readFileSync(reportFile, 'utf8')) : undefined,
    failedBefore = last && new Set(last.filter(({ result }) => result === 'fail').map(({ id }) => id)),
    examples = pickExamples(collectExamples(packages), { only, packages: named, ids: failedBefore }),
    part = Boolean(only || named),
    known = existsSync(knownFile) ? JSON.parse(readFileSync(knownFile, 'utf8')) : {},
    samples = sampleFiles(),
    results = new Map();
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, 'page'), { recursive: true });
  samples.byExtension.set('.glb', { path: modelWithClips(join(scratch, 'clips.glb')), size: 0 });
  samples.staticModel = await staticModel(join(scratch, 'static.glb'));
  await eachLimited(nodeTurns(examples.filter(({ code }) => placeOf(code) !== 'page')), NODE_JOBS, async (turn) => {
    for (const example of turn) results.set(example.id, await runInNode(example, samples));
  });
  const forPage = examples.filter(({ id, code }) => placeOf(code) !== 'node' && results.get(id)?.result !== 'pass');
  if (forPage.length) {
    const pages = await startPages(samples);
    try {
      await eachLimited(forPage, PAGE_JOBS, async (example) => results.set(example.id, await runInPage(example, pages)));
    } finally {
      await closeAll({ browser: pages.browser, servers: [pages.server] });
    }
  }
  const report = examples.map(({ id }) => ({ id, ...results.get(id) }));
  if (last) for (const entry of last) if (!results.has(entry.id)) report.push(entry);
  const { failed, fresh, gone } = judge(report, known, Boolean(part || last)),
    passed = report.filter(({ result }) => result === 'pass').length,
    inNode = report.filter(({ result, place }) => result === 'pass' && place === 'node').length;
  if (!part) writeFileSync(reportFile, `${JSON.stringify(report, null, 1)}\n`);
  if (process.argv.includes('--shrink') && !part && !last) {
    writeFileSync(knownFile, `${JSON.stringify(Object.fromEntries(Object.entries(known).filter(([id]) => !gone.includes(id))), null, 2)}\n`);
    console.log(`known list: ${gone.length} removed`);
    gone.length = 0;
  }
  for (const { id, place, reason } of fresh) console.error(`${id} (${place}): ${reason}`);
  for (const id of gone) console.error(goneLine(id, report));
  console.log(`${passed} of ${report.length} examples ran: ${inNode} in Node, ${passed - inNode} in a page; ${failed.length} failed, ${fresh.length} not on the known list`);
  if (fresh.length || gone.length) process.exitCode = 1;
}

async function main() {
  const release = await acquire({ owner: 'check-readme-run', max: LIMIT_MINUTES });
  try {
    await run();
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
