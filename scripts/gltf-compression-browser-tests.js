import assert from 'node:assert/strict';
import {mkdir, readFile, readdir, writeFile, copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {build, preview} from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results/gltf-compression-browser');
const consumer = resolve(results, 'consumer'), output = resolve(results, 'dist'), publicDir = resolve(consumer, 'public');
await mkdir(publicDir, {recursive: true});
const fixtureDir = resolve(root, 'packages/decoders/tests/fixtures');
await Promise.all(['Box.gltf', 'Box.bin'].map(name => copyFile(resolve(fixtureDir, name), resolve(publicDir, name))));
const meshoptDir = resolve(root, 'packages/gltf-pro/tests/fixtures');
await Promise.all(['Triangle.meshopt.gltf', 'Triangle.meshopt.bin'].map(name => copyFile(resolve(meshoptDir, name), resolve(publicDir, name))));
for (const [folder, name] of [[fixtureDir, 'Box'], [meshoptDir, 'Triangle.meshopt']]) {
  const doc = JSON.parse(await readFile(resolve(folder, name + '.gltf'), 'utf8')), binary = await readFile(resolve(folder, name + '.bin'));
  delete doc.buffers[0].uri;
  const json = new TextEncoder().encode(JSON.stringify(doc)), jsonLength = (json.length + 3) & ~3, binLength = (binary.length + 3) & ~3;
  const glb = new Uint8Array(28 + jsonLength + binLength), header = new DataView(glb.buffer);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, glb.length, true);
  header.setUint32(12, jsonLength, true); header.setUint32(16, 0x4e4f534a, true); glb.fill(32, 20, 20 + jsonLength); glb.set(json, 20);
  header.setUint32(20 + jsonLength, binLength, true); header.setUint32(24 + jsonLength, 0x004e4942, true); glb.set(binary, 28 + jsonLength);
  await writeFile(resolve(publicDir, name + '.glb'), glb);
}
await writeFile(resolve(consumer, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Compressed glTF production consumer</title><link rel="icon" href="data:,"></head><body><canvas style="width:128px;height:128px"></canvas><script type="module" src="/main.js"></script></body></html>');
for (const limit of ['Vertices', 'Indices']) {
  const doc = JSON.parse(await readFile(resolve(fixtureDir, 'Box.gltf'), 'utf8')), primitive = doc.meshes[0].primitives[0];
  if (limit === 'Vertices') for (const id of Object.values(primitive.attributes)) doc.accessors[id].count = 3;
  else doc.accessors[primitive.indices].count = 3;
  await writeFile(resolve(publicDir, 'Box.bad' + limit + '.gltf'), JSON.stringify(doc));
}
await writeFile(resolve(consumer, 'main.js'), `
import {Engine} from '@margoengine/core';
import {loadGLTF, parseGLTF} from '@margoengine/gltf-pro';

window.runCompressionConsumer = async kind => {
  const NativeWorker = window.Worker, workers = [];
  window.Worker = class extends NativeWorker {
    constructor(url, options) {super(url, options); if (options?.name === 'margoengine-decoder') {this.record = {url: String(url), terminated: false}; workers.push(this.record);}}
    terminate() {if (this.record) this.record.terminated = true; return super.terminate();}
  };
  let engine;
  try {
    engine = await Engine.create(document.querySelector('canvas'), {backend: 'webgpu', capacity: 32, camera: {position: [2, 2, 3], target: [0, 0, 0]}});
    engine.gpu.pushErrorScope('validation');
    const models = [], rejections = [], positions = [-1, -1, 0, 1, -1, 0, 0, 1, 0];
    const checkModel = async (model, path, synchronous = false) => {
      if (model?.then) throw new Error('parseGLTF must return its model synchronously');
      const primitive = model.primitives[0];
      if (kind === 'meshopt') {
        const actual = Array.from({length: 3}, (_, index) => Array.from(primitive.vertices.subarray(index * 20, index * 20 + 3))).flat();
        if (JSON.stringify(actual) !== JSON.stringify(positions) || JSON.stringify([...primitive.indices]) !== '[0,1,2]') throw new Error('Triangle geometry changed during decoding');
      }
      models.push({path, synchronous, primitives: model.primitives.length, vertices: primitive.vertices.length / 20, indices: primitive.indices.length, finite: primitive.vertices.every(Number.isFinite)});
      engine.render({culling: false}); await engine.gpu.queue.onSubmittedWorkDone();
      model.destroy();
      if (engine.meshes.size) throw new Error('Model disposal retained meshes');
    };
    const paths = kind === 'meshopt' ? ['/Triangle.meshopt.gltf', '/Triangle.meshopt.glb'] : ['/Box.gltf', '/Box.glb'];
    for (const path of paths) await checkModel(await loadGLTF(engine, new URL(path, location.href)), path);
    if (kind === 'meshopt') {
      const bytes = await (await fetch('/Triangle.meshopt.glb')).arrayBuffer();
      await checkModel(parseGLTF(engine, bytes), '/Triangle.meshopt.glb (sync)', true);
      const data = new Float32Array(positions), doc = {asset: {version: '2.0'}, buffers: [{byteLength: data.byteLength}], bufferViews: [{buffer: 0, byteLength: data.byteLength}], accessors: [{bufferView: 0, componentType: 5126, count: 3, type: 'VEC3'}], meshes: [{primitives: [{attributes: {POSITION: 0}}]}], nodes: [{mesh: 0}]};
      await checkModel(parseGLTF(engine, doc, [data]), 'uncompressed (sync)', true);
    }
    if (kind === 'draco') for (const path of ['/Box.badVertices.gltf', '/Box.badIndices.gltf']) {
      let rejected = false;
      try {const model = await loadGLTF(engine, new URL(path, location.href)); model.destroy();}
      catch (error) {if (!/Draco.*(vertex|index|count|limit|width|budget)/i.test(error.message)) throw error; rejected = true;}
      if (!rejected) throw new Error('Oversized decoded geometry was accepted: ' + path);
      if (engine.meshes.size) throw new Error('Rejected geometry retained meshes');
      rejections.push(path);
    }
    const validation = await engine.gpu.popErrorScope();
    if (validation) throw new Error(validation.message);
    return {models, rejections, workers, meshesAfterDisposal: engine.meshes.size};
  } finally {engine?.dispose(); window.Worker = NativeWorker;}
};
`);

await build({configFile: false, root: consumer, logLevel: 'warn', build: {target: 'es2022', outDir: output, emptyOutDir: true}});
const emitted = await readdir(resolve(output, 'assets'));
for (const pattern of [/^decoder\.worker-.*\.js$/, /^draco_decoder-.*\.wasm$/, /^draco_wasm_wrapper-.*\.js$/])
  assert.ok(emitted.some(file => pattern.test(file)), `production gltf-pro consumer did not emit ${pattern}: ${emitted.join(', ')}`);

const server = await preview({configFile: false, root: consumer, logLevel: 'error', build: {outDir: output}, preview: {host: '127.0.0.1', port: 0}});
let browser;
try {
  const channel = process.env.BROWSER_CHANNEL ?? 'msedge', args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  try {browser = await chromium.launch({headless: true, channel: channel === 'bundled' ? undefined : channel, executablePath: process.env.BROWSER_EXECUTABLE, args});}
  catch (error) {if (channel !== 'msedge' || args.length || process.env.BROWSER_CHANNEL) throw error; browser = await chromium.launch({headless: true});}
  const page = await browser.newPage(), errors = [], decodedAssets = new Set();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  page.on('response', response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    if (/draco_decoder-.*\.wasm|draco_wasm_wrapper-.*\.js|decoder\.worker-.*\.js/.test(response.url())) decodedAssets.add(new URL(response.url()).pathname);
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => typeof window.runCompressionConsumer === 'function');
  // Run the synchronous codec and ordinary path first: importing gltf-pro must not start Draco.
  const meshopt = await page.evaluate(() => window.runCompressionConsumer('meshopt'));
  assert.deepEqual(meshopt.models, ['/Triangle.meshopt.gltf', '/Triangle.meshopt.glb', '/Triangle.meshopt.glb (sync)', 'uncompressed (sync)'].map((path, index) => ({path, synchronous: index >= 2, primitives: 1, vertices: 3, indices: 3, finite: true})));
  assert.deepEqual(meshopt.workers, [], 'meshopt and uncompressed parsing do not create Draco workers');
  assert.equal(meshopt.meshesAfterDisposal, 0);
  assert.deepEqual([...decodedAssets], [], 'meshopt and uncompressed parsing do not fetch worker or Draco assets');
  const report = await page.evaluate(() => window.runCompressionConsumer('draco'));
  assert.deepEqual(report.models, ['/Box.gltf', '/Box.glb'].map(path => ({path, synchronous: false, primitives: 1, vertices: 24, indices: 36, finite: true})));
  assert.deepEqual(report.rejections, ['/Box.badVertices.gltf', '/Box.badIndices.gltf']);
  assert.equal(report.workers.length, 4, 'successful and rejected default loads create their own lazy decoder workers');
  assert.ok(report.workers.every(worker => worker.terminated), 'loadGLTF disposes temporary decoder workers');
  assert.equal(report.meshesAfterDisposal, 0);
  assert.deepEqual(errors, []);
  assert.ok([...decodedAssets].some(path => /draco_decoder-.*\.wasm/.test(path)), 'browser did not fetch the production Wasm asset');
  const result = {meshopt, draco: report, emitted, decodedAssets: [...decodedAssets], browser: browser.version()};
  await writeFile(resolve(results, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {await browser?.close(); await server.close();}
