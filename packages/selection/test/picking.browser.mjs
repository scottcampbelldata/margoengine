import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {openBrowser} from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../',import.meta.url)));
const browser=await openBrowser(),{page,hardware}=browser,errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error'||/ValidationError|Error while parsing|Invalid .*Pipeline/.test(message.text()))errors.push(message.text());});
try {
 await page.waitForFunction(()=>window.modern);
 const report=await page.evaluate(async()=>{
  const {Engine,Geometry,box,PbrMaterial}=await import('/packages/core/dist/extension.js'),{Picking,Selection}=await import('/packages/selection/dist/index.js');
  const assert=(ok,message)=>{if(!ok)throw new Error(message);};
  const canvas=document.createElement('canvas');canvas.style.cssText='width:128px;height:128px';document.body.append(canvas);
  const e=await Engine.create(canvas,{backend:'webgpu',capacity:1024,camera:{position:[0,0,4],fov:60}}),checks=[];
  const gpuErrors=[];e.gpu.addEventListener('uncapturederror',event=>gpuErrors.push(event.error.message));
  let passes=0,instances=0,copies=0,lastSize,sourceSize;
  const instrument=()=>{
   const device=e.gpu,create=device.createCommandEncoder.bind(device);
   device.createCommandEncoder=(...args)=>{
    const encoder=create(...args),begin=encoder.beginRenderPass.bind(encoder),copy=encoder.copyTextureToBuffer.bind(encoder);
    encoder.beginRenderPass=(descriptor)=>{
     passes++;const pass=begin(descriptor),draw=pass.drawIndexed.bind(pass);
     pass.drawIndexed=(count,n=1,...rest)=>{instances+=n;return draw(count,n,...rest);};return pass;
    };
    encoder.copyTextureToBuffer=(source,target,size)=>{copies++;lastSize=[...size];sourceSize=[source.texture.width,source.texture.height];return copy(source,target,size);};return encoder;
   };
  };
  const reset=()=>{passes=instances=copies=0;};
  try {
   instrument();const picking=Picking.attach(e),geometry=box(),target=e.createMesh().setGeometry(geometry).setScale([.15,.15,.15]);
   for(let y=0;y<25;y++)for(let x=0;x<25;x++)if(Math.abs(x-12)>2||Math.abs(y-12)>2)e.createMesh().setGeometry(geometry).setScale([.025,.025,.025]).setPosition([(x-12)*.15,(y-12)*.15,0]);
   reset();assert(await e.pick(64,64)===target,'First pick before rendering failed');assert(passes===1&&instances<5,'Micro pass did not cull individual shared-geometry instances');assert(sourceSize[0]===3,'Micro pass was not 3x3');
   checks.push({name:'Micro-frustum culling before the first color frame',sceneInstances:e.meshes.size,pickInstances:instances,passes});
   e.render();reset();assert(await e.pick(64,64)===target,'MRT cached pick failed');assert(passes===0&&copies===1,'Cached pick redrew the scene');assert(sourceSize[0]===128,'Cached pick did not read the viewport ID texture');
   checks.push({name:'Forward PBR MRT: slot zero selected with no pick draw calls',passes,copies});
   target.position.x=.3;reset();assert(await e.pick(64,64)===null,'Moved mesh left a stale cached hit');assert(passes===1,'Transform change did not invalidate the cache');
   target.position.x=0;target.visible=false;assert(await e.pick(64,64)===null,'Hidden mesh remained pickable');target.visible=true;e.render();
   e.camera.target=[.3,0,0];reset();await e.pick(64,64);assert(passes===1,'Camera change did not invalidate the cache');e.camera.target=[0,0,0];
   const originalMaterial=target.material;target.setMaterial(new PbrMaterial({doubleSided:false}));reset();await e.pick(64,64);assert(passes===1,'Material change did not invalidate the cache');target.setMaterial(originalMaterial);
   e.render();const pending=e.pick(64,64);await e.pick(64,64).then(()=>{throw new Error('Concurrent pick was accepted');},()=>{});target.dispose();const reused=e.createMesh().setGeometry(geometry);assert(await pending===null,'Disposed slot was returned after reuse');reused.dispose();
   checks.push({name:'Freshness, concurrent readback and stale slot guards'});
   for(const mesh of [...e.meshes.values()])mesh.dispose();
   e.camera.position=[0,0,2];e.camera.target=[0,0,0];e.camera.fov=90;
   const quad=(left,bottom,right,top)=>new Geometry([left,bottom,0,right,bottom,0,right,top,0,left,top,0],Array.from({length:4},()=>[0,0,1]).flat(),[0,1,2,0,2,3]);
   const left=e.createMesh().setGeometry(quad(-.5,-.5,0,.5));e.render();reset();assert(await e.pick(64,64)===left,'Orthogonal silhouette neighbor was missed');assert(passes===0,'Orthogonal resolve missed the MRT path');
   left.setGeometry(quad(-.5,0,0,.5));e.render();assert(await e.pick(64,64)===left,'Diagonal silhouette neighbor was missed');assert(await e.pick(66,66)===null,'Neighborhood expanded beyond one pixel');
   const right=e.createMesh().setGeometry(quad(0,-.5,.5,.5));e.render();assert(await e.pick(64,64)===right,'Neighbor overrode the center ID');right.visible=false;left.visible=false;
   assert(await e.pick(64,64)===null,'Micro pass failed to clear an empty footprint');left.visible=true;
   reset();assert(await e.pick(64,64)===left,'Micro and MRT diagonal resolve disagree');assert(sourceSize[0]===3,'Stale silhouette did not use micro pass');
   checks.push({name:'3x3 center priority, orthogonal and diagonal edges, and bounded tolerance'});
   left.setGeometry(quad(-2,1.5,-1.5,2));e.render();assert(await e.pick(0,0)===left,'Canvas corner missed');assert(lastSize[0]===2&&lastSize[1]===2,'Canvas corner read was not clipped');
   left.setGeometry(quad(-.5,0,0,.5));canvas.style.cssText='width:64px;height:64px';Object.defineProperty(window,'devicePixelRatio',{value:2,configurable:true});e.render();assert(e.canvas.width===128,'DPR resize did not apply');assert(await e.pick(32,32)===left,'CSS/device pixel conversion missed the diagonal');
   checks.push({name:'Clipped canvas corners, DPR conversion and ID-target resize'});
   for(const mesh of [...e.meshes.values()])mesh.dispose();canvas.style.cssText='width:128px;height:128px';Object.defineProperty(window,'devicePixelRatio',{value:1,configurable:true});e.camera.fov=60;e.camera.position=[0,0,4];
   const back=e.createMesh().setGeometry(geometry),front=e.createMesh().setGeometry(geometry).setPosition([0,0,1]);e.render();assert(await e.pick(64,64)===front,'MRT lost depth occlusion');
   const {SectionPlanes}=await import('/packages/machinery/dist/index.js'),planes=[[0,0,-1,0]];e.use(new SectionPlanes({planes,cap:false}));assert(await e.pick(64,64)===back,'Micro pass lost section clipping');planes[0][3]=2;assert(await e.pick(64,64)===front,'Mutable section clipping was stale');e.removePlugin('section-planes');
   const root=e.createMesh().setScale([2,1,.5]);front.setParent(root).setScale([-1,1,1]).setRotation([0,0,.4]);assert(await e.pick(64,64)===front,'Mirrored/sheared hierarchy was culled incorrectly');
   const outline=Selection.attach(e,{algorithm:'morphological'});outline.set([front]);e.render();assert(await e.pick(64,64)===front,'Outline replay corrupted MRT IDs');
   checks.push({name:'Occlusion, mutable section clipping, mirrored/sheared transforms and outline integration'});
   const {StudioShading}=await import('/examples/conveyor-simulator/src/shading.js');e.use(new StudioShading());e.render();reset();assert(await e.pick(64,64)===front&&passes===0,'Conveyor PBR shader did not preserve cached MRT IDs');
   checks.push({name:'Conveyor source shader composes with the MRT attachment'});
   await e.rebootDevice();instrument();assert(await e.pick(64,64)===front,'Picking did not recover before a restored color frame');e.render();reset();assert(await e.pick(64,64)===front&&passes===0,'Restored MRT did not recover');
   checks.push({name:'Device restoration recreates micro targets and cached MRT'});
   await e.gpu.queue.onSubmittedWorkDone();assert(gpuErrors.length===0,JSON.stringify(gpuErrors));picking.dispose();assert(!e.hasPlugin('picking'),'Picking did not detach');assert(await e.pick(64,64)===front,'Core picking stopped working after detachment');
   return {checks,gpuErrors};
  } finally {e.dispose();canvas.remove();}
 });
 assert.deepEqual(errors,[]);await writeFile('test-results/selection-picking.json',JSON.stringify({hardware,...report},null,2));console.log(JSON.stringify({hardware,...report},null,2));
} finally {await browser.close();}
