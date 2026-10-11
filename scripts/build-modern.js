import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { build } from 'vite';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { gzipSync,gunzipSync } from 'node:zlib';

const precompiled=process.argv.includes('--precompiled');
const wasmPath='packages/kernel/target/wasm32-unknown-unknown/release/vexel_kernel.wasm',optimizedPath=wasmPath.replace('.wasm','.optimized.wasm');
if(!precompiled)execFileSync('cargo',['build','--manifest-path','packages/kernel/Cargo.toml','--target','wasm32-unknown-unknown','--release'],{stdio:'inherit',env:{...process.env,CARGO_TARGET_DIR:resolve('packages/kernel/target'),RUSTFLAGS:'-C target-feature=+simd128'}});
if(!precompiled)execFileSync(process.execPath,['node_modules/binaryen/bin/wasm-opt',wasmPath,'-O3','--enable-simd','--enable-bulk-memory','--enable-bulk-memory-opt','--enable-nontrapping-float-to-int','--strip-debug','--strip-producers','--strip-target-features','--converge','-o',optimizedPath],{stdio:'inherit'});
const wasm=precompiled?gunzipSync(Buffer.from(/wasmBase64(?::\s*string)?\s*=\s*'([^']+)'/.exec(await readFile('packages/core/src/wasm.ts','utf8'))[1],'base64')):await readFile(optimizedPath);
assert.ok(wasm.length<30*1024,`Kernel exceeds 30 KiB: ${wasm.length}`);
assert.ok(WebAssembly.validate(wasm),'Invalid Wasm artifact');
if(!precompiled)await writeFile('packages/core/src/wasm.ts',`// Generated gzip blueprint; consumers need no Rust toolchain.\nexport const wasmBase64: string = '${gzipSync(wasm).toString('base64')}';\n`);
for(const name of ['core','react'])execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p',`packages/${name}/tsconfig.json`],{stdio:'inherit'});
for(const name of ['gltf','machinery','creative']){
 const output=resolve(`packages/${name}/dist`);assert.ok(output.startsWith(resolve(`packages/${name}`)+'/')||output.startsWith(resolve(`packages/${name}`)+'\\'),'Output escaped its package');
 await build({configFile:false,publicDir:false,logLevel:'warn',build:{outDir:output,emptyOutDir:true,target:'es2022',lib:{entry:`packages/${name}/src/index.ts`,formats:['es'],fileName:'index'},rollupOptions:{external:['@vexel/core','@vexel/core/extension']}}});
 execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p',`packages/${name}/tsconfig.json`],{stdio:'inherit'});
}
const sizes={kernel:{raw:wasm.length,gzip:gzipSync(wasm).length}};
for(const name of ['core','gltf','react','machinery','creative']){
  let output=await build({configFile:false,publicDir:false,logLevel:'silent',build:{write:false,minify:true,target:'es2022',lib:{entry:`packages/${name}/dist/index.js`,formats:['es']},rollupOptions:{external:['@vexel/core','@vexel/core/extension','react','react/jsx-runtime']}}});
  output=Array.isArray(output)?output[0]:output;
  const chunks=output.output.filter(item=>item.type==='chunk'),code=chunks.map(chunk=>chunk.code).join('\n');
  assert.ok(chunks.every(chunk=>Object.keys(chunk.modules).every(id=>!id.includes('/src/scene.js')&&!id.includes('/src/engine.js'))),'Legacy scene/engine leaked into modern packages');
  if(name==='core')assert.ok(chunks.every(chunk=>Object.keys(chunk.modules).every(id=>!id.includes('/machinery/')&&!id.includes('/creative/'))),'Domain pack leaked into core');
  sizes[name]={raw:Buffer.byteLength(code),gzip:gzipSync(code).length};
}
assert.ok(sizes.core.gzip<20*1024,'Core exceeds 20 KiB gzip');
assert.ok(sizes.core.gzip+sizes.gltf.gzip<30*1024,'Core + glTF exceed 30 KiB gzip');
const shake=await build({configFile:false,publicDir:false,logLevel:'silent',build:{write:false,minify:true,target:'es2022',lib:{entry:'tests/modern-particle-consumer.js',formats:['es']},rollupOptions:{external:['@vexel/core','@vexel/core/extension']}}});
const shaken=(Array.isArray(shake)?shake[0]:shake).output.filter(item=>item.type==='chunk').map(chunk=>chunk.code).join('\n');assert.ok(!shaken.includes('post-processing')&&!shaken.includes('toon-shading')&&!shaken.includes('rgba16float'),'Unused creative effects leaked into a particle-only consumer');sizes.particlesOnly={raw:Buffer.byteLength(shaken),gzip:gzipSync(shaken).length};
await mkdir('test-results',{recursive:true});await writeFile('test-results/modern-bundle-sizes.json',JSON.stringify(sizes,null,2));
const isolation=await build({configFile:false,publicDir:false,logLevel:'silent',build:{write:false,target:'es2022',lib:{entry:'tests/modern-machinery-consumer.js',formats:['es']}}});
for(const chunk of (Array.isArray(isolation)?isolation[0]:isolation).output.filter(item=>item.type==='chunk'))assert.ok(Object.keys(chunk.modules).every(id=>!id.includes('/creative/')),'Creative code leaked into a machinery consumer');
console.log(JSON.stringify(sizes,null,2));

