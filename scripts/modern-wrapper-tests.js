import assert from 'node:assert/strict';
import {build} from 'vite';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openBrowser} from './browser.js';
import {decodePNG} from '../tests/support/png.js';

const quickstart = await readFile('examples/vite/src/quickstart.ts', 'utf8');
assert.equal(quickstart.trim().split('\n').length, 5, 'Keep the orb quickstart at five lines');
const bundled = await build({root: 'examples/vite', configFile: false, logLevel: 'silent', build: {write: false, target: 'es2022', rollupOptions: {input: resolve('examples/vite/quickstart.html')}}});
const chunks = bundled.output.filter(output => output.type === 'chunk'), entry = chunks.find(chunk => chunk.isEntry);
for (const name of ['gltf', 'machinery', 'creative', 'scenery']) {
  assert.ok(!Object.keys(entry.modules).some(id => id.includes(`/packages/${name}/`)), `${name} leaked into startup`);
  assert.ok(chunks.some(chunk => !chunk.isEntry && Object.keys(chunk.modules).some(id => id.includes(`/packages/${name}/`))), `${name} has no lazy chunk`);
}

const browser = await openBrowser({startPath: '/tests/modern-wrapper.html'}), {page, hardware} = browser, errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text())) errors.push(message.text());});
try {
  await page.waitForFunction(() => window.wrapper);
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
  const fixture = {asset: {version: '2.0'}, buffers: [{byteLength: 36, uri: `data:application/octet-stream;base64,${Buffer.from(positions.buffer).toString('base64')}`}], bufferViews: [{buffer: 0, byteLength: 36}], accessors: [{bufferView: 0, componentType: 5126, count: 3, type: 'VEC3'}], meshes: [{primitives: [{attributes: {POSITION: 0}}]}], nodes: [{mesh: 0}, {mesh: 0, translation: [3, 0, 0]}]};
  await page.route('**/wrapper-model.gltf', route => route.fulfill({contentType: 'model/gltf+json', body: JSON.stringify(fixture)}));
  for (const backend of ['webgl2', 'webgpu']) {
    await page.evaluate(async backend => {
      const host = document.createElement('div'); host.id = 'viewer'; host.style.cssText = 'width:400px;height:300px'; document.body.append(host);
      const app = await window.wrapper.createStage('#viewer', {backend, onError: error => {throw error;}});
      const orb = app.sphere({color: '#84d6bd', roughness: 0.25, scale: [1, 0.85, 1]});
      window.scene = {app, host, orb, frames: 0};
      window.scene.unsubscribe = app.onTick(delta => {window.scene.frames++; orb.rotation.z += delta;});
    }, backend);
    await page.waitForFunction(() => window.scene.frames >= 5 && window.scene.orb.rotation.z > 0);
    assert.equal(await page.locator('canvas').getAttribute('aria-label'), 'Interactive 3D scene');
    const image = await decodePNG(await page.locator('canvas').screenshot({path: `test-results/modern-wrapper-${backend}.png`}));
    let mint = 0;
    for (let i = 0; i < image.data.length; i += 4) if (image.data[i + 1] > 80 && image.data[i + 1] > image.data[i] + 10) mint++;
    assert.ok(mint > 500, `${backend} orb did not render (${mint} pixels)`);
    const before = await page.evaluate(() => [...window.scene.app.engine.camera.position]);
    const canvas = page.locator('canvas'), bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + 200, bounds.y + 150); await page.mouse.down(); await page.mouse.move(bounds.x + 260, bounds.y + 170); await page.mouse.up();
    assert.notDeepEqual(await page.evaluate(() => [...window.scene.app.engine.camera.position]), before);
    await page.evaluate(() => {window.scene.host.style.width = '500px';});
    await page.waitForFunction(() => window.scene.app.canvas.width === 500);
    const modelReport = await page.evaluate(async () => {
      const app = window.scene.app, model = await app.load('/wrapper-model.gltf', {fit: false});
      model.position.set(2, 3, 4); model.scale.setAll(2);
      const bounds = [...model.bounds], stable = model.bounds === model.bounds;
      model.visible = false; app.engine.render(); const hidden = app.engine.stats.visible === 1;
      model.visible = true; model.rotation.set(0, 0, Math.PI / 2); app.engine.render();
      const rotated = [...model.bounds], raw = model.raw;
      let readbacks = null, refreshed = null, recovered = null;
      if (raw) {
        if (raw.length !== 1) throw new Error('Shared model geometry was not deduplicated');
        const compute = async () => {
          app.engine.render();
          const device = app.engine.gpu, buffers = model.raw[0];
          device.pushErrorScope('validation');
          const output = device.createBuffer({size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
          const read = device.createBuffer({size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
          try {
            const shader = device.createShaderModule({code: '@group(0) @binding(0) var<storage,read> vertices:array<f32>; @group(0) @binding(1) var<storage,read> indices:array<u32>; @group(0) @binding(2) var<storage,read> instances:array<f32>; @group(0) @binding(3) var<storage,read_write> result:array<f32>; @compute @workgroup_size(1) fn main(){result[0]=vertices[0];result[1]=f32(indices[0]);result[2]=instances[12];result[3]=instances[13];}'});
            const pipeline = device.createComputePipeline({layout: 'auto', compute: {module: shader, entryPoint: 'main'}});
            const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [buffers.vertex, buffers.index, buffers.instance, output].map((buffer, binding) => ({binding, resource: {buffer}}))});
            const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
            encoder.copyBufferToBuffer(output, 0, read, 0, 16); device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ); const values = [...new Float32Array(read.getMappedRange())]; read.unmap();
            return values;
          } finally {
            output.destroy(); read.destroy();
            const error = await device.popErrorScope(); if (error) throw new Error(error.message);
          }
        };
        readbacks = [await compute()];
        await app.engine.rebootDevice();
        const rebooted = model.raw;
        refreshed = ['vertex', 'index', 'instance'].every(key => rebooted[0][key] !== raw[0][key]);
        readbacks.push(await compute());
        const lost = app.engine.gpu, deadline = performance.now() + 10000;
        lost.destroy();
        while (app.engine.gpu === lost || app.engine.recovery) {
          if (performance.now() > deadline) throw new Error('Automatic device recovery timed out');
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        recovered = ['vertex', 'index', 'instance'].every(key => model.raw[0][key] !== rebooted[0][key]);
        readbacks.push(await compute());
      }
      const geometry = model.meshes[0].geometry; model.destroy(); model.destroy();
      let retired = false; try {app.engine.geometryBuffers(geometry);} catch {retired = true;}
      return {bounds, stable, hidden, rotated, raw: raw !== null, readbacks, refreshed, recovered, retired};
    });
    assert.deepEqual(modelReport.bounds, [0, 1, 4, 10, 5, 4]); assert.ok(modelReport.stable && modelReport.hidden);
    assert.ok(modelReport.rotated.every((value, i) => Math.abs(value - [0, 1, 4, 4, 11, 4][i]) < 1e-5));
    assert.equal(modelReport.raw, backend === 'webgpu');
    if (backend === 'webgpu') {
      assert.deepEqual(modelReport.readbacks, Array.from({length: 3}, () => [-1, 0, 2, 3]));
      assert.ok(modelReport.refreshed && modelReport.recovered && modelReport.retired);
    }
    checks.push({name: `${backend}: orb pixels, controls, canvas resize, model transforms, bounds and visibility${backend === 'webgpu' ? ', custom WGSL before/after reboot and actual device loss' : ', null raw GPU handles'}`, mintPixels: mint, ...modelReport});
    if (backend === 'webgpu') {
      const attached = await page.evaluate(async () => {
        const app = window.scene.app, plugins = [await app.sky(), await app.particles({count: 32}), await app.effects({grain: 0.01})];
        app.engine.render();
        const present = plugins.every(plugin => app.engine.hasPlugin(plugin.name));
        for (const plugin of plugins) app.engine.removePlugin(plugin.name);
        return present;
      });
      assert.ok(attached, 'High-level GPU helpers did not attach their plugins');
    }
    assert.ok(await page.evaluate(() => {
      const s = window.scene; s.unsubscribe(); s.app.dispose(); s.app.dispose();
      const frames = s.frames; s.host.remove(); return s.app.engine.disposed && !s.app.canvas.isConnected && frames >= 5;
    }));
  }
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:300px;height:200px;display:block'; document.body.append(canvas);
    window.borrowed = await window.wrapper.createStage(canvas, {backend: 'webgl2'});
    window.borrowed.sphere();
  });
  await page.waitForFunction(() => window.borrowed.canvas.width === 300 && window.borrowed.canvas.height === 200);
  await page.evaluate(() => {window.borrowed.canvas.style.width = '450px'; window.borrowed.canvas.style.height = '250px';});
  await page.waitForFunction(() => window.borrowed.canvas.width === 450 && window.borrowed.canvas.height === 250);
  assert.ok(await page.evaluate(() => {const canvas = window.borrowed.canvas; window.borrowed.dispose(); const retained = canvas.isConnected; canvas.remove(); return retained;}));
  checks.push({name: 'Borrowed canvas automatically resizes from 300x200 to 450x250 and remains attached after disposal'});
  await page.evaluate(async () => {
    const host = document.createElement('div'); host.style.cssText = 'width:300px;height:200px'; document.body.append(host);
    const errors = [], app = await window.wrapper.createStage(host, {backend: 'webgl2', onError: error => errors.push(String(error))});
    const orb = app.sphere(); orb.position.set(1, 2, 3);
    window.loss = {host, app, orb, errors, frames: 0}; app.onTick(() => window.loss.frames++);
  });
  await page.waitForFunction(() => window.loss.frames >= 2);
  await page.evaluate(() => {
    const extension = window.loss.app.canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('WEBGL_lose_context unavailable');
    extension.loseContext();
  });
  await page.waitForFunction(() => window.loss.errors.length === 1);
  const loss = await page.evaluate(async () => {
    const state = window.loss, frames = state.frames;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const stopped = state.frames === frames, position = [state.orb.position.x, state.orb.position.y, state.orb.position.z];
    state.app.dispose(); const detached = !state.app.canvas.isConnected;
    state.app = await window.wrapper.createStage(state.host, {backend: 'webgl2', onError: error => state.errors.push(String(error))});
    state.app.sphere({color: '#84d6bd'}); state.frames = 0; state.app.onTick(() => state.frames++);
    return {stopped, position, detached, errors: state.errors};
  });
  assert.deepEqual(loss, {stopped: true, position: [1, 2, 3], detached: true, errors: ['Error: WebGL context lost']});
  await page.waitForFunction(() => window.loss.frames >= 2);
  const recreated = await decodePNG(await page.locator('canvas').screenshot({path: 'test-results/modern-wrapper-webgl2-recreated.png'}));
  let recreatedMint = 0;
  for (let i = 0; i < recreated.data.length; i += 4) if (recreated.data[i + 1] > 80 && recreated.data[i + 1] > recreated.data[i] + 10) recreatedMint++;
  assert.ok(recreatedMint > 500, 'Fresh stage did not render after WebGL context loss');
  await page.evaluate(() => {window.loss.app.dispose(); window.loss.host.remove();});
  checks.push({name: 'WebGL2 context loss reports one error, stops RAF, retains transforms and permits disposal/recreation', ...loss, recreatedMintPixels: recreatedMint});
  const lifecycle = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:300px;height:200px;touch-action:pan-y'; document.body.append(canvas);
    const original = canvas.style.cssText, app = await window.wrapper.createStage(canvas, {backend: 'webgl2', autoStart: false});
    let frames = 0; app.onTick(() => frames++); await new Promise(resolve => requestAnimationFrame(resolve));
    app.dispose(); const borrowed = canvas.isConnected && canvas.style.cssText === original && frames === 0; canvas.remove();
    const host = document.createElement('div'); host.style.height = '200px'; document.body.append(host);
    let failed = false;
    try {await window.wrapper.createStage(host, {backend: 'webgl2', camera: {near: -1}});} catch {failed = host.children.length === 0;}
    const fallback = await window.wrapper.createStage(host, {backend: 'webgl2', controls: false, autoStart: false});
    const untouched = fallback.canvas.style.touchAction === '';
    let rejected = 0;
    for (const action of [() => window.wrapper.createStage('#missing'), () => window.wrapper.createStage(host, {autoStart: 'yes'}), () => fallback.sky(), () => fallback.particles(), () => fallback.effects()]) {
      try {await action();} catch {rejected++;}
    }
    fallback.dispose(); host.remove(); return {borrowed, failed, untouched, rejected};
  });
  assert.deepEqual(lifecycle, {borrowed: true, failed: true, untouched: true, rejected: 5});
  checks.push({name: 'Stage lifecycle, rollback and unsupported-backend validation', ...lifecycle});
  assert.deepEqual(errors, []);
  await writeFile('test-results/modern-wrapper.json', JSON.stringify({hardware, checks}, null, 2));
  console.log(JSON.stringify({hardware, checks}, null, 2));
} finally {await browser.close();}
