import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { pbrNeutral } from '../../shared/display.js';
const truth=JSON.parse(await readFile(new URL('./fixtures/nodes-truth.json',import.meta.url)));
const pingPongTruth=JSON.parse(await readFile(new URL('./fixtures/pingpong-truth.json',import.meta.url)));
const browser=await openBrowser({port:'free',startPath:'/tests/modern-extension.html'}), errors=[];
browser.page.on('pageerror',e=>errors.push(e.message));
browser.page.on('console',m=>{if(m.text().startsWith('nodes-test:'))console.log(m.text());});
try {
 const result=await browser.page.evaluate(async(pingPongTruth)=>{
  const {Engine}=await import('/packages/core/dist/index.js');
  const {loadMargoNodes,MargoNodeMaterial}=await import('/packages/blender/dist/nodes.js');
  const {decodeMargo}=await import('/packages/blender/dist/index.js');
  const {waitForPipelines}=await import('/scripts/support/gpu-ready.js');
  const canvas=document.createElement('canvas');canvas.style.cssText='width:128px;height:128px';document.body.append(canvas);
  const engine=await Engine.create(canvas,{backend:'webgpu',capacity:16,camera:{position:[0,4,.001],target:[0,0,0]}});
  engine.camera.up=[0,0,-1];engine.lighting.direction=[0,1,0,0];engine.lighting.radiance=[0,0,0,0];engine.lighting.ambient=[0,0,0];
  console.log('nodes-test: engine ready');engine.gpu.pushErrorScope('validation');
  const loaded=await loadMargoNodes(engine,'/packages/blender/tests/fixtures/nodes.margo');
  const render=async()=>{await waitForPipelines(async()=>{engine.render({culling:false});await engine.gpu.queue.onSubmittedWorkDone();});return canvas.toDataURL();};
  console.log('nodes-test: loaded');const frames=[];for(const t of [0,.5,1,0]){loaded.seek(t);frames.push(await render());}
  const material=[...loaded.materials.values()][0],code=material.extension.wgsl,factors=material.extension.factors;
  material.set('Amount/outputs/0',.5);const overridden=await render();
  const stable=code===material.extension.wgsl&&factors===material.extension.factors;
  const graph=decodeMargo(await(await fetch('/packages/blender/tests/fixtures/nodes.margo')).arrayBuffer()).document.materials[0].extras['margo:nodes'];
  // Compile every scalar Math operation and RGB blend, all ramp interpolations/color spaces and noise dimensions.
  const math=['ADD','SUBTRACT','MULTIPLY','DIVIDE','MULTIPLY_ADD','POWER','LOGARITHM','SQRT','INVERSE_SQRT','ABSOLUTE','EXPONENT','MINIMUM','MAXIMUM','LESS_THAN','GREATER_THAN','SIGN','COMPARE','SMOOTH_MIN','SMOOTH_MAX','ROUND','FLOOR','CEIL','TRUNC','FRACT','MODULO','FLOORED_MODULO','WRAP','SNAP','PINGPONG','SINE','COSINE','TANGENT','ARCSINE','ARCCOSINE','ARCTANGENT','ARCTAN2','SINH','COSH','TANH','RADIANS','DEGREES'];
  const blends=['MIX','ADD','MULTIPLY','SUBTRACT','SCREEN','DIVIDE','DIFFERENCE','EXCLUSION','DARKEN','LIGHTEN','OVERLAY','DODGE','BURN','HUE','SATURATION','VALUE','COLOR','SOFT_LIGHT','LINEAR_LIGHT'];
  const primitive=loaded.model.primitives[0];
  const g={version:1,bounds:graph.bounds,parameters:{a:{value:[.4]},b:{value:[.7]},c:{value:[.2]},index:{value:[0]}},surface:{},nodes:[]};
  for(const operation of math)g.nodes.push({name:operation,op:'math',operation,type:'float',inputs:['a','b','c'].map(parameter=>({parameter}))});
  const all=new MargoNodeMaterial(g);
  all.extension.output=`var results=array<f32,${math.length}>(${math.map((_,i)=>`bn${i}.x`).join(',')});color=vec3f(results[u32(materialFactors[3].x)]*0.01+0.5);`;
  primitive.extension=all.extension;
  const mathFrames=[];for(let i=0;i<math.length;i++){all.set('index',i);mathFrames.push(await render());}
  all.set('a',20).set('b',0);
  const zeroFrames=[];for(const operation of ['DIVIDE','MODULO','FLOORED_MODULO','SNAP']){all.set('index',math.indexOf(operation));zeroFrames.push(await render());}
  const ping=new MargoNodeMaterial({...g,nodes:[g.nodes[math.indexOf('PINGPONG')]]});
  ping.extension.output='color=vec3f(bn0.x/16.0+0.125);';primitive.extension=ping.extension;
  const pingFrames=[];for(const [a,b] of pingPongTruth){ping.set('a',a).set('b',b);pingFrames.push(await render());}
  // HSV blends with a grey on the hue side: a grey has no hue, so HUE and COLOR keep a and SATURATION keeps a grey a.
  const hsvCases=[['HUE',[.2,.6,.2],[.5,.5,.5]],['COLOR',[.2,.6,.2],[.3,.3,.3]],['SATURATION',[.5,.5,.5],[.8,.2,.2]],['HUE',[.2,.6,.2],[.2,.2,.8]]],hsvFrames=[];
  for(const [blend,ca,cb] of hsvCases){
   const hsv=new MargoNodeMaterial({version:1,bounds:graph.bounds,parameters:{f:{value:[1]},ca:{value:[...ca,1]},cb:{value:[...cb,1]}},surface:{},nodes:[{name:'Mix',op:'mix',mode:'RGBA',type:'color',blend,inputs:[{parameter:'f'},{parameter:'ca'},{parameter:'cb'}]}]});
   hsv.extension.output='color=bn0.xyz;';primitive.extension=hsv.extension;hsvFrames.push(await render());
  }
  console.log('nodes-test: math rendered');const variants=[];
  for(const blend of blends){const g=structuredClone(graph);g.nodes.find(n=>n.op==='mix').blend=blend;variants.push(g);}
  for(const mode of ['FLOAT','VECTOR']){const g=structuredClone(graph);Object.assign(g.nodes.find(n=>n.op==='mix'),{mode,type:mode==='FLOAT'?'float':'vector'});variants.push(g);}
  for(const interpolation of ['CONSTANT','LINEAR','EASE','CARDINAL','B_SPLINE'])for(const colorMode of ['RGB','HSV','HSL']){const g=structuredClone(graph);Object.assign(g.nodes.find(n=>n.op==='ramp'),{interpolation,colorMode});variants.push(g);}
  const noiseFrames=[];
  for(const dimensions of [1,2,3,4])for(const noiseType of ['FBM','MULTIFRACTAL','RIDGED_MULTIFRACTAL','HYBRID_MULTIFRACTAL','HETERO_TERRAIN']){
   const g=structuredClone(graph);const n=g.nodes.find(n=>n.op==='noise');Object.assign(n,{dimensions,noiseType});
   // Render noise directly to exercise actual octave evaluation rather than just parsing its function.
   g.surface={emission:{link:g.nodes.indexOf(n)}};
   variants.push(g);
  }
  for(const [index,g] of variants.entries()){console.log('nodes-test: variant '+index);const m=new MargoNodeMaterial(g);primitive.extension=m.extension;const image=await render();if(g.surface.emission?.link===g.nodes.findIndex(n=>n.op==='noise'))noiseFrames.push(image);}
  const noiseGraph=structuredClone(graph),noiseIndex=noiseGraph.nodes.findIndex(n=>n.op==='noise');noiseGraph.surface={emission:{link:noiseIndex}};
  const noisy=new MargoNodeMaterial(noiseGraph);primitive.extension=noisy.extension;
  const beforeNoise=await render();noisy.set('Live Noise/inputs/1',.89);const afterNoise=await render();noisy.set('Live Noise/inputs/1',.13);const resetNoise=await render();
  const rampGraph=structuredClone(graph),rampIndex=rampGraph.nodes.findIndex(n=>n.op==='ramp');rampGraph.surface={emission:{link:rampIndex}};
  const crossing=new MargoNodeMaterial(rampGraph),stops=rampGraph.nodes[rampIndex].stops;crossing.set('Amount/outputs/0',.5).set(stops[0][0].parameter,1).set(stops[1][0].parameter,0);primitive.extension=crossing.extension;
  const crossedRamp=await render();
  const coordinates={version:1,parameters:{},bounds:[[-2,-2,0],[2,2,0]],nodes:[{name:'Generated',op:'generated',type:'vector',inputs:[]}],surface:{emission:{link:0}}};
  primitive.extension=new MargoNodeMaterial(coordinates).extension;const metres=await render();
  coordinates.bounds=[[-1,-1,0],[1,1,0]];coordinates.unitScale=2;primitive.extension=new MargoNodeMaterial(coordinates).extension;const units=await render();
  console.log('nodes-test: render checks finished');const validation=(await engine.gpu.popErrorScope())?.message??null;
  loaded.dispose();loaded.dispose();const remaining=engine.meshes.size;engine.dispose();canvas.remove();
  return {hsvFrames,frames,overridden,stable,mathFrames,zeroFrames,pingFrames,math,variants:variants.length,noiseFrames,beforeNoise,afterNoise,resetNoise,crossedRamp,metres,units,validation,remaining};
 },pingPongTruth);
 const png=async url=>decodePNG(Buffer.from(url.split(',')[1],'base64'));
 const center=async url=>{const p=await png(url);return [...p.data.subarray((64*p.width+64)*4,(64*p.width+64)*4+3)];};
 const encoded=color=>pbrNeutral(color).map(v=>Math.round(255*(v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055)));
 const centers=await Promise.all(result.frames.map(center));
 for(let i=0;i<3;i++){
  const expected=encoded(truth[i].color);for(let c=0;c<3;c++)assert.ok(Math.abs(centers[i][c]-expected[c])<=2,`Cycles oracle frame ${i} channel ${c}: ${centers[i]} vs ${expected}`);
 }
 assert.deepEqual(centers[3],centers[0]);assert.deepEqual(await center(result.overridden),centers[1]);assert.equal(result.stable,true);
 const a=.4,b=.7,c=.2,div=(a,b)=>b===0?0:a/b,wrap=(a,hi,lo)=>a-(hi-lo)*Math.floor((a-lo)/(hi-lo));
 const smooth=(a,b,k)=>Math.min(a,b)-Math.max(k-Math.abs(a-b),0)**3/k**2/6;
 const expected=[a+b,a-b,a*b,a/b,a*b+c,a**b,Math.log(a)/Math.log(b),Math.sqrt(a),1/Math.sqrt(a),Math.abs(a),Math.exp(a),Math.min(a,b),Math.max(a,b),1,0,1,0,smooth(a,b,c),-smooth(-a,-b,c),Math.floor(a+.5),Math.floor(a),Math.ceil(a),Math.trunc(a),a%1,a-Math.trunc(a/b)*b,a-Math.floor(a/b)*b,wrap(a,b,c),Math.floor(div(a,b))*b,b-Math.abs(wrap(a,2*b,0)-b),Math.sin(a),Math.cos(a),Math.tan(a),Math.asin(a),Math.acos(a),Math.atan(a),Math.atan2(a,b),Math.sinh(a),Math.cosh(a),Math.tanh(a),a*Math.PI/180,a*180/Math.PI];
 for(let i=0;i<expected.length;i++){const actual=(await center(result.mathFrames[i]))[0],want=Math.round((expected[i]*.01+.5)*255);assert.ok(Math.abs(actual-want)<=1,`${result.math[i]} ${actual} vs ${want}`);}
 // Grey hue side: unchanged a (Blender's mix keeps it); a coloured b still lends its hue (blue onto green).
 for(const [i,want] of [[.2,.6,.2],[.2,.6,.2],[.5,.5,.5],[.2,.2,.6]].entries()){
  const got=await center(result.hsvFrames[i]);
  for(let k=0;k<3;k++)assert.ok(Math.abs(got[k]-Math.round(want[k]*255))<=1,`HSV blend case ${i}: ${got} vs ${want.map(v=>Math.round(v*255))}`);
 }
 for(const frame of result.zeroFrames)assert.ok(Math.abs((await center(frame))[0]-128)<=1,'divide/modulo/floored-modulo/snap by zero must return zero');
 for(const [i,[a,b,value]] of pingPongTruth.entries()){
  const actual=(await center(result.pingFrames[i]))[0],want=Math.round((value/16+.125)*255);
  assert.ok(Math.abs(actual-want)<=1,`Ping-Pong(${a},${b}): ${actual} vs ${want}, Blender value ${value}`);
 }
 assert.notEqual(result.beforeNoise,result.afterNoise,'4D W must animate the procedural field');assert.equal(result.beforeNoise,result.resetNoise,'noise must be deterministic');
 const crossing=await center(result.crossedRamp),crossExpected=encoded([.475,.45,.425]);for(let c=0;c<3;c++)assert.ok(Math.abs(crossing[c]-crossExpected[c])<=1,`crossed ramp ${crossing} vs ${crossExpected}`);
 assert.equal(result.metres,result.units,'Generated coordinates preserve Blender unit scaling');
 for(const image of result.noiseFrames){const p=await png(image);assert.ok(p.data.some((v,i)=>i%4!==3&&v>0),'fractal noise renders finite nonblack values');}
 assert.equal(result.validation,null);assert.equal(result.remaining,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({centers,math:result.math.length,variants:result.variants,validation:result.validation,remaining:result.remaining}));
} finally {await browser.close();}
