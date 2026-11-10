// A real kernel, binary widget comm, AFM loading and two-way state in JupyterLab.
// Run through gpu-lock after python/build-notebook.mjs. Every operation has a deadline.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { launchBrowser } from '../../scripts/lib/browser.mjs';
import { closeAll } from '../../scripts/support/shutdown.mjs';
import { killTree, notebookHasKernel, serverPort, startKernel, step } from './jupyter-steps.mjs';
import { venvDir, venvTools } from './venv.mjs';

const root = resolve(import.meta.dirname, '../..'), folder = join(root, 'test-results/sciviz-jupyter');
mkdirSync(folder, { recursive: true });
const notebook = JSON.parse(readFileSync(join(root, 'examples/notebooks/sciviz-portable.ipynb'), 'utf8'));
notebook.cells = notebook.cells.filter(cell => cell.cell_type === 'code');
writeFileSync(join(folder, 'check.ipynb'), JSON.stringify(notebook));
const settings = join(folder, 'settings/@jupyterlab/notebook-extension');
mkdirSync(settings, { recursive: true });
writeFileSync(join(settings, 'tracker.jupyterlab-settings'), JSON.stringify({ windowingMode: 'none' }));
const python = venvTools(venvDir())?.python;
assert.ok(python, 'Run npm run setup:python-test to create the notebook test environment');
const server = spawn(python, ['-m', 'jupyterlab', '--no-browser', '--port=0', '--ServerApp.token=', '--ServerApp.password=', '--ServerApp.ip=127.0.0.1', `--ServerApp.root_dir=${folder}`, '--LabApp.expose_app_in_browser=True'], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, PYTHONPATH: join(root, 'python'), MARGO_REPO: root, JUPYTER_CONFIG_DIR: join(folder, 'config'), JUPYTERLAB_SETTINGS_DIR: join(folder, 'settings') },
});
let log = '', browser;
server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
const deadline = setTimeout(() => { killTree(server.pid); killTree(process.pid); }, 240000);
try {
  const base = await step('start JupyterLab', 60000, async () => {
    while (!serverPort(log)) { if (server.exitCode !== null) throw new Error(log); await new Promise(r => setTimeout(r, 100)); }
    return `http://127.0.0.1:${serverPort(log)}`;
  });
  browser = await launchBrowser({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    globalThis.notebookFigures = [];
    window.addEventListener('margo-notebook-ready', e => { globalThis.notebookFigures.push(e.detail); });
  });
  const kernelId = await step('start notebook kernel', 60000, () => startKernel(base, 'check.ipynb', AbortSignal.timeout(60000)));
  await page.goto(`${base}/lab/tree/check.ipynb`, { timeout: 60000 });
  await page.waitForFunction(notebookHasKernel, { path: 'check.ipynb', kernelId }, { timeout: 60000 });
  // Invoke the notebook's actual execution command after its kernel is connected.
  await page.evaluate(() => globalThis.jupyterapp.commands.execute('notebook:run-all-cells'));
  await page.waitForFunction(() => globalThis.notebookFigures.length === 2 || [...document.querySelectorAll('.jp-OutputArea-output')].some(el => el.textContent.includes('Traceback')), null, { timeout: 90000 });
  const count = await page.evaluate(() => globalThis.notebookFigures.length);
  assert.equal(count, 2, await page.locator('.jp-OutputArea').allTextContents().then(a => a.join('\n')));
  const run = code => page.evaluate(async code => {
    const panel = [...globalThis.jupyterapp.shell.widgets('main')].find(w => w.context?.path === 'check.ipynb');
    const reply = await panel.sessionContext.session.kernel.requestExecute({ code }).done;
    if (reply.content.status !== 'ok') throw new Error(JSON.stringify(reply.content));
  }, code);
  await run('mri.camera = {**mri.spec["camera"], "position": [3.3, 2, 2]}\nexo.selection = {"region": {"rect": [0, 0, 400, 300]}, "points": [{"layer": 0, "indices": np.array([2, 5], dtype="<u4")}]}');
  await page.waitForFunction(() => notebookFigures[0].engine.camera.position[0] === 3.3 && notebookFigures[1].selection?.points[0].indices[1] === 5);
  await run('mri.observe(lambda change: (Path("camera.json").write_text(json.dumps(change["new"]))), names="camera")\nexo.observe(lambda change: (Path("selection.json").write_text(str(list(memoryview(change["new"]["points"][0]["indices"]).cast("B").cast("I"))))), names="selection")');
  await page.evaluate(() => {
    const [mri, exo] = notebookFigures;
    mri.engine.camera.position = [4.4, 2, 2]; mri.controls.dispatchEvent(new Event('change'));
    exo.setSelection({ region: { rect: [0, 0, 400, 300] }, points: [{ layer: exo.layers[0], indices: new Uint32Array([1, 3]) }] });
  });
  await step('receive browser events in Python', 30000, async () => {
    for (;;) {
      try {
        if (JSON.parse(readFileSync(join(folder, 'camera.json'))).position[0] === 4.4 && readFileSync(join(folder, 'selection.json'), 'utf8') === '[1, 3]') return;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await new Promise(r => setTimeout(r, 50));
    }
  });
  await run('assert not mri.error and not exo.error\nassert len(mri.buffers["b0"]) == 88 * 128 * 128 * 2');
  await page.screenshot({ path: join(folder, 'jupyterlab.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('JupyterLab: real OpenNeuro + Arrow Exoplanet widgets, binary comm, camera and selection in both directions');
} finally {
  writeFileSync(join(folder, 'server.log'), log);
  if (browser) await closeAll({ browser });
  killTree(server.pid); clearTimeout(deadline);
}
