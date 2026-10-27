import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url)),
  repository = resolve(packageRoot, '../..'),
  testsRoot = join(packageRoot, 'tests');
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const specifier = (subpath) => '@margoengine/react' + (subpath === '.' ? '' : subpath.slice(1));
// Every entry's runtime names. Each binding has one home: the root holds those that need no optional package, and a
// binding that needs @margoengine/<name> is in @margoengine/react/<name> (2026-10-27).
const expected = {
  '.': [
    'BoxGeometry',
    'Canvas',
    'Center',
    'GeometryResource',
    'Group',
    'MargoCanvas',
    'MargoContext',
    'Mesh',
    'PbrMaterial',
    'RenderView',
    'Scene',
    'Stage',
    'Sun',
    'boxGeometry',
    'clearLoader',
    'group',
    'mesh',
    'meshStandardMaterial',
    'useCamera',
    'useEngine',
    'useFrame',
    'useLoader',
    'useMargo',
    'useMargoStage',
    'useProgress',
  ],
  './controls': ['ArcballControls', 'CadControls', 'MapControls', 'OrbitControls', 'PointerLock', 'TransformControls'],
  './gltf-pro': ['Gltf', 'Model'],
  './fbx': ['Fbx'],
  './animation': ['Animation'],
  './environment': ['AmbientLight', 'Environment', 'Fog', 'HemisphereLight'],
  './html': ['Html'],
  './shadows': ['ContactShadows', 'Shadows'],
  './sky': ['Sky'],
  './text': ['Text'],
  './geometry': ['Box', 'Plane', 'Sphere'],
  './materials': ['BatchedItem', 'BatchedMesh', 'MeshTransmissionMaterial'],
  './post': [
    'Afterimage',
    'Bloom',
    'DepthTexture',
    'EffectComposer',
    'FXAA',
    'GTAO',
    'Glitch',
    'LensFlare',
    'MotionBlur',
    'SMAA',
    'SSAO',
    'SSGI',
    'SSR',
    'SceneTargets',
  ],
  './dof': ['DepthOfField'],
  './tonemap': ['Tonemap'],
  './taa': ['TAA'],
  './machinery': ['SectionPlanes'],
  './voxel': ['Voxels', 'useBlockTextures'],
  './physics': [
    'BallCollider',
    'CapsuleCollider',
    'ConeCollider',
    'ConvexHullCollider',
    'CuboidCollider',
    'CylinderCollider',
    'HeightfieldCollider',
    'Physics',
    'RigidBody',
    'TrimeshCollider',
    'useAfterPhysicsStep',
    'useBeforePhysicsStep',
    'useJoint',
    'usePhysics',
  ],
  './xr': ['Controller', 'XR', 'useXR'],
};
const optionalPeers = [
  '@margoengine/gltf-pro',
  '@margoengine/fbx',
  '@margoengine/environment',
  '@margoengine/html',
  '@margoengine/text',
  '@margoengine/sky',
  '@margoengine/shadows',
  '@margoengine/controls',
  '@margoengine/geometry',
  '@margoengine/post',
  '@margoengine/dof',
  '@margoengine/tonemap',
  '@margoengine/taa',
  '@margoengine/physics',
  '@dimforge/rapier3d-compat',
  '@margoengine/xr',
  '@margoengine/materials',
  '@margoengine/animation',
  '@margoengine/animator',
  '@margoengine/voxel',
  '@margoengine/machinery',
  '@margoengine/cameras',
];
async function temporary(run) {
  const directory = await mkdtemp(join(testsRoot, '.subpaths-'));
  try {
    return await run(directory);
  } finally {
    assert.equal(dirname(directory), testsRoot, 'Only remove this test fixture directory');
    await rm(directory, { recursive: true, force: true });
  }
}
async function runNode(args, options = {}) {
  try {
    return await execute(process.execPath, args, { cwd: repository, maxBuffer: 5 * 1024 * 1024, ...options });
  } catch (error) {
    assert.fail((error.stdout ?? '') + '\n' + (error.stderr ?? '') + '\n' + error.message);
  }
}

test('package exports preserve independent public runtime and declaration paths with optional peers', async () => {
  assert.deepEqual(Object.keys(manifest.exports).sort(), Object.keys(expected).sort());
  // Progress (cache) and model picking (selection) are part of the bindings, installed with them.
  for (const name of ['@margoengine/cache', '@margoengine/math', '@margoengine/selection'])
    assert.ok(manifest.dependencies[name], name);
  assert.equal(manifest.sideEffects, false);
  assert.ok(manifest.files.includes('dist'));
  for (const [subpath, entry] of Object.entries(manifest.exports)) {
    const filename = subpath === '.' ? 'index' : subpath.slice(2);
    assert.equal(entry.import, `./dist/${filename}.js`);
    assert.equal(entry.types, `./dist/${filename}.d.ts`);
    // React Server Components resolve "react-server": the same exports behind 'use client'. Every other bundler loads
    // the plain entry, which carries no module-level directive to warn about.
    assert.deepEqual(Object.keys(entry), ['types', 'react-server', 'import']);
    assert.equal(entry['react-server'], `./dist/rsc/${filename}.js`);
    // Next.js rejects `export *` in a client boundary: the server entry names every export of the plain entry.
    assert.match(
      await readFile(join(packageRoot, entry['react-server']), 'utf8'),
      new RegExp(`^'use client';\\n(?://.*\\n)*export \\{ [\\w, ]+ \\} from '\\.\\./${filename}\\.js';\\n$`),
    );
    assert.deepEqual(
      Object.keys(await import(pathToFileURL(join(packageRoot, entry['react-server'])).href)),
      Object.keys(await import(pathToFileURL(join(packageRoot, entry.import)).href)),
      `${subpath}: the react-server entry exports exactly the plain entry's names`,
    );
    await access(join(packageRoot, entry.import));
    await access(join(packageRoot, entry.types));
    assert.equal(import.meta.resolve(specifier(subpath)), pathToFileURL(join(packageRoot, entry.import)).href);
    const api = await import(specifier(subpath));
    assert.deepEqual(Object.keys(api).sort(), expected[subpath].sort(), subpath);
    assert.equal('useThree' in api, false);
    const emitted = await readFile(join(packageRoot, entry.import), 'utf8');
    assert.equal(/(?:from|import\s*\()\s*['"](?:three|react-reconciler)(?:['"/])/.test(emitted), false);
  }
  for (const peer of optionalPeers) {
    assert.ok(manifest.peerDependencies[peer], peer + ' is a declared peer');
    assert.equal(manifest.peerDependenciesMeta[peer]?.optional, true, peer + ' is optional');
  }
  for (const peer of ['@margoengine/core', '@margoengine/stage', 'react']) assert.ok(manifest.peerDependencies[peer]);
  for (const group of ['dependencies', 'peerDependencies', 'optionalDependencies'])
    for (const name of Object.keys(manifest[group] ?? {}))
      assert.equal(name === 'three' || name === 'react-reconciler', false);
  // One home per binding: no name is exported by two entries (margoengine/react re-exports them all).
  const homes = new Map();
  for (const [subpath, names] of Object.entries(expected))
    for (const name of names) {
      assert.equal(homes.get(name), undefined, `${name} is exported by ${homes.get(name)} and ${subpath}`);
      homes.set(name, subpath);
    }
  // Animation takes a ref, so it is a forwardRef component object, like Mesh.
  assert.equal(typeof (await import(specifier('./animation'))).Animation.render, 'function');
});

test("only the react-server entries carry 'use client'", async () => {
  // A module-level directive in a bundled file makes Vite and Rollup warn once per file ("Module level directives
  // cause errors when bundled") in every app built without @vitejs/plugin-react: 17 warnings per build (2026-10-26).
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) await walk(join(directory, entry.name));
      else if (entry.name.endsWith('.js')) files.push(join(directory, entry.name));
  };
  await walk(join(packageRoot, 'dist'));
  const directives = [];
  for (const file of files)
    if (/^\s*(['"])use (?:client|server)\1/.test(await readFile(file, 'utf8')))
      directives.push(relative(join(packageRoot, 'dist'), file).replaceAll('\\', '/'));
  assert.deepEqual(
    directives.sort(),
    Object.keys(expected)
      .map((subpath) => `rsc/${subpath === '.' ? 'index' : subpath.slice(2)}.js`)
      .sort(),
  );
});

test('server imports and canonical JSX evaluate no optional peers; a mounted Bloom loads only its own peer', async () =>
  temporary(async (directory) => {
    const hooks = join(directory, 'hooks.mjs'),
      consumer = join(directory, 'ssr.mjs');
    await writeFile(
      hooks,
      `import {registerHooks} from 'node:module';
    const peers=${JSON.stringify(optionalPeers)};globalThis.__optionalLoads=[];
    registerHooks({resolve(specifier,context,next){
      if(peers.some(peer=>specifier===peer||specifier.startsWith(peer+'/')))return {url:'margo-react-optional:'+encodeURIComponent(specifier),shortCircuit:true};
      return next(specifier,context);
    },load(url,context,next){
      if(!url.startsWith('margo-react-optional:'))return next(url,context);
      const name=decodeURIComponent(url.slice('margo-react-optional:'.length));
      return {format:'module',shortCircuit:true,source:'globalThis.__optionalLoads.push('+JSON.stringify(name)+'); export const Bloom={attach(engine,options){const effect={name:"bloom",options,dispose(){engine.plugins.delete("bloom");}};engine.plugins.set("bloom",effect);return effect;}};'};
    }});`,
    );
    await writeFile(
      consumer,
      `import assert from 'node:assert/strict';
    import React from 'react';import {renderToString} from 'react-dom/server';
    import {Canvas,Stage,Mesh} from '@margoengine/react';
    import {Center} from '@margoengine/react';
    import {Gltf} from '@margoengine/react/gltf-pro';import {Box} from '@margoengine/react/geometry';import {Html} from '@margoengine/react/html';
    import {Text} from '@margoengine/react/text';import {Fbx} from '@margoengine/react/fbx';
    import {EffectComposer,Bloom,SSAO} from '@margoengine/react/post';import {DepthOfField} from '@margoengine/react/dof';
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
    const {Context}=await import(${JSON.stringify(pathToFileURL(join(packageRoot, 'dist/internal.js')).href)});
    const {render,act,cleanup}=await import('@testing-library/react');
    const engine={backend:'webgpu',gpu:{},plugins:new Map(),disposed:false,onError(error){throw error;}};
    const scene={engine,resources:{models:new Set()},frames:{callbacks:new Set()}};
    const view=render(h(Context.Provider,{value:scene},h(EffectComposer,null,h(Bloom))));
    await act(async()=>{});assert.deepEqual(globalThis.__optionalLoads,['@margoengine/post/bloom']);assert.equal(engine.plugins.size,1);
    cleanup();await act(async()=>{});assert.equal(engine.plugins.size,0);assert.equal(scene.frames.callbacks.size,0);
    console.log('Optional peer evaluation stayed lazy during SSR and isolated on mount');`,
    );
    const result = await runNode(['--import', pathToFileURL(hooks).href, consumer]);
    assert.match(result.stdout, /Optional peer evaluation stayed lazy/);
  }));

const baseConsumer = `import {createElement as h} from 'react';
  import {Canvas,Stage,Mesh,BoxGeometry,PbrMaterial} from '@margoengine/react';
  export const PickingCube=()=>h(Canvas,{frameloop:'demand'},h(Stage,null,h(Mesh,{onClick:event=>console.log(event.object.name)},h(BoxGeometry),h(PbrMaterial,{color:'#84d6bd'}))));`;
const optionalConsumer = `import {createElement as h} from 'react';
  import {Canvas} from '@margoengine/react';import {Box} from '@margoengine/react/geometry';import {Text} from '@margoengine/react/text';
  import {Gltf} from '@margoengine/react/gltf-pro';import {EffectComposer,Bloom} from '@margoengine/react/post';import {XR,Controller} from '@margoengine/react/xr';
  import {Physics,RigidBody} from '@margoengine/react/physics';
  export const OptionalScene=()=>h(Canvas,null,h(Box),h(Text,null,'Margo'),h(Gltf,{src:'/model.glb'}),h(EffectComposer,null,h(Bloom)),h(Physics,null,h(RigidBody,null,h(Box))),h(XR,null,h(Controller)));`;
function staticChunks(outputs) {
  const chunks = new Map(outputs.filter((item) => item.type === 'chunk').map((chunk) => [chunk.fileName, chunk])),
    seen = new Set();
  const visit = (chunk) => {
    if (seen.has(chunk)) return;
    seen.add(chunk);
    for (const name of chunk.imports) {
      const dependency = chunks.get(name);
      if (dependency) visit(dependency);
    }
  };
  for (const chunk of chunks.values()) if (chunk.isEntry) visit(chunk);
  return [...seen];
}
async function bundle(directory, name, source) {
  const entry = join(directory, name + '.js');
  await writeFile(entry, source);
  // Every warning the build prints, Vite's own and the bundler's. The packages resolve to their workspace folders,
  // outside node_modules, so Vite also reports ineffective dynamic imports inside them, as it does for a linked install.
  const warnings = [],
    record = (message) => warnings.push(String(message?.message ?? message));
  const result = await build({
    configFile: false,
    root: repository,
    logLevel: 'warn',
    customLogger: {
      info() {},
      warn: record,
      warnOnce: record,
      error: record,
      clearScreen() {},
      hasErrorLogged: () => false,
      hasWarned: false,
    },
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: { entry, formats: ['es'], fileName: name },
      rollupOptions: {
        external: (id) =>
          id === 'react' || id.startsWith('react/') || id === 'react-dom' || id.startsWith('react-dom/'),
        onwarn: record,
      },
    },
  });
  assert.deepEqual(warnings, [], `${name}: the build prints no warnings`);
  return (Array.isArray(result) ? result.flatMap((output) => output.output) : result.output).filter(
    (item) => item.type === 'chunk',
  );
}
test('Vite picking-cube initial chunk graph excludes optional React subpaths and native engines', async () =>
  temporary(async (directory) => {
    const outputs = await bundle(directory, 'picking-cube', baseConsumer),
      initial = staticChunks(outputs);
    assert.ok(initial.length > 0);
    const modules = initial.flatMap((chunk) => Object.keys(chunk.modules)).map((id) => id.replaceAll('\\', '/'));
    assert.ok(modules.some((id) => id.endsWith('/react/dist/components.js')));
    for (const fragment of [
      '/react/dist/model',
      '/react/dist/composer',
      '/react/dist/post',
      '/react/dist/physics',
      '/react/dist/xr',
      '/react/dist/picking',
      '/physics/',
      '/post/',
      '/dof/',
      '/tonemap/',
      '/taa/',
      '/xr/',
      '/geometry/',
      '/sky/',
      '/text/',
      '/fbx/',
      'rapier3d',
    ])
      assert.equal(
        modules.some((id) => id.includes(fragment)),
        false,
        fragment + ' is absent from the initial graph',
      );
    // The root reaches no optional package, not even lazily (2026-10-27): the build emits no chunk of one. Before, it
    // emitted the FBX loader and its exporters (2026-10-26) and, through the stage class, every stage pack.
    const emitted = outputs.flatMap((chunk) => Object.keys(chunk.modules)).map((id) => id.replaceAll('\\', '/'));
    assert.deepEqual(
      [...new Set(emitted.map((id) => /\/packages\/([\w-]+)\//.exec(id)?.[1]).filter(Boolean))].sort(),
      ['cache', 'core', 'math', 'react', 'shared', 'stage'].filter((name) =>
        emitted.some((id) => id.includes(`/packages/${name}/`)),
      ),
      'only the root, core, the stage and their dependencies are emitted',
    );
    for (const name of [
      'fbx',
      'gltf-pro',
      'selection',
      'shadows',
      'cameras',
      'gltf',
      'machinery',
      'scenery',
      'creative',
      'environment',
    ])
      assert.equal(
        emitted.some((id) => id.includes(`/packages/${name}/`)),
        false,
        `no ${name} chunk is emitted`,
      );
    const code = initial.map((chunk) => chunk.code).join('\n');
    assert.match(code, /\.pick\(/, 'Canvas picking survives the base consumer build');
    assert.equal(/EffectComposer|function Physics\(|function XR\(/.test(code), false);
    for (const chunk of outputs) assert.equal(/react-reconciler|from ["']three["']/.test(chunk.code), false);
  }));

test('an unused binding of the one-install entry emits nothing: preload is not a module-level side effect', async () =>
  temporary(async (directory) => {
    // `Model.preload = ...` at module level kept model.js, and its lazy gltf-pro import with the Draco and Basis
    // decoders, in every margoengine/react build (bundler matrix, 2026-10-27). The components are pure now.
    const outputs = await bundle(
      directory,
      'umbrella-cube',
      `import {createElement as h} from 'react';
  import {Canvas,Mesh,BoxGeometry,PbrMaterial} from 'margoengine/react';
  export const Cube=()=>h(Canvas,null,h(Mesh,null,h(BoxGeometry),h(PbrMaterial)));`,
    );
    const emitted = outputs.flatMap((chunk) => Object.keys(chunk.modules)).map((id) => id.replaceAll('\\', '/'));
    for (const name of [
      'gltf-pro',
      'fbx',
      'environment',
      'html',
      'text',
      'sky',
      'geometry',
      'post',
      'shadows',
      'decoders',
    ])
      assert.equal(
        emitted.some((id) => id.includes(`/packages/${name}/`)),
        false,
        `${name} is emitted`,
      );
    for (const file of ['model', 'fbx', 'environment', 'model-assets'])
      assert.equal(
        emitted.some((id) => id.endsWith(`/react/dist/${file}.js`)),
        false,
        `react/${file} is emitted`,
      );
  }));

test('OrbitControls loads the orbit controls entry only, never the controls index and its BVH raycaster', async () =>
  temporary(async (directory) => {
    // It loaded @margoengine/controls (index): every OrbitControls page fetched TransformControls, DragControls and
    // @margoengine/bvh as one 39 KB gzip chunk when the controls mounted (2026-10-26).
    const outputs = await bundle(
      directory,
      'orbit-cube',
      `import {createElement as h} from 'react';
  import {Canvas,Mesh,BoxGeometry,PbrMaterial} from '@margoengine/react';
  import {OrbitControls} from '@margoengine/react/controls';
  export const OrbitCube=()=>h(Canvas,null,h(Mesh,null,h(BoxGeometry),h(PbrMaterial)),h(OrbitControls,{profile:'blender'}));`,
    );
    const emitted = outputs.flatMap((chunk) => Object.keys(chunk.modules ?? {})).map((id) => id.replaceAll('\\', '/'));
    assert.ok(emitted.some((id) => id.endsWith('/controls/src/orbit.ts') || id.endsWith('/controls/dist/orbit.js')));
    assert.deepEqual(
      emitted.filter((id) =>
        /\/bvh\/|\/controls\/(src|dist)\/(index|transform|drag|gizmo|pointer-lock|fly|walk)\.(ts|js)$/.test(id),
      ),
      [],
      'no controls index, gizmo, drag or BVH module is emitted for OrbitControls',
    );
  }));

test('Vite optional entry includes requested bindings while keeping their native peers off the initial graph', async () =>
  temporary(async (directory) => {
    const outputs = await bundle(directory, 'optional-scene', optionalConsumer),
      initial = staticChunks(outputs);
    const modules = initial.flatMap((chunk) => Object.keys(chunk.modules)).map((id) => id.replaceAll('\\', '/'));
    for (const subpath of ['geometry', 'text', 'model', 'composer', 'physics', 'xr'])
      assert.ok(
        modules.some((id) => id.endsWith('/react/dist/' + subpath + '.js')),
        subpath + ' React binding is present',
      );
    for (const fragment of [
      '/packages/physics/',
      '/packages/post/',
      '/packages/xr/',
      '/packages/text/',
      '/packages/gltf-pro/',
      'rapier3d',
    ])
      assert.equal(
        modules.some((id) => id.includes(fragment)),
        false,
        fragment + ' native peer remains lazy',
      );
    const all = outputs.flatMap((chunk) => Object.keys(chunk.modules)).map((id) => id.replaceAll('\\', '/'));
    for (const fragment of [
      '/packages/physics/',
      '/packages/post/',
      '/packages/xr/',
      '/packages/text/',
      '/packages/gltf-pro/',
      'rapier3d',
    ])
      assert.ok(
        all.some((id) => id.includes(fragment)),
        fragment + ' has a deferred output chunk',
      );
  }));

test('strict TypeScript consumers compile every public React subpath, callbacks and canonical scene snippets', async () =>
  temporary(async (directory) => {
    await writeFile(
      join(directory, 'consumer.tsx'),
      `import React,{Suspense,useRef} from 'react';
    import {Canvas,Stage,Mesh,Group,BoxGeometry,Center,useFrame,useMargo,type MeshRef} from '@margoengine/react';
    import {Model,Gltf,type GltfProps} from '@margoengine/react/gltf-pro';import {Fbx,type FbxProps} from '@margoengine/react/fbx';
    import {Animation} from '@margoengine/react/animation';import {MeshTransmissionMaterial} from '@margoengine/react/materials';
    import {Box,Sphere,Plane,type BoxProps} from '@margoengine/react/geometry';import {Sky} from '@margoengine/react/sky';
    import {ContactShadows} from '@margoengine/react/shadows';import {PointerLock,TransformControls,OrbitControls} from '@margoengine/react/controls';
    import {Text,type TextProps} from '@margoengine/react/text';import {Html} from '@margoengine/react/html';import {Environment} from '@margoengine/react/environment';
    import {EffectComposer,Bloom,SSAO,type BloomProps,type EffectComposerProps} from '@margoengine/react/post';
    import {DepthOfField,type DepthOfFieldProps} from '@margoengine/react/dof';import {Tonemap,type TonemapProps} from '@margoengine/react/tonemap';import {TAA,type TAAProps} from '@margoengine/react/taa';
    import {Physics,RigidBody,CuboidCollider,BallCollider,usePhysics,type PhysicsProps,type RigidBodyProps,type PhysicsBody} from '@margoengine/react/physics';
    import {XR,Controller,useXR,type XRProps,type ControllerProps,type XRContextValue} from '@margoengine/react/xr';
    function Hooks(){const state=useMargo(),world=usePhysics(),xr:XRContextValue=useXR();state.invalidate();state.camera?.position;state.size.width;state.gl?.canvas;state.clock.toFixed(2);world?.raycast([0,0,0],[0,-1,0]);void xr.ready;useFrame((engine,delta)=>{engine.camera.fov+=delta;});return null;}
    const loader:GltfProps={src:'/model.glb'},fbx:FbxProps={src:'/model.fbx'},box:BoxProps={args:[1,1,1],color:'#84d6bd',roughness:0.25},text:TextProps={text:'Margo'};
    const bloom:BloomProps={strength:1,onReady:effect=>{effect.options.strength=0.5;}},dof:DepthOfFieldProps={focalDistance:8},tone:TonemapProps={curve:'agx'},taa:TAAProps={historyWeight:0.9},composer:EffectComposerProps={enabled:true};
    const physics:PhysicsProps={gravity:[0,-9.81,0]},body:RigidBodyProps={type:'dynamic',onReady:(value:PhysicsBody)=>value.wakeUp()},xr:XRProps={mode:'immersive-vr'},controller:ControllerProps={handedness:'left',onSelect:event=>event.controller.source};
    export function App(){const ref=useRef<MeshRef>(null);return <Canvas frameloop="demand"><Stage><Mesh ref={ref} onClick={event=>{event.object.name;}}/><Group><Center><Box {...box}/><Sphere/><Plane/></Center></Group><Suspense fallback={<span>Loading</span>}><Gltf {...loader}/><Model src="/second.glb"/><Fbx {...fbx}/><Environment src="/studio.hdr"/></Suspense><Sky/><ContactShadows/><PointerLock/><TransformControls object={ref}/><Text {...text}/><Html>Label</Html><OrbitControls/><EffectComposer {...composer}><Bloom {...bloom}/><SSAO/><DepthOfField {...dof}/><Tonemap {...tone}/><TAA {...taa}/></EffectComposer><Physics {...physics}><RigidBody {...body}><Mesh/></RigidBody></Physics><XR {...xr}><Controller {...controller}/></XR></Stage></Canvas>;}
    void Gltf.preload('/model.glb');void Fbx.preload('/model.fbx');void Environment.preload('/studio.hdr');void Hooks;
    export const materialAndClip=<Canvas><Mesh><BoxGeometry/><MeshTransmissionMaterial factor={0.8} ior={1.5} volume={{thicknessFactor:0.5}}/></Mesh><Gltf src="/character.glb" onClick={event=>event.object.name}><Animation clip="Walk" playing loop blend={0.2}/></Gltf></Canvas>;
    export const assetBodies=<Physics><RigidBody colliders="cuboid"><Fbx src="/asset.fbx"/></RigidBody><RigidBody colliders="hull"><Gltf src="/asset.glb"/></RigidBody><RigidBody colliders="trimesh"><Box/></RigidBody><RigidBody colliders={false}><CuboidCollider args={[0.5,1,0.5]}/><BallCollider args={[0.25]}/><Fbx src="/asset.fbx"/></RigidBody></Physics>;
    // @ts-expect-error Automatic collider modes are explicit and bounded.
    export const invalidCollider:RigidBodyProps={colliders:'gpu-mesh'};
    // @ts-expect-error useThree is intentionally not part of this package.
    import {useThree} from '@margoengine/react';
  `,
    );
    await writeFile(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          jsx: 'react-jsx',
          skipLibCheck: true,
        },
        files: ['consumer.tsx'],
      }),
    );
    await runNode([join(repository, 'node_modules/typescript/bin/tsc'), '-p', join(directory, 'tsconfig.json')]);
  }));

test('the root entry never names Rapier, so apps without physics build with webpack and Turbopack', async () => {
  // Bundlers resolve every string-literal import() they reach, used or not: one inside the root's module graph made
  // `@dimforge/rapier3d-compat` a required install for any app importing '@margoengine/react' (bundler matrix,
  // 2026-10-25). Physics lives only in '@margoengine/react/physics'.
  const seen = new Set(),
    pending = [join(packageRoot, 'dist/index.js')];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const code = await readFile(file, 'utf8');
    assert.equal(code.includes('rapier3d'), false, `${file} names Rapier`);
    for (const [, path] of code.matchAll(/(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g))
      pending.push(join(dirname(file), path));
  }
  assert.ok(seen.size > 5, 'the walk reached the root modules');
  assert.equal(
    [...seen].some((file) => file.endsWith('physics.js')),
    false,
  );
});
