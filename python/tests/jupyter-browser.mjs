// End-to-end check of the margoengine Python package in real notebooks: starts a Jupyter server from the data venv
// (test-results/.venv-data in the main checkout, python/requirements-notebook.txt; python/tests/venv.mjs makes it from
// the pinned file when it is missing, as `npm run setup:python-test` does, and when that cannot work, no Python or no
// network, the check prints a loud SKIP naming the fix and exits 0, or 1 with MARGO_REQUIRE_JUPYTER=1), opens the same notebook in
// JupyterLab 4 and in Notebook 7 in headless Edge, runs it, and checks that each figure's widget view appears and draws
// (non-background pixels in its canvas) with no errors in the page. In JupyterLab it also checks the camera both ways:
// the camera the kernel sets is where the view starts, and dragging in the view reaches the kernel's `camera` trait,
// and a notebook that connects to its kernel late still runs its cells (lateNotebookConnection).
// Last, fig.to_png draws a figure in its own headless browser. Every step has a hard time limit (jupyter-steps.mjs): a
// step that hangs is named, and the Jupyter server, its kernels and the browser are all ended. The kernel imports this checkout's python/ package and
// the server loads this checkout's built extension (PYTHONPATH and JUPYTER_PATH), whatever the venv has installed.
// One GPU job at a time, from the repository root (npm run test:python:browser builds the extension first):
//   node scripts/gpu-lock.mjs run --owner=<you> -- npm run test:python:browser
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { decodePNG } from '../../tests/support/png.js';
import { killTree, notebookHasKernel, serverPort, startKernel, step } from './jupyter-steps.mjs';
import { compareVersions, ensureVenv, missingNeeded, namesToRead, parsePins, requirements, SETUP, STAMP, venvDir, venvTools } from './venv.mjs';

// Run by a supervisor: this file starts itself as a child under a hard time limit and, on timeout, ends the child and
// everything it started (the server, kernels, browser) and says so. The child does the work below.
if (!process.env.MARGO_JUPYTER_CHILD) {
  // The venv first (its own time limits; making it can take minutes, outside the check's limit below).
  const venv = ensureVenv();
  if (!venv.ok) {
    const strict = process.env.MARGO_REQUIRE_JUPYTER === '1';
    console.error(
      `
==== ${strict ? 'FAIL' : 'SKIP'}: test:python:browser did not run (this is not a pass) ====
jupyter: ${venv.reason}
Fix: ${SETUP}
====
`,
    );
    process.exit(strict ? 1 : 0);
  }
  const limit = 10 * 60_000;
  const child = spawn(process.execPath, [import.meta.filename], {
    stdio: 'inherit',
    env: { ...process.env, MARGO_JUPYTER_CHILD: '1' },
  });
  const timer = setTimeout(() => {
    console.error(`jupyter: the whole check passed ${limit / 1000} s; ending its process tree`);
    killTree(child.pid);
  }, limit);
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    process.exit(code ?? (signal ? 1 : 0));
  });
  await new Promise(() => {});
}
// A hung step ends the whole tree (this process, the server, kernels and browser), not just throws.
let versions;
process.on('uncaughtException', (error) => {
  console.error(error?.step ? `jupyter: ${error.message}` : error);
  if (versions) console.error(`jupyter: ran on ${versions}`);
  killTree(process.pid);
  process.exit(1);
});

const root = resolve(import.meta.dirname, '../..'),
  venv = venvDir(),
  { jupyter, python } = venvTools(venv) ?? {},
  extension = join(root, 'python/margoengine/labextension');
assert.ok(jupyter && python, `no jupyter in ${venv}: run ${SETUP}`);
assert.ok(existsSync(join(extension, 'package.json')), 'the extension is not built: run node python/build-frontend.mjs');

// The Python and Jupyter stack the check runs on, at the head of the server log kept on failure and in the success
// line, so a failure names the versions it ran against. Only the venv's own packages count: the venv excludes the
// system and user site-packages.
// The names come from the pinned requirements file: a pinned package that is missing or at another version fails the
// check by name; the optional extras (the ones jupyterlab needs no pin for) print "not installed". notebook is pinned: the
// Notebook 7 step below opens its interface and fails without it.
const pins = parsePins(readFileSync(requirements, 'utf8'));
const stack = spawnSync(
  python,
  [
    '-c',
    'import sys, site, json, importlib.metadata as m\nout = {}\nfor n in json.loads(sys.argv[1]):\n    try:\n        out[n] = m.version(n)\n    except m.PackageNotFoundError:\n        out[n] = None\nprint(json.dumps({"python": sys.version.split()[0], "exe": sys.executable, "site": site.ENABLE_USER_SITE, "versions": out}))',
    JSON.stringify(namesToRead(pins)),
  ],
  { encoding: 'utf8', timeout: 60_000 },
);
assert.equal(stack.status, 0, `reading the venv's versions failed: ${stack.stderr}`);
const read = JSON.parse(stack.stdout),
  { line, problems } = compareVersions(pins, new Map(Object.entries(read.versions)));
versions = `python ${read.python} ${read.exe}; user site ${read.site}; ${line}`;
// A package the check opens must be there before anything starts: never a 30 s wait for a page that cannot render.
const absent = missingNeeded(new Map(Object.entries(read.versions)));
if (absent.length) rmSync(join(venv, STAMP), { force: true }); // so the setup command repairs this venv
assert.deepEqual(absent, [], absent.join(' | '));
assert.deepEqual(problems, [], `the venv does not match ${requirements}: run ${SETUP}\n${problems.join('\n')}`);
console.log(`jupyter: runs on ${versions}`);

// The classic AMD module VS Code loads: it asks the loader for @jupyter-widgets/base only and returns the two widget
// classes built on it, with the model's defaults naming this module.
{
  const amd = readFileSync(join(root, 'python/margoengine/nbextension/index.js'), 'utf8');
  let deps, factory;
  new Function('define', amd)((d, f) => ([deps, factory] = [d, f]));
  assert.deepEqual(deps, ['@jupyter-widgets/base'], 'AMD dependencies');
  const classes = factory({ DOMWidgetModel: class { defaults() { return {}; } }, DOMWidgetView: class {} });
  assert.deepEqual(Object.keys(classes).sort(), ['MargoFigureModel', 'MargoFigureView']);
  const defaults = new classes.MargoFigureModel().defaults();
  assert.equal(defaults._model_module, '@margoengine/jupyter');
  assert.equal(defaults._view_name, 'MargoFigureView');
}

// The notebook folder lives in test-results (git-ignored) and is replaced each run: a just-stopped server on Windows
// still holds its files for a moment, so it is cleared at the start rather than the end.
const folder = join(root, 'test-results/jupyter-check');
rmSync(folder, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });
cpSync(extension, join(folder, 'data/labextensions/@margoengine/jupyter'), { recursive: true });

// A scatter from a DataFrame (its camera set by the kernel and watched into camera.json), a volume and a surface.
const start = [0.5, 2.5, 1.5];
const code = (source) => ({ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source });
writeFileSync(
  join(folder, 'check.ipynb'),
  JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    cells: [
      code(
        'import json, pathlib, numpy as np, pandas as pd, margoengine as margo\nrng = np.random.default_rng(1)\ndf = pd.DataFrame(rng.standard_normal((200000, 3)), columns=["x", "y", "z"])\ndef dump(name, value):\n    part = pathlib.Path(name + ".part")\n    part.write_text(json.dumps(value))\n    part.replace(name)',
      ),
      code(
        `f1 = margo.scatter(df, x="x", y="y", z="z", color="z")\nf1.camera = {"position": ${JSON.stringify(start)}, "target": [0, 0, 0]}\nf1.observe(lambda change: dump("camera.json", change["new"]), names="camera")\nf1.on_click(lambda event: dump("click.json", event))\nf1`,
      ),
      code(
        'g = np.linspace(-3, 3, 48, dtype=np.float32)\nX, Y, Z = np.meshgrid(g, g, g)\nmargo.volume(np.exp(-(X**2 + Y**2 + Z**2)), opacity=[(0, 0), (0.3, 0.2), (1, 1)])',
      ),
      code(
        'x = np.linspace(-3, 3, 64)\nf3 = margo.surface(np.sin(x)[None, :] * np.cos(x)[:, None], x=(-3, 3), y=(-3, 3))\npx, py = rng.uniform(-3, 3, (2, 400))\nf3.scatter(x=px, y=py, z=np.sin(px) * np.cos(py) + 0.05, point_size=4)\nf3.drag_mode = "box"\nf3.on_select(lambda s: dump("selection.json", {str(k): len(v) for k, v in s.items()}))\nf3',
      ),
    ].map((cell, k) => ({ ...cell, id: `c${k}` })),
  }),
);

// The same kind of notebook without Margo, for the page errors an app shows by itself.
writeFileSync(
  join(folder, 'plain.ipynb'),
  JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    cells: [{ ...code('1 + 1'), id: 'p0' }],
  }),
);

// JupyterLab 4 and Notebook 7 render only the cells in view by default (windowing); every cell stays rendered here so
// each figure keeps drawing while the others are checked. A settings folder of the check's own keeps the user's
// settings untouched.
const settings = join(folder, 'settings/@jupyterlab/notebook-extension');
mkdirSync(settings, { recursive: true });
writeFileSync(join(settings, 'tracker.jupyterlab-settings'), JSON.stringify({ windowingMode: 'none' }));

// Several checks run at once on this PC (one per worktree), so nothing is shared between them. The server takes the
// first free port from one this check holds while it starts, and the check reads the port it took from its log (a fixed
// port sent a second check to the first one's server, or left it waiting for a log line that never came). Its
// workspaces and config live in the check folder (JUPYTER_CONFIG_DIR), not the user's ~/.jupyter, where concurrent
// checks overwrote one shared workspace. Both apps expose `window.jupyterapp`, from which the check reads when a
// notebook holds its kernel (notebookHasKernel).
const portHolder = createServer();
await new Promise((done) => portHolder.listen(0, '127.0.0.1', done));
const offered = portHolder.address().port;
const server = spawn(
  jupyter,
  [
    'lab',
    '--no-browser',
    `--port=${offered}`,
    '--ServerApp.token=',
    '--ServerApp.password=',
    '--ServerApp.ip=127.0.0.1',
    `--ServerApp.root_dir=${folder}`,
    '--LabApp.expose_app_in_browser=True',
    '--JupyterNotebookApp.expose_app_in_browser=True',
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JUPYTER_CONFIG_DIR: join(folder, 'config'),
      JUPYTERLAB_SETTINGS_DIR: join(folder, 'settings'),
      JUPYTER_PATH: join(folder, 'data'),
      PYTHONPATH: join(root, 'python'),
    },
  },
);
let log = `${versions}\n`;
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const brightPixels = (png) => {
  let lit = 0;
  for (let i = 0; i < png.data.length; i += 4) if (png.data[i] + png.data[i + 1] + png.data[i + 2] > 3 * 60) lit++;
  return lit;
};
// The kernel's handlers write what they get to JSON files in the notebook folder.
const readJson = (name) => {
  const file = join(folder, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
};
const readCamera = () => readJson('camera.json');
const waitFor = (what, test, ms = 60_000) =>
  step(what, ms, async () => {
    for (;;) {
      const value = test();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
  });
let base;

// The page errors an app shows by itself: a notebook without Margo, opened and run the same way. (Notebook 7.6.3
// throws "Cannot read properties of undefined (reading 'schema')" from its own settings loading on every notebook.)
async function ownErrors(browser, path) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = new Set();
  page.on('pageerror', (e) => errors.add(e.message));
  await open(page, path, 'plain.ipynb', 'plain notebook');
  await step('run the plain notebook', 60_000, async () => {
    await page.locator('.lm-MenuBar-itemLabel', { hasText: /^Run$/ }).click();
    await page.locator('.lm-Menu-itemLabel', { hasText: /^Run All Cells$/ }).click();
    await page.waitForTimeout(5000);
  });
  await page.close();
  return errors;
}

// Starts the notebook's kernel through the server and opens the notebook in `page`. The notebook must hold its own
// kernel connection before cells run: Run All sent earlier makes the app ask "Select Kernel" and run nothing, which
// under load left the check waiting for figures that never came.
async function open(page, path, notebook, label) {
  const abort = new AbortController();
  try {
    const kernel = await step(`${label}: start the kernel`, 90_000, () => startKernel(base, notebook, abort.signal));
    await step(`${label}: load the page`, 90_000, async () => {
      await page.goto(`${base}${path}`);
      await page.waitForSelector('.jp-NotebookPanel .jp-Cell');
    });
    await step(`${label}: connect the notebook to its kernel`, 60_000, () =>
      page.waitForFunction(notebookHasKernel, { path: notebook, kernelId: kernel }, { timeout: 60_000, polling: 100 }),
    );
  } finally {
    abort.abort();
  }
}

// Regression check for the stall above: JupyterLab's help menu opens a connection of its own to the running kernel
// before the notebook connects, to read the kernel's banner, and closes it when the banner comes. Under load the
// just-started kernel answered late, the server counted that connection while the notebook had none yet, and a check
// that ran the cells on that count met "Select Kernel" (or Run All ran nothing). Here both happen every time: the first
// connection to each kernel (the help menu's) never gets its answers, so it stays open, and the notebook's session
// lookup is held back 5 s, so the notebook connects late. Run All must still run the cell, with no dialog.
async function lateNotebookConnection(browser) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  let lookups = 0;
  const held = new Map();
  await page.route(
    (url) => url.pathname === '/api/sessions',
    async (route) => {
      if (route.request().method() === 'GET' && lookups++ > 0) await new Promise((r) => setTimeout(r, 5000));
      await route.continue();
    },
  );
  await page.routeWebSocket(
    (url) => {
      const kernel = /\/api\/kernels\/([^/]+)\/channels$/.exec(url.pathname)?.[1];
      if (kernel && !held.has(kernel)) held.set(kernel, url.searchParams.get('session_id'));
      return Boolean(kernel) && held.get(kernel) === url.searchParams.get('session_id');
    },
    (ws) => ws.connectToServer().onMessage(() => {}),
  );
  try {
    await open(page, '/lab/tree/plain.ipynb', 'plain.ipynb', 'JupyterLab, late notebook connection');
    await page.locator('.lm-MenuBar-itemLabel', { hasText: /^Run$/ }).click();
    await page.locator('.lm-Menu-itemLabel', { hasText: /^Run All Cells$/ }).click();
    const outcome = await step('JupyterLab, late notebook connection: run the cell', 60_000, () =>
      Promise.race([
        page.waitForSelector('.jp-Dialog', { timeout: 60_000 }).then(async (d) => `the dialog "${(await d.textContent()).trim()}"`),
        page
          .waitForFunction(() => document.querySelector('.jp-OutputArea-output')?.textContent.trim() === '2', null, { timeout: 60_000 })
          .then(() => 'ran'),
      ]),
    );
    assert.equal(outcome, 'ran', `JupyterLab, late notebook connection: Run All showed ${outcome}`);
    assert.ok(lookups > 1, 'the notebook looked its session up after the first lookup (the one held back)');
    const { id, clientId } = await page.evaluate(() => {
      const kernel = [...globalThis.jupyterapp.shell.widgets('main')].find((w) => w.context?.path === 'plain.ipynb').sessionContext.session.kernel;
      return { id: kernel.id, clientId: kernel.clientId };
    });
    assert.ok(held.has(id) && held.get(id) !== clientId, `a connection other than the notebook's (${held.get(id)}, not ${clientId}) was held open`);
  } catch (error) {
    await keepEvidence(page);
    throw error;
  }
  await page.close();
}

// The page as it was when the check failed, with the server's log, for diagnosis.
async function keepEvidence(page) {
  await page.screenshot({ path: join(root, 'test-results/jupyter-browser.png'), fullPage: true, timeout: 10_000 }).catch(() => {});
  writeFileSync(join(root, 'test-results/jupyter-server.log'), log);
}

// Opens the notebook at `path`, runs every cell from the Run menu (the same in both apps) and returns the bright
// pixel count of each figure. Page errors fail the check unless the app shows them without Margo too (`own`).
async function runNotebook(browser, path, app, own = new Set()) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => own.has(e.message) || errors.push(`${e.message}\n${e.stack}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && /margo|widget/i.test(m.text())) errors.push(m.text());
  });
  page.setDefaultTimeout(60_000);
  try {
    await open(page, path, 'check.ipynb', app);
    await page.locator('.lm-MenuBar-itemLabel', { hasText: /^Run$/ }).click();
    await page.locator('.lm-Menu-itemLabel', { hasText: /^Run All Cells$/ }).click();
    // Three figures, or an error output (which the check below reports).
    await step(`${app}: run the cells`, 190_000, () =>
      page.waitForFunction(
      () => {
        const canvases = [...document.querySelectorAll('.jp-OutputArea canvas')];
        const failed = [...document.querySelectorAll('.jp-OutputArea-output')].some((o) => /Traceback|failed/.test(o.textContent));
        return failed || (canvases.length >= 3 && canvases.every((c) => c.width > 0 && c.height > 0));
      },
        null,
        { timeout: 180_000 },
      ),
    );
    const failures = await page.evaluate(() =>
      [...document.querySelectorAll('.jp-OutputArea-output')].map((o) => o.textContent).filter((t) => /Error|failed|Traceback/.test(t)),
    );
    assert.deepEqual(failures, [], `${app}: cell outputs show errors`);
    await page.waitForTimeout(3000);
    // Each figure's canvas as the browser shows it (a screenshot: reading a WebGPU canvas from the page after the
    // frame was presented returns nothing).
    const drawn = await step(`${app}: capture the figures`, 120_000, async () => {
      const lit = [];
      for (const canvas of await page.locator('.jp-OutputArea canvas').all()) {
        await canvas.scrollIntoViewIfNeeded({ timeout: 30_000 });
        await page.waitForTimeout(500);
        lit.push(brightPixels(await decodePNG(new Uint8Array(await canvas.screenshot({ timeout: 30_000, animations: 'allow' })))));
      }
      return lit;
    });
    assert.deepEqual(errors, [], `${app}: page errors`);
    assert.equal(drawn.length, 3, `${app}: ${drawn.length} figures`);
    for (const [k, lit] of drawn.entries()) assert.ok(lit > 500, `${app}: figure ${k} drew ${lit} bright pixels`);
    return { page, drawn };
  } catch (error) {
    await keepEvidence(page);
    throw error;
  }
}

let browser;
try {
  const port = await step('start the Jupyter server', 60_000, async () => {
    for (;;) {
      const port = serverPort(log);
      if (port) return port;
      await new Promise((r) => setTimeout(r, 100));
    }
  }).catch((error) => {
    error.message += `\n${log}`;
    throw error;
  });
  portHolder.close();
  assert.notEqual(port, offered, 'the server moved on from the port in use');
  base = `http://127.0.0.1:${port}`;
  browser = await step('launch the browser', 60_000, () =>
    chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true }),
  );

  // JupyterLab, with the camera both ways.
  const lab = await runNotebook(browser, '/lab/tree/check.ipynb', 'JupyterLab');
  const first = await waitFor('the view to report its camera', readCamera);
  for (const [k, v] of start.entries()) assert.ok(Math.abs(first.position[k] - v) < 1e-6, `camera starts where the kernel set it: ${first.position}`);
  assert.equal(first.up.length, 3, 'the reported camera is complete (up)');
  assert.ok(first.fov > 0, 'the reported camera is complete (fov)');
  const canvas = lab.page.locator('.jp-OutputArea canvas').first();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  await lab.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await lab.page.mouse.down();
  await lab.page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2 + 40, { steps: 10 });
  await lab.page.mouse.up();
  const moved = await waitFor('the dragged camera to reach the kernel', () => {
    const now = readCamera();
    return now && Math.hypot(...now.position.map((v, k) => v - first.position[k])) > 0.1 ? now : undefined;
  });
  // A click on the dense middle of the scatter reaches on_click with the point under the pointer.
  await lab.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const click = await waitFor('the click to reach on_click', () => readJson('click.json'));
  assert.equal(click.button, 0);
  assert.ok(click.hit && click.hit.layer === 0 && Number.isInteger(click.hit.index), `click hit ${JSON.stringify(click.hit)}`);
  // A box drag over the third figure (drag_mode "box") selects scatter points there and reaches on_select.
  const third = lab.page.locator('.jp-OutputArea canvas').nth(2);
  await third.scrollIntoViewIfNeeded();
  await lab.page.waitForTimeout(500);
  const area = await third.boundingBox();
  await lab.page.mouse.move(area.x + area.width * 0.2, area.y + area.height * 0.2);
  await lab.page.mouse.down();
  await lab.page.mouse.move(area.x + area.width * 0.8, area.y + area.height * 0.8, { steps: 10 });
  await lab.page.mouse.up();
  const selected = await waitFor('the selection to reach on_select', () => readJson('selection.json'));
  assert.ok(selected['1'] > 0, `box selected ${JSON.stringify(selected)} (layer 1 is the scatter)`);
  await lab.page.screenshot({ path: join(root, 'test-results/jupyter-browser.png'), fullPage: true });
  await lab.page.close();
  console.log(
    `jupyter: JupyterLab drew 3 figures (${lab.drawn.join(', ')} bright pixels); camera kernel -> view -> kernel, then drag to [${moved.position.map((v) => v.toFixed(2))}]; click hit point ${click.hit.index}; box selected ${selected['1']} points`,
  );
  // JupyterLab saved its workspace in the check folder, not in the user's ~/.jupyter.
  const workspaces = join(folder, 'config/lab/workspaces');
  await waitFor('JupyterLab to save its workspace in the check folder', () => existsSync(workspaces) && readdirSync(workspaces).length);
  await lateNotebookConnection(browser);
  console.log('jupyter: a notebook that connects to its kernel late still runs its cells (no "Select Kernel")');

  // Notebook 7 (the notebook package's own interface, served by the same server).
  const own = await ownErrors(browser, '/notebooks/plain.ipynb');
  const notebook = await runNotebook(browser, '/notebooks/check.ipynb', 'Notebook 7', own);
  await notebook.page.close();
  console.log(
    `jupyter: Notebook 7 drew 3 figures (${notebook.drawn.join(', ')} bright pixels); its own page errors without Margo: ${[...own].join(' | ') || 'none'}`,
  );
} finally {
  await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, 15_000))]);
  // The jupyter launcher starts the server and its kernels as child processes; on Windows kill() stops only the
  // launcher, so the whole tree is ended.
  killTree(server.pid);
}

// fig.to_png: the package draws a surface in its own headless browser (Edge, as above) and writes a PNG, which must
// have the asked size and show the plot.
const png = join(root, 'test-results/python-to-png.png');
rmSync(png, { force: true });
const script = [
  'import numpy as np, margoengine as margo',
  'x = np.linspace(-3, 3, 64)',
  'fig = margo.surface(np.sin(x)[None, :] * np.cos(x)[:, None], x=(-3, 3), y=(-3, 3))',
  `fig.to_png(${JSON.stringify(png)}, width=500, height=300, scale=2, browser=${JSON.stringify(process.env.MARGO_BROWSER ?? 'msedge')})`,
].join('\n');
const run = spawnSync(python, ['-c', script], {
  encoding: 'utf8',
  timeout: 120_000,
  killSignal: 'SIGKILL',
  env: { ...process.env, PYTHONPATH: join(root, 'python') },
});
assert.ok(!run.error, `step "fig.to_png" hung or failed to start: ${run.error}`);
assert.equal(run.status, 0, `to_png failed:\n${run.stdout}\n${run.stderr}`);
const image = await decodePNG(new Uint8Array(readFileSync(png)));
assert.deepEqual([image.width, image.height], [1000, 600], 'to_png size at scale 2');
const lit = brightPixels(image);
assert.ok(lit > 5000, `to_png drew ${lit} bright pixels`);
console.log(`jupyter: fig.to_png wrote 1000 x 600 with ${lit} bright pixels (test-results/python-to-png.png)`);
