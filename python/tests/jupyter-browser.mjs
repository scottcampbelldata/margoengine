// End-to-end check of the margoengine Python package in a real JupyterLab: starts `jupyter lab` from the data venv
// (test-results/.venv-data in the main checkout, python/requirements-notebook.txt, with the package and its
// prebuilt extension installed as python/README.md says), opens a notebook in headless Edge, runs it, and checks that
// each figure's widget view appears and draws (non-background pixels in its canvas) with no errors in the page.
// One GPU job at a time, from the repository root after `node python/build-frontend.mjs`:
//   node scripts/gpu-lock.mjs run --owner=<you> -- node python/tests/jupyter-browser.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { decodePNG } from '../../tests/support/png.js';

const root = resolve(import.meta.dirname, '../..'),
  main = root.replace(/[\\/]\.[\w-]+[\\/]worktrees[\\/][^\\/]+$/, ''),
  venv = join(main, 'test-results/.venv-data'),
  jupyter = ['Scripts/jupyter.exe', 'bin/jupyter'].map((p) => join(venv, p)).find(existsSync);
assert.ok(jupyter, `no jupyter in ${venv}: install python/requirements-notebook.txt there`);

// A notebook with a scatter from a DataFrame, a volume and a surface: one figure per cell.
// The notebook folder lives in test-results (git-ignored) and is replaced each run: a just-stopped server on Windows
// still holds its files for a moment, so it is cleared at the start rather than the end.
const folder = join(root, 'test-results/jupyter-check');
rmSync(folder, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });
const code = (source) => ({ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source });
writeFileSync(
  join(folder, 'check.ipynb'),
  JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    cells: [
      code(
        'import numpy as np, pandas as pd, margoengine as margo\nrng = np.random.default_rng(1)\ndf = pd.DataFrame(rng.standard_normal((200000, 3)), columns=["x", "y", "z"])',
      ),
      code('margo.scatter(df, x="x", y="y", z="z", color="z")'),
      code(
        'g = np.linspace(-3, 3, 48, dtype=np.float32)\nX, Y, Z = np.meshgrid(g, g, g)\nmargo.volume(np.exp(-(X**2 + Y**2 + Z**2)), opacity=[(0, 0), (0.3, 0.2), (1, 1)])',
      ),
      code('x = np.linspace(-3, 3, 64)\nmargo.surface(np.sin(x)[None, :] * np.cos(x)[:, None], x=(-3, 3), y=(-3, 3))'),
    ].map((cell, k) => ({ ...cell, id: `c${k}` })),
  }),
);

// JupyterLab 4 renders only the cells in view by default (windowing); every cell stays rendered here so each figure
// keeps drawing while the others are checked. A settings folder of the check's own keeps the user's settings untouched.
const settings = join(folder, 'settings/@jupyterlab/notebook-extension');
mkdirSync(settings, { recursive: true });
writeFileSync(join(settings, 'tracker.jupyterlab-settings'), JSON.stringify({ windowingMode: 'none' }));

const port = 8913;
const server = spawn(
  jupyter,
  ['lab', '--no-browser', `--port=${port}`, '--ServerApp.token=', '--ServerApp.password=', '--ServerApp.ip=127.0.0.1', `--ServerApp.root_dir=${folder}`],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, JUPYTERLAB_SETTINGS_DIR: join(folder, 'settings') } },
);
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
let browser;
try {
  for (let t = 0; !log.includes(`127.0.0.1:${port}`); t++) {
    assert.ok(t < 600, `jupyter lab did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /margo|widget/i.test(m.text())) errors.push(m.text());
  });
  page.setDefaultTimeout(120_000);
  await page.goto(`http://127.0.0.1:${port}/lab/tree/check.ipynb`);
  await page.waitForSelector('.jp-NotebookPanel .jp-Cell');
  // Wait for the kernel, then run every cell (Run > Run All Cells has the command id notebook:run-all-cells).
  await page.waitForFunction(() => document.querySelector('.jp-Notebook-ExecutionIndicator, .jp-KernelStatus') !== null);
  await page.waitForTimeout(3000);
  await page.keyboard.press('Control+Shift+C');
  await page.keyboard.type('Run All Cells');
  await page.keyboard.press('Enter');
  // Three figures: wait until each output canvas has drawn something brighter than the dark theme's background.
  await page.waitForFunction(
    () => {
      const canvases = [...document.querySelectorAll('.jp-OutputArea canvas')];
      return canvases.length >= 3 && canvases.every((c) => c.width > 0 && c.height > 0);
    },
    null,
    { timeout: 180_000 },
  );
  await page.waitForTimeout(3000);
  // Each figure's canvas as the browser shows it (a screenshot: reading a WebGPU canvas from the page after the frame
  // was presented returns nothing), counted for pixels brighter than the dark theme's background.
  const drawn = [];
  for (const canvas of await page.locator('.jp-OutputArea canvas').all()) {
    await canvas.scrollIntoViewIfNeeded({ timeout: 30_000 });
    await page.waitForTimeout(500);
    const png = await decodePNG(new Uint8Array(await canvas.screenshot({ timeout: 30_000, animations: 'allow' })));
    let lit = 0;
    for (let i = 0; i < png.data.length; i += 4) if (png.data[i] + png.data[i + 1] + png.data[i + 2] > 3 * 60) lit++;
    drawn.push(lit);
  }
  await page.screenshot({ path: join(root, 'test-results/jupyter-browser.png'), fullPage: true });
  const failures = await page.evaluate(() => [...document.querySelectorAll('.jp-OutputArea-output')].map((o) => o.textContent).filter((t) => /Error|failed|Traceback/.test(t)));
  assert.deepEqual(failures, [], 'cell outputs show errors');
  assert.deepEqual(errors, [], 'page errors');
  assert.equal(drawn.length, 3, `${drawn.length} figures`);
  for (const [k, lit] of drawn.entries()) assert.ok(lit > 500, `figure ${k} drew ${lit} bright pixels`);
  console.log(`jupyter: 3 figures drawn in JupyterLab (${drawn.join(', ')} bright pixels); screenshot test-results/jupyter-browser.png`);
} finally {
  await browser?.close();
  // The jupyter launcher starts the server and its kernels as child processes; on Windows kill() stops only the
  // launcher, so the whole tree is ended there.
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  else server.kill();
}
