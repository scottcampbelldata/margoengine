import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer as createHTTPServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { compatRun, compatShim, compatUrl } from '../../../scripts/support/compat-shim.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results');
const fixtures = {
  '/image.png': [resolve(root, '../physics2d/tests/fixtures/outline/donut.png'), 'image/png'],
  '/font.woff2': [resolve(root, '../../site/fonts/SourceSans3-latin.woff2'), 'font/woff2'],
};
const resourceServer=createHTTPServer(async(request,response)=>{
  response.setHeader('Access-Control-Allow-Origin','*');
  if(request.url==='/fonts.css'||request.url==='/nested/fonts.css') {
    response.setHeader('Content-Type','text/css');
    response.end(request.url==='/fonts.css'?'@import url("nested/fonts.css");':
      '@font-face {font-family:InlineSource;src:url("../font.woff2") format("woff2");font-weight:100 900;}');
  } else if(fixtures[request.url]) {
    const [file,type]=fixtures[request.url];response.setHeader('Content-Type',type);response.end(await readFile(file));
  } else {response.statusCode=404;response.end();}
});
await new Promise(resolve=>resourceServer.listen(0,'127.0.0.1',resolve));
await mkdir(results, { recursive: true });
const server = await createServer({
  configFile: resolve(root, 'vite.config.js'),
  logLevel: 'error',
  server: { port: 0 },
});
await server.listen();
let browser;
try {
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  browser = await launchBrowser({
    headless: true,
    args,
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(120000);
  if (compatRun()) await page.addInitScript(compatShim, compatUrl());
  await page.addInitScript(url=>{window.htmlResourceOrigin=url;},`http://127.0.0.1:${resourceServer.address().port}`);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico'))
      errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`${server.resolvedUrls.local[0]}test/html.html`);
  await page.waitForFunction(() => typeof window.runHTMLTests === 'function');
  const report = await page.evaluate(() => window.runHTMLTests());
  report.browser = browser.version();
  assert.deepEqual(errors, []);
  await writeFile(resolve(results, compatRun() ? 'html-browser-compat.json' : 'html-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await closeAll({ browser, servers: [server,resourceServer] });
}
