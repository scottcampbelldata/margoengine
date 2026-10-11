import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {openBrowser} from './browser.js';

const names=['core','gltf','react','machinery','creative'],npm=process.env.npm_execpath;
assert.ok(npm,'Run this check through npm run modern:test:packages');
const archives=resolve('test-results/modern-packages');await mkdir(archives,{recursive:true});
const dependencies={react:'18.3.1','react-dom':'18.3.1','@types/react':'^18.3.0','@types/react-dom':'^18.3.0'};
for(const name of ['core','react'])await writeFile(`packages/${name}/dist/__stale-package-test.js`,'throw new Error("Stale build artifact");');
for(const name of names){
  const [pack]=JSON.parse(execFileSync(process.execPath,[npm,'pack','--workspace',`@vexel/${name}`,'--pack-destination',archives,'--json'],{encoding:'utf8'})),files=new Set(pack.files.map(file=>file.path));
  assert.ok(pack.files.every(file=>['package.json','README.md','LICENSE'].includes(file.path)||file.path.startsWith('dist/')));
  assert.ok(files.has('README.md')&&files.has('LICENSE'));assert.ok(!files.has('dist/__stale-package-test.js'));
  const manifest=JSON.parse(await readFile(`packages/${name}/package.json`,'utf8'));
  assert.notEqual(manifest.private,true);assert.equal(manifest.license,'MIT');assert.equal(manifest.publishConfig.access,'public');
  for(const entry of Object.values(manifest.exports))for(const target of Object.values(entry))assert.ok(files.has(target.slice(2)),`Missing packed export: ${manifest.name} ${target}`);
  dependencies[`@vexel/${name}`]=`file:${join(archives,pack.filename).replaceAll('\\','/')}`;
}
const fixture=await mkdtemp(join(tmpdir(),'vexel-consumer-'));let browser;
try{
  await writeFile(join(fixture,'package.json'),JSON.stringify({private:true,type:'module',dependencies}));
  execFileSync(process.execPath,[npm,'install','--ignore-scripts','--no-audit','--no-fund'],{cwd:fixture,stdio:'inherit'});
  for(const name of names){
    assert.equal(await readFile(join(fixture,`node_modules/@vexel/${name}/LICENSE`),'utf8'),await readFile('LICENSE','utf8'));
    const markdown=await readFile(join(fixture,`node_modules/@vexel/${name}/README.md`),'utf8');
    await writeFile(join(fixture,`${name}-readme.tsx`),[...markdown.matchAll(/```tsx?\r?\n([\s\S]*?)```/g)].map(match=>match[1]).join('\n'));
  }
  await writeFile(join(fixture,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',jsx:'react-jsx',types:[],lib:['ES2022','DOM'],outDir:'out'},include:['consumer.tsx','*-readme.tsx']}));
  await writeFile(join(fixture,'consumer.tsx'),`import {TransformStore,type PassContext} from '@vexel/core/extension';
import {EngineKernel,type Mesh as MeshHandle} from '@vexel/core';
import {loadGLTF} from '@vexel/gltf';
import {Canvas,Mesh,BoxGeometry,PbrMaterial,type MeshRef} from '@vexel/react';
import {Kinematics,ExplodedView,SectionPlanes,EngineeringAnnotations,PartInstancer,parseCAD,loadCAD,deduplicateParts} from '@vexel/machinery';
import {GPUParticles,PostProcessing,ToonShading,HDRRenderTarget} from '@vexel/creative';
import {renderToString} from 'react-dom/server';
const device=(pass:PassContext)=>pass.backend==='webgpu'?pass.device:null;
const store=await TransformStore.create(3);store.dispose();
const html=renderToString(<Canvas><Mesh><BoxGeometry/><PbrMaterial/></Mesh></Canvas>);
if(!html.includes('<canvas')||typeof loadGLTF!=='function'||!Kinematics||!ExplodedView||new GPUParticles({count:32}).count!==32)throw new Error('Consumer failed');
new SectionPlanes({planes:[[0,0,1,0]]});new EngineeringAnnotations();new PartInstancer();new ToonShading();new PostProcessing({atmosphere:{sky:true},bloom:0.5});
if(typeof parseCAD!=='function'||typeof loadCAD!=='function'||typeof deduplicateParts!=='function'||!HDRRenderTarget)throw new Error('Domain exports failed');
function refs(engine:import('@vexel/core').EngineKernel,node:MeshRef){
// @ts-expect-error Canvas onCreated uses the portable engine surface
engine.frameGraph;
// @ts-expect-error React mesh refs hide Wasm slot indices
node.id;
return <Canvas onCreated={engine=>{
// @ts-expect-error Canvas hides the raw device
engine.gpu;
}}><Mesh ref={node=>{if(node){
// @ts-expect-error Mesh refs hide raw matrix views
node.matrix;
}}}/></Canvas>;
}
function frozen(canvas:HTMLCanvasElement){void EngineKernel.create(canvas).then(engine=>{const mesh=engine.createMesh();void loadCAD(engine,'http://example.invalid/model.stl');void loadGLTF(engine,'http://example.invalid/model.glb');new Kinematics([{node:mesh,axis:'x',min:0,max:1}],{distances:[{a:mesh,b:mesh,length:0}]});engine.use(new PartInstancer());
// @ts-expect-error runtime storage is confined to the extension entry
engine.store;
// @ts-expect-error GPU state is confined to the extension entry
engine.gpu;
// @ts-expect-error attached geometry changes use setGeometry
mesh.geometry=null;
// @ts-expect-error slot-map indices are confined to the extension entry
mesh.id;
// @ts-expect-error Wasm matrix views are confined to the extension entry
mesh.matrix;
});}
console.log('Standalone package imports, WebGPU declarations, Wasm and React 18 SSR pass');
`);
  execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',join(fixture,'tsconfig.json')],{stdio:'inherit'});
  execFileSync(process.execPath,[join(fixture,'out/consumer.js')],{cwd:fixture,stdio:'inherit'});
  const aliases={'@vexel/core/extension':join(fixture,'node_modules/@vexel/core/dist/extension.js'),react:join(fixture,'node_modules/react'),'react-dom':join(fixture,'node_modules/react-dom')};
  aliases['@vexel/core/extension']=join(fixture,'node_modules/@vexel/core/dist/extension.js');
  for(const name of names)aliases[`@vexel/${name}`]=join(fixture,`node_modules/@vexel/${name}/dist/index.js`);
  browser=await openBrowser({startPath:'/tests/modern.html',aliases});const {page}=browser,errors=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.waitForFunction(()=>window.modern);await page.evaluate(()=>window.modern.mount());
  await page.waitForFunction(()=>window.modern.state.react?.meshes.size===2&&window.modern.state.parent&&window.modern.state.child);
  assert.ok(await page.evaluate(()=>{const s=window.modern.state;return s.react.store.parents[s.child.id]===s.parent.id;}));
  const renders=await page.evaluate(()=>window.modern.state.renders);await page.waitForFunction(()=>window.modern.state.frames>=20);assert.equal(await page.evaluate(()=>window.modern.state.renders),renders);
  await page.evaluate(()=>window.modern.mount({position:2}));await page.waitForFunction(()=>window.modern.state.parent?.position.x===2);
  await page.evaluate(()=>window.modern.mount({show:false}));await page.waitForFunction(()=>window.modern.state.react.meshes.size===0);
  await page.evaluate(()=>window.modern.mount({suspend:true}));await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.modern.state.react.meshes.size),0);
  await page.evaluate(()=>window.modern.mount());await page.waitForFunction(()=>window.modern.state.react.meshes.size===2);
  await page.evaluate(()=>window.modern.unmount());assert.ok(await page.evaluate(()=>window.modern.state.react.disposed));assert.equal(await page.evaluate(()=>window.modern.state.react.meshes.size),0);
  assert.deepEqual(await page.evaluate(()=>window.modern.state.errors),[]);assert.deepEqual(errors,[]);
  const react=JSON.parse(await readFile(join(fixture,'node_modules/react/package.json'),'utf8')).version;
  await writeFile('test-results/modern-packages.json',JSON.stringify({hardware:browser.hardware,packages:names.map(name=>`@vexel/${name}`),react,checks:['standalone imports and Wasm','strict consumer declarations without workspace ambient types','React 18 SSR','React 18 StrictMode, nested refs, props, RAF, Suspense and teardown']},null,2));
  console.log(`React ${react} packaged browser lifecycle passes`);
}finally{
  await browser?.close();
  const target=await realpath(fixture);assert.equal(dirname(target).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.ok(basename(target).startsWith('vexel-consumer-'));
  await rm(target,{recursive:true,force:true});
}
