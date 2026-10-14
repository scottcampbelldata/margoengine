import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {preview} from 'vite';
import {openBrowser} from './browser.js';
import {decodePNG} from '../tests/support/png.js';
const context=await openBrowser({startPath:'/tests/modern.html'}),{page,hardware}=context,errors=[];
page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(`${message.text()} (${message.location().url})`);});
const result={hardware,checks:[]};
let vite,next;
try {
  await page.waitForFunction(()=>window.modern);
  const pixels=[];
  for(const backend of ['webgl2','webgpu']){
    const report=await page.evaluate(backend=>window.modern.core(backend),backend);assert.equal(report.backend,backend);assert.equal(report.stats.visible,1);assert.equal(report.stats.drawCalls,1);
    await page.evaluate(async()=>{window.modern.state.core.render();await window.modern.state.core.gpu?.queue.onSubmittedWorkDone();});
    const png=await page.locator('[data-core]').screenshot({path:`test-results/modern-${backend}.png`}),image=await decodePNG(png),offset=(Math.floor(image.height/2)*image.width+Math.floor(image.width/2))*4;
    const pixel=[...image.data.slice(offset,offset+3)];assert.ok(pixel[0]>pixel[1]+15,`${backend} did not render red PBR geometry (${pixel})`);pixels.push(pixel);
    const uncull=await page.evaluate(()=>{const e=window.modern.state.core;e.render({culling:false});return {...e.stats};});assert.equal(uncull.visible,2);assert.equal(uncull.drawCalls,1);
    result.checks.push({name:`${backend}: pixels, instancing and culling`,pixel});
  }
  assert.ok(pixels[0].every((v,i)=>Math.abs(v-pixels[1][i])<=3),'Backend PBR pixels disagree');
  const particles=await page.evaluate(async()=>{
    const e=window.modern.state.core,p=await window.modern.particles(),device=e.gpu;
    const read=async()=>{const buffer=device.createBuffer({size:32,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(p.gpuState.particles,0,buffer,0,32);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);const values=[...new Float32Array(buffer.getMappedRange())];buffer.unmap();buffer.destroy();return values;};
    const before=await read();e.render({delta:0.1});await device.queue.onSubmittedWorkDone();const after=await read();e.removePlugin(p.name);e.render();await device.queue.onSubmittedWorkDone();return {count:p.count,before,after};
  });assert.equal(particles.count,100_000);assert.ok(particles.after[1]<particles.before[1]);assert.ok(particles.after.every(Number.isFinite));result.checks.push({name:'100000 GPU particles update storage and retire passes',...particles});
  await page.evaluate(()=>window.modern.mount());await page.waitForFunction(()=>window.modern.state.react?.meshes.size===2&&window.modern.state.parent&&window.modern.state.child);
  const initial=await page.evaluate(()=>{const s=window.modern.state;return {count:s.react.meshes.size,parent:s.parent.id,child:s.child.id,link:s.react.store.parents[s.child.id],x:s.child.matrix[12],renders:s.renders,frames:s.frames};});assert.equal(initial.link,initial.parent);
  await page.waitForFunction(()=>window.modern.state.frames>=20);assert.equal(await page.evaluate(()=>window.modern.state.renders),initial.renders,'Frame updates caused React renders');
  assert.equal(await page.locator('mesh,boxgeometry,pbrmaterial').count(),0,'Custom tags leaked into DOM');
  await page.evaluate(()=>window.modern.mount({position:2}));await page.waitForFunction(()=>window.modern.state.parent?.position.x===2);assert.equal(await page.evaluate(()=>window.modern.state.react.meshes.size),2);
  await page.evaluate(()=>window.modern.mount({show:false}));await page.waitForFunction(()=>window.modern.state.react.meshes.size===0);
  await page.evaluate(()=>window.modern.mount({suspend:true}));await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.modern.state.react.meshes.size),0,'Suspended render leaked entities');
  await page.evaluate(()=>window.modern.mount());await page.waitForFunction(()=>window.modern.state.react.meshes.size===2&&window.modern.state.child);
  await page.evaluate(()=>window.modern.unmount());assert.ok(await page.evaluate(()=>window.modern.state.react.disposed));assert.equal(await page.evaluate(()=>window.modern.state.react.meshes.size),0);
  result.checks.push({name:'React StrictMode, nesting, live props, no frame re-renders, Suspense, teardown'});
  assert.deepEqual(await page.evaluate(()=>window.modern.state.errors),[]);assert.deepEqual(errors,[]);
  const fallback=await page.evaluate(async()=>{
    Object.defineProperty(navigator,'gpu',{value:undefined,configurable:true});
    try{return await window.modern.core('auto');}finally{delete navigator.gpu;}
  });assert.equal(fallback.backend,'webgl2');assert.match(fallback.fallbackReason,/unavailable/);result.checks.push({name:'Automatic WebGL2 fallback without WebGPU'});
  const manifest=JSON.parse(await readFile('examples/vite/dist/.vite/manifest.json','utf8')),requests=new Set();
  const chunks={};for(const name of ['gltf','machinery','creative','scenery']){const key=`../../packages/${name}/dist/index.js`;assert.ok(manifest[key].isDynamicEntry);assert.ok(!manifest['index.html'].imports?.includes(key));chunks[name]=manifest[key].file;}
  vite=await preview({root:'examples/vite',configFile:false,logLevel:'error',preview:{host:'127.0.0.1',port:5194,strictPort:true}});
  page.on('request',request=>requests.add(new URL(request.url()).pathname.slice(1)));
  await page.goto('http://127.0.0.1:5194');await page.getByText('Rust / Wasm + webgpu',{exact:true}).waitFor();
  for(const file of Object.values(chunks))assert.ok(!requests.has(file),'Optional pack fetched during initial load');
  const scenery=page.getByRole('button',{name:'Toggle moonlit scenery'});
  const moonPixels=image=>{
    let total=0,count=0,lit=0;
    for(let y=0;y<image.height*0.3;y++)for(let x=Math.floor(image.width*0.6);x<image.width;x++){const i=(y*image.width+x)*4;total+=image.data[i]+image.data[i+1]+image.data[i+2];count++;}
    const threshold=total/count+60;
    for(let y=0;y<image.height*0.3;y++)for(let x=Math.floor(image.width*0.6);x<image.width;x++){const i=(y*image.width+x)*4;if(image.data[i]>180&&image.data[i+1]>180&&image.data[i+2]>180&&image.data[i]+image.data[i+1]+image.data[i+2]>threshold)lit++;}
    return lit;
  };
  assert.equal(await scenery.getAttribute('aria-pressed'),'false');
  await scenery.click();await page.getByRole('status').filter({hasText:'Scenery: moonlit sky'}).waitFor();assert.equal(await scenery.getAttribute('aria-pressed'),'true');assert.ok(requests.has(chunks.scenery));
  const moonImage=await decodePNG(await page.locator('canvas').screenshot({path:'test-results/modern-vite-scenery.png'})),moon=moonPixels(moonImage);assert.ok(moon>100,`Moon not visible over the base engine: ${moon}`);
  let mint=0;for(let i=0;i<moonImage.data.length;i+=4)if(moonImage.data[i+1]>80&&moonImage.data[i+1]>moonImage.data[i]+10)mint++;assert.ok(mint>500,'Scenery hid the base geometry');
  await scenery.click();await page.getByRole('status').filter({hasText:'Scenery removed'}).waitFor();assert.equal(await scenery.getAttribute('aria-pressed'),'false');assert.ok(moonPixels(await decodePNG(await page.locator('canvas').screenshot()))<20,'Moon remained after removal');
  await scenery.click();await page.getByRole('status').filter({hasText:'Scenery: moonlit sky'}).waitFor();await scenery.click();await page.getByRole('status').filter({hasText:'Scenery removed'}).waitFor();
  result.checks.push({name:'Vite scenery: lazy load, visible moon over base geometry, pressed state, removal and repeated toggle',moonPixels:moon});
  await page.getByRole('button',{name:'Load glTF module'}).click();await page.getByRole('status').filter({hasText:'Static glTF loaded'}).waitFor();assert.ok(requests.has(chunks.gltf));
  await page.getByRole('button',{name:'Toggle exploded view'}).click();await page.getByRole('status').filter({hasText:'Machinery: exploded view'}).waitFor();assert.ok(requests.has(chunks.machinery));
  await page.getByRole('button',{name:'Load glTF module'}).click();await page.getByRole('status').filter({hasText:'Static glTF loaded'}).waitFor();
  await page.getByRole('button',{name:'Toggle GPU leaves'}).click();await page.getByRole('status').filter({hasText:'Creative: 5,000 GPU leaves'}).waitFor();assert.ok(requests.has(chunks.creative));
  await page.getByLabel('Metalness').fill('0.8');assert.equal(await page.locator('output').innerText(),'0.80');
  await page.locator('canvas').screenshot({path:'test-results/modern-vite.png'});
  await page.getByRole('button',{name:'Toggle GPU leaves'}).click();await page.getByRole('status').filter({hasText:'Particles removed'}).waitFor();
  await page.getByText('Domain tools',{exact:true}).click();await page.getByRole('button',{name:'Toggle capped section'}).click();await page.getByRole('status').filter({hasText:'Machinery: capped section'}).waitFor();await page.getByLabel('Section offset').fill('0.2');
  await page.getByRole('button',{name:'Toggle dimensions'}).click();await page.getByRole('status').filter({hasText:'Machinery: dimensions and callout'}).waitFor();await page.waitForFunction(()=>document.querySelector('svg[data-margoengine-annotations]')?.textContent?.includes('1.60 m'));assert.match(await page.locator('svg[data-margoengine-annotations]').textContent(),/1.60 m.*Mint assembly/);
  const obj='v -1 -1 0\nv 1 -1 0\nv 0 1 0\ng first\nf 1 2 3\ng second\nf 1 2 3';await page.getByLabel('Import STL, OBJ, STEP or IGES').setInputFiles({name:'fixture.obj',mimeType:'text/plain',buffer:Buffer.from(obj)});await page.getByRole('status').filter({hasText:'CAD: 2 parts, 1 unique CAD geometries'}).waitFor();
  const fx=page.getByRole('button',{name:'Toggle atmosphere and FX'});
  await fx.click();await page.getByRole('status').filter({hasText:'Bloom, atmosphere and FX'}).waitFor();
  await scenery.click();await page.getByRole('status').filter({hasText:'Scenery: moonlit sky'}).waitFor();assert.ok(moonPixels(await decodePNG(await page.locator('canvas').screenshot()))>100,'Existing FX covered the moon');
  await fx.click();await page.getByRole('status').filter({hasText:'Effects removed'}).waitFor();await fx.click();await page.getByRole('status').filter({hasText:'Bloom, atmosphere and FX'}).waitFor();assert.ok(moonPixels(await decodePNG(await page.locator('canvas').screenshot()))>100,'New FX covered the moon');
  await page.getByRole('button',{name:'Toggle toon shading'}).click();await page.getByRole('status').filter({hasText:'Creative: toon shading'}).waitFor();await page.getByRole('button',{name:'Restore GPU device'}).click();await page.getByRole('status').filter({hasText:'GPU restored; scene retained'}).waitFor();assert.equal(await scenery.getAttribute('aria-pressed'),'true');assert.ok(moonPixels(await decodePNG(await page.locator('canvas').screenshot()))>100,'Device restoration lost the moon');
  await page.locator('canvas').screenshot({path:'test-results/modern-vite-domains.png'});
  result.checks.push({name:'Vite domain controls: cut slider, dimensions, OBJ upload/deduplication, atmosphere/FX, toon, device restoration'});
  await scenery.click();await page.getByRole('status').filter({hasText:'Scenery removed'}).waitFor();assert.ok(moonPixels(await decodePNG(await page.locator('canvas').screenshot()))<20,'Removing scenery did not restore the FX atmosphere');
  result.checks.push({name:'Vite scenery: FX enabled in either order, restored atmosphere on removal and GPU device restoration'});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'test-results/modern-vite-mobile.png',fullPage:true});
  result.checks.push({name:'Vite production: lazy packages, repeated import, explode, GPU leaves, material control, mobile layout',chunks});
  await page.addInitScript(()=>{if(location.search==='?fallback=1')Object.defineProperty(navigator,'gpu',{value:undefined,configurable:true});});
  requests.clear();await page.goto('http://127.0.0.1:5194/?fallback=1');await page.getByText('Rust / Wasm + webgl2',{exact:true}).waitFor();await scenery.click();await page.getByRole('status').filter({hasText:'Moonlit scenery needs WebGPU'}).waitFor();assert.equal(await scenery.getAttribute('aria-pressed'),'false');assert.ok(!requests.has(chunks.scenery),'Unsupported backend fetched scenery');
  result.checks.push({name:'Vite scenery: WebGL2 fallback reports WebGPU requirement before fetching the pack'});
  next=spawn(process.execPath,[resolve('node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','5195'],{cwd:resolve('examples/next'),stdio:['ignore','pipe','pipe'],windowsHide:true});
  let nextLog='';next.stdout.on('data',data=>{nextLog+=data;});next.stderr.on('data',data=>{nextLog+=data;});
  const deadline=Date.now()+30_000;let ready=false;
  while(Date.now()<deadline){try{ready=(await fetch('http://127.0.0.1:5195')).ok;if(ready)break;}catch{}if(next.exitCode!==null)throw new Error(`Next exited: ${nextLog}`);await new Promise(resolve=>setTimeout(resolve,200));}
  assert.ok(ready,`Next server failed to start: ${nextLog}`);
  await page.setViewportSize({width:1100,height:800});await page.goto('http://127.0.0.1:5195');await page.getByRole('heading',{name:'Margo Engine / Next.js'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('canvas')?.width>1);
  await page.waitForTimeout(300);assert.deepEqual(await page.locator('p[role="alert"]').allTextContents(),[]);
  const nextImage=await decodePNG(await page.locator('canvas').screenshot({path:'test-results/modern-next.png'}));let lit=0;
  for(let i=0;i<nextImage.data.length;i+=4)if(nextImage.data[i+1]>80&&nextImage.data[i+1]>nextImage.data[i]+10)lit++;assert.ok(lit>500,'Next client failed to render mint geometry');
  result.checks.push({name:'Next production: SSR, client hydration, rendered geometry'});
  assert.deepEqual(errors,[]);
  await mkdir('test-results',{recursive:true});await writeFile('test-results/modern-browser.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{next?.kill();await new Promise(resolve=>vite?vite.httpServer.close(resolve):resolve());await context.close();}
