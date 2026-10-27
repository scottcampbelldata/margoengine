// `npm run check:quickstart`: times the README quickstart the way a new reader does it, and proves it works.
//
// In a fresh temp folder outside the repository, with only Node, npm and git assumed, it follows the README's install
// route 2 line by line (route 1 with --route=1): clone, `npm ci`, `npm run pack:packages`, a new project,
// `npm install <tarballs> vite`, then writes index.html and main.ts EXACTLY as the README prints them (extracted from
// the clone's README by scripts/support/doc-snippets.mjs, never retyped), starts `npx vite` and opens the page in a
// real WebGPU browser (the Edge/Chromium the GPU checks use, under a shared GPU lock slot for the browser part only).
// The browser asserts, from pixels and handlers, never by eye:
//   * a lit, TEXTURED scene: the first frame has content, the floor shows the checker's sharp edges and the same
//     scene with the texture removed does not;
//   * a SHADOW: the ball's shadow lies on the floor beside it and is darker than the same scene with `shadows.add`
//     removed (the shipped page is compared with that reference too);
//   * INTERACTION: clicking the ball and the crate fires the page's pick handler (waited for, not a fixed time) and
//     draws the orange outline; an orbit drag changes the picture and does not pick;
//   * no console warning or error, page error or failed request on the shipped page;
//   * the README's message when WebGPU is missing shows, and `Browser support` is a heading of the README.
// Gate: first command to verified interactive frame in under 300 s of machine time. Writes
// test-results/quickstart-timing.json. Hard time limit for the whole run (default 900 s) with process-tree cleanup.
//   node scripts/quickstart-timing.mjs [--route=1|2] [--source=<repo or url>] [--dir=<folder>] [--keep]
//     [--warm-cache] [--max=300] [--limit=900]
// --source defaults to this checkout (its committed HEAD is cloned, with uncommitted work laid over it). --warm-cache uses your npm cache
// instead of a cold one (the default, which is what a first-time reader has; downloaded bytes are the cold cache's size).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { acquire, killTree, quoteWindows } from './gpu-lock.mjs';
import { quickstartFiles } from './support/doc-snippets.mjs';

const root = resolve(import.meta.dirname, '..');
const windows = process.platform === 'win32';

/** Starts a program the way a terminal would: through cmd.exe on Windows (npm and npx are .cmd files there). */
const launch = (command, args, options) =>
  windows
    ? spawn([command, ...args].map(quoteWindows).join(' '), { ...options, shell: true })
    : spawn(command, args, options);

/** The README's three edits that make the reference scenes: shadows off, no texture, no crate spin. */
export const VARIANTS = {
  frozen: (code) => freeze(code),
  noshadow: (code) => freeze(remove(code, 'for (const mesh of [ground, crate, ball]) shadows.add(mesh);')),
  notexture: (code) => freeze(code).replaceAll('{ map: checker }', '{}').replaceAll('map: checker, ', ''),
};
function remove(code, line) {
  assert.ok(
    code.includes(line),
    `the README no longer contains "${line}"; update VARIANTS in scripts/quickstart-timing.mjs`,
  );
  return code.replace(line, '');
}
function freeze(code) {
  return remove(code, 'crate.root.rotation.y += delta * 0.5;');
}

/** Luminance (0..255) of every pixel of a screenshot, with its size and the raw RGB. */
export async function pixels(png) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lum = new Float32Array(info.width * info.height);
  for (let i = 0; i < lum.length; i++)
    lum[i] = 0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2];
  return { width: info.width, height: info.height, rgb: data, lum };
}

/** Pixels of the ball's teal (#84d6bd, lit or shaded): its box and centre. */
export function findBall({ width, height, rgb }) {
  let n = 0,
    sx = 0,
    sy = 0,
    x0 = width,
    x1 = 0,
    y0 = height,
    y1 = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3,
        r = rgb[i],
        g = rgb[i + 1],
        b = rgb[i + 2];
      if (g > r + 25 && g > b + 5 && g > 50) {
        n++;
        sx += x;
        sy += y;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
  return n < 300 ? null : { n, cx: sx / n, cy: sy / n, x0, x1, y0, y1 };
}

/** Number of pixel-to-pixel luminance jumps over `threshold` in the rows of a band of the picture. */
export function sharpEdges({ width, lum }, y0, y1, threshold) {
  let edges = 0;
  for (let y = y0; y < y1; y++)
    for (let x = 1; x < width; x++) if (Math.abs(lum[y * width + x] - lum[y * width + x - 1]) > threshold) edges++;
  return edges;
}

/**
 * The ball's shadow on the floor: pixels outside the ball (in the reference with no shadows) that the shadowed picture
 * makes much darker, in a window around the ball. Returns their count, centroid and mean luminance in both pictures.
 */
export function shadowOf(on, off, ball) {
  const { width } = off;
  let n = 0,
    sx = 0,
    sy = 0,
    lumOn = 0,
    lumOff = 0;
  const x0 = Math.max(0, ball.x0 - 260),
    x1 = Math.min(width, ball.x1 + 260);
  const y0 = Math.max(0, ball.y0),
    y1 = Math.min(off.height, ball.y1 + 220);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const k = y * width + x,
        i = k * 3;
      const teal = off.rgb[i + 1] > off.rgb[i] + 25 && off.rgb[i + 1] > off.rgb[i + 2] + 5;
      if (teal || (x >= ball.x0 - 4 && x <= ball.x1 + 4 && y >= ball.y0 - 4 && y <= ball.y1 + 4)) continue;
      if (off.lum[k] - on.lum[k] > 30) {
        n++;
        sx += x;
        sy += y;
        lumOn += on.lum[k];
        lumOff += off.lum[k];
      }
    }
  return n ? { n, cx: sx / n, cy: sy / n, lumOn: lumOn / n, lumOff: lumOff / n } : { n };
}

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const flag = (name) => process.argv.includes(`--${name}`);

export async function main() {
  const route = arg('route', '2'),
    source = arg('source', root),
    gate = Number(arg('max', 300)),
    limit = Number(arg('limit', 900)),
    dir = resolve(arg('dir', join(tmpdir(), `margo-quickstart-timing-${Date.now()}`))),
    warm = flag('warm-cache'),
    reuse = flag('reuse');
  assert.ok(['1', '2'].includes(route), '--route must be 1 or 2');
  assert.ok(reuse || !existsSync(join(dir, 'margoengine')), `${dir} already has a run; pick an empty folder`);
  mkdirSync(dir, { recursive: true });
  const started = Date.now(),
    timeline = [],
    sizes = {},
    notes = [];
  // Time spent queueing for the GPU behind other jobs is not the quickstart's time: it is taken off every timestamp and
  // off the hard limit, and reported as gpuLockWaitSeconds.
  let waited = 0;
  const active = () => Date.now() - started - waited;
  const mark = (step) => {
    const seconds = Number((active() / 1000).toFixed(1));
    timeline.push({ step, seconds });
    console.log(`[${String(seconds).padStart(6)} s] ${step}`);
    return seconds;
  };

  const children = new Set();
  let dead = false;
  const cleanup = () => {
    for (const pid of children) killTree(pid);
    children.clear();
  };
  let hardStop;
  const arm = () => {
    clearTimeout(hardStop);
    hardStop = setTimeout(
      () => {
        dead = true;
        console.error(`quickstart-timing: hard limit of ${limit} s reached; ending every process it started`);
        cleanup();
        writeResults(false, `hard limit of ${limit} s reached`);
        process.exit(2);
      },
      Math.max(1, limit * 1000 - active()),
    );
  };
  arm();
  const writeResults = (passed, failure) => {
    mkdirSync(join(root, 'test-results'), { recursive: true });
    writeFileSync(
      join(root, reuse ? 'test-results/quickstart-timing-reuse.json' : 'test-results/quickstart-timing.json'),
      `${JSON.stringify({ passed, failure: failure ?? null, route, source: String(source), gateSeconds: gate, timeline, sizes, notes, node: process.version, platform: process.platform }, null, 2)}\n`,
    );
  };

  /** Runs a command to its end in `cwd`, logging to `<dir>/<name>.log`; resolves with its output. Rejects on failure. */
  const run = (name, command, args, cwd, env = {}) =>
    new Promise((done, fail) => {
      const logFile = join(dir, `${name}.log`);
      let out = '';
      const child = launch(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      children.add(child.pid);
      for (const s of [child.stdout, child.stderr]) s.on('data', (c) => (out += c));
      child.once('error', fail);
      child.once('close', (code) => {
        children.delete(child.pid);
        writeFileSync(logFile, out);
        code === 0 ? done(out) : fail(new Error(`${name} failed (exit ${code}); see ${logFile}\n${out.slice(-1500)}`));
      });
    });

  const folderBytes = (folder) => {
    let total = 0;
    for (const entry of readdirSync(folder, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      try {
        total += statSync(join(entry.parentPath ?? entry.path, entry.name)).size;
      } catch {}
    }
    return total;
  };

  let dev, browser, release;
  try {
    mark('start (first command)');
    // 1. Obtain: the README's "git clone ... && git lfs install && git lfs pull" from the local checkout.
    const clone = join(dir, 'margoengine');
    let project,
      origin,
      env = {},
      files;
    if (reuse) {
      // Development aid: an earlier run's folder (--keep), the README taken from this checkout. Not a measurement.
      project = route === '2' ? join(dir, 'my-scene') : clone;
      files = quickstartFiles(readFileSync(join(root, 'README.md'), 'utf8'));
      notes.push('REUSED an earlier install: the timings are not a measurement');
    } else {
      await run('clone', 'git', ['clone', '--quiet', String(source), clone], dir);
      await run('lfs-install', 'git', ['lfs', 'install', '--local'], clone);
      await run('lfs-pull', 'git', ['lfs', 'pull'], clone);
      // A clone has the committed state only. When the source is this checkout, lay its uncommitted work over it, so
      // the check run before a commit tests what is about to be committed.
      if (resolve(String(source)) === root) {
        const listed = (...a) =>
          execFileSync('git', ['ls-files', '-z', ...a], { cwd: root, encoding: 'utf8' })
            .split('\0')
            .filter(Boolean);
        const changed = [...new Set([...listed('-m'), ...listed('-o', '--exclude-standard')])].filter((f) =>
          existsSync(join(root, f)),
        );
        for (const f of changed) {
          mkdirSync(dirname(join(clone, f)), { recursive: true });
          copyFileSync(join(root, f), join(clone, f));
        }
        if (changed.length) notes.push(`uncommitted files laid over the clone: ${changed.length}`);
      }
      sizes.cloneBytes = folderBytes(clone);
      mark('clone + git lfs pull done');

      // 2. Install: `npm ci` (cold npm cache by default, so the cache's size is what the reader downloads).
      const cache = join(dir, 'npm-cache');
      env = warm ? {} : { npm_config_cache: cache };
      await run('npm-ci', 'npm', ['ci'], clone, env);
      sizes.npmCiNodeModulesBytes = folderBytes(join(clone, 'node_modules'));
      if (!warm) sizes.npmCiDownloadedBytes = folderBytes(cache);
      mark('npm ci done');

      files = quickstartFiles(readFileSync(join(clone, 'README.md'), 'utf8'));
      assert.deepEqual(
        Object.keys(files).sort(),
        ['index.html', 'main.ts'],
        'the README must print index.html and main.ts',
      );
      if (route === '2') {
        // 3. Route 2: `npm run pack:packages` (builds every package, writes one tgz each), then a new project.
        await run('pack', 'npm', ['run', 'pack:packages'], clone, env);
        const tarballs = readdirSync(join(clone, 'test-results')).filter((f) => f.endsWith('.tgz'));
        assert.ok(tarballs.length > 0, 'pack:packages wrote no .tgz');
        sizes.tarballCount = tarballs.length;
        sizes.tarballBytes = tarballs.reduce((sum, f) => sum + statSync(join(clone, 'test-results', f)).size, 0);
        mark('npm run pack:packages done (build + pack)');
        project = join(dir, 'my-scene');
        mkdirSync(project);
        await run('npm-init', 'npm', ['init', '-y'], project, env);
        // The README shows `npm install ../margoengine/test-results/*.tgz vite` for a shell that expands the glob.
        await run(
          'npm-install',
          'npm',
          ['install', ...tarballs.map((f) => `../margoengine/test-results/${f}`), 'vite'],
          project,
          env,
        );
        sizes.projectNodeModulesBytes = folderBytes(join(project, 'node_modules'));
        if (!warm) sizes.downloadedBytesTotal = folderBytes(cache);
        mark('npm install <tarballs> vite done');
      } else {
        // Route 1: `npm run build:packages`, then the page saved in the clone (examples/quickstart; the unit test
        // tests/docs-guides.test.js proves it equals the README block, so the README text is written beside it).
        await run('build', 'npm', ['run', 'build:packages'], clone, env);
        project = clone;
        mark('npm run build:packages done');
      }
    }
    writeFileSync(join(project, route === '2' ? 'index.html' : 'readme-index.html'), files['index.html']);
    writeFileSync(join(project, route === '2' ? 'main.ts' : 'readme-main.ts'), files['main.ts']);
    if (route === '1')
      writeFileSync(join(project, 'readme-index.html'), files['index.html'].replace('./main.ts', './readme-main.ts'));
    // Reference scenes: the README's own text with one thing taken away (see VARIANTS).
    for (const [name, make] of Object.entries(VARIANTS)) {
      const main = route === '2' ? `${name}.ts` : `readme-${name}.ts`;
      writeFileSync(join(project, main), make(files['main.ts']));
      writeFileSync(
        join(project, route === '2' ? `${name}.html` : `readme-${name}.html`),
        files['index.html'].replace('./main.ts', `./${main}`),
      );
    }
    mark('index.html and main.ts written from the README');

    // 4. Dev server: the README says `npx vite` (route 2) or `npm run dev:examples` (route 1).
    const command = route === '2' ? ['npx', ['vite']] : ['npm', ['run', 'dev:examples']];
    let output = '';
    dev = launch(command[0], command[1], {
      cwd: project,
      env: { ...process.env, ...env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(dev.pid);
    for (const s of [dev.stdout, dev.stderr]) s.on('data', (c) => (output += c));
    const deadline = Date.now() + 60_000;
    while (!/Local:\s+(http:\/\/\S+)/.test(output.replace(/\x1b\[[0-9;]*m/g, ''))) {
      assert.ok(Date.now() < deadline, `the dev server printed no address in 60 s:\n${output}`);
      assert.ok(dev.exitCode === null, `the dev server exited:\n${output}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    origin = /Local:\s+(http:\/\/[^\s/]+)/.exec(output.replace(/\x1b\[[0-9;]*m/g, ''))[1];
    mark(`dev server ready at ${origin}`);
    const pageUrl = (name) =>
      route === '2'
        ? `${origin}/${name === 'readme' ? '' : `${name}.html`}`
        : `${origin}/${name === 'readme' ? 'readme-index.html' : `readme-${name}.html`}`;

    // 5. The browser, under one shared GPU slot.
    clearTimeout(hardStop);
    const queued = Date.now();
    release = await acquire({ owner: 'quickstart-timing', mode: 'shared', max: 15 });
    waited += Date.now() - queued;
    sizes.gpuLockWaitSeconds = Number((waited / 1000).toFixed(1));
    arm();
    mark(`GPU lock held (waited ${sizes.gpuLockWaitSeconds} s behind other jobs; not counted)`);
    browser = await chromium
      .launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true })
      .catch(() => chromium.launch({ headless: true }));
    notes.push(`browser ${process.env.BROWSER_CHANNEL ?? 'msedge'} ${browser.version()} headless`);
    const open = async (url, { noGpu = false, noAdapter = false } = {}) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      if (noGpu)
        await context.addInitScript(() => {
          delete Navigator.prototype.gpu;
        });
      if (noAdapter)
        await context.addInitScript(() => {
          navigator.gpu.requestAdapter = async () => null;
        });
      const page = await context.newPage();
      page.problems = [];
      page.bytes = 0;
      page.on(
        'console',
        (m) => ['error', 'warning'].includes(m.type()) && page.problems.push(`console ${m.type()}: ${m.text()}`),
      );
      page.on('pageerror', (e) => page.problems.push(`page error: ${e.message}`));
      page.on('requestfailed', (r) => page.problems.push(`request failed: ${r.url()}`));
      page.on('response', async (r) => {
        if (r.status() >= 400) page.problems.push(`${r.status()} ${r.url()}`);
        page.bytes += Number(r.headers()['content-length'] ?? 0);
      });
      await page.goto(url, { waitUntil: 'load' });
      return page;
    };
    const shoot = (page) => page.screenshot({ type: 'png' });
    const shotDir = join(root, 'test-results/quickstart-timing');
    mkdirSync(shotDir, { recursive: true });
    /** Waits, takes the picture, keeps it as test-results/quickstart-timing/<label>.png and returns its pixels. */
    const settle = async (page, ms = 1200, label) => {
      await page.waitForTimeout(ms);
      const png = await shoot(page);
      if (label) writeFileSync(join(shotDir, `${label}.png`), png);
      return pixels(png);
    };

    // 5a. The shipped page: first frame = the first screenshot that is not one colour.
    const page = await open(pageUrl('readme'));
    for (let tries = 0; ; tries++) {
      assert.ok(tries < 300, `no frame with content in 30 s; problems: ${page.problems.join(' | ')}`);
      const shot = await pixels(await shoot(page));
      if (findBall(shot) && sharpEdges(shot, 560, 700, 20) > 300) break;
      await page.waitForTimeout(100);
    }
    mark('first frame rendered (ball, floor texture visible)');
    sizes.pageDownloadedBytes = page.bytes;
    await page.waitForTimeout(800);
    const status = () => page.textContent('#status');
    assert.match(await status(), /Drag to orbit/, 'the status line must still show its first text');

    // Reference scenes (frozen crate; with and without shadows; without texture).
    const frozen = await open(pageUrl('frozen')),
      off = await open(pageUrl('noshadow')),
      plain = await open(pageUrl('notexture'));
    const [shotOn, shotOff, shotPlain] = [
      await settle(frozen, 1200, 'frozen'),
      await settle(off, 1200, 'no-shadow'),
      await settle(plain, 1200, 'no-texture'),
    ];
    const shipped = await settle(page, 300, 'shipped');

    // TEXTURE: sharp checker edges on the floor band, many with the texture and (nearly) none without.
    const band = [560, 700],
      withTex = sharpEdges(shipped, ...band, 20),
      without = sharpEdges(shotPlain, ...band, 20);
    sizes.floorEdges = { withTexture: withTex, withoutTexture: without };
    assert.ok(
      withTex > 300 && without < withTex / 10,
      `texture pattern: ${withTex} sharp edges with it, ${without} without`,
    );

    // SHADOW: the ball's shadow is on the floor beside the ball, darker than the no-shadow reference, in both the
    // frozen-crate scene and the shipped page.
    const ball = findBall(shotOff);
    assert.ok(ball, 'the ball must be visible in the no-shadow scene');
    const shadow = shadowOf(shotOn, shotOff, ball),
      seen = shadowOf(shipped, shotOff, ball);
    sizes.shadow = { frozen: shadow, shipped: seen, ball };
    assert.ok(shadow.n > 600, `no shadow beside the ball: ${shadow.n} darkened floor pixels`);
    assert.ok(
      shadow.cy > ball.cy && shadow.cy < ball.y1 + 200,
      `the shadow is not on the floor at the ball: centre y ${shadow.cy.toFixed(0)}, ball ${ball.cy.toFixed(0)}..${ball.y1}`,
    );
    assert.ok(
      shadow.lumOn < shadow.lumOff * 0.8,
      `the shadow is not darker than the floor: ${shadow.lumOn.toFixed(0)} vs ${shadow.lumOff.toFixed(0)}`,
    );
    assert.ok(seen.n > 600, `the shipped page shows no ball shadow: ${seen.n} darkened floor pixels`);
    mark('texture and shadow assertions passed');

    // INTERACTION: a click fires the pick handler (waited for), an outline appears, an orbit drag changes the picture.
    const clickAndWait = async (x, y) => {
      await page.evaluate(() => {
        document.querySelector('#status').textContent = 'waiting for the handler';
      });
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForFunction(
        () => document.querySelector('#status').textContent !== 'waiting for the handler',
        null,
        { timeout: 8000 },
      );
      return status();
    };
    const orange = (shot) => {
      let n = 0;
      for (let i = 0; i < shot.rgb.length; i += 3)
        if (shot.rgb[i] > 220 && shot.rgb[i + 1] > 110 && shot.rgb[i + 1] < 190 && shot.rgb[i + 2] < 90) n++;
      return n;
    };
    const before = await settle(page, 300);
    assert.ok(orange(before) < 30, 'there is an orange outline before any pick');
    assert.match(
      await clickAndWait(Math.round(ball.cx), Math.round(ball.cy)),
      /Picked the ball\./,
      'clicking the ball must fire the handler',
    );
    const ballPicked = await settle(page, 600);
    assert.ok(orange(ballPicked) > 100, `no orange outline after picking the ball (${orange(ballPicked)} px)`);
    // The crate sits left of the ball and spins; scan the left half of the floor row by row until the handler says so.
    let crate = null;
    scan: for (const fy of [0.5, 0.42, 0.58, 0.35, 0.65])
      for (const fx of [0.4, 0.34, 0.46, 0.28, 0.22, 0.52]) {
        const text = await clickAndWait(Math.round(1280 * fx), Math.round(720 * fy));
        if (/Picked the crate\./.test(text)) {
          crate = [fx, fy];
          break scan;
        }
      }
    assert.ok(crate, 'clicking the crate never fired the handler with "Picked the crate."');
    assert.match(
      await clickAndWait(30, 700),
      /Click the crate or the ball\./,
      'clicking empty floor must clear the pick',
    );
    const still = await settle(page, 400);
    await page.mouse.move(300, 640);
    await page.mouse.down();
    await page.mouse.move(520, 600, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(900);
    const orbited = await pixels(await shoot(page));
    let moved = 0;
    for (let i = 0; i < still.lum.length; i += 7) if (Math.abs(still.lum[i] - orbited.lum[i]) > 25) moved++;
    assert.ok(moved > 1500, `an orbit drag must change the picture (${moved} sampled pixels changed)`);
    assert.doesNotMatch(await status(), /Picked/, 'an orbit drag must not pick');
    const secondsToInteractive = mark('interaction verified (pick handler, outline, orbit)');
    // Chrome on Windows warns that powerPreference is ignored: a recorded bug (docs/known-bugs.md), reported here, not hidden.
    const known = (p) => /powerPreference option is currently ignored/.test(p);
    for (const p of page.problems.filter(known)) notes.push(`KNOWN BUG (docs/known-bugs.md): ${p}`);
    assert.deepEqual(
      page.problems.filter((p) => !known(p)),
      [],
      'the shipped page logs no warning, error or failed request',
    );

    // FAILURE PATH: no WebGPU shows the README's own message and then stops.
    const none = await open(pageUrl('readme'), { noGpu: true });
    await none.waitForFunction(() => /no WebGPU/.test(document.querySelector('#status').textContent), null, {
      timeout: 8000,
    });
    const message = await none.textContent('#status');
    assert.match(message, /Browser support/);
    assert.match(
      readFileSync(join(clone, 'README.md'), 'utf8'),
      /^## Browser support$/m,
      'the message points at a README heading that does not exist',
    );
    notes.push(`no-WebGPU message: ${message}`);
    // A browser that has WebGPU but no usable GPU (a blocklisted driver, a remote desktop): the adapter request answers null.
    const blind = await open(pageUrl('readme'), { noAdapter: true });
    await blind
      .waitForFunction(() => /could not start/.test(document.querySelector('#status').textContent), null, {
        timeout: 8000,
      })
      .catch(async () => {
        throw new Error(
          `with no adapter the page still says "${await blind.textContent('#status')}"; the reader sees no reason`,
        );
      });
    const reason = await blind.textContent('#status');
    assert.match(reason, /WebGPU unavailable.*Browser support/);
    notes.push(`no-adapter message: ${reason}`);

    // Gate. The timeline minus the later checks is the reader's machine time to the first interactive frame.
    const firstFrame = timeline.find((t) => t.step.startsWith('first frame')).seconds;
    sizes.secondsToFirstFrame = firstFrame;
    sizes.secondsToVerifiedInteractive = secondsToInteractive;
    assert.ok(
      secondsToInteractive < gate,
      `machine time to the verified interactive frame was ${secondsToInteractive} s; the gate is ${gate} s`,
    );
    writeResults(true);
    console.log(
      `PASSED: first frame ${firstFrame} s, verified interactive ${secondsToInteractive} s (gate ${gate} s). Results: test-results/quickstart-timing.json`,
    );
  } catch (error) {
    if (!dead) writeResults(false, String(error?.message ?? error).slice(0, 2000));
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(hardStop);
    await browser?.close().catch(() => {});
    release?.();
    cleanup();
    if (!flag('keep') && !reuse)
      // Deleting node_modules can take minutes on Windows; do it detached so the check ends now.
      spawn(
        process.execPath,
        ['-e', `require('fs').rmSync(${JSON.stringify(dir)},{recursive:true,force:true,maxRetries:5})`],
        { detached: true, stdio: 'ignore' },
      ).unref();
    else console.log(`kept ${dir}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
