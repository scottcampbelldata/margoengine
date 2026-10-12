import assert from 'node:assert/strict';
import {mkdir, readdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {build, createServer, preview} from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results');
await mkdir(results, {recursive: true});
const config = resolve(root, 'vite.config.js');

// Production consumer build: the worker, Wasm and wrappers must be emitted as separate assets.
const consumerOut = resolve(results, 'consumer');
await build({configFile: config, root: resolve(root, 'tests/consumer'), logLevel: 'warn', build: {outDir: consumerOut, emptyOutDir: true}});
const emitted = await readdir(resolve(consumerOut, 'assets'));
for (const pattern of [/^decoder\.worker-.*\.js$/, /^draco_decoder-.*\.wasm$/, /^draco_wasm_wrapper-.*\.js$/, /^basis_transcoder-.*\.wasm$/, /^basis_transcoder-.*\.js$/])
  assert.ok(emitted.some(file => pattern.test(file)), `consumer build did not emit ${pattern}: ${emitted.join(', ')}`);

const server = await createServer({configFile: config, logLevel: 'error', server: {port: 0}});
await server.listen();
const productionServer = await preview({configFile: config, root: resolve(root, 'tests/consumer'), logLevel: 'error', build: {outDir: consumerOut}, preview: {port: 0, host: '127.0.0.1'}});
let browser;
try {
  const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  try {browser = await chromium.launch({headless: true, channel: channel === 'bundled' ? undefined : channel, executablePath: process.env.BROWSER_EXECUTABLE, args});}
  catch (error) {if (channel !== 'msedge' || args.length || process.env.BROWSER_CHANNEL) throw error; browser = await chromium.launch({headless: true});}
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  page.on('response', response => {if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) errors.push(`${response.status()} ${response.url()}`);});
  await page.goto(`${server.resolvedUrls.local[0]}tests/decoders.html`);
  await page.waitForFunction(() => typeof window.runDecoderTests === 'function');
  const report = await page.evaluate(() => window.runDecoderTests());
  await page.goto(productionServer.resolvedUrls.local[0]);
  await page.waitForFunction(() => typeof window.runConsumer === 'function');
  report.consumer = await page.evaluate(() => window.runConsumer());
  assert.deepEqual(report.consumer, {vertices: 24, indices: 36, width: 2048, format: 'rgba8unorm'});
  report.consumer.emitted = emitted;
  report.checks.push('Production Vite consumer emits the worker and decoders as assets and decodes from them');
  report.browser = browser.version();
  assert.deepEqual(errors.filter(error => !/^Failed to load resource/.test(error)), []);
  await writeFile(resolve(results, 'decoders-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
  await productionServer.close();
}
