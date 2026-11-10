import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
import {openBrowser} from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..',import.meta.url)));
const fixture=await readFile('packages/webgl2-compat/test/xr.html','utf8');
const replace=(s,from,to)=>{assert.ok(s.includes(from),from);return s.replace(from,to);};
function documentFor(moved){let s=fixture;
 s=replace(s,'const mode =',`import {MeshDetection,ImageTracking,DOMOverlay,PersistentAnchors,domOverlaySessionOptions,imageTrackingSessionOptions} from '/packages/xr/dist/ar-extra.js';
 import {loadGLTF} from '/packages/gltf-pro/dist/index.js';
 const matrix=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,${moved?.6:0},1,2,1]);let detected;
 const mode =`);
 s=replace(s,'getPose: () => null','getPose: () => ({transform:{matrix}}),detectedMeshes:new Set([detected]),getImageTrackingResults:()=>[{index:0,imageSpace:{},trackingState:"tracked",measuredWidthInMeters:.2}]');
 s=replace(s,'const xr = await XR.create(engine);',`const licensed=await loadGLTF(engine,'/packages/exporters/tests/fixtures/Box.glb');licensed.root.visible=false;
 const primitive=licensed.primitives[0],vertices=new Float32Array(primitive.vertices.length/20*3);
 for(let i=0;i<vertices.length/3;i++)vertices.set(primitive.vertices.subarray(i*20,i*20+3),i*3);
 detected={meshSpace:{},vertices,indices:primitive.indices,lastChangedTime:1,semanticLabel:'box'};
 const xr = await XR.create(engine);`);
 s=replace(s,"await xr.requestSession('immersive-vr');",`const overlayRoot=document.createElement('div');document.body.append(overlayRoot);
 const bitmap=await createImageBitmap(new ImageData(new Uint8ClampedArray([255,255,255,255]),1,1));
 await xr.requestSession('immersive-ar',imageTrackingSessionOptions([{image:bitmap,widthInMeters:.2}],{},domOverlaySessionOptions(overlayRoot,{requiredFeatures:['mesh-detection','anchors']})));
 session.enabledFeatures=session.features;session.domOverlayState={type:'screen'};session.getImageTrackability=async()=>['trackable'];
 session.persistentAnchors=[];session.restorePersistentAnchor=async()=>({anchorSpace:{},delete(){}});session.deletePersistentAnchor=async handle=>{session.persistentAnchors=session.persistentAnchors.filter(x=>x!==handle);};
 const persistent=PersistentAnchors.attach(xr),saved=await persistent.save({async requestPersistentHandle(){session.persistentAnchors.push('box-anchor');return 'box-anchor';}});
 if(saved!=='box-anchor'||!(await persistent.restore(saved)).anchorSpace)throw new Error('persistent anchor round trip');await persistent.delete(saved);if(persistent.handles.length)throw new Error('persistent anchor deletion');
 const overlay=DOMOverlay.attach(xr,overlayRoot),event=new Event('beforexrselect',{cancelable:true});overlayRoot.dispatchEvent(event);if(!event.defaultPrevented)throw new Error('DOM overlay did not stop world select');
 const images=ImageTracking.attach(xr);if((await images.trackability())[0]!=='trackable')throw new Error('image trackability');
 const meshes=await MeshDetection.create(xr,{show:{engine,material:new PbrMaterial({color:'#ee6633'})}});`);
 s=replace(s,'const pixels =',`{const attached=session.frames;while(session.frames<attached+3)await new Promise(r=>setTimeout(r,5));}// The observers attach after the fixture's own three-frame wait has often passed: give them three frames of their own.
 await xr.device.queue.onSubmittedWorkDone();if(meshes.meshes.size!==1||images.images.size!==1)throw new Error('missing AR observations');
 const pixels =`);
 s=replace(s,'await xr.end();','meshes.dispose();images.dispose();overlay.dispose();persistent.dispose();bitmap.close();overlayRoot.remove(); await xr.end();');return s;}
const browser=await openBrowser({startPath:'/tests/modern-extension.html',port:'free',compat:false}),origin=new URL(browser.page.url()).origin,results=new Map();
try{await browser.page.route('**/packages/webgl2-compat/test/xr.html*',async route=>route.fulfill({status:200,contentType:'text/html',body:documentFor(new URL(route.request().url()).searchParams.get('moved')==='1')}));
 for(const backend of ['native','compat'])for(const route of ['separate','engine'])for(const moved of [0,1]){
 const key=`${backend}/${route}/${moved}`;await browser.page.goto(`${origin}/packages/webgl2-compat/test/xr.html?mode=${backend}&route=${route}&moved=${moved}`);await browser.page.waitForFunction(()=>window.ready,null,{timeout:60000});const result=await browser.page.evaluate(()=>window.check);assert.deepEqual(result.errors,[],key);assert.equal(result.gl,0,key);results.set(key,result.eyes.map(eye=>Buffer.from(eye,'base64')));
 }
 const checks=[];for(const backend of ['native','compat'])for(const route of ['separate','engine'])for(let eye=0;eye<2;eye++){
 const a=results.get(`${backend}/${route}/0`)[eye],b=results.get(`${backend}/${route}/1`)[eye];let different=0;for(let i=0;i<a.length;i+=4)if(Math.max(...[0,1,2].map(c=>Math.abs(a[i+c]-b[i+c])))>8)different++;
 assert.ok(different>100,`${backend}/${route}/${eye}: detected mesh pose changed only ${different} pixels`);checks.push({backend,route,eye,different});}
 await writeFile('test-results/xr-ar-extra-browser.json',JSON.stringify({checks},null,2));console.log('AR extras stereo PASS',JSON.stringify(checks));
}finally{await browser.close();}
