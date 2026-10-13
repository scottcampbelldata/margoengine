import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, rm, readdir } from 'node:fs/promises';
import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { gzipSync,gunzipSync } from 'node:zlib';
import { compactInternals } from './compact-internals.js';
import { compactOutput, external, measureCoreStage } from './measure-size.js';
async function compactPackage(name){
 const root=`packages/${name}/dist`,files=(await readdir(root)).filter(file=>file.endsWith('.js'));
 for(const file of files)await writeFile(`${root}/${file}`,compactInternals(await readFile(`packages/${name}/src/${file.replace(/\.js$/,'.ts')}`,'utf8'),await readFile(`${root}/${file}`,'utf8')));
 // Keep module paths and identities intact, including the extension entry point.
 const output=await build({configFile:false,publicDir:false,logLevel:'warn',build:{write:false,minify:true,target:'es2022',lib:{entry:Object.fromEntries(files.map(file=>[file.slice(0,-3),`${root}/${file}`])),formats:['es'],fileName:(_,name)=>`${name}.js`},rollupOptions:{external:(_id,importer)=>!!importer,output:compactOutput}}});
 for(const chunk of output[0].output){assert.equal(chunk.type,'chunk');assert.ok(files.includes(chunk.fileName),'Unexpected library chunk');await writeFile(`${root}/${chunk.fileName}`,chunk.code);}
}

const precompiled=process.argv.includes('--precompiled');
const wasmPath='packages/kernel/target/wasm32-unknown-unknown/release/margoengine_kernel.wasm',optimizedPath=wasmPath.replace('.wasm','.optimized.wasm');
if(!precompiled)execFileSync('cargo',['build','--manifest-path','packages/kernel/Cargo.toml','--target','wasm32-unknown-unknown','--release'],{stdio:'inherit',env:{...process.env,CARGO_TARGET_DIR:resolve('packages/kernel/target'),RUSTFLAGS:'-C target-feature=+simd128'}});
if(!precompiled)execFileSync(process.execPath,['node_modules/binaryen/bin/wasm-opt',wasmPath,'-O3','--enable-simd','--enable-bulk-memory','--enable-bulk-memory-opt','--enable-nontrapping-float-to-int','--strip-debug','--strip-producers','--strip-target-features','--converge','-o',optimizedPath],{stdio:'inherit'});
const wasm=precompiled?gunzipSync(Buffer.from(/wasmBase64(?::\s*string)?\s*=\s*'([^']+)'/.exec(await readFile('packages/core/src/wasm.ts','utf8'))[1],'base64')):await readFile(optimizedPath);
assert.ok(wasm.length<30*1024,`Kernel exceeds 30 KiB: ${wasm.length}`);
assert.ok(WebAssembly.validate(wasm),'Invalid Wasm artifact');
const compressedWasm=gzipSync(wasm,{level:5,memLevel:6,windowBits:12});
assert.deepEqual(gunzipSync(compressedWasm),wasm,'Kernel compression must be lossless');
if(!precompiled)await writeFile('packages/core/src/wasm.ts',`// Generated gzip blueprint; consumers need no Rust toolchain.\nexport const wasmBase64: string = '${compressedWasm.toString('base64')}';\n`);
const machineryPath='packages/machinery/kernel/target/wasm32-unknown-unknown/release/margoengine_machinery_kernel.wasm';
if(!precompiled){
 execFileSync('cargo',['build','--manifest-path','packages/machinery/kernel/Cargo.toml','--target','wasm32-unknown-unknown','--release'],{stdio:'inherit',env:{...process.env,CARGO_TARGET_DIR:resolve('packages/machinery/kernel/target'),RUSTFLAGS:'-C target-feature=+simd128'}});
 execFileSync(process.execPath,['node_modules/binaryen/bin/wasm-opt',machineryPath,'-O3','--enable-simd','--enable-bulk-memory','--enable-nontrapping-float-to-int','--strip-debug','--strip-producers','-o',machineryPath+'.optimized'],{stdio:'inherit'});
 await writeFile('packages/machinery/src/wasm.ts',`// Generated machinery kernel; consumers need no Rust toolchain.\nexport const machineryWasm: string = '${gzipSync(await readFile(machineryPath+'.optimized')).toString('base64')}';\n`);
}
const featurePackages=['gltf-pro','blender','animation','post','shadows','clustered','vfx','animator','taa','splats','geometry','terrain','xr','ifc','usdz','dof','tonemap','lines','stats','inspector','environment','controls'];
const packages=['core','gltf','react','loaders','exporters','machinery','creative','scenery',...featurePackages,'margoengine'];
for(const name of packages){
 const output=resolve(`packages/${name}/dist`);assert.equal(dirname(output),resolve(`packages/${name}`),'Output escaped its package');
 await rm(output,{recursive:true,force:true});await copyFile('LICENSE',`packages/${name}/LICENSE`);
}
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','packages/core/tsconfig.json'],{stdio:'inherit'});
await compactPackage('core');
for(const name of ['loaders','exporters'])execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p',`packages/${name}/tsconfig.json`],{stdio:'inherit'});
for(const name of ['gltf','machinery','creative','scenery',...featurePackages]){
 const output=resolve(`packages/${name}/dist`);assert.ok(output.startsWith(resolve(`packages/${name}`)+'/')||output.startsWith(resolve(`packages/${name}`)+'\\'),'Output escaped its package');
 const manifest=JSON.parse(await readFile(`packages/${name}/package.json`,'utf8'));
 const entry=Object.fromEntries(Object.values(manifest.exports).map(({import:target})=>{
  assert.ok(/^\.\/dist\/[\w-]+\.js$/.test(target),'Unsupported package entry: '+target);
  const module=target.slice('./dist/'.length,-'.js'.length);
  return [module,`packages/${name}/src/${module}.ts`];
 }));
 await build({configFile:false,publicDir:false,logLevel:'warn',build:{outDir:output,emptyOutDir:true,target:'es2022',lib:{entry,formats:['es'],fileName:(_,entryName)=>entryName+'.js'},rollupOptions:{external:['@margoengine/core','@margoengine/core/extension','@margoengine/animation','@margoengine/gltf-pro','@margoengine/loaders','@margoengine/lines'],output:compactOutput}}});
 if(name==='machinery'){
  // Retain analyzable asset URLs for the consuming app's bundler.
  for(const file of (await readdir(output)).filter(file=>file.endsWith('.js'))){const entry=resolve(output,file);await writeFile(entry,(await readFile(entry,'utf8')).replace(/(?:''|""|``)\s*\+\s*import\.meta\.url/g,'import.meta.url'));}
  await build({configFile:false,publicDir:false,logLevel:'warn',build:{outDir:resolve(output,'workers'),emptyOutDir:true,target:'es2022',lib:{entry:'packages/machinery/src/workers/cad-worker.ts',name:'CADWorker',formats:['iife'],fileName:()=> 'cad-runtime.js'}}});
  for(const file of ['occt-import-js.js','occt-import-js.wasm'])await copyFile(`node_modules/occt-import-js/dist/${file}`,resolve(output,'workers',file));
  await copyFile('node_modules/occt-import-js/LICENSE.md',resolve(output,'workers/OCCT-LICENSE.txt'));
  await copyFile('packages/machinery/src/workers/OCCT-NOTICE.txt',resolve(output,'workers/OCCT-NOTICE.txt'));
}
 execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p',`packages/${name}/tsconfig.json`],{stdio:'inherit'});
}
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','packages/margoengine/tsconfig.json'],{stdio:'inherit'});
await compactPackage('margoengine');
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','packages/react/tsconfig.json'],{stdio:'inherit'});
const sizes={kernel:{raw:wasm.length,gzip:compressedWasm.length}};
for(const name of packages){
  let output=await build({configFile:false,publicDir:false,logLevel:'silent',build:{write:false,minify:true,target:'es2022',lib:{entry:`packages/${name}/dist/index.js`,formats:['es']},rollupOptions:{external,output:compactOutput}}});
  output=Array.isArray(output)?output[0]:output;
  const chunks=output.output.filter(item=>item.type==='chunk'),code=chunks.map(chunk=>chunk.code).join('\n');
  assert.ok(chunks.every(chunk=>Object.keys(chunk.modules).every(id=>!id.includes('/src/scene.js')&&!id.includes('/src/engine.js'))),'Legacy scene/engine leaked into modern packages');
  if(name==='core')assert.ok(chunks.every(chunk=>Object.keys(chunk.modules).every(id=>!['machinery','creative','scenery','loaders','exporters',...featurePackages].some(pack=>id.includes(`/packages/${pack}/`)))),'Domain pack leaked into core');
  sizes[name]={raw:Buffer.byteLength(code),gzip:gzipSync(code).length};
}
assert.ok(sizes.core.gzip<20*1024,'Core exceeds 20 KiB gzip');
assert.ok(sizes.core.gzip+sizes.gltf.gzip<30*1024,'Core + glTF exceed 30 KiB gzip');
const {modules,...baseSize}=await measureCoreStage();
sizes.base=baseSize;
assert.ok(modules.every(id=>!['loaders','exporters',...featurePackages].some(pack=>id.includes(`/packages/${pack}/`))),'Optional feature package leaked into core + stage');
const shake=await build({configFile:false,publicDir:false,logLevel:'silent',build:{write:false,minify:true,target:'es2022',lib:{entry:'tests/modern-particle-consumer.js',formats:['es']},rollupOptions:{external:['@margoengine/core','@margoengine/core/extension']}}});
const shaken=(Array.isArray(shake)?shake[0]:shake).output.filter(item=>item.type==='chunk').map(chunk=>chunk.code).join('\n');assert.ok(!shaken.includes('post-processing')&&!shaken.includes('toon-shading')&&!shaken.includes('rgba16float'),'Unused creative effects leaked into a particle-only consumer');sizes.particlesOnly={raw:Buffer.byteLength(shaken),gzip:gzipSync(shaken).length};
await mkdir('test-results',{recursive:true});await writeFile('test-results/modern-bundle-sizes.json',JSON.stringify(sizes,null,2));
const isolation=await build({configFile:false,publicDir:false,logLevel:'silent',build:{write:false,target:'es2022',lib:{entry:'tests/modern-machinery-consumer.js',formats:['es']}}});
for(const chunk of (Array.isArray(isolation)?isolation[0]:isolation).output.filter(item=>item.type==='chunk'))assert.ok(Object.keys(chunk.modules).every(id=>!id.includes('/creative/')&&!id.includes('/scenery/')),'Creative/scenery code leaked into a machinery consumer');
console.error(JSON.stringify(sizes,null,2));

