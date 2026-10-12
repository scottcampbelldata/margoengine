import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {build} from 'vite';
import {openBrowser} from './browser.js';
import {animatedTriangle} from '../tests/support/gltf-pro-fixture.js';
import {decodePNG} from '../tests/support/png.js';
import {readResponse} from '../packages/shared/loading.js';
await mkdir('test-results',{recursive:true});

const urls={
  helmet:'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/DamagedHelmet/glTF-Binary/DamagedHelmet.glb',
  robot:'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/RobotExpressive/RobotExpressive.glb'
};
const assets={};
for(const [name,url] of Object.entries(urls)) {
  const path='test-results/'+name+'.glb';try{assets[name]=await readFile(path);}catch(error){if(error.code!=='ENOENT')throw error;const bytes=await readResponse(await fetch(url),{maxBytes:64*1024*1024,label:name+' asset'});assets[name]=Buffer.from(bytes);await writeFile(path,assets[name]);}
}
const demos={helmet:'damaged-helmet',robot:'robot-expressive',character:'character-animation'};
async function assertRobotMobileLayout(page){
  const layout=await page.evaluate(()=>{
    const scene=document.querySelector('#viewport').getBoundingClientRect(),controls=document.querySelector('aside').getBoundingClientRect();
    return {sceneTop:scene.top,sceneBottom:scene.bottom,controlsTop:controls.top,controlsBottom:controls.bottom,height:innerHeight,pageScroll:scrollY,overflowX:document.documentElement.scrollWidth>innerWidth,overflowY:document.documentElement.scrollHeight>innerHeight+1};
  });
  assert(layout.sceneTop===0&&layout.sceneBottom>0&&layout.sceneBottom<=layout.controlsTop+1&&layout.controlsBottom<=layout.height+1&&!layout.overflowX&&!layout.overflowY&&layout.pageScroll===0,'Robot and settings must stay on screen: '+JSON.stringify(layout));
}
for(const demo of Object.values(demos)) {
  const output=await build({configFile:false,logLevel:'silent',build:{write:false,target:'es2022',rollupOptions:{input:'examples/'+demo+'.html'}}});
  assert.ok(output.output.some(chunk=>chunk.type==='chunk'&&chunk.isEntry),'Demo build failed');
}
const browser=await openBrowser({startPath:'/tests/modern-extension.html'}),{page,hardware}=browser,errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'||/Error while parsing|Invalid .*Pipeline|ValidationError/.test(m.text()))errors.push(m.text());});
try {
  for(const [name,url] of Object.entries(urls))await page.route(url,route=>route.fulfill({body:assets[name],contentType:'model/gltf-binary'}));
  const fixture=animatedTriangle();
  const result=await page.evaluate(async ({doc,buffers,urls})=>{
    const {Engine}=await import('/packages/core/dist/index.js');
    const {parseGLTF,loadGLTF}=await import('/packages/gltf-pro/dist/index.js');
    const {Animation}=await import('/packages/animation/dist/index.js');
    const {SSAO}=await import('/packages/post/dist/index.js');
    const assert=(ok,message)=>{if(!ok)throw new Error(message);};
    const canvas=document.createElement('canvas');canvas.style.cssText='width:256px;height:256px';document.body.append(canvas);
    const engine=await Engine.create(canvas,{backend:'webgpu',capacity:2048,camera:{position:[0,0,3],target:[0,0,0],near:0.01,far:100}});
    const device=engine.gpu,modules=[],create=device.createShaderModule.bind(device);
    device.createShaderModule=d=>{const m=create(d);modules.push(m);return m;};device.pushErrorScope('validation');
    const model=parseGLTF(engine,doc,buffers.map(b=>new Uint8Array(b))),animation=Animation.attach(model);
    animation.seek(0.5);animation.playing=false;animation.setMorph(0,0,0.5);
    const ssao=SSAO.attach(engine,{radius:0.5,bias:0.025,samples:32});ssao.add(model);engine.render({culling:false});
    const output=model.primitives[0].deformed,read=device.createBuffer({size:model.primitives[0].vertices.byteLength,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(output,0,read,0,read.size);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    const values=new Float32Array(read.getMappedRange()).slice();read.unmap();read.destroy();
    const info=(await Promise.all(modules.map(m=>m.getCompilationInfo()))).flatMap(i=>i.messages.filter(m=>m.type==='error').map(m=>m.message));
    const validation=await device.popErrorScope();assert(!validation&&info.length===0,JSON.stringify({validation:validation?.message,info}));
    assert(Math.abs(values[0]+0.25)<1e-5,'Morph-before-skin position is incorrect: '+values[0]);
    assert(Math.abs(values[4])<1e-5&&Math.abs(values[6]-1)<1e-5,'Deformed normal changed');
    assert(values[16]===1&&values[19]===1,'Deformation overwrote vertex color');
    ssao.dispose();model.dispose();assert(engine.meshes.size===0&&!engine.hasPlugin(animation.name)&&!engine.hasPlugin(ssao.name),'Model/animation/effect cleanup leaked');
    device.pushErrorScope('validation');
    const large=structuredClone(doc),jointCount=1001;
    large.nodes=[{mesh:0,skin:0,children:Array.from({length:jointCount},(_,i)=>i+1)},...Array.from({length:jointCount},()=>({}))];
    large.skins=[{joints:Array.from({length:jointCount},(_,i)=>i+1)}];large.animations[0].channels[0].target.node=jointCount;
    const largeBuffers=buffers.map(b=>new Uint8Array(b)),jointAccessor=large.meshes[0].primitives[0].attributes.JOINTS_0;
    const jointBuffer=large.bufferViews[large.accessors[jointAccessor].bufferView].buffer;
    const ids=new Uint16Array([1000,0,0,0,1000,0,0,0,1000,0,0,0]);largeBuffers[jointBuffer]=new Uint8Array(ids.buffer);
    const many=parseGLTF(engine,large,largeBuffers),manyAnimation=Animation.attach(many);manyAnimation.seek(0.5);manyAnimation.playing=false;engine.render({culling:false});
    const check=device.createBuffer({size:many.primitives[0].vertices.byteLength,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),copy=device.createCommandEncoder();
    copy.copyBufferToBuffer(many.primitives[0].deformed,0,check,0,check.size);device.queue.submit([copy.finish()]);await check.mapAsync(GPUMapMode.READ);
    const lastBoneX=new Float32Array(check.getMappedRange())[0];check.unmap();check.destroy();
    assert(Math.abs(lastBoneX+0.4)<1e-5,'1,001-bone skin failed: '+lastBoneX);const largeError=await device.popErrorScope();assert(!largeError,largeError?.message);
    many.dispose();assert(!engine.hasPlugin(manyAnimation.name)&&engine.meshes.size===0,'Large skin cleanup leaked');
    const helmet=await loadGLTF(engine,urls.helmet),effect=SSAO.attach(engine,{radius:0.25,bias:0.01,samples:32});effect.add(helmet);
    const b=helmet.bounds;engine.camera.position=[3,2,5];engine.camera.fitToBoundingBox([b[0],b[1],b[2]],[b[3],b[4],b[5]],{duration:0});
    engine.render();await device.queue.onSubmittedWorkDone();engine.render();
    window.extensionScene={engine,helmet,effect};return {morphPosition:values[0],jointCount,lastBoneX,shaderModules:modules.length,helmetPrimitives:helmet.primitives.length};
  },{doc:fixture.doc,buffers:fixture.buffers.map(b=>[...new Uint8Array(b.buffer,b.byteOffset,b.byteLength)]),urls});
  const on=await decodePNG(await page.locator('canvas').screenshot({path:'test-results/helmet-ssao-on.png'}));
  await page.evaluate(async()=>{window.extensionScene.effect.enabled=false;window.extensionScene.engine.render();await window.extensionScene.engine.gpu.queue.onSubmittedWorkDone();});
  const off=await decodePNG(await page.locator('canvas').screenshot({path:'test-results/helmet-ssao-off.png'}));
  let changed=0,darker=0;
  for(let i=0;i<on.data.length;i+=4){const a=on.data[i]+on.data[i+1]+on.data[i+2],b=off.data[i]+off.data[i+1]+off.data[i+2];if(b-a>2){changed++;darker+=b-a;}}
  assert.ok(changed>20,'SSAO toggle produced no ambient occlusion: '+changed);
  await page.evaluate(async()=>{const s=window.extensionScene;s.engine.lighting.radiance.fill(0);s.engine.lighting.radiance[0]=s.engine.lighting.radiance[1]=s.engine.lighting.radiance[2]=1;s.effect.enabled=false;s.engine.render();await s.engine.gpu.queue.onSubmittedWorkDone();});
  const directOff=await decodePNG(await page.locator('canvas').screenshot());
  await page.evaluate(async()=>{const s=window.extensionScene;s.effect.enabled=true;s.engine.render();await s.engine.gpu.queue.onSubmittedWorkDone();});
  const directOn=await decodePNG(await page.locator('canvas').screenshot());
  assert.deepEqual(directOn.data,directOff.data,'SSAO attenuated direct lighting or emission');
  await page.evaluate(async()=>{const s=window.extensionScene;s.engine.lighting.radiance.fill(0);s.effect.enabled=false;s.engine.render();await s.engine.gpu.queue.onSubmittedWorkDone();});
  const emissiveOff=await decodePNG(await page.locator('canvas').screenshot());
  await page.evaluate(async()=>{const s=window.extensionScene;s.effect.enabled=true;s.engine.render();await s.engine.gpu.queue.onSubmittedWorkDone();});
  const emissiveOn=await decodePNG(await page.locator('canvas').screenshot());
  assert.deepEqual(emissiveOn.data,emissiveOff.data,'SSAO attenuated emissive lighting');
  await page.evaluate(async()=>{const s=window.extensionScene;await s.engine.rebootDevice();s.effect.enabled=true;s.engine.render();await s.engine.gpu.queue.onSubmittedWorkDone();s.engine.render();s.engine.dispose();});
  // Keep the body at one pose so pixel changes measure expressions, including during playback.
  await page.addInitScript(()=>{const raf=window.requestAnimationFrame.bind(window);window.demoTime=1000;window.requestAnimationFrame=callback=>raf(()=>callback(window.demoTime));});
  const samplingAudit=()=>{
    window.samplingAudit={textures:[],pipelines:[]};
    for(const name of ['createTexture','createRenderPipeline','createRenderPipelineAsync']){
      const original=GPUDevice.prototype[name];GPUDevice.prototype[name]=function(descriptor){
        window.samplingAudit[name==='createTexture'?'textures':'pipelines'].push(name==='createTexture'?descriptor.sampleCount??1:descriptor.multisample?.count??1);
        return original.call(this,descriptor);
      };
    }
  };
  await page.addInitScript(samplingAudit);
  for(const [name,demo] of Object.entries(demos)) {
    await page.goto('http://127.0.0.1:5193/examples/'+demo+'.html');
    await page.waitForFunction(()=>document.querySelector('#viewport').dataset.ready==='true'||document.querySelector('#error').textContent.length>0);
    assert.equal(await page.locator('#error').innerText(),'');
    if(name==='helmet') {await page.locator('#ssao').uncheck();await page.locator('#ssao').check();}
    else {
      assert.ok(await page.locator('#clip option').count()>0);
      await page.locator('#clip').selectOption({label:'Idle'});
      const frame=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))),sliders=page.locator('#morphs input');
      assert.equal(await sliders.count(),3);await frame();
      const neutral=await decodePNG(await page.locator('canvas').screenshot());
      for(let i=0;i<3;i++) {
        await sliders.nth(i).fill('1');await frame();
        const expression=await decodePNG(await page.locator('canvas').screenshot({path:'test-results/'+name+'-expression-'+i+'.png'}));let changed=0;
        for(let pixel=0;pixel<neutral.data.length;pixel+=4)if(Math.abs(neutral.data[pixel]-expression.data[pixel])+Math.abs(neutral.data[pixel+1]-expression.data[pixel+1])+Math.abs(neutral.data[pixel+2]-expression.data[pixel+2])>12)changed++;
        assert.ok(changed>100,'Expression '+i+' did not change the face during playback: '+changed);
        await page.locator('#pause').click();await frame();
        assert.equal(Buffer.compare((await decodePNG(await page.locator('canvas').screenshot())).data,expression.data),0,'Pausing reset the expression');
        await page.locator('#clip').selectOption({label:'Idle'});assert.equal(await page.locator('#pause').getAttribute('aria-pressed'),'true','Clip switching resumed paused playback');
        await page.locator('#pause').click();await page.locator('#clip').selectOption({label:'Idle'});await frame();
        assert.equal(Buffer.compare((await decodePNG(await page.locator('canvas').screenshot())).data,expression.data),0,'Clip switching reset the expression');
        await sliders.nth(i).fill('0');await frame();
        assert.equal(Buffer.compare((await decodePNG(await page.locator('canvas').screenshot())).data,neutral.data),0,'Expression did not return to neutral');
      }
      const preset=page.locator('#expression'),speed=page.locator('#speed');
      await preset.selectOption({label:'Angry'});await frame();
      assert.deepEqual(await sliders.evaluateAll(inputs=>inputs.map(input=>input.valueAsNumber)),[1,0,0]);
      await sliders.nth(1).fill('0.5');assert.equal(await preset.inputValue(),'custom');
      await preset.selectOption('neutral');await frame();
      assert.equal(Buffer.compare((await decodePNG(await page.locator('canvas').screenshot())).data,neutral.data),0,'Neutral preset did not reset the face');
      await page.locator('#pause').click();
      await page.locator('canvas').focus();await page.keyboard.press('ArrowRight');await page.evaluate(()=>window.demoTime+=100);await frame();
      assert.ok(!(await decodePNG(await page.locator('canvas').screenshot())).data.every((value,i)=>value===neutral.data[i]),'Keyboard orbit did not move the camera');
      await page.locator('#reset-view').click();await frame();
      assert.equal(Buffer.compare((await decodePNG(await page.locator('canvas').screenshot())).data,neutral.data),0,'Reset view did not restore the camera');
      await page.locator('#pause').click();
      await page.locator('#clip').selectOption({label:'Running'});await speed.fill('0.5');await frame();
      const running=await decodePNG(await page.locator('canvas').screenshot());
      assert.equal(await page.locator('#speed-value').innerText(),'0.5×');
      await page.evaluate(()=>window.demoTime+=100);await frame();const halfSpeed=await decodePNG(await page.locator('canvas').screenshot());
      assert.ok(!halfSpeed.data.every((value,i)=>value===running.data[i]),'Playback did not advance');
      await page.locator('#clip').selectOption({label:'Running'});await speed.fill('1');await frame();
      await page.evaluate(()=>window.demoTime+=50);await frame();
      assert.equal(Buffer.compare((await decodePNG(await page.locator('canvas').screenshot())).data,halfSpeed.data),0,'Playback speed did not scale animation time');
      await page.emulateMedia({reducedMotion:'reduce'});await frame();
      await page.locator('#clip').selectOption({label:'Walking'});assert.equal(await page.locator('#pause').getAttribute('aria-pressed'),'true','Clip switching ignored reduced motion');
      await preset.selectOption({label:'Surprised'});await frame();
      await page.screenshot({path:'test-results/'+name+'-studio.png'});
      await page.emulateMedia({reducedMotion:'no-preference'});
    }
    await page.locator('canvas').screenshot({path:'test-results/'+name+'-demo.png'});
    const canvas=page.locator('canvas');await canvas.focus();await page.keyboard.press('ArrowRight');
    await page.setViewportSize({width:600,height:800});await page.waitForTimeout(100);assert.equal(await page.locator('#error').innerText(),'');
    if(name!=='helmet') {
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Robot controls overflow on mobile');
      await assertRobotMobileLayout(page);
      await page.locator('#expression').selectOption('neutral');
      await page.screenshot({path:'test-results/'+name+'-mobile.png',fullPage:true});
    }
    await page.setViewportSize({width:1440,height:1100});
  }
  assert.ok(await page.evaluate(()=>samplingAudit.textures.includes(4)&&samplingAudit.pipelines.includes(4)),'Desktop robot did not use 4× MSAA');
  const mobileContext=await page.context().browser().newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});
  const mobile=await mobileContext.newPage();mobile.on('pageerror',e=>errors.push(e.message));
  await mobile.addInitScript(samplingAudit);
  await mobile.addInitScript(()=>{const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=callback=>raf(()=>callback(1000));});
  await mobile.route(urls.robot,route=>route.fulfill({body:assets.robot,contentType:'model/gltf-binary'}));
  await mobile.goto('http://127.0.0.1:5193/examples/character-animation.html');await mobile.waitForFunction(()=>document.querySelector('#status')?.textContent==='Ready');
  assert.equal(await mobile.locator('#error').innerText(),'');
  assert.ok(await mobile.evaluate(()=>!samplingAudit.textures.includes(4)&&!samplingAudit.pipelines.includes(4)),'Mobile robot allocated 4× resources');
  assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile robot controls overflow');
  await assertRobotMobileLayout(mobile);
  await mobile.locator('#clip').selectOption({label:'Idle'});
  await mobile.locator('#pause').click();
  const sceneBefore=await mobile.locator('#viewport').boundingBox();
  await mobile.locator('aside').evaluate(controls=>controls.scrollTop=controls.scrollHeight);
  await assertRobotMobileLayout(mobile);
  assert.deepEqual(await mobile.locator('#viewport').boundingBox(),sceneBefore,'Scrolling controls moved the robot');
  await mobile.locator('aside').evaluate(controls=>controls.scrollTop=0);
  const neutralPhone=await decodePNG(await mobile.locator('canvas').screenshot());
  await mobile.locator('#expression').selectOption({label:'Sad'});
  await mobile.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const sadPhone=await decodePNG(await mobile.locator('canvas').screenshot());
  let phoneExpressionPixels=0;
  for(let i=0;i<neutralPhone.data.length;i+=4)if(Math.abs(neutralPhone.data[i]-sadPhone.data[i])+Math.abs(neutralPhone.data[i+1]-sadPhone.data[i+1])+Math.abs(neutralPhone.data[i+2]-sadPhone.data[i+2])>12)phoneExpressionPixels++;
  assert(phoneExpressionPixels>100,'Phone expression did not visibly change while controls were on screen');
  await assertRobotMobileLayout(mobile);
  for(const size of [{width:320,height:568},{width:360,height:667}]){
    await mobile.setViewportSize(size);await mobile.waitForTimeout(150);await assertRobotMobileLayout(mobile);
  }
  await mobile.setViewportSize({width:390,height:844});await mobile.waitForTimeout(150);
  await mobile.screenshot({path:'test-results/robot-phone.png',fullPage:true});await mobileContext.close();
  assert.deepEqual(errors,[]);
  await writeFile('test-results/modern-extensions.json',JSON.stringify({hardware,...result,ssaoChangedPixels:changed,ssaoDarkening:darker,phoneExpressionPixels},null,2));
  console.log(JSON.stringify({...result,ssaoChangedPixels:changed,hardware},null,2));
} finally {await browser.close();}
