import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { build, preview } from 'vite';
import { basisTextureQuad } from '../tests/support/texture-fixture.js';

const repository = fileURLToPath(new URL('..', import.meta.url)),
  results = resolve(repository, 'test-results/gltf-ktx2-production');
const consumer = resolve(results, 'consumer'),
  publicDir = resolve(consumer, 'public'),
  output = resolve(results, 'dist');
await mkdir(publicDir, { recursive: true });
for (const name of ['Dot_C.ktx2', 'Rib_N.ktx2'])
  await copyFile(resolve(repository, 'packages/decoders/tests/fixtures', name), resolve(publicDir, name));
const fixture = basisTextureQuad({
  colorURI: './Dot_C.ktx2',
  normalURI: './Rib_N.ktx2',
  fallbackURI: 'data:image/png;base64,AA==',
});
await writeFile(resolve(publicDir, 'basis-quad.gltf'), JSON.stringify(fixture.doc));
await writeFile(
  resolve(consumer, 'index.html'),
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>glTF BasisU production consumer</title><link rel="icon" href="data:,"></head><body><canvas style="width:128px;height:128px"></canvas><script type="module" src="/main.js"></script></body></html>',
);
await writeFile(
  resolve(consumer, 'main.js'),
  `
import {Engine} from '@margoengine/core';
import {loadGLTF} from '@margoengine/gltf-pro';
window.runKTX2Consumer=async()=>{
  const NativeWorker=window.Worker,workers=[];
  window.Worker=class extends NativeWorker{
    constructor(url,options){super(url,options);if(options?.name==='margoengine-decoder'){this.record={url:String(url),terminated:false};workers.push(this.record);}}
    terminate(){if(this.record)this.record.terminated=true;return super.terminate();}
  };
  let engine;
  try{
    if(workers.length)throw new Error('Importing glTF support created a decoder worker');
    engine=await Engine.create(document.querySelector('canvas'),{backend:'webgpu',capacity:16,camera:{position:[0,0,3],target:[0,0,0]}});
    const device=engine.gpu,textures=[],createTexture=device.createTexture.bind(device);
    device.createTexture=descriptor=>{const value=createTexture(descriptor),record={descriptor,destroyed:false},destroy=value.destroy.bind(value);textures.push(record);value.destroy=()=>{record.destroyed=true;destroy();};return value;};
    device.pushErrorScope('validation');
    const model=await loadGLTF(engine,new URL('/basis-quad.gltf',location.href));
    try{
      if(workers.length!==1||!workers[0].terminated)throw new Error('Automatic glTF loading retained its BasisU worker');
      const modelTextures=textures.slice(),mips=modelTextures.filter(record=>record.descriptor.mipLevelCount>1).map(record=>({size:record.descriptor.size,levels:record.descriptor.mipLevelCount,format:record.descriptor.format}));
      if(!mips.some(image=>image.size[0]===128&&image.levels===8&&image.format.endsWith('-srgb')))throw new Error('Color KTX2 mip chain was not uploaded as sRGB');
      if(!mips.some(image=>image.size[0]===32&&image.levels===6&&!image.format.endsWith('-srgb')))throw new Error('Normal KTX2 mip chain was not uploaded as linear');
      engine.camera.update(1,true);engine.store.tick(false);engine.render({culling:false});await device.queue.onSubmittedWorkDone();
      const width=128,height=128,target=device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
      const depth=device.createTexture({size:[width,height],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT});
      const color=target.createView(),depthView=depth.createView(),encoder=device.createCommandEncoder();
      encoder.beginRenderPass({colorAttachments:[{view:color,clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depthView,depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'store'}}).end();
      model.draw({backend:'webgpu',device,encoder,color,depth:depthView,format:'rgba8unorm',width,height,camera:engine.camera,descriptor:{multisample:{count:1},depthStencil:{format:'depth32float'}}},'beauty',color,depthView);
      const buffer=device.createBuffer({size:width*height*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      encoder.copyTextureToBuffer({texture:target},{buffer,bytesPerRow:width*4},[width,height]);device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);const pixels=new Uint8Array(buffer.getMappedRange());let coloredPixels=0;
      for(let i=0;i<pixels.length;i+=4)coloredPixels+=+(pixels[i]>0||pixels[i+1]>0||pixels[i+2]>0);
      buffer.unmap();buffer.destroy();target.destroy();depth.destroy();
      if(!coloredPixels)throw new Error('The production KTX2 model produced no colored pixels');
      model.destroy();if(engine.meshes.size)throw new Error('Disposal retained model meshes');
      if(modelTextures.some(record=>!record.destroyed))throw new Error('Disposal retained a KTX2 texture');
      const validation=await device.popErrorScope();if(validation)throw new Error(validation.message);
      return {workers,mips,coloredPixels,meshesAfterDisposal:engine.meshes.size,texturesDisposed:true};
    }finally{model.destroy();}
  }finally{engine?.dispose();window.Worker=NativeWorker;}
};
`,
);
await build({
  root: consumer,
  configFile: false,
  logLevel: 'warn',
  build: { target: 'es2022', outDir: output, emptyOutDir: true },
});
const emitted = await readdir(resolve(output, 'assets'));
for (const pattern of [/^decoder\.worker-.*\.js$/, /^basis_transcoder-.*\.wasm$/, /^basis_transcoder-.*\.js$/])
  assert.ok(
    emitted.some((name) => pattern.test(name)),
    `Production KTX2 consumer did not emit ${pattern}`,
  );
const server = await preview({
  root: consumer,
  configFile: false,
  logLevel: 'error',
  build: { outDir: output },
  preview: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  const channel = process.env.BROWSER_CHANNEL ?? 'msedge',
    args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  try {
    browser = await chromium.launch({ headless: true, channel: channel === 'bundled' ? undefined : channel, args });
  } catch (error) {
    if (channel !== 'msedge' || args.length || process.env.BROWSER_CHANNEL) throw error;
    browser = await chromium.launch({ headless: true });
  }
  const page = await browser.newPage(),
    errors = [],
    assets = new Set();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(response.status() + ' ' + response.url());
    if (/decoder\.worker-.*\.js|basis_transcoder-.*\.(?:js|wasm)/.test(response.url()))
      assets.add(new URL(response.url()).pathname);
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => typeof window.runKTX2Consumer === 'function');
  const checks = await page.evaluate(() => window.runKTX2Consumer());
  assert.deepEqual(errors, []);
  assert.ok(
    [...assets].some((path) => /basis_transcoder-.*\.wasm/.test(path)),
    'Production browser did not fetch the emitted BasisU Wasm',
  );
  const report = { ...checks, emitted, assets: [...assets], browser: browser.version(), errors };
  await writeFile(resolve(results, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
