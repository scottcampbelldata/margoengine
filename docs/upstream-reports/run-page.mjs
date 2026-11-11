// Opens one repro page in a real browser and prints the object the page leaves in `window.result`.
// Convenience only: every repro page also runs by itself in any browser (serve the folder over http://localhost,
// WebGPU needs a secure context) and shows the same output as text.
//
//   node docs/upstream-reports/run-page.mjs <folder/page.html> [--browser=edge|chrome|chromium|firefox|webkit]
//        [--query=a=1&b=2] [--luid=high,low (Chromium: use that adapter, decimal LUID)] [--arg=<chromium switch>, repeatable] [--headed] [--timeout=120000]
//
// Needs Playwright (`npm i playwright-core`; browsers are the system Edge or Chrome, or Playwright's own).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { extname, join, resolve, dirname, basename } from 'node:path';
import { createRequire } from 'node:module';

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const target = resolve(process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? '');
const browserName = arg('browser', 'edge');
const timeout = Number(arg('timeout', '120000'));
const root = dirname(target);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webm': 'video/webm', '.mp4': 'video/mp4' };
const server = createServer(async (req, res) => {
  try {
    const body = await readFile(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    res.writeHead(200, { 'content-type': types[extname(req.url.split('?')[0])] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end(); /* favicon and the like */
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://localhost:${server.address().port}/${basename(target)}${arg('query') ? '?' + arg('query') : ''}`;
const { chromium, firefox, webkit } = createRequire(join(process.cwd(), 'package.json'))('playwright-core');
const headed = process.argv.includes('--headed') || browserName === 'firefox';
let browser;
try {
  if (browserName === 'firefox')
    browser = await firefox.launch({ headless: false, executablePath: realpathSync.native(firefox.executablePath()), firefoxUserPrefs: { 'dom.webgpu.enabled': true, 'gfx.webgpu.ignore-blocklist': true } });
  else if (browserName === 'webkit') browser = await webkit.launch({ headless: !headed });
  else
    browser = await chromium.launch({
      headless: !headed,
      args: ['--enable-unsafe-webgpu', ...(arg('luid') ? ['--use-adapter-luid=' + arg('luid')] : []), ...process.argv.filter((a) => a.startsWith('--arg=')).map((a) => a.slice(6))],
      ...(browserName === 'edge' ? { channel: 'msedge' } : browserName === 'chrome' ? { channel: 'chrome' } : {}),
    });
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => process.stderr.write(`[page ${m.type()}] ${m.text()}\n`));
  page.on('pageerror', (e) => process.stderr.write(`[page error] ${e.message}\n`));
  await page.goto(url);
  await page.waitForFunction(() => window.result !== undefined, null, { timeout });
  console.log(JSON.stringify({ browser: browserName, version: browser.version(), url, result: await page.evaluate(() => window.result) }, null, 2));
} finally {
  await browser?.close();
  server.close();
}
