// `npm run check:readme-run`: runs the examples of every package README and guide, as a reader would paste them. An example
// runs in Node when it can, else in a real page on Chromium with WebGPU, where the elements it asks for exist and a file it
// fetches is answered with a real sample of that format. An example passes when nothing threw, no promise was left rejected
// and the GPU reported no validation error. One that fails and is not on the known list fails the check, and so does a known
// entry that now passes or names an example that is gone, so the list (scripts/support/readme-run-known.json) only ever shrinks.
// A step of check:merge, whole in the full check, never in verify or a gate before the push; verify's
// tests/run-readme-examples.test.js does check that every known entry still names an example, as a README edit renames one. It holds one
// shared GPU slot, and the GPU lock ends its whole process tree at LIMIT_MINUTES.
//   npm run check:readme-run                       the check; needs a build, and uses the GPU
//   npm run check:readme-run -- --only=biomes      the examples whose id holds that text
//   npm run check:readme-run -- --packages=a,b     the examples of those packages (check:merge on a narrowed run)
//   npm run check:readme-run -- --failed           the examples that failed in the last report
//   npm run check:readme-run -- --shrink           writes the known list down to what still fails; it never adds an entry
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, transformWithOxc } from 'vite';
import { acquire } from './gpu-lock.mjs';
import { reportSpeedPhase } from './support/speed-phase.mjs';
import { chromiumLaunchOptions, launchBrowser } from './lib/browser.mjs';
import { exampleIds, packageMarkdown, readmeEntries } from './support/readme-types.mjs';
import { closeAll, endTree } from './support/shutdown.mjs';
import { workspacePackages } from './check-readme-types.mjs';
import { headlessReference } from './support/headless-readme.mjs';
import { readmeFixture, readmeNodeEnv, serveSample } from './support/readme-assets.mjs';
import { finishLiveExample, observeLiveExample, serveLiveLink, usesLiveLink } from './support/readme-live.mjs';

const root = resolve(import.meta.dirname, '..'),
  // Each run writes only its own folder: the lock gives a run one shared GPU slot, so two runs in one checkout can overlap,
  // and one that cleared a shared folder deleted the other's example files mid-run (its page then failed to import them).
  scratchBase = join(root, 'test-results/readme-run'),
  scratch = join(scratchBase, `run-${process.pid}`),
  knownFile = join(root, 'scripts/support/readme-run-known.json'),
  reportFile = join(root, 'test-results/readme-run-report.json'),
  option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3),
  NODE_LIMIT = 30_000,
  PAGE_LIMIT = 20_000,
  SETTLE = 500,
  NODE_JOBS = 8,
  // A whole run took 5 minutes on the RTX A6000 (2026-11-07) and about 25 when first measured; the limit is well past both.
  LIMIT_MINUTES = 60;

/** True while the process `pid` lives. */
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/**
 * Makes the empty folder `run-<pid>` under `base` for this run, and removes what runs whose process is gone left there.
 * The folder of a run still going is never touched.
 */
export function claimScratch(base, pid = process.pid, alive = isAlive) {
  mkdirSync(base, { recursive: true });
  for (const entry of readdirSync(base)) {
    const owner = /^run-(\d+)$/.exec(entry)?.[1];
    if (owner && Number(owner) !== pid && alive(Number(owner))) continue;
    rmSync(join(base, entry), { recursive: true, force: true });
  }
  const folder = join(base, `run-${pid}`);
  mkdirSync(join(folder, 'page'), { recursive: true });
  return folder;
}

/** What the examples of a package are, by id: `{ id, name, code }`. */
export function collectExamples(packages) {
  return packages.flatMap(({ name, folder }) =>
    packageMarkdown(folder).flatMap(({ document, markdown }) => {
      const entries = readmeEntries(markdown),
        ids = exampleIds(name, document, entries);
      const files = companionFiles(entries);
      return entries.map(({ code }, index) => ({ id: ids[index], name, code, files }));
    }),
  );
}

/** True for code that can run only in a page, and false for code that needs Node, undefined when either may do. */
export function placeOf(code) {
  if (/from\s+['"](?:node:|webgpu['"])/.test(code) || browserAutomation(code)) return 'node';
  if (/\bdocument\.|\bwindow\.|\bnavigator\.|requestAnimationFrame|createStage\(|Engine\.create\(|<canvas/.test(code))
    return 'page';
  return undefined;
}

/** A browser driver belongs to Node and must finish its assertions, rather than pass as an ongoing server. */
export const browserAutomation = (code) => /from\s+['"](?:playwright|@playwright\/test)['"]/.test(code);

/** Named source blocks in a multi-file example, such as the page and its worker. Only local basenames are accepted. */
export function companionFiles(entries) {
  return Object.fromEntries(
    entries.flatMap(({ code }) => {
      const name = /^\s*\/\/\s*([\w-]+\.(?:tsx?|[cm]?js))\s*\r?\n/.exec(code)?.[1];
      return name ? [[name, code]] : [];
    }),
  );
}

/** The basic loader, directly or through Stage, needs a static fixture; the pro loader retains its animated sample. */
export const usesMinimalGLTF = (code) =>
  /(?:from\s*|import\s*\(\s*)['"](?:@margoengine\/(?:gltf|stage\/gltf)|margoengine\/(?:gltf|stage\/gltf))['"]/.test(
    code,
  );

/** Each program has its own directory, so relative worker imports cannot collide with another example's files. */
export async function writePageExample(example, base = join(scratch, 'page')) {
  const folder = join(base, example.id),
    file = join(folder, 'example.tsx');
  mkdirSync(folder, { recursive: true });
  writeFileSync(file, example.code);
  for (const [name, code] of Object.entries(example.files ?? {})) {
    writeFileSync(join(folder, name), code);
    // TypeScript projects commonly refer to the emitted .js name from new URL(). Serve that file too.
    if (/\.tsx?$/.test(name))
      writeFileSync(
        join(folder, name.replace(/\.tsx?$/, '.js')),
        (await transformWithOxc(code, name, { jsx: { runtime: 'automatic' } })).code,
      );
  }
  return `/${example.id}/example.tsx`;
}

const CODE = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.html', '.md', '.json', '.py', '.txt', '.css']);
// A sample of each format a reader would expect, where the smallest file of that extension is an odd one.
const PREFERRED = {
  '.glb': 'examples/assets/khronos-samples/AnimatedColorsCube.glb',
};
// The clip names the examples use, on one real rigged model: an example's own file has them.
const CLIPS = [
  'Idle',
  'Walk',
  'Run',
  'Walking',
  'Running',
  'Jump',
  'Attack',
  'SwingLeft',
  'SwingRight',
  'Wave',
  'Dance',
];

/** A plain static GLB from the exporter. */
async function staticModel(file) {
  const { exportGLB } = await import('../packages/exporters/dist/index.js');
  writeFileSync(
    file,
    exportGLB({
      nodes: [
        {
          name: 'Triangle',
          geometry: {
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
            indices: [0, 1, 2],
          },
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

const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';

/** True for a Git LFS pointer left in place of its file: told by its first line, never by its size (real files can be tiny). */
export function isLfsPointer(path) {
  if (statSync(path).size > 1024) return false;
  return readFileSync(path, 'latin1').startsWith(LFS_POINTER);
}

const gitFiles = (...specs) =>
  spawnSync('git', ['ls-files', ...specs], { cwd: root, encoding: 'utf8', maxBuffer: 2 ** 26 }).stdout.split('\n');

/**
 * The samples a file name stands for: `byName` for a file of that very name in the sample folders or the packages' test
 * fixtures, `byExtension` for the smallest real file of each extension in the sample folders only (a fixture may be an odd
 * file kept for its oddity, so it answers only to its own name). `files` and `fixtures` are repository paths under
 * `base` (default: what git lists in examples/assets, and under every packages/<name>/test or tests folder).
 */
export function sampleFiles(
  files,
  base = root,
  fixtures = files ? [] : gitFiles(':(glob)packages/*/tests/**', ':(glob)packages/*/test/**'),
) {
  const listed = files ?? gitFiles('examples/assets'),
    samples = new Map(),
    byName = new Map();
  const real = (file) => {
    const path = join(base, file),
      extension = extname(file).toLowerCase();
    // A file kept to test a refusal is no sample.
    if (
      !extension ||
      CODE.has(extension) ||
      !existsSync(path) ||
      /invalid|corrupt|truncat|broken|malformed|\bbad\b|damaged/i.test(file)
    )
      return undefined;
    const { size } = statSync(path);
    // An empty file or a Git LFS pointer is no sample, and a loader would rightly refuse it; a small real file is one.
    return !size || isLfsPointer(path) ? undefined : { path, size, extension };
  };
  for (const file of listed.filter(Boolean)) {
    const sample = real(file);
    if (!sample) continue;
    const { path, size, extension } = sample;
    byName.set(basename(file).toLowerCase(), { path, size });
    if (PREFERRED[extension] === file) samples.set(extension, { path, size: 0 });
    if (size < (samples.get(extension)?.size ?? 2 ** 24)) samples.set(extension, { path, size });
  }
  for (const file of fixtures.filter(Boolean)) {
    const name = basename(file).toLowerCase(),
      sample = !byName.has(name) && real(file);
    if (sample) byName.set(name, { path: sample.path, size: sample.size });
  }
  // A .gltf and a .bin an example names together are one model, so the .bin stands for that .gltf's own buffer.
  const gltf = samples.get('.gltf'),
    uri = gltf && JSON.parse(readFileSync(gltf.path, 'utf8')).buffers?.[0]?.uri,
    buffer = typeof uri === 'string' && !uri.startsWith('data:') ? join(dirname(gltf.path), decodeURI(uri)) : undefined;
  if (buffer && existsSync(buffer) && !isLfsPointer(buffer))
    samples.set('.bin', { path: buffer, size: statSync(buffer).size });
  return { byName, byExtension: samples };
}

/**
 * The file under `examples/assets` a page asks for by its path there, such as `3d-tiles/TilesetWithTreeBillboards/tileset.json`:
 * a sample made of several files (a tileset and its tiles) is served as it is, relative links included. Undefined when there is none.
 */
export function assetFile(pathname, base = join(root, 'examples/assets')) {
  const path = resolve(base, `.${pathname}`);
  return path.startsWith(base + sep) && existsSync(path) && statSync(path).isFile() && !isLfsPointer(path)
    ? { path }
    : undefined;
}

const sampleFor = ({ byName, byExtension }, name) =>
  byName.get(basename(name).toLowerCase()) ?? byExtension.get(extname(name).toLowerCase());

/** File names an example names in strings, for the folder it runs in. */
export const namedFiles = (code) =>
  [...code.matchAll(/['"`]([\w./-]+\.[a-zA-Z0-9]{2,5})['"`]/g)].map(([, name]) => name);

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
  writeFileSync(file, (await transformWithOxc(example.code, 'example.tsx', { jsx: { runtime: 'automatic' } })).code);
  for (const name of namedFiles(example.code)) {
    const sample = readmeFixture(name) ?? sampleFor(samples, name);
    if (!sample || name.startsWith('/') || name.includes('..')) continue;
    mkdirSync(dirname(join(folder, name)), { recursive: true });
    copyFileSync(sample.path, join(folder, name));
  }
  return { file, folder };
}

export async function runInNode(example, samples, options = {}) {
  const location = await writeNodeExample(example, samples);
  const reference = headlessReference(example.code);
  if (reference) {
    const file = join(location.folder, 'reference.mjs');
    writeFileSync(file, (await transformWithOxc(reference, 'reference.tsx', { jsx: { runtime: 'automatic' } })).code);
    const result = await runNodeFile({ ...example, code: reference }, { file, folder: location.folder }, options);
    if (result.result !== 'pass') return { ...result, reason: 'Reference preparation failed: ' + result.reason };
  }
  return runNodeFile(example, location, options);
}

function runNodeFile(example, { file, folder }, { timeout = NODE_LIMIT } = {}) {
  const launch = browserAutomation(example.code) ? chromiumLaunchOptions() : undefined;
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        '--unhandled-rejections=strict',
        '--import',
        new URL('./support/readme-node-assets.mjs', import.meta.url).href,
        file,
      ],
      {
        cwd: folder,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe'],
        env: launch
          ? {
              ...process.env,
              BROWSER_ARGS: JSON.stringify(launch.args),
              ...(launch.channel ? { BROWSER_CHANNEL: launch.channel } : {}),
              ...(launch.executablePath ? { BROWSER_EXECUTABLE: launch.executablePath } : {}),
            }
          : example.code.includes('headless/ffmpeg')
            ? readmeNodeEnv()
            : process.env,
      },
    );
    let errors = '',
      limited = false,
      ending;
    child.stderr.on('data', (chunk) => (errors += chunk));
    const limit = setTimeout(() => {
      limited = true;
      ending = endTree(child.pid);
    }, timeout);
    child.on('close', async (code) => {
      clearTimeout(limit);
      const remaining = ending ? await ending : [];
      if (remaining.length)
        return done({
          result: 'fail',
          place: 'node',
          reason: `Timed-out example left processes running: ${remaining.join(', ')}`,
        });
      if (limited)
        done({
          result: 'fail',
          place: 'node',
          reason: `${browserAutomation(example.code) ? 'Browser test' : 'Example'} did not finish within ${timeout / 1000} s`,
        });
      else if (code === 0) done({ result: 'pass', place: 'node' });
      else done({ result: 'fail', place: 'node', reason: firstError(errors) });
    });
  });
}

/** The line of a stack trace that says what went wrong. */
const firstError = (text) =>
  (
    text.split(/\r?\n/).find((line) => /^\s*(?:\w*Error|MargoError|Uncaught)\b|\bERR_/.test(line)) ??
    text.split(/\r?\n/)[0] ??
    ''
  )
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
  if (query.has('live')) {
    const { PBRModel } = await import('/@fs/${fileURLToPath(import.meta.resolve('@margoengine/gltf-pro/model')).replaceAll('\\', '/')}');
    const { Camera } = await import('/@fs/${fileURLToPath(import.meta.resolve('@margoengine/core')).replaceAll('\\', '/')}');
    (${observeLiveExample.toString()})(PBRModel, Camera);
  }
  await import(query.get('example'));
  window.__ran = 'done';
} catch (error) {
  record(error?.stack?.split('\\n')[0] ?? error);
  window.__ran = 'threw';
}
</script>`;

async function startPages(samples, examples) {
  const programs = new Map(examples.map((example) => [`/${example.id}/example.tsx`, example]));
  const server = await createServer({
    root: join(scratch, 'page'),
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1', fs: { allow: [root] }, hmr: false, watch: null },
    // React ships CommonJS. A raw /@fs import cannot provide its named exports to a browser.
    optimizeDeps: {
      noDiscovery: true,
      include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'],
    },
    oxc: { jsx: { runtime: 'automatic' } },
    plugins: [
      {
        name: 'readme-samples',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (serveLiveLink(request, response)) return;
            const { pathname } = new URL(request.url, 'http://example.test');
            if (pathname === '/run.html') {
              response.setHeader('content-type', 'text/html');
              return response.end(PAGE);
            }
            // Minimal glTF takes static models only, so its examples get one.
            const source = new URL(request.headers.referer ?? '/', 'http://example.test').searchParams.get('example'),
              program = programs.get(source),
              fixture = readmeFixture(pathname),
              minimal = /\.gl(?:b|tf)$/.test(pathname) && program && usesMinimalGLTF(program.code),
              sample = minimal
                ? { path: samples.staticModel }
                : (fixture ?? assetFile(pathname) ?? sampleFor(samples, pathname));
            if (
              !sample ||
              (!fixture && /\.(?:tsx|js|mjs|css|html)$/.test(pathname)) ||
              pathname.startsWith('/@') ||
              pathname.includes('/node_modules/') ||
              pathname.includes('/packages/')
            )
              return next();
            serveSample(request, response, sample.path);
          });
        },
      },
    ],
  });
  await server.listen();
  const browser = await launchBrowser({ headless: true, args: ['--enable-unsafe-webgpu'] });
  return { server, browser, origin: `http://127.0.0.1:${server.httpServer.address().port}` };
}

export async function runInPage(example, pages, { timeout = PAGE_LIMIT } = {}) {
  const file = await writePageExample(example);
  const live = usesLiveLink(example.code);
  const url = `${pages.origin}/run.html?example=${encodeURIComponent(file)}&elements=${encodeURIComponent(JSON.stringify(askedElements(example.code)))}${live ? '&live' : ''}`;
  let phase = 'creating page',
    page,
    result,
    timer;
  const fail = (reason) => ({ result: 'fail', place: 'page', reason });
  const work = (async () => {
    try {
      page = await pages.browser.newPage();
      if (live) {
        // Redirect the documented add-on address to this run's own service. No shared port or fake browser API.
        await page.route('http://127.0.0.1:8765/**', (route) => {
          const target = new URL(route.request().url());
          return route.fulfill({
            status: 307,
            headers: {
              location: `${pages.origin}/__readme-live${target.pathname}${target.search}`,
              'access-control-allow-origin': '*',
            },
          });
        });
      }
      phase = 'navigating';
      await page.goto(url, { timeout });
      if (live) {
        phase = 'completing live-link lifecycle';
        await finishLiveExample(page, timeout);
      }
      phase = 'waiting for module completion';
      await page.waitForFunction(() => window.__ran, undefined, { timeout });
      phase = 'settling';
      await page.waitForTimeout(SETTLE);
      phase = 'reading errors';
      const errors = await page.evaluate(() => window.__errors);
      result = errors.length ? fail(errors[0]) : { result: 'pass', place: 'page' };
    } catch (error) {
      result = fail(String(error.message).split('\n')[0].slice(0, 300));
    } finally {
      phase = 'closing page';
      await page?.close();
    }
    return result;
  })();
  const expired = Symbol('deadline');
  try {
    const outcome = await Promise.race([
      work,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(expired), timeout);
      }),
    ]);
    if (outcome !== expired) return outcome;
    const reason = `Example did not finish within ${timeout / 1000} s while ${phase}${result?.reason ? '; ' + result.reason : ''}`;
    pages.failed = `${example.id}: ${reason}`;
    // The owned browser's bounded close kills its whole process tree, including unresponsive renderers/workers.
    await closeAll({ browser: pages.browser });
    return fail(reason);
  } catch (error) {
    return fail(String(error.message).split('\n')[0].slice(0, 300));
  } finally {
    clearTimeout(timer);
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

/** A run holds one GPU slot: finish and close one page before starting the next example. */
export async function eachPage(items, work) {
  for (const item of items) await work(item);
}

/** The examples a run takes: those of `packages` (names), when given, whose id holds `only`, when given, and in `ids`, when given. */
export const pickExamples = (examples, { only, packages, ids }) =>
  examples.filter(
    ({ id, name }) => (!packages || packages.includes(name)) && (!only || id.includes(only)) && (!ids || ids.has(id)),
  );

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
  claimScratch(scratchBase);
  for (const example of examples) for (const name of namedFiles(example.code)) readmeFixture(name);
  samples.byExtension.set('.glb', { path: modelWithClips(join(scratch, 'clips.glb')), size: 0 });
  samples.staticModel = await staticModel(join(scratch, 'static.glb'));
  await eachLimited(nodeTurns(examples.filter(({ code }) => placeOf(code) !== 'page')), NODE_JOBS, async (turn) => {
    for (const example of turn) results.set(example.id, await runInNode(example, samples));
  });
  const forPage = examples.filter(({ id, code }) => placeOf(code) !== 'node' && results.get(id)?.result !== 'pass');
  if (forPage.length) {
    const pages = await startPages(samples, examples);
    try {
      await eachPage(forPage, async (example) => {
        if (pages.failed) throw new Error(pages.failed);
        results.set(example.id, await runInPage(example, pages));
        writeFileSync(
          join(scratch, 'partial-report.json'),
          `${JSON.stringify(
            [...results].map(([id, result]) => ({ id, ...result })),
            null,
            1,
          )}\n`,
        );
        if (pages.failed) throw new Error(pages.failed);
      });
    } finally {
      await closeAll({ browser: pages.browser, servers: [pages.server] });
    }
  }
  const report = examples.map(({ id }) => ({ id, ...results.get(id) }));
  writeFileSync(join(scratch, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  if (last) for (const entry of last) if (!results.has(entry.id)) report.push(entry);
  const { failed, fresh, gone } = judge(report, known, Boolean(part || last)),
    passed = report.filter(({ result }) => result === 'pass').length,
    inNode = report.filter(({ result, place }) => result === 'pass' && place === 'node').length;
  if (!part) writeFileSync(reportFile, `${JSON.stringify(report, null, 1)}\n`);
  if (process.argv.includes('--shrink') && !part && !last) {
    writeFileSync(
      knownFile,
      `${JSON.stringify(Object.fromEntries(Object.entries(known).filter(([id]) => !gone.includes(id))), null, 2)}\n`,
    );
    console.log(`known list: ${gone.length} removed`);
    gone.length = 0;
  }
  for (const { id, place, reason } of fresh) console.error(`${id} (${place}): ${reason}`);
  for (const id of gone) console.error(goneLine(id, report));
  console.log(
    `${passed} of ${report.length} examples ran: ${inNode} in Node, ${passed - inNode} in a page; ${failed.length} failed, ${fresh.length} not on the known list`,
  );
  if (fresh.length || gone.length) process.exitCode = 1;
}

async function main() {
  reportSpeedPhase('check:readme-run');
  const release = await acquire({ owner: 'check-readme-run', max: LIMIT_MINUTES });
  try {
    await run();
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
