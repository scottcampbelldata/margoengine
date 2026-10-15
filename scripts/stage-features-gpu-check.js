// Real-adapter check of the stage's lazy lighting packs: a stage scene with a loaded glTF model on a floor, then
// `await app.environment(url)` and `await app.shadows()` must each change the frame, with zero WebGPU validation
// errors, and `app.dispose()` must release both (and abort an environment load still in flight).
// Run from the repository root after building packages, with the GPU lock held:
//   node scripts/gpu-lock.mjs run --owner=<id> -- node scripts/stage-features-gpu-check.js
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from './browser.js';
import {decodePNG} from '../tests/support/png.js';

// A unit cube glTF (24 vertices with face normals, 36 indices).
function cube() {
  const positions = [], normals = [], indices = [];
  for (const [axis, sign] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3, base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 0, 0], n = [0, 0, 0]; p[axis] = sign * 0.5; p[u] = a * 0.5 * sign; p[v] = b * 0.5; n[axis] = sign;
      positions.push(...p); normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const bytes = Buffer.concat([Buffer.from(new Float32Array(positions).buffer), Buffer.from(new Float32Array(normals).buffer), Buffer.from(new Uint32Array(indices).buffer)]);
  return {asset: {version: '2.0'}, buffers: [{byteLength: bytes.length, uri: `data:application/octet-stream;base64,${bytes.toString('base64')}`}],
    bufferViews: [{buffer: 0, byteLength: 288}, {buffer: 0, byteOffset: 288, byteLength: 288}, {buffer: 0, byteOffset: 576, byteLength: 144}],
    accessors: [{bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5]}, {bufferView: 1, componentType: 5126, count: 24, type: 'VEC3'}, {bufferView: 2, componentType: 5125, count: 36, type: 'SCALAR'}],
    meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1}, indices: 2}]}], nodes: [{mesh: 0, translation: [0, 0.5, 0]}]};
}

const browser = await openBrowser({startPath: '/tests/modern-wrapper.html', port: 5237}), {page, hardware} = browser, errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
try {
  await page.route('**/stage-cube.gltf', route => route.fulfill({contentType: 'model/gltf+json', body: JSON.stringify(cube())}));
  await page.waitForFunction(() => window.wrapper);
  await page.evaluate(async () => {
    const host = document.createElement('div'); host.id = 'stage'; host.style.cssText = 'width:400px;height:300px'; document.body.prepend(host);
    // Camera on the side the sun (toward +3, +5, +4) casts the cube's shadow.
    const app = await window.wrapper.createStage(host, {backend: 'webgpu', controls: false, autoStart: false, camera: {position: [-5, 4, -6], target: [0, 0, 0]}});
    const device = app.engine.gpu, gpuErrors = [];
    device.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
    app.box({size: [6, 0.2, 6], position: [0, -0.1, 0], color: '#d8d8d8', roughness: 0.9});
    const model = await app.load('/stage-cube.gltf', {fit: false});
    app.engine.camera.fitToBoundingBox([-1.5, 0, -1.5], [1, 1, 1], {aspect: 4 / 3, duration: 0}); // the cube and the floor its shadow falls on
    const render = async () => {
      device.pushErrorScope('validation');
      for (let i = 0; i < 3; i++) {app.engine.render({culling: false}); await device.queue.onSubmittedWorkDone();}
      const error = await device.popErrorScope(); if (error) gpuErrors.push(error.message);
    };
    window.stage = {app, model, gpuErrors, render};
    await render();
  });
  const shot = async name => {const bytes = await page.locator('#stage canvas').screenshot(); await writeFile(`test-results/stage-features-${name}.png`, bytes); return decodePNG(bytes);};
  const diff = (a, b) => {let pixels = 0, worst = 0; for (let i = 0; i < a.data.length; i += 4) {let d = 0; for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c])); if (d > 2) pixels++; worst = Math.max(worst, d);} return {pixels, worst};};
  const luma = image => {let sum = 0; for (let i = 0; i < image.data.length; i += 4) sum += 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2]; return +(sum / (image.data.length / 4)).toFixed(2);};

  const plain = await shot('plain');
  const environment = await page.evaluate(async () => {
    const lighting = await window.stage.app.environment('/packages/environment/tests/fixtures/spot1Lux.hdr', {intensity: 4});
    window.stage.lighting = lighting; await window.stage.render();
    return {plugins: ['environment', 'environment:lighting'].map(name => window.stage.app.engine.hasPlugin(name)), size: lighting.environment.size ?? null};
  });
  const lit = await shot('environment');
  const shadows = await page.evaluate(async () => {
    const shadows = await window.stage.app.shadows({resolution: 1024});
    window.stage.shadows = shadows; await window.stage.render();
    return {plugin: window.stage.app.engine.hasPlugin('shadows'), draws: {...shadows.stats}};
  });
  const shadowed = await shot('shadows');
  const result = {hardware, environment: {...environment, diff: diff(plain, lit), luma: [luma(plain), luma(lit)]}, shadows: {...shadows, diff: diff(lit, shadowed), luma: [luma(lit), luma(shadowed)]}};

  result.dispose = await page.evaluate(async () => {
    const {app, lighting, shadows, gpuErrors} = window.stage;
    app.dispose();
    const disposed = {engine: app.engine.disposed, lighting: lighting.disposed, environment: lighting.environment.disposed, canvasRemoved: !document.querySelector('#stage canvas')};
    // A second stage disposed while its environment is still loading: the load rejects with AbortError.
    const other = await window.wrapper.createStage('#stage', {backend: 'webgpu', controls: false, autoStart: false});
    const pending = other.environment('/packages/environment/tests/fixtures/spot1Lux.hdr').then(() => 'resolved', error => error.name);
    other.dispose();
    return {...disposed, shadowsRemoved: !app.engine.hasPlugin?.('shadows'), abortedLoad: await pending, gpuErrors: [...gpuErrors]};
  });
  console.log(JSON.stringify(result, null, 2));
  await writeFile('test-results/stage-features-gpu.json', JSON.stringify(result, null, 2));
  assert.deepEqual(result.environment.plugins, [true, true]);
  assert.ok(result.environment.diff.pixels > 1000, `environment did not change the frame: ${JSON.stringify(result.environment.diff)}`);
  assert.equal(result.shadows.plugin, true);
  assert.ok(result.shadows.diff.pixels > 500, `shadows did not change the frame: ${JSON.stringify(result.shadows.diff)}`);
  assert.ok(result.shadows.luma[1] < result.shadows.luma[0], 'shadows did not darken the frame');
  assert.deepEqual({...result.dispose, gpuErrors: undefined}, {engine: true, lighting: true, environment: true, canvasRemoved: true, shadowsRemoved: true, abortedLoad: 'AbortError', gpuErrors: undefined});
  assert.deepEqual(result.dispose.gpuErrors, []);
  assert.deepEqual(errors, []);
  console.log('stage features GPU check passed');
} finally {await browser.close();}
