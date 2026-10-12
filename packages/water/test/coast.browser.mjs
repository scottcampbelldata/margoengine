import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../',import.meta.url)));
await mkdir('test-results',{recursive:true});
const browser=await openBrowser({startPath:'/tests/modern-game.html'}),{page,hardware}=browser,errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try{
 await page.evaluate(async()=>{
  const {EngineKernel,box,PbrMaterial}=await import('/packages/core/dist/index.js'),{Water}=await import('/packages/water/dist/index.js');
  const {Bloom}=await import('/packages/post/dist/index.js'),{TerrainHeightmap}=await import('/packages/terrain/dist/index.js');
  const canvas=document.createElement('canvas');canvas.id='coast-regression';canvas.style.cssText='width:512px;height:320px';document.body.append(canvas);
  const engine=await EngineKernel.create(canvas,{backend:'webgpu',capacity:16,camera:{position:[0,3,30],target:[0,0,70],near:0.1,far:80}});
  const post=Bloom.attach(engine,{strength:0,exposure:0});
  let sloped=false;const terrain=TerrainHeightmap.attach(engine,x=>sloped?-1.2-x*0.15:-3,{size:[80,80],resolution:64});
  let source='';const create=engine.gpu.createShaderModule.bind(engine.gpu);
  engine.gpu.createShaderModule=descriptor=>{if(descriptor.code.includes('fn coastBlend'))source=descriptor.code;return create(descriptor);};
  const createScene=()=>engine.gpu.createTexture({size:[512,320],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  let scene=createScene();
  const water=Water.attach(engine,{size:[160,160],segments:128,horizon:true,terrain:{heightmap:()=>terrain.texture,origin:[-40,-40],size:[80,80]},depth:()=>post.depthTexture,sceneColor:()=>scene,waves:[{direction:[1,0.37],amplitude:0.35,wavelength:17.37,steepness:0.3,phase:0.43}]});
  engine.gpu.pushErrorScope('validation');engine.render({delta:0});await engine.gpu.queue.onSubmittedWorkDone();engine.gpu.createShaderModule=create;
  async function probe(custom){
   const points=[];
   for(const [axis,sign] of [[0,-1],[0,1],[1,-1],[1,1]])for(const d of [-0.0001,0.0001]){const p=[7,7,Math.hypot(1.25,1.25),0];p[axis]=sign*(40+d);points.push(p);}
   for(const [x,z] of [[37.5,7],[37.499,7],[37.501,7],[37.5,6.999],[37.5,7.001],[0,0],[10000,0]])points.push([x,z,Math.hypot(1.25,1.25),0]);
   points[points.length-1][2]=1000;
   if(custom){points.splice(0,points.length,...custom);}
   const device=engine.gpu,data=new Float32Array(points.flat()),queries=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
   const results=device.createBuffer({size:points.length*32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=device.createBuffer({size:results.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
   try{
    device.queue.writeBuffer(queries,0,data);
    const module=device.createShaderModule({code:source+`
@group(0) @binding(8) var<storage,read> queries:array<vec4f>;
@group(0) @binding(9) var<storage,read_write> results:array<vec4f>;
@compute @workgroup_size(32) fn probe(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&queries)){return;}let q=queries[id.x];
 if(q.w>2){let v=vec3f(-cos(q.x)*cos(q.y),sin(q.y),-sin(q.x)*cos(q.y));results[id.x*2u]=vec4f(directionalGlint(frame.lights[0],vec3f(0,1,0),v,0.12),1);results[id.x*2u+1u]=vec4f(directionalGlint(frame.lights[1],vec3f(0,1,0),v,0.12),1);return;}
 if(q.w>1){results[id.x*2u]=vec4f(fresnel(q.x),0,0,1);results[id.x*2u+1u]=vec4f(reflectionRay(vec3f(1,q.y,0.5)),1);return;}
 if(q.w>0){results[id.x*2u]=vec4f(noise(q.xy),0);results[id.x*2u+1u]=vec4f(0);return;}
 let v=surface(q.xy,q.z);
 results[id.x*2u]=vec4f(v.position,v.crest);results[id.x*2u+1u]=vec4f(v.normal,1);
}`});
    const pipeline=device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'probe'}});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:water.uniform}},{binding:3,resource:water.coastal.views[water.coastal.current]},{binding:7,resource:{buffer:water.coastal.connected}},{binding:8,resource:{buffer:queries}},{binding:9,resource:{buffer:results}}]});
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(points.length/32));pass.end();encoder.copyBufferToBuffer(results,0,read,0,results.size);device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();return points.map((_,i)=>({position:values.slice(i*8,i*8+3),normal:values.slice(i*8+4,i*8+7)}));
   }finally{queries.destroy();results.destroy();read.destroy();}
  }
  async function background(blue){
   const encoder=engine.gpu.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:scene.createView(),loadOp:'clear',storeOp:'store',clearValue:{r:blue?0:1,g:0,b:blue?1:0,a:1}}]});pass.end();engine.gpu.queue.submit([encoder.finish()]);engine.render({delta:0});await engine.gpu.queue.onSubmittedWorkDone();
  }
  window.coastTest={engine,water,probe,background,async slope(value){sloped=value;terrain.onDeviceRestored(water.engine);engine.render({delta:0});await engine.gpu.queue.onSubmittedWorkDone();},addBottom(){engine.createMesh().setGeometry(box(80,0.1,80)).setMaterial(new PbrMaterial({color:'#ffffff'})).position.y=-3;},async restore(){scene.destroy();await engine.rebootDevice();scene=createScene();engine.gpu.pushErrorScope('validation');await background(false);},async validation(){return (await engine.gpu.popErrorScope())?.message;},dispose(){scene.destroy();engine.dispose();}};
 });
 const samples=await page.evaluate(()=>window.coastTest.probe());
 for(let i=0;i<8;i+=2){assert.ok(Math.hypot(...samples[i].position.map((v,j)=>v-samples[i+1].position[j]))<0.001,'Coastal edge tears offshore');assert.ok(samples[i].normal.reduce((sum,v,j)=>sum+v*samples[i+1].normal[j],0)>0.9999,'Coastal normals jump at the map edge');}
 const tangent=samples[10].position.map((v,i)=>v-samples[9].position[i]),binormal=samples[12].position.map((v,i)=>v-samples[11].position[i]);
 const normal=[binormal[1]*tangent[2]-binormal[2]*tangent[1],binormal[2]*tangent[0]-binormal[0]*tangent[2],binormal[0]*tangent[1]-binormal[1]*tangent[0]],length=Math.hypot(...normal);
 assert.ok(normal.reduce((sum,v,i)=>sum+v/length*samples[8].normal[i],0)>0.999,'Transition shading disagrees with its displaced surface');
 assert.ok(Math.abs(samples[13].position[1])>0.01,'Connected ocean inside the terrain map is flat');assert.ok(Math.abs(samples[14].position[1])<1e-6,'Coarse horizon geometry retains unresolved waves');
 const wind=[1,0.37],windLength=Math.hypot(...wind),points=Array.from({length:48},(_,i)=>[65-wind[1]/windLength*i,65+wind[0]/windLength*i,0.1,0]);
 const crests=await page.evaluate(points=>window.coastTest.probe(points),points),heights=crests.map(s=>s.position[1]);
 assert.ok(Math.max(...heights)-Math.min(...heights)>0.15,'Swell crests remain straight across the wind');
 const offshorePoints=[[66,57],[65.99,57],[66.01,57],[66,56.99],[66,57.01]].map(p=>[...p,0.1,0]);
 const curved=await page.evaluate(points=>window.coastTest.probe(points),offshorePoints);
 const dx=curved[2].position.map((v,i)=>v-curved[1].position[i]),dz=curved[4].position.map((v,i)=>v-curved[3].position[i]);
 const curvedNormal=[dz[1]*dx[2]-dz[2]*dx[1],dz[2]*dx[0]-dz[0]*dx[2],dz[0]*dx[1]-dz[1]*dx[0]],curvedLength=Math.hypot(...curvedNormal);
 assert.ok(curvedNormal.reduce((sum,v,i)=>sum+v/curvedLength*curved[0].normal[i],0)>0.9999,'Curved swell normals disagree with displacement');
 await page.evaluate(()=>window.coastTest.slope(true));
 const slopePoints=[[1,7],[0.99,7],[1.01,7],[1,6.99],[1,7.01]].map(p=>[...p,0.1,0]),sloped=await page.evaluate(points=>window.coastTest.probe(points),slopePoints);
 const sx=sloped[2].position.map((v,i)=>v-sloped[1].position[i]),sz=sloped[4].position.map((v,i)=>v-sloped[3].position[i]);
 const shoreNormal=[sz[1]*sx[2]-sz[2]*sx[1],sz[2]*sx[0]-sz[0]*sx[2],sz[0]*sx[1]-sz[1]*sx[0]],shoreLength=Math.hypot(...shoreNormal);
 assert.ok(shoreNormal.reduce((sum,v,i)=>sum+v/shoreLength*sloped[0].normal[i],0)>0.9999,'Depth-based shore blend normals disagree with displacement');
 await page.evaluate(()=>window.coastTest.slope(false));
 const noisePoints=[[1.31,-2.46],[1.3,-2.46],[1.32,-2.46],[1.31,-2.47],[1.31,-2.45]].map(p=>[...p,0.1,1]);
 const ripple=await page.evaluate(points=>window.coastTest.probe(points),noisePoints);
 assert.ok(Math.abs((ripple[2].position[0]-ripple[1].position[0])/0.02-ripple[0].position[1])<0.001,'Ripple X gradient disagrees with its height field');
 assert.ok(Math.abs((ripple[4].position[0]-ripple[3].position[0])/0.02-ripple[0].position[2])<0.001,'Ripple Z gradient disagrees with its height field');
 await page.evaluate(async()=>{const {water,engine}=window.coastTest;water.setWaveHeight(0.99/(water.values[36]*water.values[35]));engine.render({delta:0});await engine.gpu.queue.onSubmittedWorkDone();});
 const steepPoints=[];for(let z=0;z<4;z++)for(let x=0;x<4;x++)for(const [dx,dz] of [[-0.01,0],[0.01,0],[0,-0.01],[0,0.01]])steepPoints.push([66+x*4+dx,57+z*4+dz,0.1,0]);
 const steep=await page.evaluate(points=>window.coastTest.probe(points),steepPoints);
 for(let i=0;i<steep.length;i+=4){const dx=steep[i+1].position.map((v,j)=>(v-steep[i].position[j])/0.02),dz=steep[i+3].position.map((v,j)=>(v-steep[i+2].position[j])/0.02);assert.ok(dx[0]*dz[2]-dx[2]*dz[0]>0,'Curved wave spectrum folds at an accepted height');}
 await page.evaluate(async()=>{const {water,engine}=window.coastTest;water.setWaveHeight(0);engine.render({delta:0});await engine.gpu.queue.onSubmittedWorkDone();});
 const flat=await page.evaluate(points=>window.coastTest.probe(points),points);for(const sample of flat){assert.equal(sample.position[1],0);assert.deepEqual(sample.normal,[0,1,0]);}
 await page.evaluate(async()=>{const {water,engine}=window.coastTest;water.setWaveHeight(0.35);engine.render({delta:0});await engine.gpu.queue.onSubmittedWorkDone();});
 const image=async(blue,label)=>{await page.evaluate(blue=>window.coastTest.background(blue),blue);return decodePNG(await page.locator('#coast-regression').screenshot({path:`test-results/water-coast-${hardware.webgpu.vendor}-${label}.png`}));};
 const red=await image(false,'red-sky'),blue=await image(true,'blue-sky');
 const difference=(a,b)=>{let pixels=0;for(let i=0;i<a.data.length;i+=4)if(Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2])>3)pixels++;return pixels;};
 assert.equal(difference(red,blue),0,'Clear-depth sky pixels tint the seabed');
 await page.evaluate(()=>window.coastTest.addBottom());const bottomRed=await image(false,'red-bottom'),bottomBlue=await image(true,'blue-bottom'),refractedPixels=difference(bottomRed,bottomBlue);
 assert.ok(refractedPixels>100,'Valid submerged geometry lost screen refraction');assert.equal(await page.evaluate(()=>window.coastTest.validation()),undefined);
 await page.evaluate(()=>window.coastTest.restore());assert.deepEqual(await page.evaluate(()=>window.coastTest.probe()),samples);
 assert.equal(await page.evaluate(()=>window.coastTest.validation()),undefined);assert.deepEqual(errors,[]);
 const optics=await page.evaluate(()=>window.coastTest.probe([[1.00000012,-0.8,0,2],[-0.00000012,-0.01,0,2],[0.5,0.8,0,2]]));
 assert.ok(Math.abs(optics[0].position[0]-0.02)<1e-6,'Fresnel roundoff exceeded one');assert.equal(optics[1].position[0],1);assert.ok(Math.abs(optics[2].position[0]-0.050625)<1e-6);
 for(const sample of optics){assert.ok(sample.position.every(Number.isFinite)&&sample.normal.every(Number.isFinite));assert.ok(sample.normal[1]>0,'Open-water reflection sampled ground');}
 const alignment=[];
 for(const intensity of [[1,0],[0.25,0.75],[0,1]]){
  await page.evaluate(async intensity=>{const {water,engine}=window.coastTest;water.options.lights=[[-0.45,0.22],[0.55,0.36]].map(([azimuth,elevation],i)=>({direction:[Math.cos(azimuth)*Math.cos(elevation),Math.sin(elevation),Math.sin(azimuth)*Math.cos(elevation),intensity[i]],radiance:[1,1,1]}));engine.render({delta:0});await engine.gpu.queue.onSubmittedWorkDone();},intensity);
  for(let light=0;light<2;light++){
   const azimuth=light?0.55:-0.45,elevation=light?0.36:0.22,angles=Array.from({length:201},(_,i)=>azimuth-0.5+i*0.005);
   const values=await page.evaluate(points=>window.coastTest.probe(points),angles.map(angle=>[angle,elevation,0,3]));
   const glints=values.map(v=>(light?v.normal:v.position)[0]);assert.ok(glints.every(v=>Number.isFinite(v)&&v>=0));
   if(intensity[light]===0){assert.ok(glints.every(v=>v===0));continue;}
   const peak=glints.indexOf(Math.max(...glints));assert.ok(Math.abs(angles[peak]-azimuth)<0.006,'Reflection drifts away from its light as dusk intensity changes');alignment.push({intensity,light,azimuth,peak:angles[peak]});
  }
 }
 assert.deepEqual(errors,[]);
 const report={hardware,refractedPixels,samples,optics,alignment,crestHeightRange:Math.max(...heights)-Math.min(...heights),errors};await writeFile(`test-results/water-coast-${hardware.webgpu.vendor}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({vendor:hardware.webgpu.vendor,refractedPixels,checks:['Four continuous coastal edges','Depth-based shore blend normals','Curved crests across the wind','Analytical curved swell normals','Ripple height-field gradients','No folds near the accepted height limit','Zero amplitude flattens the spectrum','Ocean waves continue inside the map','Coarse horizon waves filtered','Sky rejected as seabed','Submerged refraction retained','Device restoration','Fresnel roundoff remains finite','Open-water reflection stays above the horizon','Sun/moon reflection alignment through changing intensities']}));
}finally{await page.evaluate(()=>window.coastTest?.dispose());await browser.close();}
