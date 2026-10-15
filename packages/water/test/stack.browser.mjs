// Water refraction inside a PostStack with SSAO (HANDOFF 5l.q): Water samples the stack's shared HDR capture
// (`stack.sceneTexture`) instead of a standalone Bloom's. Real WebGPU; run under the GPU lock:
// node scripts/gpu-lock.mjs run --owner=<id> -- node packages/water/test/stack.browser.mjs
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../',import.meta.url)));
await mkdir('test-results',{recursive:true});
const browser=await openBrowser({startPath:'/tests/modern-game.html'}),{page,hardware}=browser,errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try{
 const setup=await page.evaluate(async()=>{
  const {EngineKernel,box,PbrMaterial}=await import('/packages/core/dist/index.js'),{Water}=await import('/packages/water/dist/index.js');
  const {PostStack}=await import('/packages/post/dist/stack.js'),{SSAO}=await import('/packages/post/dist/ssao.js'),{Bloom}=await import('/packages/post/dist/bloom.js');
  const canvas=document.createElement('canvas');canvas.style.cssText='width:512px;height:320px';document.body.append(canvas);
  const engine=await EngineKernel.create(canvas,{backend:'webgpu',capacity:16,camera:{position:[0,9,12],target:[0,-1,0],near:0.1,far:120}});
  const mesh=(geometry,color,at)=>engine.createMesh().setGeometry(geometry).setMaterial(new PbrMaterial({color,roughness:0.9})).setPosition(at);
  mesh(box(60,0.2,60),'#808080',[0,-2,0]);              // seabed
  mesh(box(4,1,4),'#ff2020',[0,-1.3,0]);                 // red block, fully under water (top at -0.8)
  mesh(box(6,0.4,6),'#d0d0d0',[-7,0.2,-2]);              // platform above water
  mesh(box(2,2,2),'#d0d0d0',[-7,1.4,-2]);                // cube on it: SSAO darkens the crease
  const ssao=new SSAO({radius:1}),stack=PostStack.attach(engine,[ssao,new Bloom({strength:0,exposure:0})]);
  const sceneColor=()=>stack.sceneTexture;
  const water=Water.attach(engine,{size:[60,60],segments:64,height:0,depth:()=>stack.depthTexture,sceneColor,waves:[{direction:[1,0.3],amplitude:0.02,wavelength:9,steepness:0.05}]});
  engine.gpu.pushErrorScope('validation');
  const frame=async()=>{engine.render({delta:0});await engine.gpu.queue.onSubmittedWorkDone();};
  await frame();
  const project=p=>{const m=engine.camera.matrix,x=m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],y=m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],w=m[3]*p[0]+m[7]*p[1]+m[11]*p[2]+m[15];return [Math.round((x/w*0.5+0.5)*512),Math.round((0.5-y/w*0.5)*320)];};
  window.stackTest={engine,ssao,water,sceneColor,frame};
  const scene=stack.sceneTexture;
  return {red:project([0,-0.8,0]),crease:project([-6,0.45,-1.05]),samples:engine.gpu&&scene?scene.sampleCount:0,format:scene?.format,width:scene?.width};
 });
 assert.equal(setup.format,'rgba16float');assert.equal(setup.width,512);
 const vendor=hardware.webgpu.vendor,shot=async name=>decodePNG(await page.locator('canvas').screenshot({path:`test-results/water-stack-${vendor}-${name}.png`}));
 const refracted=await shot('refraction-ssao');
 await page.evaluate(async()=>{const t=window.stackTest;t.ssao.enabled=false;await t.frame();});
 const noSSAO=await shot('refraction');
 await page.evaluate(async()=>{const t=window.stackTest;t.ssao.enabled=true;t.water.options.sceneColor=undefined;await t.frame();});
 const approximate=await shot('approximate-ssao');
 const validation=await page.evaluate(async()=>{const {engine}=window.stackTest,error=await engine.gpu.popErrorScope();engine.dispose();return error?.message;});
 const mean=(image,[cx,cy],r=6)=>{const sum=[0,0,0];let n=0;for(let y=cy-r;y<=cy+r;y++)for(let x=cx-r;x<=cx+r;x++){const i=(y*image.width+x)*4;for(let c=0;c<3;c++)sum[c]+=image.data[i+c];n++;}return sum.map(v=>v/n);};
 const redness=rgb=>rgb[0]-(rgb[1]+rgb[2])/2;
 const changed=(a,b,inside)=>{let n=0;for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){if(!inside(x,y))continue;const i=(y*a.width+x)*4;if(Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2])>6)n++;}return n;};
 const nearCrease=(x,y)=>Math.abs(x-setup.crease[0])<40&&Math.abs(y-setup.crease[1])<40,nearRed=(x,y)=>Math.abs(x-setup.red[0])<30&&Math.abs(y-setup.red[1])<20;
 const result={hardware,setup,
  redness:{refracted:redness(mean(refracted,setup.red)),approximate:redness(mean(approximate,setup.red))},
  ssaoChangedPixels:{crease:changed(refracted,noSSAO,nearCrease),overRedBlock:changed(refracted,noSSAO,nearRed)},
  validation:validation??null,errors};
 await writeFile(`test-results/water-stack-${vendor}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({vendor,redness:result.redness,ssaoChangedPixels:result.ssaoChangedPixels}));
 assert.equal(validation,undefined);assert.deepEqual(errors,[]);
 assert.ok(result.redness.refracted>result.redness.approximate+20,'refraction shows the red block through the water');
 assert.ok(result.ssaoChangedPixels.crease>20,'SSAO is active in the same frame');
}finally{await browser.close();}
