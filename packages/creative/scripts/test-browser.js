import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {build, createServer} from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results');
await mkdir(results, {recursive: true});
await build({configFile:false,root:resolve(root,'examples/earth'),logLevel:'silent',build:{write:false,target:'es2022'}});
const server = await createServer({configFile: resolve(root, 'vite.config.js'), logLevel: 'error', server: {port: 0}});
await server.listen();
let browser;
try {
  const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  try {browser = await chromium.launch({headless: true, channel: channel === 'bundled' ? undefined : channel, args});}
  catch (error) {if (channel !== 'msedge' || args.length || process.env.BROWSER_CHANNEL) throw error; browser = await chromium.launch({headless: true});}
  const page = await browser.newPage({viewport: {width: 800, height: 600}, deviceScaleFactor: 1});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text())) errors.push(message.text());});
  await page.route('**/tests/slow-map.png', () => {});
  await page.goto(`${server.resolvedUrls.local[0]}tests/planet.html`);
  await page.waitForFunction(() => typeof window.runPlanetTests === 'function');
  const checks = await page.evaluate(() => window.runPlanetTests());
  const instrument = () => {
    window.earthAudit = {live:new Set(),samples:[],textures:[],boundSamples:new Set(),created:0,frame:[]};
    const pipelines = new WeakMap();
    for (const name of ['createBuffer','createTexture','createRenderPipeline','createBindGroup']) {
      const create = GPUDevice.prototype[name];
      GPUDevice.prototype[name] = function(desc) {
        const result = create.call(this,desc), audit = window.earthAudit; audit.created++;
        if(name==='createRenderPipeline'){const samples=desc.multisample?.count??1;audit.samples.push(samples);pipelines.set(result,samples);}
        if(name==='createTexture')audit.textures.push(desc.sampleCount??1);
        if(name==='createBuffer'||name==='createTexture'){audit.live.add(result);const destroy=result.destroy.bind(result);result.destroy=()=>{audit.live.delete(result);destroy();};}
        return result;
      };
    }
    const set = GPURenderPassEncoder.prototype.setPipeline;
    GPURenderPassEncoder.prototype.setPipeline = function(pipeline){earthAudit.boundSamples.add(pipelines.get(pipeline));return set.call(this,pipeline);};
    const write = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function(buffer,offset,data,...rest){if(data instanceof Float32Array&&data.length===48)earthAudit.frame=Array.from(data);return write.call(this,buffer,offset,data,...rest);};
  };
  await page.addInitScript(instrument);
  await page.goto(`${server.resolvedUrls.local[0]}examples/earth/`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true' || document.body.dataset.error === 'true');
  assert.equal(await page.locator('body').getAttribute('data-error'), null, await page.locator('#error').textContent());
  assert(await page.evaluate(()=>earthAudit.textures.includes(4)&&earthAudit.boundSamples.has(4)),'Desktop globe did not render with 4× MSAA');
  await page.locator('#pause').click();
  assert.equal(await page.locator('#pause').getAttribute('aria-pressed'), 'true');
  await page.locator('#pause').click();
  assert.equal(await page.locator('#pause').getAttribute('aria-pressed'), 'false');
  await page.locator('#sun').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#sun-value').textContent(), '-109°');
  await page.locator('#rotation').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#rotation-value').textContent(), '1.1×');
  await page.locator('canvas').focus();
  for (const key of ['ArrowRight', '+', 'Home']) await page.keyboard.press(key);
  await page.locator('#reset').click();
  await page.locator('#pause').click();
  const settle = () => page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const image = () => page.evaluate(()=>document.querySelector('canvas').toDataURL());
  await settle();
  for(const [id,value] of [['sun','0'],['bloom','1'],['exposure','1.5']]){
    const previous=await page.locator('#'+id).inputValue(),before=await image();
    await page.locator('#'+id).fill(value);await settle();assert(await image()!==before,id+' did not change globe pixels');
    await page.locator('#'+id).fill(previous);await settle();
  }
  const withStars = await image();await page.locator('#stars').uncheck();await settle();
  assert(await image()!==withStars,'Star visibility did not change background pixels');await page.locator('#stars').check();
  await page.locator('#rotation').fill('0');await page.locator('#cloud-speed').fill('1');
  const initial = await page.evaluate(()=>earthAudit.frame);
  await page.locator('#pause').click();await page.waitForFunction(offset=>earthAudit.frame[39]!==offset,initial[39]);
  await page.locator('#pause').click();
  assert.deepEqual(await page.evaluate(()=>earthAudit.frame.slice(16,32)),initial.slice(16,32),'Cloud drift changed Earth rotation');
  await page.locator('#rotation').fill('1');await page.locator('#cloud-speed').fill('0');
  const clouds = await page.evaluate(()=>earthAudit.frame[39]),model = await page.evaluate(()=>earthAudit.frame.slice(16,32));
  await page.locator('#pause').click();await page.waitForFunction(model=>earthAudit.frame.slice(16,32).some((v,i)=>v!==model[i]),model);
  await page.locator('#pause').click();assert.equal(await page.evaluate(()=>earthAudit.frame[39]),clouds,'Cloud drift ignored its zero speed');
  await page.locator('#rotation').fill('1');await page.locator('#cloud-speed').fill('1');
  const paused = await page.evaluate(()=>earthAudit.frame);await settle();
  assert.deepEqual(await page.evaluate(()=>earthAudit.frame.slice(16,32)),paused.slice(16,32));
  assert.equal(await page.evaluate(()=>earthAudit.frame[39]),paused[39]);
  checks.checks.push('HDR bloom/exposure, sun and star controls change pixels; independent cloud/planet speeds and pause hold their clocks');
  await page.locator('#pause').click();
  await page.setViewportSize({width: 520, height: 800});
  await page.waitForFunction(() => {const canvas = document.querySelector('canvas'); return canvas.width > 0 && Math.abs(canvas.width - canvas.clientWidth) <= 1;});
  assert.equal(await page.locator('body').getAttribute('data-error'), null);
  await page.setViewportSize({width: 1280, height: 900});
  await settle();
  checks.framePacing = await page.evaluate(() => new Promise(resolve => {
    const resources = earthAudit.created;
    const intervals = []; let previous;
    const frame = time => {
      if (previous !== undefined) intervals.push(time - previous);
      previous = time;
      if (intervals.length < 180) {requestAnimationFrame(frame); return;}
      const sorted = [...intervals].sort((a, b) => a - b);
      resolve({frames: intervals.length, averageFPS: 1000 * intervals.length / intervals.reduce((total, value) => total + value, 0), p50Ms: sorted[90], p95Ms: sorted[171],resourceCreations:earthAudit.created-resources});
    };
    requestAnimationFrame(frame);
  }));
  assert.equal(checks.framePacing.resourceCreations,0,'Steady Earth frames allocated GPU resources');
  await page.screenshot({path: resolve(results, 'earth-demo.png'), fullPage: true});
  await page.evaluate(() => {
    const original = GPUQueue.prototype.writeBuffer;
    window.planetZoomCheck = {minimumDistance: Infinity, restore() {GPUQueue.prototype.writeBuffer = original;}};
    GPUQueue.prototype.writeBuffer = function (...args) {
      const data = args[2];
      if (data instanceof Float32Array && data.length === 48) window.planetZoomCheck.minimumDistance = Math.min(window.planetZoomCheck.minimumDistance, Math.hypot(data[32], data[33], data[34]));
      return original.apply(this, args);
    };
  });
  const canvasBounds = await page.locator('canvas').boundingBox();
  await page.mouse.move(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + canvasBounds.height / 2);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -500);
  const distance = await page.evaluate(() => {const result = window.planetZoomCheck.minimumDistance; window.planetZoomCheck.restore(); return result;});
  assert.ok(distance >= 1.1 - 1e-5 && distance < 2, `Demo wheel zoom entered the atmosphere shell: ${distance}`);
  checks.minimumDemoZoomDistance = distance;
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.locator('#viewport canvas').count(), 0, 'Demo teardown left its owned canvas');
  assert.equal(await page.evaluate(()=>earthAudit.live.size),0,'Earth teardown leaked GPU buffers or textures');
  const mobileContext = await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true,reducedMotion:'reduce',userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
  try {
    await mobileContext.addInitScript(instrument);const mobile=await mobileContext.newPage();
    mobile.on('pageerror',e=>errors.push(e.message));mobile.on('console',m=>{if(m.type()==='error'||/ValidationError|Invalid .*Pipeline/.test(m.text()))errors.push(m.text());});
    await mobile.goto(`${server.resolvedUrls.local[0]}examples/earth/`);await mobile.locator('body[data-ready=true]').waitFor();
    const quality=await mobile.evaluate(()=>{const canvas=document.querySelector('canvas');return {samples:earthAudit.samples,textures:earthAudit.textures,dpr:canvas.width/canvas.clientWidth,overflow:document.documentElement.scrollWidth>innerWidth,open:document.getElementById('settings').open};});
    assert(!quality.samples.includes(4)&&!quality.textures.includes(4));assert.equal(quality.dpr,2);assert(!quality.overflow&&!quality.open);
    assert.equal(await mobile.locator('#pause').getAttribute('aria-pressed'),'true');
    const original=await mobile.evaluate(()=>earthAudit.frame);await mobile.waitForTimeout(100);
    const still=await mobile.evaluate(()=>earthAudit.frame);
    assert(still.every((value,i)=>Math.abs(value-original[i])<1e-6),'Reduced motion changed the globe');
    const pinch=await mobileContext.newCDPSession(mobile);
    await pinch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:120,y:250},{x:270,y:250}]});
    await pinch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:90,y:250},{x:300,y:250}]});
    await pinch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await mobile.waitForFunction(position=>earthAudit.frame.slice(32,35).some((v,i)=>v!==position[i]),original.slice(32,35));
    await mobile.locator('#reset').click();await mobile.waitForFunction(position=>earthAudit.frame.slice(32,35).every((v,i)=>Math.abs(v-position[i])<1e-6),original.slice(32,35));
    await mobile.screenshot({path:resolve(results,'earth-mobile.png'),fullPage:true});
    await mobile.evaluate(()=>dispatchEvent(new Event('pagehide')));assert.equal(await mobile.evaluate(()=>earthAudit.live.size),0);
    checks.mobile=quality;checks.checks.push('Mobile uses 1× MSAA/DPR 2, collapsible controls, paused pinch/reset, reduced motion and clean teardown');
  } finally {await mobileContext.close();}
  checks.checks.push('Earth demo startup, pause, sliders, keyboard, resize, exterior zoom limit and teardown');
  assert.deepEqual(errors, []);
  await writeFile(resolve(results, 'planet-browser.json'), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify(checks, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
