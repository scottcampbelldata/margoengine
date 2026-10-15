// Local cold-load profiles; phone layouts still use the host GPU, not physical mobile.
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {chromium} from '@playwright/test';
import {preview} from 'vite';
import {installDemoLoadAudit} from './demo-load-audit.js';

const allDemos=['/night-citadel/','/gameplay-sandbox/','/demos/flight-helmet.html','/demos/character-animation.html','/demos/robot-expressive.html','/demos/windy-meadow.html','/demos/earth/','/demos/dof/','/demos/tonemap/'];
const demos=process.argv.length>2?process.argv.slice(2):allDemos;
assert.ok(demos.every(path=>allDemos.includes(path)),'Pass demo paths from the production site');
const profiles={
  'phone-layout-cold':{viewport:{width:390,height:844},deviceScaleFactor:3,cpuSlowdown:4,latencyMs:40,downloadMbps:10,samples:3,headless:true,mobile:true,channel:'msedge'},
  'native-chrome-cold':{viewport:null,cpuSlowdown:1,latencyMs:40,downloadMbps:10,samples:3,headless:false,mobile:false,channel:'chrome'},
  'android-layout-fast-4g':{viewport:{width:390,height:844},deviceScaleFactor:3,cpuSlowdown:1,latencyMs:150,downloadMbps:1.6,samples:3,headless:true,mobile:true,channel:'chrome'},
};
const profileName=process.env.LOAD_PROFILE??'phone-layout-cold',profile=profiles[profileName];
assert.ok(profile,'Unknown LOAD_PROFILE; choose '+Object.keys(profiles).join(', '));
for(const value of Object.values(profiles))assert.ok(value.samples===3&&value.cpuSlowdown>=1&&value.latencyMs>=0&&value.downloadMbps>0&&value.mobile===(value.viewport!==null));
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
      const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL??profile.channel,headless:profile.headless,
        args:profile.headless?[]:['--start-maximized','--disable-features=CalculateNativeWinOcclusion','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-background-timer-throttling']});
      try {
        const context=await browser.newContext({viewport:profile.viewport,...(profile.mobile?{deviceScaleFactor:profile.deviceScaleFactor,isMobile:true,hasTouch:true,
          userAgent:'Mozilla/5.0 (Linux; Android 15; Test layout) AppleWebKit/537.36 Chrome/154.0.0.0 Mobile Safari/537.36'}:{})});
        const page=await context.newPage(),errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
        await page.addInitScript(installDemoLoadAudit);
        const cdp=await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate',{rate:profile.cpuSlowdown});
        await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
        await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:profile.latencyMs,downloadThroughput:profile.downloadMbps*125000,uploadThroughput:625000});
        await page.goto(new URL(path,origin).href);
        try {await page.waitForFunction(()=>window.demoLoad.principalScenePresentedOpportunity>0,null,{timeout:60000});}
        catch(reason){throw new Error(path+' failed to render: '+JSON.stringify({errors,state:await page.evaluate(()=>({...window.demoLoad,status:document.querySelector('#status')?.textContent,error:document.querySelector('#error')?.textContent}))}),{cause:reason});}
        const timing=await page.evaluate(async()=>{
          const adapter=await navigator.gpu.requestAdapter();
          return {...window.demoLoad,navigation:performance.getEntriesByType('navigation')[0]?.toJSON()??null,gpu:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description,fallback:adapter.info.isFallbackAdapter??adapter.isFallbackAdapter??null},
            viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},canvases:[...document.querySelectorAll('canvas')].map(canvas=>({width:canvas.width,height:canvas.height})),
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
    const interactive=samples.map(sample=>sample.principalScenePresentedOpportunity).sort((a,b)=>a-b);
    const result={path,medianMs:Math.round(frames[1]),worstMs:Math.round(frames.at(-1)),readyMedianMs:Math.round(ready[1]),sceneReadyMedianMs:Math.round(interactive[1]),sceneReadyWorstMs:Math.round(interactive.at(-1)),underOneSecond:interactive.at(-1)<=1000,samples};
    results.push(result);
    console.log(`${path}: first frame median ${result.medianMs} ms, worst ${result.worstMs} ms; full scene ready median ${result.sceneReadyMedianMs} ms`);
  }
  const report=`test-results/demo-loads-${profileName}${demos===allDemos?'':'-focused'}.json`;
  await writeFile(report,JSON.stringify({profileName,profile,physicalMobile:false,browser:'Chromium / '+(process.env.BROWSER_CHANNEL??profile.channel),results},null,2)+'\n');
  assert.ok(results.every(result=>result.underOneSecond),'Complete principal scene exceeds 1000 ms; see '+report);
}finally{await new Promise(resolve=>server.httpServer.close(resolve));await rm(snapshot,{recursive:true,force:true});}
