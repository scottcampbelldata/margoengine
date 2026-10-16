import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'vite';

const execute=promisify(execFile);
const packageRoot=fileURLToPath(new URL('..',import.meta.url)),repository=resolve(packageRoot,'../..'),testsRoot=join(packageRoot,'tests');
const manifest=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
const specifier=subpath=>'@margoengine/react'+(subpath==='.'?'':subpath.slice(1));
const expected={
  './kit':['Fbx','Gltf','preload','Environment','OrbitControls','Html','Box','Sphere','Plane','Sky','ContactShadows','Center','PointerLock','TransformControls','Text'],
  './post':['EffectComposer','Bloom','SSAO','DepthOfField','Tonemap','TAA'],
  './physics':['Physics','RigidBody','CuboidCollider','BallCollider','usePhysics'],
  './xr':['XR','Controller','useXR'],
};
const optionalPeers=['@margoengine/gltf-pro','@margoengine/fbx','@margoengine/environment','@margoengine/html','@margoengine/text','@margoengine/gizmo','@margoengine/sky','@margoengine/shadows','@margoengine/controls','@margoengine/geometry','@margoengine/post','@margoengine/dof','@margoengine/tonemap','@margoengine/taa','@margoengine/physics','@dimforge/rapier3d-compat','@margoengine/xr'];
async function temporary(run) {
  const directory=await mkdtemp(join(testsRoot,'.subpaths-'));
  try{return await run(directory);}finally{
    assert.equal(dirname(directory),testsRoot,'Only remove this test fixture directory');
    await rm(directory,{recursive:true,force:true});
  }
}
async function runNode(args,options={}) {
  try{return await execute(process.execPath,args,{cwd:repository,maxBuffer:5*1024*1024,...options});}
  catch(error){assert.fail((error.stdout??'')+'\n'+(error.stderr??'')+'\n'+error.message);}
}

test('package exports preserve independent public runtime and declaration paths with optional peers',async()=>{
  assert.deepEqual(Object.keys(manifest.exports).sort(),['.','./kit','./post','./physics','./xr'].sort());
  assert.equal(manifest.sideEffects,false);assert.ok(manifest.files.includes('dist'));
  for(const [subpath,entry] of Object.entries(manifest.exports)) {
    const filename=subpath==='.'?'index':subpath.slice(2);
    assert.equal(entry.import,`./dist/${filename}.js`);assert.equal(entry.types,`./dist/${filename}.d.ts`);
    await access(join(packageRoot,entry.import));await access(join(packageRoot,entry.types));
    assert.equal(import.meta.resolve(specifier(subpath)),pathToFileURL(join(packageRoot,entry.import)).href);
    const api=await import(specifier(subpath));
    if(expected[subpath])assert.deepEqual(Object.keys(api).sort(),expected[subpath].sort());
    else for(const name of ['Canvas','Stage','Mesh','Model','Environment','OrbitControls','Html','Group','group','preload','useFrame','useMargo','useMargoStage'])assert.equal(typeof api[name]==='function'||typeof api[name]==='object',true,name+' is exported');
    assert.equal('useThree' in api,false);
    const emitted=await readFile(join(packageRoot,entry.import),'utf8');
    assert.equal(/(?:from|import\s*\()\s*['"](?:three|react-reconciler)(?:['"/])/.test(emitted),false);
  }
  for(const peer of optionalPeers){assert.ok(manifest.peerDependencies[peer],peer+' is a declared peer');assert.equal(manifest.peerDependenciesMeta[peer]?.optional,true,peer+' is optional');}
  for(const peer of ['@margoengine/core','margoengine','react'])assert.ok(manifest.peerDependencies[peer]);
  for(const group of ['dependencies','peerDependencies','optionalDependencies'])for(const name of Object.keys(manifest[group]??{}))assert.equal(name==='three'||name==='react-reconciler',false);
  const base=await readFile(join(packageRoot,'dist/index.js'),'utf8');
  assert.equal(/(?:kit|post|physics|xr)\.js/.test(base),false,'The base entry does not re-export optional subpaths');
});

test('server imports and canonical JSX evaluate no optional peers; a mounted Bloom loads only its own peer',async()=>temporary(async directory=>{
  const hooks=join(directory,'hooks.mjs'),consumer=join(directory,'ssr.mjs');
  await writeFile(hooks,`import {registerHooks} from 'node:module';
    const peers=${JSON.stringify(optionalPeers)};globalThis.__optionalLoads=[];
    registerHooks({resolve(specifier,context,next){
      if(peers.some(peer=>specifier===peer||specifier.startsWith(peer+'/')))return {url:'margo-react-optional:'+encodeURIComponent(specifier),shortCircuit:true};
      return next(specifier,context);
    },load(url,context,next){
      if(!url.startsWith('margo-react-optional:'))return next(url,context);
      const name=decodeURIComponent(url.slice('margo-react-optional:'.length));
      return {format:'module',shortCircuit:true,source:'globalThis.__optionalLoads.push('+JSON.stringify(name)+'); export const Bloom={attach(engine,options){const effect={name:"bloom",options,dispose(){engine.plugins.delete("bloom");}};engine.plugins.set("bloom",effect);return effect;}};'};
    }});`);
  await writeFile(consumer,`import assert from 'node:assert/strict';
    import React from 'react';import {renderToString} from 'react-dom/server';
    import {Canvas,Stage,Mesh} from '@margoengine/react';
    import {Gltf,Box,Center,Html,Text,Fbx} from '@margoengine/react/kit';
    import {EffectComposer,Bloom,SSAO,DepthOfField} from '@margoengine/react/post';
    import {Physics,RigidBody} from '@margoengine/react/physics';
    import {XR,Controller} from '@margoengine/react/xr';
    const h=React.createElement;
    assert.equal(typeof window,'undefined');assert.deepEqual(globalThis.__optionalLoads,[]);
    const tree=h(Canvas,null,h(Stage,null,
      h(Mesh,{onClick(){}}),h(React.Suspense,{fallback:h('span',null,'Loading')},h(Gltf,{src:'/model.glb'})),
      h(Center,null,h(Box)),h(Html,null,'Hello'),h(Text,null,'World'),h(Fbx,{src:'/model.fbx'}),
      h(EffectComposer,null,h(Bloom),h(SSAO),h(DepthOfField)),
      h(Physics,null,h(RigidBody,null,h(Mesh))),h(XR,null,h(Controller))));
    assert.match(renderToString(tree),/<canvas/);assert.deepEqual(globalThis.__optionalLoads,[]);
    const {JSDOM}=await import('jsdom');const dom=new JSDOM('<!doctype html><html><body></body></html>');
    for(const key of ['window','document','HTMLElement','HTMLCanvasElement','navigator'])Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
    globalThis.IS_REACT_ACT_ENVIRONMENT=true;
    const {Context}=await import(${JSON.stringify(pathToFileURL(join(packageRoot,'dist/internal.js')).href)});
    const {render,act,cleanup}=await import('@testing-library/react');
    const engine={backend:'webgpu',gpu:{},plugins:new Map(),disposed:false,onError(error){throw error;}};
    const scene={engine,resources:{models:new Set()},frames:{callbacks:new Set()}};
    const view=render(h(Context.Provider,{value:scene},h(EffectComposer,null,h(Bloom))));
    await act(async()=>{});assert.deepEqual(globalThis.__optionalLoads,['@margoengine/post/bloom']);assert.equal(engine.plugins.size,1);
    cleanup();await act(async()=>{});assert.equal(engine.plugins.size,0);assert.equal(scene.frames.callbacks.size,0);
    console.log('Optional peer evaluation stayed lazy during SSR and isolated on mount');`);
  const result=await runNode(['--import',pathToFileURL(hooks).href,consumer]);assert.match(result.stdout,/Optional peer evaluation stayed lazy/);
}));

const baseConsumer=`import {createElement as h} from 'react';
  import {Canvas,Stage,Mesh,BoxGeometry,PbrMaterial} from '@margoengine/react';
  export const PickingCube=()=>h(Canvas,{frameloop:'demand'},h(Stage,null,h(Mesh,{onClick:event=>console.log(event.object.name)},h(BoxGeometry),h(PbrMaterial,{color:'#84d6bd'}))));`;
const optionalConsumer=`import {createElement as h} from 'react';
  import {Canvas} from '@margoengine/react';
  import {Box,Text,Gltf} from '@margoengine/react/kit';
  import {EffectComposer,Bloom} from '@margoengine/react/post';
  import {Physics,RigidBody} from '@margoengine/react/physics';
  import {XR,Controller} from '@margoengine/react/xr';
  export const OptionalScene=()=>h(Canvas,null,h(Box),h(Text,null,'Margo'),h(Gltf,{src:'/model.glb'}),h(EffectComposer,null,h(Bloom)),h(Physics,null,h(RigidBody,null,h(Box))),h(XR,null,h(Controller)));`;
function staticChunks(outputs) {
  const chunks=new Map(outputs.filter(item=>item.type==='chunk').map(chunk=>[chunk.fileName,chunk])),seen=new Set();
  const visit=chunk=>{if(seen.has(chunk))return;seen.add(chunk);for(const name of chunk.imports){const dependency=chunks.get(name);if(dependency)visit(dependency);}};
  for(const chunk of chunks.values())if(chunk.isEntry)visit(chunk);
  return [...seen];
}
async function bundle(directory,name,source) {
  const entry=join(directory,name+'.js');await writeFile(entry,source);
  const result=await build({configFile:false,root:repository,logLevel:'silent',build:{write:false,minify:false,target:'es2022',lib:{entry,formats:['es'],fileName:name},rollupOptions:{external:id=>id==='react'||id.startsWith('react/')||id==='react-dom'||id.startsWith('react-dom/')}}});
  return (Array.isArray(result)?result.flatMap(output=>output.output):result.output).filter(item=>item.type==='chunk');
}
test('Vite picking-cube initial chunk graph excludes optional React subpaths and native engines',async()=>temporary(async directory=>{
  const outputs=await bundle(directory,'picking-cube',baseConsumer),initial=staticChunks(outputs);
  assert.ok(initial.length>0);
  const modules=initial.flatMap(chunk=>Object.keys(chunk.modules)).map(id=>id.replaceAll('\\','/'));
  assert.ok(modules.some(id=>id.endsWith('/react/dist/components.js')));
  for(const fragment of ['/react/dist/kit','/react/dist/post','/react/dist/physics','/react/dist/xr','/physics/','/post/','/dof/','/tonemap/','/taa/','/xr/','/geometry/','/gizmo/','/sky/','/text/','/fbx/','rapier3d'])assert.equal(modules.some(id=>id.includes(fragment)),false,fragment+' is absent from the initial graph');
  const code=initial.map(chunk=>chunk.code).join('\n');assert.match(code,/\.pick\(/,'Canvas picking survives the base consumer build');
  assert.equal(/EffectComposer|function Physics\(|function XR\(/.test(code),false);
  for(const chunk of outputs)assert.equal(/react-reconciler|from ["']three["']/.test(chunk.code),false);
}));

test('Vite optional entry includes requested bindings while keeping their native peers off the initial graph',async()=>temporary(async directory=>{
  const outputs=await bundle(directory,'optional-scene',optionalConsumer),initial=staticChunks(outputs);
  const modules=initial.flatMap(chunk=>Object.keys(chunk.modules)).map(id=>id.replaceAll('\\','/'));
  for(const subpath of ['kit-helpers','post','physics','xr'])assert.ok(modules.some(id=>id.endsWith('/react/dist/'+subpath+'.js')),subpath+' React binding is present');
  for(const fragment of ['/packages/physics/','/packages/post/','/packages/xr/','/packages/text/','/packages/gltf-pro/','rapier3d'])assert.equal(modules.some(id=>id.includes(fragment)),false,fragment+' native peer remains lazy');
  const all=outputs.flatMap(chunk=>Object.keys(chunk.modules)).map(id=>id.replaceAll('\\','/'));
  for(const fragment of ['/packages/physics/','/packages/post/','/packages/xr/','/packages/text/','/packages/gltf-pro/','rapier3d'])assert.ok(all.some(id=>id.includes(fragment)),fragment+' has a deferred output chunk');
}));

test('strict TypeScript consumers compile every public React subpath, callbacks and canonical scene snippets',async()=>temporary(async directory=>{
  await writeFile(join(directory,'consumer.tsx'),`import React,{Suspense,useRef} from 'react';
    import {Canvas,Stage,Mesh,Group,Model,useFrame,useMargo,type MeshRef} from '@margoengine/react';
    import {Gltf,Fbx,preload,Box,Sphere,Plane,Sky,ContactShadows,Center,PointerLock,TransformControls,Text,Html,Environment,OrbitControls,type GltfProps,type FbxProps,type BoxProps,type TextProps} from '@margoengine/react/kit';
    import {EffectComposer,Bloom,SSAO,DepthOfField,Tonemap,TAA,type BloomProps,type DepthOfFieldProps,type EffectComposerProps,type TonemapProps,type TAAProps} from '@margoengine/react/post';
    import {Physics,RigidBody,CuboidCollider,BallCollider,usePhysics,type PhysicsProps,type RigidBodyProps,type PhysicsBody} from '@margoengine/react/physics';
    import {XR,Controller,useXR,type XRProps,type ControllerProps,type XRContextValue} from '@margoengine/react/xr';
    function Hooks(){const state=useMargo(),world=usePhysics(),xr:XRContextValue=useXR();state.invalidate();state.camera?.position;state.size.width;state.gl?.canvas;state.clock.toFixed(2);world?.raycast([0,0,0],[0,-1,0]);void xr.ready;useFrame((engine,delta)=>{engine.camera.fov+=delta;});return null;}
    const loader:GltfProps={src:'/model.glb'},fbx:FbxProps={src:'/model.fbx'},box:BoxProps={args:[1,1,1]},text:TextProps={text:'Margo'};
    const bloom:BloomProps={strength:1,onReady:effect=>{effect.options.strength=0.5;}},dof:DepthOfFieldProps={focalDistance:8},tone:TonemapProps={curve:'agx'},taa:TAAProps={historyWeight:0.9},composer:EffectComposerProps={enabled:true};
    const physics:PhysicsProps={gravity:[0,-9.81,0]},body:RigidBodyProps={type:'dynamic',onReady:(value:PhysicsBody)=>value.wakeUp()},xr:XRProps={mode:'immersive-vr'},controller:ControllerProps={handedness:'left',onSelect:event=>event.controller.source};
    export function App(){const ref=useRef<MeshRef>(null);return <Canvas frameloop="demand"><Stage><Mesh ref={ref} onClick={event=>{event.object.name;}}/><Group><Center><Box {...box}/><Sphere/><Plane/></Center></Group><Suspense fallback={<span>Loading</span>}><Gltf {...loader}/><Model src="/second.glb"/><Fbx {...fbx}/><Environment src="/studio.hdr"/></Suspense><Sky/><ContactShadows/><PointerLock/><TransformControls object={ref}/><Text {...text}/><Html>Label</Html><OrbitControls/><EffectComposer {...composer}><Bloom {...bloom}/><SSAO/><DepthOfField {...dof}/><Tonemap {...tone}/><TAA {...taa}/></EffectComposer><Physics {...physics}><RigidBody {...body}><Mesh/></RigidBody></Physics><XR {...xr}><Controller {...controller}/></XR></Stage></Canvas>;}
    void preload('/model.glb');void preload('/model.fbx','fbx');void Hooks;
    export const assetBodies=<Physics><RigidBody colliders="cuboid"><Fbx src="/asset.fbx"/></RigidBody><RigidBody colliders="hull"><Gltf src="/asset.glb"/></RigidBody><RigidBody colliders="trimesh"><Box/></RigidBody><RigidBody colliders={false}><CuboidCollider args={[0.5,1,0.5]}/><BallCollider args={[0.25]}/><Fbx src="/asset.fbx"/></RigidBody></Physics>;
    // @ts-expect-error Automatic collider modes are explicit and bounded.
    export const invalidCollider:RigidBodyProps={colliders:'gpu-mesh'};
    // @ts-expect-error useThree is intentionally not part of this package.
    import {useThree} from '@margoengine/react';
  `);
  await writeFile(join(directory,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:true,jsx:'react-jsx',skipLibCheck:true},files:['consumer.tsx']}));
  await runNode([join(repository,'node_modules/typescript/bin/tsc'),'-p',join(directory,'tsconfig.json')]);
}));
