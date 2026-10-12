// Desktop GPU timings with phone layout/CPU/network emulation; this is not iPhone Safari.
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {chromium} from '@playwright/test';
import {preview} from 'vite';

const demos=['/night-citadel/','/gameplay-sandbox/','/demos/damaged-helmet.html','/demos/character-animation.html','/demos/robot-expressive.html','/demos/windy-meadow.html','/demos/earth/'];
const profile={viewport:{width:390,height:844},deviceScaleFactor:3,cpuSlowdown:4,latencyMs:40,downloadMbps:10,samples:3};
await mkdir('test-results',{recursive:true});
// Other chats can rebuild site/dist while a page is fetching its hashed assets.
const output=resolve('test-results'),snapshot=await mkdtemp(resolve(output,'demo-load-site-'));
assert.ok(snapshot.startsWith(output+sep));
await cp('site/dist',snapshot,{recursive:true});
const server=await preview({configFile:false,root:snapshot,build:{outDir:'.'},logLevel:'error',preview:{host:'127.0.0.1',port:0}});
const origin=server.resolvedUrls.local[0],results=[];
try {
  for(const path of demos){
    const samples=[];
    for(let sample=0;sample<profile.samples;sample++){
      const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL??'msedge',headless:true});
      try {
        const context=await browser.newContext({viewport:profile.viewport,deviceScaleFactor:profile.deviceScaleFactor,isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'});
        const page=await context.newPage(),errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
        await page.addInitScript(()=>{
          const load=window.demoLoad={draws:0,submitted:0,firstFrame:0,ready:0};
          for(const method of ['draw','drawIndexed','drawIndirect','drawIndexedIndirect']){
            const original=GPURenderPassEncoder.prototype[method];
            GPURenderPassEncoder.prototype[method]=function(...args){load.draws++;return original.apply(this,args);};
          }
          const submit=GPUQueue.prototype.submit;
          GPUQueue.prototype.submit=function(...args){
            const result=submit.apply(this,args);
            if(load.draws&&!load.submitted){
              load.submitted=performance.now();
              this.onSubmittedWorkDone().then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{load.firstFrame=performance.now();})));
            }
            return result;
          };
          const ready=()=>{
            if(document.body?.dataset.ready==='true'||document.querySelector('#viewport')?.dataset.ready==='true'||window.sandbox||window.nightCitadel?.stats.frames>0)load.ready=performance.now();
            else requestAnimationFrame(ready);
          };
          requestAnimationFrame(ready);
        });
        const cdp=await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate',{rate:profile.cpuSlowdown});
        await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
        await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:profile.latencyMs,downloadThroughput:profile.downloadMbps*125000,uploadThroughput:625000});
        await page.goto(new URL(path,origin).href);
        try {await page.waitForFunction(()=>window.demoLoad.firstFrame>0&&window.demoLoad.ready>0,null,{timeout:60000});}
        catch(reason){throw new Error(path+' failed to render: '+JSON.stringify({errors,state:await page.evaluate(()=>({...window.demoLoad,status:document.querySelector('#status')?.textContent,error:document.querySelector('#error')?.textContent}))}),{cause:reason});}
        const timing=await page.evaluate(async()=>{
          const adapter=await navigator.gpu.requestAdapter();
          return {...window.demoLoad,gpu:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description},
            resources:performance.getEntriesByType('resource').map(r=>({url:r.name,startMs:Math.round(r.startTime),durationMs:Math.round(r.duration),transferBytes:r.transferSize}))};
        });
        assert.deepEqual(errors,[],path+' reported a browser error');
        assert.ok(timing.resources.every(resource=>new URL(resource.url).origin===new URL(origin).origin),path+' fetched an external resource');
        if(sample===0)await page.screenshot({path:'test-results/demo-load-'+path.split('/').filter(Boolean).at(-1).replace('.html','')+'.png',fullPage:true});
        samples.push(timing);
      }finally{await browser.close();}
    }
    const frames=samples.map(sample=>sample.firstFrame).sort((a,b)=>a-b);
    const ready=samples.map(sample=>sample.ready).sort((a,b)=>a-b);
    const interactive=samples.map(sample=>Math.max(sample.firstFrame,sample.ready)).sort((a,b)=>a-b);
    const result={path,medianMs:Math.round(frames[1]),worstMs:Math.round(frames.at(-1)),readyMedianMs:Math.round(ready[1]),sceneReadyMedianMs:Math.round(interactive[1]),sceneReadyWorstMs:Math.round(interactive.at(-1)),underOneSecond:interactive.at(-1)<=1000,samples};
    results.push(result);
    console.log(`${path}: first frame median ${result.medianMs} ms, worst ${result.worstMs} ms; controls ready median ${result.readyMedianMs} ms`);
  }
  await writeFile('test-results/demo-loads.json',JSON.stringify({profile,browser:'Chromium / '+(process.env.BROWSER_CHANNEL??'msedge'),results},null,2)+'\n');
}finally{await new Promise(resolve=>server.httpServer.close(resolve));await rm(snapshot,{recursive:true,force:true});}
