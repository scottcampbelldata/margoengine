import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('../../..',import.meta.url)));
import { readFile,writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
// Reuse Margo's real stereo fixture without duplicating its fake platform or changing its original assertions.
const fixture=await readFile('packages/webgl2-compat/test/xr.html','utf8');
const inject=(source,marker,value)=>{assert.ok(source.includes(marker),`Stereo fixture marker disappeared: ${marker}`);return source.replace(marker,value);};
const context=await openBrowser({startPath:'/tests/modern-extension.html',port:'free',compat:false});
const origin=new URL(context.page.url()).origin;
const variants=new Map();
function documentFor(active){
 let html=fixture;
 const source=`{handedness:'left',profiles:[],targetRayMode:'tracked-pointer',targetRaySpace:{},gamepad:{connected:true,axes:[0,0,0,-1],buttons:[]}}`;
 html=inject(html,'inputSources = [];',`inputSources = [${source}];`);
 html=inject(html,'return {};',`return { getOffsetReferenceSpace() {return this;} };`);
 html=inject(html,'({ views: EYES.map(eyeView) })',`({ views:EYES.map(eyeView),transform:eyeView('none').transform })`);
 html=inject(html,'const xr = await XR.create(engine);',`
 const {SmoothLocomotion}=await import('/packages/xr/dist/locomotion.js');
 const {loadGLTF}=await import('/packages/gltf-pro/dist/index.js');
 // Khronos/Cesium Box, CC BY 4.0: existing fixture notice records source and licence.
 const licensed=await loadGLTF(engine,'/packages/exporters/tests/fixtures/Box.glb');
 licensed.root.setPosition([0,1,0]);
 globalThis.XRRigidTransform ??= class {constructor(position,orientation){this.position=position;this.orientation=orientation;}};
 const xr = await XR.create(engine);
`);
 html=inject(html,"await xr.requestSession('immersive-vr');",`await xr.requestSession('immersive-vr');
 const movement=SmoothLocomotion.attach(xr,{vignette:${active},fade:0,fieldOfView:0.4,feather:0.12});`);
 html=inject(html,'await xr.end();' ,'movement.dispose(); await xr.end();');
 return html;
}
try {
 await context.page.route('**/packages/webgl2-compat/test/xr.html*',async route=>{
  const active=new URL(route.request().url()).searchParams.get('comfort')==='on';
  await route.fulfill({status:200,contentType:'text/html',body:documentFor(active)});
 });
 for(const backend of ['native','compat'])for(const route of ['separate','engine'])for(const active of [false,true]){
  const key=`${backend}/${route}/${active}`;
  await context.page.goto(`${origin}/packages/webgl2-compat/test/xr.html?mode=${backend}&route=${route}&comfort=${active?'on':'off'}`);
  await context.page.waitForFunction(()=>window.ready,null,{timeout:60000});
  const result=await context.page.evaluate(()=>window.check);
  assert.deepEqual(result.errors,[],key);assert.equal(result.gl,0,key);
  assert.equal(result.route,route,key);
  variants.set(key,result.eyes.map(s=>Buffer.from(s,'base64')));
 }
 const checks=[];
 for(const backend of ['native','compat'])for(const route of ['separate','engine'])for(let eye=0;eye<2;eye++){
  const base=variants.get(`${backend}/${route}/false`)[eye],masked=variants.get(`${backend}/${route}/true`)[eye];
  let dimmed=0,brightened=0,centerChanged=0;
  for(let y=0;y<256;y++)for(let x=0;x<256;x++){
   const i=(y*256+x)*4;
   const d=Math.max(...[0,1,2].map(c=>base[i+c]-masked[i+c]));
   const b=Math.max(...[0,1,2].map(c=>masked[i+c]-base[i+c]));
   if(d>8)dimmed++;if(b>2)brightened++;
   if(x>=120&&x<136&&y>=120&&y<136&&d>2)centerChanged++;
  }
  assert.ok(dimmed>100,`${backend}/${route}/${eye}: ${dimmed} dimmed pixels`);
  assert.equal(brightened,0,`${backend}/${route}/${eye}: overlay brightened scene`);
  assert.equal(centerChanged,0,`${backend}/${route}/${eye}: central opening must stay clear`);
  checks.push({backend,route,eye,dimmed,brightened,centerChanged});
 }
 await writeFile('test-results/xr-locomotion-browser.json',JSON.stringify({checks},null,2));
 console.log('Stereo locomotion comfort PASS',JSON.stringify(checks));
}finally{await context.close();}
