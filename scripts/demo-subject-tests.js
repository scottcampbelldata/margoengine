// Verify complete production subjects and the visible-frame timing audit.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {preview} from 'vite';
import {decodePNG} from '../tests/support/png.js';
import {installDemoLoadAudit} from './demo-load-audit.js';
import {submitPrincipalScene} from '../packages/shared/demo-frame.js';

await mkdir('test-results',{recursive:true});
const auditOnly=process.argv.includes('--audit-only');
const cases=[
  {name:'citadel',path:'/night-citadel/'},
  {name:'afterlight',path:'/gameplay-sandbox/'},
  {name:'helmet',path:'/demos/damaged-helmet.html'}
];
const server=await preview({configFile:false,root:'site',build:{outDir:'dist'},logLevel:'error',preview:{host:'127.0.0.1',port:0}});
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL??'msedge',args:process.env.BROWSER_ARGS?JSON.parse(process.env.BROWSER_ARGS):[],headless:true}),report=[];
try {
  const fixture=await browser.newContext(),audit=await fixture.newPage();
  await audit.addInitScript(installDemoLoadAudit);
  await audit.route('**/audit-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Visible frame fixture</title>'}));
  await audit.goto(new URL('/audit-fixture',server.resolvedUrls.local[0]).href);
  const excluded=await audit.evaluate(async()=>{
    const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),canvas=document.createElement('canvas');
    canvas.width=canvas.height=8;document.body.append(canvas);
    const context=canvas.getContext('webgpu'),format=navigator.gpu.getPreferredCanvasFormat();context.configure({device,format});
    const module=device.createShaderModule({code:'@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}@fragment fn fragment()->@location(0) vec4f{return vec4f(1,0,0,1);}'});
    const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format}]}});
    const offscreen=device.createTexture({size:[8,8],format,usage:GPUTextureUsage.RENDER_ATTACHMENT});
    const encoder=device.createCommandEncoder();
    const clear=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store'}]});
    clear.setPipeline(pipeline);clear.draw(0);clear.draw(3,0);clear.end();
    const pass=encoder.beginRenderPass({colorAttachments:[{view:offscreen.createView(),loadOp:'clear',storeOp:'store'}]});
    pass.setPipeline(pipeline);pass.draw(3);pass.end();device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    window.auditFixture={device,context,pipeline,offscreen};return {...demoLoad};
  });
  assert(excluded.draws>0&&excluded.submitted===0&&excluded.firstFrame===0,'Clear plus offscreen draw was counted as visible');
  await audit.evaluate(()=>{
    const {device,context,pipeline}=auditFixture,encoder=device.createCommandEncoder();
    const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store'}]});
    pass.setPipeline(pipeline);pass.draw(3);pass.end();device.queue.submit([encoder.finish()]);
  });
  await audit.waitForFunction(()=>demoLoad.firstFrame>0);
  assert.equal(await audit.evaluate(()=>demoLoad.principalScenePresentedOpportunity),null,'An early canvas frame was counted as the complete subject');
  await audit.addScriptTag({content:submitPrincipalScene.toString()});
  await audit.evaluate(async()=>{
    const {device,context,pipeline}=auditFixture;
    const readiness=await submitPrincipalScene(()=>{
      const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store'}]});
      pass.setPipeline(pipeline);pass.draw(3);pass.end();device.queue.submit([encoder.finish()]);
    },device.queue);
    window.extensionDemo={readiness};
  });
  await audit.waitForFunction(()=>demoLoad.principalScenePresentedOpportunity>0);
  const principal=await audit.evaluate(()=>({...demoLoad}));
  assert.ok(principal.principalSceneSubmitted>principal.submitted);
  assert.ok(principal.principalSceneGpuComplete>=principal.principalSceneSubmitted&&principal.principalScenePresentedOpportunity>=principal.principalSceneGpuComplete);
  assert.equal(principal.principalSceneCorrelation,'identified-webgpu-submit');
  await audit.evaluate(()=>{auditFixture.offscreen.destroy();auditFixture.device.destroy();});await fixture.close();
  console.log('Frame audit distinguishes offscreen work, an early canvas frame and the correlated complete subject.');
  for(const demo of auditOnly?[]:cases){
    const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.addInitScript(installDemoLoadAudit);
    await page.addInitScript(()=>{
      window.startupAudit={live:new Set()};
      for(const method of ['createBuffer','createTexture']){
        const original=GPUDevice.prototype[method];
        GPUDevice.prototype[method]=function(...args){
          const result=original.apply(this,args),audit=window.startupAudit;
          audit.live.add(result);const destroy=result.destroy.bind(result);
          result.destroy=()=>{audit.live.delete(result);destroy();};return result;
        };
      }
    });
    try {
      await page.goto(new URL(demo.path,server.resolvedUrls.local[0]).href,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>demoLoad.principalScenePresentedOpportunity>0&&demoLoad.ready>0);
      if(demo.name==='helmet')assert(await page.locator('#ssao').isEnabled());
      else if(demo.name==='afterlight')assert(await page.locator('#explore').isEnabled());
      else assert(await page.locator('#status').isHidden());
      const style=demo.name==='citadel'?'body > :not(canvas) {visibility:hidden!important}':demo.name==='afterlight'?'main > :not(canvas) {visibility:hidden!important}':'aside {visibility:hidden!important}';
      const image=await page.locator('canvas').first().screenshot({style}),pixels=await decodePNG(image);
      const {data,width,height}=pixels,background=data.subarray(0,3);let subjectPixels=0;
      for(let y=Math.floor(height*0.2);y<height*0.8;y++)for(let x=Math.floor(width*0.15);x<width*0.85;x++){
        const i=(y*width+x)*4;
        if(Math.abs(data[i]-background[0])+Math.abs(data[i+1]-background[1])+Math.abs(data[i+2]-background[2])>30)subjectPixels++;
      }
      assert(subjectPixels>2000,'Only a blank/background frame appeared for '+demo.name+': '+subjectPixels);
      if(demo.name==='afterlight'){
        let explorerPixels=0;
        for(let y=Math.floor(height*0.44);y<height*0.65;y++)for(let x=Math.floor(width*0.4);x<width*0.6;x++){
          const i=(y*width+x)*4,rgb=[data[i],data[i+1],data[i+2]];
          if(Math.min(...rgb)>80&&Math.max(...rgb)-Math.min(...rgb)<45)explorerPixels++;
        }
        assert(explorerPixels>1000,'Afterlight completed startup before the explorer appeared');
      }
      await writeFile('test-results/'+demo.name+'-complete-scene.png',image);
      const timing=await page.evaluate(()=>({...demoLoad}));
      await page.evaluate(()=>dispatchEvent(new Event('pagehide')));
      assert.equal(await page.evaluate(()=>startupAudit.live.size),0,demo.name+' leaked GPU resources');
      assert.deepEqual(errors,[],demo.name+' reported a browser error');
      report.push({demo:demo.name,subjectPixels,timing});
    }finally{await context.close();}
  }
  if(!auditOnly){await writeFile('test-results/demo-subject-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
}finally{await browser.close();await new Promise(resolve=>server.httpServer.close(resolve));}
