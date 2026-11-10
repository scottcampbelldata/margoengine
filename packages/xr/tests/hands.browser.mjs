import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {openBrowser} from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..',import.meta.url)));
const fixture=await readFile('packages/webgl2-compat/test/xr.html','utf8');
const replace=(s,from,to)=>{assert.ok(s.includes(from),from);return s.replace(from,to);};
function documentFor(moved){let s=fixture;
 s=replace(s,"const mode =",`import {HAND_JOINT_NAMES,SkinnedHands} from '/packages/xr/dist/hands.js';
 import {loadGLTF} from '/packages/gltf-pro/dist/index.js';
 const jointPoses=new Map();
 const mode =`);
 s=replace(s,'inputSources = [];',`inputSources = ['left','right'].map(handedness=>({handedness,profiles:['generic-hand'],targetRayMode:'tracked-pointer',targetRaySpace:{},hand:new Map(HAND_JOINT_NAMES.map(name=>[name,{handedness,name}]))}));`);
 s=replace(s,'getPose: () => null','getPose: () => null, getJointPose: space => ({transform:{matrix:jointPoses.get(space.handedness+space.name)},radius:0.008})');
 s=replace(s,'const xr = await XR.create(engine);',`const models={left:await loadGLTF(engine,'/packages/xr/tests/fixtures/hands/left.glb'),right:await loadGLTF(engine,'/packages/xr/tests/fixtures/hands/right.glb')};
 engine.render({delta:0});
 for(const handedness of ['left','right'])for(const name of HAND_JOINT_NAMES){
 const model=models[handedness],node=model.nodes[model.asset.doc.nodes.findIndex(node=>node.name===name)],m=new Float32Array(node.matrix);
 m[12]+=(handedness==='left'?-.25:.25)+${moved?.18:0};m[13]+=1;m[14]+=3.5;
 jointPoses.set(handedness+name,m);}
 const xr = await XR.create(engine);
 const hands=await SkinnedHands.create(xr,models);`);
 s=replace(s,'const pixels =', 'await xr.device.queue.onSubmittedWorkDone(); const pixels =');
 s=replace(s,'await xr.end();','hands.dispose(); await xr.end();');return s;}
const browser=await openBrowser({startPath:'/tests/modern-extension.html',port:'free',compat:false});
const origin=new URL(browser.page.url()).origin,results=new Map();
try{await browser.page.route('**/packages/webgl2-compat/test/xr.html*',async route=>route.fulfill({status:200,contentType:'text/html',body:documentFor(new URL(route.request().url()).searchParams.get('moved')==='1')}));
 for(const backend of ['native','compat'])for(const route of ['separate','engine'])for(const moved of [0,1]){
 const key=`${backend}/${route}/${moved}`;await browser.page.goto(`${origin}/packages/webgl2-compat/test/xr.html?mode=${backend}&route=${route}&moved=${moved}`);
 await browser.page.waitForFunction(()=>window.ready,null,{timeout:60000});const result=await browser.page.evaluate(()=>window.check);assert.deepEqual(result.errors,[],key);assert.equal(result.gl,0,key);results.set(key,result.eyes.map(eye=>Buffer.from(eye,'base64')));
 }
 const checks=[];for(const backend of ['native','compat'])for(const route of ['separate','engine'])for(let eye=0;eye<2;eye++){
 const a=results.get(`${backend}/${route}/0`)[eye],b=results.get(`${backend}/${route}/1`)[eye];let different=0;
 for(let i=0;i<a.length;i+=4)if(Math.max(...[0,1,2].map(c=>Math.abs(a[i+c]-b[i+c])))>8)different++;
 assert.ok(different>20,`${backend}/${route}/${eye}: moving skin changed only ${different} pixels`);checks.push({backend,route,eye,different});}
 await writeFile('test-results/xr-hands-browser.json',JSON.stringify({checks},null,2));console.log('Skinned hand stereo PASS',JSON.stringify(checks));
}finally{await browser.close();}
