// Functional local-source test. Cold production load timing is measured separately.
// Desktop cases force ?quality=high: the default desktop tier is light (single-sampled phone model, no detail upgrade).
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from './browser.js';
import {decodePNG} from '../tests/support/png.js';
import {installDemoLoadAudit} from './demo-load-audit.js';

const browser=await openBrowser({startPath:'/examples/flight-helmet.html',port:5197}),page=browser.page,errors=[];
page.on('pageerror',error=>errors.push(error.message));
const results=[],requests=[];page.on('request',request=>{if(request.url().includes('flight-helmet'))requests.push(request.url());});
await page.addInitScript(installDemoLoadAudit);
const fullImages=[];
async function captureFull(label){
  await page.evaluate(()=>{const d=extensionDemo;d.stage.engine.stop();d.stage.engine.camera.cancelFit();d.stage.engine.camera.position=[2,1.5,4];d.stage.engine.camera.target=[0,0,0];});
  const images=[];
  for(const enabled of [false,true]){
    await page.locator('#ssao').setChecked(enabled);
    await page.evaluate(async()=>{extensionDemo.stage.engine.render({delta:0});extensionDemo.stage.engine.render({delta:0});await extensionDemo.stage.engine.gpu.queue.onSubmittedWorkDone();});
    const image=await decodePNG(await page.locator('canvas').screenshot({path:`test-results/helmet-${label}-ao-${enabled}.png`}));
    assert.ok(image.data.some((value,i)=>i%4!==3&&value!==image.data[i%4]),'Full helmet image is empty');images.push(image);
  }
  return images;
}
try{
  for(const failDetail of [false,true]){
    let release,detailRequested=false;
    const wait=new Promise(resolve=>{release=resolve;});
    await page.route('**/assets/flight-helmet.glb',async route=>{detailRequested=true;await wait;if(failDetail)await route.abort('failed');else await route.continue();});
    await page.goto('http://127.0.0.1:5197/examples/flight-helmet.html?quality=high');
    await page.waitForFunction(()=>window.extensionDemo?.quality==='preview'&&document.querySelector('#viewport').dataset.ready==='true');
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Full detail is loading'));
    assert.ok(detailRequested,'Desktop detail was never requested after the complete preview');
    const preview=await page.evaluate(()=>{
      const d=extensionDemo;document.querySelector('#ssao').click();d.stage.engine.camera.position=[2,1.5,4];d.stage.engine.render();
      return {quality:d.quality,triangles:d.model.primitives.reduce((sum,p)=>sum+p.indices.length/3,0),readiness:d.readiness,camera:Array.from(d.stage.engine.camera.position),disposed:d.model.disposed};
    });
    assert.equal(preview.quality,'preview');assert.ok(preview.triangles>5000);assert.equal(preview.disposed,false);
    assert.ok(preview.readiness.principalSceneSubmitted>0&&preview.readiness.principalSceneGpuComplete>=preview.readiness.principalSceneSubmitted);
    assert.ok(preview.readiness.principalScenePresentedOpportunity>=preview.readiness.principalSceneGpuComplete);
    await page.waitForFunction(()=>demoLoad.principalScenePresentedOpportunity>0);
    assert.equal(await page.evaluate(()=>demoLoad.principalScenePresentedOpportunity),preview.readiness.principalScenePresentedOpportunity);
    release();
    await page.waitForFunction(fail=>fail?document.querySelector('#status').textContent.includes('could not load'):window.extensionDemo?.quality==='full',failDetail);
    const final=await page.evaluate(()=>({quality:extensionDemo.quality,triangles:extensionDemo.model.primitives.reduce((sum,p)=>sum+p.indices.length/3,0),
      previewDisposed:extensionDemo.initialModel.disposed,activeDisposed:extensionDemo.model.disposed,camera:Array.from(extensionDemo.stage.engine.camera.position),ssaoChecked:document.querySelector('#ssao').checked}));
    assert.equal(final.activeDisposed,false);assert.equal(final.ssaoChecked,false);assert.ok(final.camera.every((value,i)=>Math.abs(value-preview.camera[i])<1e-12),'Detail upgrade reset the camera');
    if(failDetail){assert.equal(final.quality,'preview');assert.equal(final.previewDisposed,false);assert.equal(final.triangles,preview.triangles);}
    else{assert.equal(final.quality,'full');assert.equal(final.previewDisposed,true);assert.ok(final.triangles>preview.triangles);fullImages.push(...await captureFull('streamed-full'));}
    results.push({failDetail,preview,final});await page.unroute('**/assets/flight-helmet.glb');
  }
  let releaseBaseline;
  const baselineHeld=new Promise(resolve=>{releaseBaseline=resolve;});
  await page.route('**/assets/flight-helmet-mobile.glb',route=>route.fulfill({path:'examples/assets/flight-helmet.glb',contentType:'model/gltf-binary'}));
  await page.route('**/assets/flight-helmet.glb',async route=>{await baselineHeld;await route.abort('failed');});
  await page.goto('http://127.0.0.1:5197/examples/flight-helmet.html?quality=high');
  await page.waitForFunction(()=>window.extensionDemo?.quality==='preview'&&document.querySelector('#viewport').dataset.ready==='true');
  assert.ok(await page.evaluate(()=>extensionDemo.model.primitives.reduce((sum,p)=>sum+p.indices.length/3,0)>15000));
  const baselineImages=await captureFull('direct-full');
  for(let i=0;i<fullImages.length;i++){
    assert.equal(fullImages[i].width,baselineImages[i].width);assert.equal(fullImages[i].height,baselineImages[i].height);
    assert.equal(Buffer.compare(fullImages[i].data,baselineImages[i].data),0,'Streamed full-detail image changed from loading the original full model directly');
  }
  results.push({mode:'full-detail-parity',aoOff:true,aoOn:true,changedChannels:0});
  await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')));releaseBaseline();
  await page.unroute('**/assets/flight-helmet-mobile.glb');await page.unroute('**/assets/flight-helmet.glb');
  for(const mode of ['android-layout','pagehide']){
    const mobile=mode==='android-layout',context=await page.context().browser().newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1100},
      deviceScaleFactor:mobile?3:1,isMobile:mobile,hasTouch:mobile,...(mobile?{userAgent:'Mozilla/5.0 (Linux; Android 15; Test layout) AppleWebKit/537.36 Chrome/154.0.0.0 Mobile Safari/537.36'}:{})});
    try{
      const current=await context.newPage(),caseErrors=[],detailRequests=[];current.on('pageerror',error=>caseErrors.push(error.message));
      current.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/flight-helmet.glb'))detailRequests.push(request.url());});
      await current.addInitScript(installDemoLoadAudit);
      let release,requested=false;const held=new Promise(resolve=>{release=resolve;});
      await current.route('**/assets/flight-helmet.glb',async route=>{requested=true;await held;await route.continue();});
      await current.goto('http://127.0.0.1:5197/examples/flight-helmet.html?quality=high');
      await current.waitForFunction(()=>window.extensionDemo&&document.querySelector('#viewport').dataset.ready==='true'&&demoLoad.principalScenePresentedOpportunity>0);
      if(mobile){
        const state=await current.evaluate(()=>({quality:extensionDemo.quality,triangles:extensionDemo.model.primitives.reduce((sum,p)=>sum+p.indices.length/3,0),readiness:extensionDemo.readiness}));
        assert.equal(state.quality,'mobile');assert.equal(state.triangles,20734);assert.equal(detailRequests.length,0);results.push({mode,...state});
        await current.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')));
      }else{
        await current.waitForFunction(()=>document.querySelector('#status').textContent.includes('Full detail is loading'));assert.equal(requested,true);
        await current.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')));release();
        await current.waitForTimeout(100);
        const state=await current.evaluate(()=>({quality:extensionDemo.quality,engineDisposed:extensionDemo.stage.engine.disposed,modelDisposed:extensionDemo.model.disposed}));
        assert.deepEqual(state,{quality:'preview',engineDisposed:true,modelDisposed:true});results.push({mode,...state});
      }
      release();assert.deepEqual(caseErrors,[],mode+' emitted a browser exception');
    }finally{await context.close();}
  }
  assert.deepEqual(errors,[]);await writeFile('test-results/helmet-streaming.json',JSON.stringify({hardware:browser.hardware,results},null,2)+'\n');
  console.log(JSON.stringify({hardware:browser.hardware,results},null,2));
}catch(reason){
  const state=await page.evaluate(()=>({status:document.querySelector('#status')?.textContent,error:document.querySelector('#error')?.textContent,ready:document.querySelector('#viewport')?.dataset.ready,
    quality:window.extensionDemo?.quality,readiness:window.extensionDemo?.readiness}));
  await writeFile('test-results/helmet-streaming-failure.json',JSON.stringify({state,requests,errors},null,2)+'\n');
  throw new Error(JSON.stringify({state,requests,errors}),{cause:reason});
}finally{await browser.close();}
