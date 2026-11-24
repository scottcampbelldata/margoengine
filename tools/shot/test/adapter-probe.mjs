// The repeat-launch check of docs/known-bugs.md ("over SSH on the dev PC a browser launch now and then gets no WebGPU
// adapter"): launches the shot tool's browser N times (default 12) and asks each for a high-performance WebGPU adapter
// at 0, 0.5, 2 and 5 s after load, keeping edge://gpu's text (test-results/adapter-probe/gpu-<n>.txt) for a look.
// Prints one JSON line per launch and a count; exits 1 when any launch never got an adapter. Run it in the session the
// renders run in (over SSH, or in the "Margo Shot Runner" task's desktop session).
//   node tools/shot/test/adapter-probe.mjs [launches] [launch arguments as JSON, default ["--disable-gpu-sandbox"] over SSH]
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { shotBrowser } from '../platform.mjs';

const launches = Number(process.argv[2] ?? 12),
  extra = JSON.parse(process.argv[3] ?? (process.env.SSH_CONNECTION ? '["--disable-gpu-sandbox"]' : '[]')),
  out = resolve(import.meta.dirname, '../../../test-results/adapter-probe');
mkdirSync(out, { recursive: true });
const server = createServer((_, response) => response.end('<!doctype html><title>adapter probe</title>'));
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/`;
let missing = 0;
for (let i = 0; i < launches; i++) {
  const record = { launch: i, args: extra };
  const browser = await launchBrowser({ name: shotBrowser(), args: extra, headless: true, exit: () => {} });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    record.tries = await page.evaluate(async () => {
      const answers = [];
      for (const wait of [0, 500, 2000, 5000]) {
        await new Promise((done) => setTimeout(done, wait));
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
        answers.push(adapter ? `${adapter.info.vendor} ${adapter.info.architecture}` : null);
        if (adapter) break;
      }
      return answers;
    });
    const gpu = await browser.newPage();
    if (await gpu.goto('edge://gpu', { timeout: 20_000 }).then(() => true, () => false)) {
      // The page fills its feature table in after load: wait until its WebGPU row is there, not for a fixed time.
      const pageText = () => {
        let s = '';
        const visit = (node) => {
          if (node.nodeType === 3) s += node.textContent + '\n';
          if (node.shadowRoot) visit(node.shadowRoot);
          for (const child of node.childNodes ?? []) visit(child);
        };
        visit(document.body ?? document);
        return s;
      };
      // A page that never shows the row is itself a finding of the probe: say so beside the text it did show.
      record.gpuPage = await gpu
        .waitForFunction(`(${pageText})().includes('WebGPU')`, null, { timeout: 20_000, polling: 250 })
        .then(() => 'ready', () => 'no WebGPU row within 20 s');
      const text = await gpu.evaluate(pageText);
      writeFileSync(join(out, `gpu-${i}.txt`), text);
    }
  } catch (error) {
    record.error = String(error.message ?? error).slice(0, 300);
  } finally {
    await closeAll({ browser });
  }
  if (!record.tries?.at(-1)) missing++;
  console.log(JSON.stringify(record));
}
await closeAll({ servers: [server] });
console.log(`${launches - missing} of ${launches} launches got a WebGPU adapter`);
process.exitCode = missing ? 1 : 0;
