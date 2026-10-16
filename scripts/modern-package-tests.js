import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile,copyFile,readdir,rm,realpath} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {openBrowser} from './browser.js';

const names=['core','gltf','react','machinery','creative','scenery','gltf-pro','animation','post','shadows','clustered','vfx','animator','taa','splats','terrain','environment','controls','margoengine'],npm=process.env.npm_execpath;
const packedNames=JSON.parse(await readFile('package.json','utf8')).workspaces.filter(path=>path.startsWith('packages/')).map(path=>path.slice('packages/'.length));
const noticeFiles=new Map([['post','NOTICE.md'],['tonemap','NOTICE.md'],['materials','THIRD_PARTY_NOTICES.md'],['usdz','THIRD-PARTY-NOTICES.txt'],['text','NOTICE.md']]);
const packageDocuments=new Map([...noticeFiles,['blender','FORMAT.md']]);
const packageName=name=>name==='margoengine'?'margoengine':`@margoengine/${name}`;
assert.ok(npm,'Run this check through npm run modern:test:packages');
// Reuse a verified archive set while concurrent source edits are in progress.
// This mode never packs, rebuilds, or injects markers into shared dist.
const reuseTarballs=process.env.MARGOENGINE_PACKAGE_TEST_REUSE_TARBALLS==='1';
const archives=resolve(reuseTarballs?'test-results/margo-packages':'test-results/modern-packages');
if(reuseTarballs)await realpath(archives);else await mkdir(archives,{recursive:true});
const dependencies={react:'18.3.1','react-dom':'18.3.1','@types/react':'^18.3.0','@types/react-dom':'^18.3.0','@testing-library/react':'16.3.3',jsdom:'26.1.0',vite:JSON.parse(await readFile('package.json','utf8')).devDependencies.vite,'@dimforge/rapier3d-compat':JSON.parse(await readFile('node_modules/@dimforge/rapier3d-compat/package.json','utf8')).version};
// A local retry can reuse the coherent workspace build made by core's prepack.
// The default still exercises every package's own prepack hook.
const reuseBuild=process.env.MARGOENGINE_PACKAGE_TEST_REUSE_BUILDS==='1';
if(!reuseTarballs)for(const name of ['core','react'])await writeFile(`packages/${name}/dist/__stale-package-test.js`,'throw new Error("Stale build artifact");');
for(const name of packedNames){
  let pack,manifest;
  if(reuseTarballs){
    const workspaceManifest=JSON.parse(await readFile(`packages/${name}/package.json`,'utf8'));
    const filename=packageName(name).replace(/^@/,'').replace('/','-')+'-'+workspaceManifest.version+'.tgz',archive=join(archives,filename);
    const members=execFileSync('tar',['-tf',archive],{encoding:'utf8'}).split(/\r?\n/).filter(Boolean);
    assert.ok(members.length&&members.every(member=>member.startsWith('package/')&&!member.split('/').includes('..')),`Invalid cached package archive: ${filename}`);
    pack={filename,files:members.filter(member=>!member.endsWith('/')).map(member=>({path:member.slice('package/'.length)}))};
    manifest=JSON.parse(execFileSync('tar',['-xOf',archive,'package/package.json'],{encoding:'utf8'}));
    assert.equal(manifest.name,packageName(name),`Wrong cached package: ${filename}`);assert.equal(manifest.version,workspaceManifest.version,`Wrong cached version: ${filename}`);
  }else{
    [pack]=JSON.parse(execFileSync(process.execPath,[npm,'pack','--workspace',packageName(name),'--pack-destination',archives,'--json',...(reuseBuild&&name!=='core'?['--ignore-scripts']:[])],{encoding:'utf8'}));
    manifest=JSON.parse(await readFile(`packages/${name}/package.json`,'utf8'));
  }
  const files=new Set(pack.files.map(file=>file.path));
  const unexpected=pack.files.filter(file=>!['package.json','README.md','LICENSE',...(packageDocuments.has(name)?[packageDocuments.get(name)]:[])].includes(file.path)&&!file.path.startsWith('dist/')).map(file=>file.path);
  assert.deepEqual(unexpected,[],`${packageName(name)} contains unexpected packed files: ${unexpected.join(', ')}`);
  if(noticeFiles.has(name))assert.ok(files.has(noticeFiles.get(name)),`${packageName(name)} must retain its third-party notices`);
  if(name==='blender')assert.ok(files.has('FORMAT.md'),'@margoengine/blender must retain its format specification');
  assert.ok(files.has('README.md')&&files.has('LICENSE'));assert.ok(!files.has('dist/__stale-package-test.js'));
  if(name==='machinery')for(const file of ['cad-runtime.js','occt-import-js.js','occt-import-js.wasm','OCCT-LICENSE.txt','OCCT-NOTICE.txt'])assert.ok(files.has('dist/workers/'+file),`Missing CAD worker asset: ${file}`);
  assert.notEqual(manifest.private,true);assert.equal(manifest.license,name==='materials'?'MIT AND Apache-2.0':'MIT');assert.equal(manifest.publishConfig.access,'public');
  for(const entry of Object.values(manifest.exports))for(const target of Object.values(entry))assert.ok(files.has(target.slice(2)),`Missing packed export: ${manifest.name} ${target}`);
  dependencies[packageName(name)]=`file:${join(archives,pack.filename).replaceAll('\\','/')}`;
}
const fixture=await mkdtemp(join(tmpdir(),'margoengine-consumer-'));let browser;const browserErrors=[];
try{
  await writeFile(join(fixture,'package.json'),JSON.stringify({private:true,type:'module',dependencies}));
  execFileSync(process.execPath,[npm,'install','--ignore-scripts','--no-audit','--no-fund'],{cwd:fixture,stdio:'inherit'});
  for(const [name,file] of packageDocuments)assert.equal(await readFile(join(fixture,`node_modules/${packageName(name)}/${file}`),'utf8'),await readFile(`packages/${name}/${file}`,'utf8'),`${packageName(name)} must preserve its installed ${file} verbatim`);
  for(const name of names){
    assert.equal(await readFile(join(fixture,`node_modules/${packageName(name)}/LICENSE`),'utf8'),await readFile('LICENSE','utf8'));
    const markdown=await readFile(join(fixture,`node_modules/${packageName(name)}/README.md`),'utf8');
    // Standalone examples have imports; continuation blocks retain the preceding setup.
    const examples=[];
    for(const [,code] of markdown.matchAll(/```tsx?\r?\n([\s\S]*?)```/g)){
      if(!examples.length||/^\s*(?:import\s|const\s+\{[^}]+\}\s*=\s*await\s+import\s*\()/m.test(code))examples.push(code);
      else examples[examples.length-1]+='\n'+code;
    }
    for(const [index,code] of examples.entries())await writeFile(join(fixture,`${name}-${index}-readme.tsx`),code);
  }
  await writeFile(join(fixture,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',jsx:'react-jsx',types:[],lib:['ES2022','DOM'],outDir:'out'},include:['consumer.tsx','*-readme.tsx']}));
  await writeFile(join(fixture,'consumer.tsx'),`import {TransformStore,type PassContext} from '@margoengine/core/extension';
import {EngineKernel,type Mesh as MeshHandle} from '@margoengine/core';
import {loadGLTF} from '@margoengine/gltf';
import {Canvas,Mesh,Box,BoxGeometry,PbrMaterial,MeshTransmissionMaterial,Gltf,Animation,Model,Environment,OrbitControls,useMargo,useMargoStage,type MeshRef} from '@margoengine/react';
import {Kinematics,ExplodedView,SectionPlanes,EngineeringAnnotations,PartInstancer,parseCAD,parseCADAsync,loadCAD,deduplicateParts,SurfacePhysics,TelemetryChannel,AssemblyBVH,measureClearance} from '@margoengine/machinery';
import {GPUParticles,PostProcessing,ToonShading,HDRRenderTarget} from '@margoengine/creative';
import {PostStack,Bloom} from '@margoengine/post';
import {SkyMoon,type SkyMoonConfig} from '@margoengine/scenery';
import {Stage,createStage,sphere,type LoadedModel} from 'margoengine';
import {renderToString} from 'react-dom/server';
const device=(pass:PassContext)=>pass.backend==='webgpu'?pass.device:null;
const store=await TransformStore.create(3);store.dispose();
if(typeof createStage!=='function'||typeof Stage!=='function'||sphere().indices.length===0)throw new Error('Stage exports failed');
function loaded(model:LoadedModel){model.position.set(1,2,3);model.rotation.set(0,0.5,0);model.scale.setAll(2);model.visible=false;const bounds:Float32Array=model.bounds;const buffer:GPUBuffer|undefined=model.raw?.[0].vertex;
// @ts-expect-error bounds cannot be replaced
model.bounds=new Float32Array(6);
model.destroy();return {bounds,buffer};}
const html=renderToString(<Canvas><Mesh><BoxGeometry/><PbrMaterial/></Mesh></Canvas>);
const afterScene=renderToString(<Canvas><Box color="#84d6bd"/><Mesh><BoxGeometry/><MeshTransmissionMaterial factor={0}/></Mesh><Gltf src="/character.glb"><Animation clip="Walk" blend={0.2}/></Gltf></Canvas>);if(!afterScene.includes('<canvas'))throw new Error('Root scene exports failed');
const declarative=renderToString(<Canvas shadows onCreated={stage=>stage.engine.camera.position=[1,2,5]}><Model src="/model.glb" materials={{Upper:{baseColor:[0.2,0.8,0.3]}}} onLoad={mesh=>mesh.setPosition([1,0,0])}/><Environment src="/studio.hdr" exposure={1} background/><OrbitControls enableDamping minDistance={1} maxDistance={10}/></Canvas>);
if(!declarative.includes('<canvas')||typeof useMargo!=='function'||typeof useMargoStage!=='function')throw new Error('Declarative exports failed');
if(!html.includes('<canvas')||typeof loadGLTF!=='function'||!Kinematics||!ExplodedView||new GPUParticles({count:32}).count!==32)throw new Error('Consumer failed');
new SectionPlanes({planes:[[0,0,1,0]]});new EngineeringAnnotations();new PartInstancer();new ToonShading();new PostStack([new Bloom({strength:0.5}),new PostProcessing({atmosphere:{density:0.01}})]);
if(typeof parseCAD!=='function'||typeof loadCAD!=='function'||typeof deduplicateParts!=='function'||!HDRRenderTarget)throw new Error('Domain exports failed');
if(typeof parseCADAsync!=='function'||typeof SurfacePhysics.create!=='function'||typeof TelemetryChannel.create!=='function'||typeof AssemblyBVH.create!=='function'||typeof measureClearance!=='function')throw new Error('Machinery runtime exports failed');
const moonlit:SkyMoonConfig={moonDirection:[0,1,0],moonPhase:1};if(new SkyMoon(moonlit).config!==moonlit)throw new Error('Scenery exports failed');
function refs(engine:import('@margoengine/core').EngineKernel,node:MeshRef){
// @ts-expect-error useMargoStage uses the portable engine surface
engine.frameGraph;
// @ts-expect-error React mesh refs hide Wasm slot indices
node.id;
return <Canvas onCreated={stage=>{
const engine=stage.engine;
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
  // Run against the installed tarball itself. Relative internal-module imports and
  // public package imports must share the same React contexts and asset caches.
  const reactRoot=join(fixture,'node_modules/@margoengine/react'),supportRoot=join(fixture,'node_modules'),reactTests=[];
  for(const directory of ['test','tests']){
    await mkdir(join(reactRoot,directory),{recursive:true});
    for(const file of await readdir('packages/react/'+directory,{withFileTypes:true})){
      // These packaging/bundler checks require the workspace and already run in
      // the full Node gate; all component lifecycle tests also run on React 18.
      if(!file.isFile()||!file.name.endsWith('.js')||file.name==='subpaths.test.js')continue;
      const relative=directory+'/'+file.name;await copyFile('packages/react/'+relative,join(reactRoot,relative));
      if(file.name.endsWith('.test.js'))reactTests.push(relative);
    }
  }
  reactTests.sort();
  await mkdir(join(supportRoot,'@margoengine/gltf-pro/src'),{recursive:true});await mkdir(join(supportRoot,'docs'),{recursive:true});
  await copyFile('packages/gltf-pro/src/shader.ts',join(supportRoot,'@margoengine/gltf-pro/src/shader.ts'));
  await mkdir(join(supportRoot,'@margoengine/shared'),{recursive:true});
  await copyFile('packages/shared/aces.js',join(supportRoot,'@margoengine/shared/aces.js'));
  for(const file of ['react-integration.md','react-r3f.md'])await copyFile('docs/'+file,join(supportRoot,'docs',file));
  execFileSync(process.execPath,['--experimental-test-module-mocks','--test',...reactTests.map(file=>join(reactRoot,file))],{cwd:fixture,stdio:'inherit'});
  const aliases=[],browserExport=entry=>typeof entry==='string'?entry:browserExport(entry.browser??entry.import??entry.default);
  for(const name of [...packedNames.map(packageName),'react','react-dom']){
    const directory=join(fixture,'node_modules',name),manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
    for(const [subpath,entry] of Object.entries(manifest.exports)){
      const specifier=name+(subpath==='.'?'':subpath.slice(1));
      aliases.push({find:new RegExp('^'+specifier.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$'),replacement:join(directory,browserExport(entry))});
    }
  }
  browser=await openBrowser({startPath:'/tests/modern.html',aliases});const {page}=browser,errors=browserErrors;
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
  await writeFile('test-results/modern-packages.json',JSON.stringify({hardware:browser.hardware,packages:packedNames.map(packageName),archiveSource:reuseTarballs?'cached-tarballs':'prepack',archiveDirectory:archives,react,reactTests,checks:['standalone imports and Wasm','strict consumer declarations without workspace ambient types','React 18 SSR','React 18 declarative, kit, post, physics, XR and loader lifecycle unit tests','React 18 StrictMode, nested refs, props, RAF, Suspense and teardown']},null,2));
  console.log(`React ${react} packaged browser lifecycle passes`);
}catch(error){
  if(browser){
    const state=await browser.page.evaluate(()=>{const state=window.modern?.state;return state?{errors:state.errors,meshes:state.react?.meshes.size,disposed:state.react?.disposed,frames:state.frames,parent:!!state.parent,child:!!state.child}:null;}).catch(()=>null);
    console.error('Packed browser failure:',JSON.stringify({state,errors:browserErrors}));
  }
  throw error;
}finally{
  await browser?.close();
  const target=await realpath(fixture);assert.equal(dirname(target).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.ok(basename(target).startsWith('margoengine-consumer-'));
  await rm(target,{recursive:true,force:true});
}
