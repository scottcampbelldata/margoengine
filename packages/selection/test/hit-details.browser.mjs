import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../../',import.meta.url)));
const browser=await openBrowser({port:'free'}), {page}=browser, errors=[];
page.setDefaultTimeout(120000);
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error') errors.push(m.text())});
try {
 await page.waitForFunction(()=>window.modern);
 const report=await page.evaluate(async()=>{
  const {Engine,box}=await import('/packages/core/dist/extension.js');
  const {HitDetails}=await import('/packages/selection/dist/hit-details.js');
  const {loadGLTF}=await import('/packages/gltf-pro/dist/index.js');
  const {Material,createMesh}=await import('/packages/materials/dist/index.js');
  const {CameraProjection}=await import('/packages/cameras/dist/index.js');
  const assert=(ok,m)=>{if(!ok)throw new Error(m)};
  const canvas=document.createElement('canvas');canvas.style.cssText='width:128px;height:128px';document.body.prepend(canvas);
  const e=await Engine.create(canvas,{backend:'webgpu',camera:{position:[0,0,4],target:[0,0,0],fov:60}});
  const gpuErrors=[]; e.gpu.addEventListener('uncapturederror',ev=>gpuErrors.push(ev.error.message));
  const picker=HitDetails.attach(e);
  const mesh=e.createMesh().setGeometry(box());
  const check=async(label,z,uv)=>{
   const hits=await picker.pickMany([[64,64],[65,63],[0,0]]);
   for(const h of hits.slice(0,2)) {
    assert(h && h.position && h.normal && h.uv,label+' missing details');
    assert(Math.abs(h.position[2]-z)<0.00005,label+' wrong depth '+JSON.stringify({position:h.position,normal:h.normal,uv:h.uv}));
    assert(Math.abs(Math.hypot(...h.normal)-1)<0.00001 && h.normal[2]>0.999,label+' wrong normal');
    assert(Math.abs(h.distance-Math.hypot(h.position[0],h.position[1],4-z))<0.00005,label+' wrong distance');
    if(uv) { const scale=/mirrored|orthographic/.test(label)?[-1,2]:[1,1]; const expected=[0.5+h.position[0]/(2*scale[0]),0.5+h.position[1]/(2*scale[1])]; assert(h.uv.every((v,i)=>Math.abs(v-expected[i])<0.00001),label+' wrong UV '+h.uv); }
   }
   assert(hits[2]===null,label+' miss');
  };
  await check('core',0.5,false); mesh.dispose();
  const model=await loadGLTF(e,'/packages/exporters/tests/fixtures/Box.glb');
  await check('real licensed glTF',0.5,false); model.dispose();
  const plane=createMesh(e,{positions:[-1,-1,0,1,-1,0,1,1,0,-1,1,0],normals:[0,0,1,0,0,1,0,0,1,0,0,1],uvs:[0,0,1,0,1,1,0,1],indices:[0,1,2,0,2,3]},new Material({shading:'basic'}));
  await check('UV plane',0,true);
  plane.root.setScale([-1,2,1]); await check('mirrored nonuniform',0,true);
  const projection=CameraProjection.attach(e,{mode:'orthographic',height:4});
  await check('orthographic',0,true);
  const neighbor=await picker.pick(96,64);assert(neighbor&&Math.abs(neighbor.position[0]-0.984375)<0.00001,'neighbor details must follow the winning pixel');
  const controller=new AbortController();controller.abort();let cancelled=false;try{await picker.pick(64,64,undefined,controller.signal)}catch(e){cancelled=e.name==='AbortError'}assert(cancelled,'aborted details query');
  projection.dispose();
  picker.dispose();plane.dispose();e.dispose();
  assert(gpuErrors.length===0,gpuErrors.join('\n'));return {checks:7};
 });
 assert.deepEqual(errors,[]);console.log('hit-details',report);
}finally{await browser.close()}
