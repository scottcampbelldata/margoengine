// Functional source/GPU checks; hosted cold-load and physical mobile acceptance are separate.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from './browser.js';
import {installDemoLoadAudit} from './demo-load-audit.js';
import {decodePNG} from '../tests/support/png.js';
import {expect} from '@playwright/test';

const url='http://127.0.0.1:5199/packages/creative/examples/earth/';
const browser=await openBrowser({startPath:'/packages/creative/examples/earth/',port:5199});
const native=browser.page.context().browser(),results=[],fullImages=[];
const high=/\/assets\/earth-(day\.jpg|(?:night|clouds|normal|specular)\.webp)$/;
const lowToHigh={day:'earth-day.jpg',night:'earth-night.webp',clouds:'earth-clouds.webp',normal:'earth-normal.webp',specular:'earth-specular.webp'};
await browser.page.goto('about:blank');
async function still(page,label){
  await page.evaluate(async()=>{const d=earthDemo;d.stage.engine.stop();d.stage.engine.camera.cancelFit();d.stage.engine.camera.position=[0,0.6,3.8];d.stage.engine.camera.target=[0,0,0];d.earth.rotation.y=0.35;d.earth.clouds.offsetU=0.42;d.earth.setSunDirection([0.7,0.2,-0.4]);d.stage.engine.render({delta:0});d.stage.engine.render({delta:0});await d.stage.engine.gpu.queue.onSubmittedWorkDone();});
  const image=await decodePNG(await page.locator('canvas').screenshot({path:`test-results/earth-${label}.png`}));
  assert.ok(image.data.some((value,i)=>i%4!==3&&value!==image.data[i%4]),'Earth image is empty');return image;
}
try{
  for(const mode of ['desktop-success','failed-detail','pagehide','android-layout','direct-full']){
    const mobile=mode==='android-layout',context=await native.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1100},
      deviceScaleFactor:mobile?3:1,isMobile:mobile,hasTouch:mobile,...(mobile?{userAgent:'Mozilla/5.0 (Linux; Android 15; Test layout) AppleWebKit/537.36 Chrome/154.0.0.0 Mobile Safari/537.36'}:{})});
    try{
      const page=await context.newPage(),errors=[],requests=[];page.on('pageerror',error=>errors.push(error.message));
      page.on('request',request=>{if(high.test(new URL(request.url()).pathname))requests.push(request.url());});
      await page.addInitScript(installDemoLoadAudit);await page.emulateMedia({reducedMotion:'reduce'});
      let release;const held=new Promise(resolve=>{release=resolve;});
      await page.route(request=>high.test(request.pathname),async route=>{await held;if(mode==='failed-detail'||mode==='direct-full')await route.abort('failed');else await route.continue();});
      if(mode==='direct-full')await page.route(/\/assets\/earth-(day|night|clouds|normal|specular)-mobile\.webp$/,route=>{
        const name=new URL(route.request().url()).pathname.match(/earth-(\w+)-mobile/)[1];return route.fulfill({path:'packages/creative/examples/earth/assets/'+lowToHigh[name]});
      });
      await page.goto(url);
      await page.waitForFunction(()=>window.earthDemo&&demoLoad.principalScenePresentedOpportunity>0);
      const initial=await page.evaluate(()=>{
        const d=earthDemo;window.originalEarthRotation=d.earth.rotation;window.originalEarthClouds=d.earth.clouds;window.originalEarth=d.earth;
        d.earth.rotation.y=0.35;d.earth.clouds.offsetU=0.42;document.querySelector('#sun').value='35';document.querySelector('#sun').dispatchEvent(new Event('input'));
        return {quality:d.quality,readiness:d.readiness,load:{...demoLoad},controls:!document.querySelector('#controls').disabled,
          imageCount:Object.values(d.earth.images).filter(Boolean).length,imageWidths:Object.values(d.earth.images).filter(Boolean).map(image=>image.width)};
      });
      assert.equal(initial.controls,true);assert.equal(initial.imageCount,5);
      assert.ok(initial.imageWidths.every(width=>width===(mode==='direct-full'?2048:1024)));
      assert.equal(initial.load.principalScenePresentedOpportunity,initial.readiness.principalScenePresentedOpportunity);
      assert.equal(initial.quality,mobile?'mobile':'preview');
      if(mobile){assert.equal(requests.length,0);results.push({mode,initial});}
      else{
        await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Full detail is loading'));
        await expect.poll(()=>requests.length).toBe(5);
        if(mode==='direct-full'){
          const image=await still(page,'direct-full');assert.equal(image.width,fullImages[0].width);assert.equal(image.height,fullImages[0].height);
          assert.equal(Buffer.compare(image.data,fullImages[0].data),0,'Atomic upgrade changed the final full-map rendering');
          results.push({mode,initial,changedChannels:0});
          await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')));release();
        }else if(mode==='pagehide'){
          await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')));release();await page.waitForTimeout(100);
          assert.equal(await page.evaluate(()=>earthDemo.stage.engine.disposed),true);
          assert.equal(await page.evaluate(()=>Object.values(originalEarth.images).filter(Boolean).length),0);results.push({mode,initial,disposed:true});
        }else{
          release();await page.waitForFunction(failed=>failed?document.querySelector('#status').textContent.includes('could not load'):earthDemo.quality==='full',mode==='failed-detail');
          const final=await page.evaluate(()=>({quality:earthDemo.quality,samePlanet:earthDemo.earth===originalEarth,
            sameRotation:earthDemo.earth.rotation===originalEarthRotation,sameClouds:earthDemo.earth.clouds===originalEarthClouds,
            rotation:earthDemo.earth.rotation.y,cloudOffset:earthDemo.earth.clouds.offsetU,controls:!document.querySelector('#controls').disabled,
            widths:Object.values(earthDemo.earth.images).filter(Boolean).map(image=>image.width),disposed:earthDemo.stage.engine.disposed,
            detailStarts:performance.getEntriesByType('resource').filter(entry=>/\/assets\/earth-(day\.jpg|(?:night|clouds|normal|specular)\.webp)$/.test(new URL(entry.name).pathname)).map(entry=>entry.startTime)}));
          assert.equal(final.samePlanet,true);assert.equal(final.sameRotation,true);assert.equal(final.sameClouds,true);assert.equal(final.controls,true);assert.equal(final.disposed,false);
          assert.ok(Math.abs(final.rotation-0.35)<1e-6);assert.ok(Math.abs(final.cloudOffset-0.42)<1e-12);
          assert.equal(final.quality,mode==='failed-detail'?'preview':'full');assert.ok(final.widths.every(width=>width===(mode==='failed-detail'?1024:2048)));
          if(mode==='desktop-success'){assert.equal(final.detailStarts.length,5);assert.ok(final.detailStarts.every(start=>start>=initial.readiness.principalScenePresentedOpportunity));}
          if(mode==='desktop-success')fullImages.push(await still(page,'streamed-full'));
          else await still(page,'failed-detail-preview');results.push({mode,initial,final});
        }
      }
      release();assert.deepEqual(errors,[],mode+' emitted a browser exception');
      console.log(JSON.stringify({mode,principalMs:initial.readiness.principalScenePresentedOpportunity,checks:'passed'}));
    }finally{await context.close();}
  }
  await writeFile('test-results/earth-streaming.json',JSON.stringify({hardware:browser.hardware,headless:true,results},null,2)+'\n');
}finally{await browser.close();}
