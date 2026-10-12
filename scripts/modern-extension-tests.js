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
for(const name of ['helmet','robot']) {
  const output=await build({configFile:false,logLevel:'silent',build:{write:false,target:'es2022',rollupOptions:{input:'examples/'+(name==='helmet'?'damaged-helmet':'robot-expressive')+'.html'}}});
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
  for(const name of ['helmet','robot']) {
    await page.goto('http://127.0.0.1:5193/examples/'+(name==='helmet'?'damaged-helmet':'robot-expressive')+'.html');
    await page.waitForFunction(()=>document.querySelector('#viewport').dataset.ready==='true'||document.querySelector('#error').textContent.length>0);
    assert.equal(await page.locator('#error').innerText(),'');
    if(name==='helmet') {await page.locator('#ssao').uncheck();await page.locator('#ssao').check();}
    else {assert.ok(await page.locator('#clip option').count()>0);await page.locator('#pause').click();const sliders=page.locator('#morphs input');assert.ok(await sliders.count()>0);await sliders.first().fill('0.75');await page.locator('#clip').selectOption({label:'Running'});}
    await page.locator('canvas').screenshot({path:'test-results/'+name+'-demo.png'});
    const canvas=page.locator('canvas');await canvas.focus();await page.keyboard.press('ArrowRight');
    await page.setViewportSize({width:600,height:800});await page.waitForTimeout(100);assert.equal(await page.locator('#error').innerText(),'');
    await page.setViewportSize({width:1440,height:1100});
  }
  assert.deepEqual(errors,[]);
  await writeFile('test-results/modern-extensions.json',JSON.stringify({hardware,...result,ssaoChangedPixels:changed,ssaoDarkening:darker},null,2));
  console.log(JSON.stringify({...result,ssaoChangedPixels:changed,hardware},null,2));
} finally {await browser.close();}
