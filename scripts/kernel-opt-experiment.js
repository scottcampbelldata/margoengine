// Isolated Cargo profile comparison. This never rewrites the shipping kernel or dist.
// Optional: --toolchain=<absolute Rust toolchain directory> --output=<experiment directory>
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {build} from 'vite';
import {compactOutput,external} from './measure-size.js';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const argument=name=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3);
const output=resolve(argument('output')??join(repository,'test-results/kernel-opt-experiment'));
const toolchain=argument('toolchain');
const binary=name=>toolchain?join(toolchain,'bin',name+(process.platform==='win32'?'.exe':'')):name;
const cargo=binary('cargo'),rustc=binary('rustc');
const digest=value=>createHash('sha256').update(value).digest('hex');
const protectedFiles=['packages/core/src/kernel.ts','packages/core/src/wasm.ts','packages/kernel/Cargo.toml','packages/kernel/src/lib.rs','packages/core/dist/wasm.js'];
const protectedHashes=await Promise.all(protectedFiles.map(async name=>[name,digest(await readFile(join(repository,name)))]));
const environment={...process.env,CARGO_HOME:join(output,'cargo'),RUSTUP_HOME:join(output,'rustup'),RUSTC:rustc};
if(toolchain){
  const nativeLinker=join(toolchain,'lib/rustlib/x86_64-pc-windows-gnu/bin/self-contained/x86_64-w64-mingw32-gcc.exe');
  environment.PATH=join(toolchain,'bin')+(process.platform==='win32'?';':':')+(environment.PATH??'');
  if(process.platform==='win32'&&toolchain.includes('windows-gnu'))environment.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=nativeLinker;
}
const run=(command,args,env=environment)=>execFileSync(command,args,{cwd:output,env,encoding:'utf8',maxBuffer:4*1024*1024});
await mkdir(output,{recursive:true});
const report={rustc:run(rustc,['--version']).trim(),cargo:run(cargo,['--version']).trim(),sourceSha256:protectedHashes,variants:{},benchmarks:[]};
const wasmSource=await readFile(join(repository,'packages/core/src/wasm.ts'),'utf8');
const shippingCompressed=Buffer.from(/wasmBase64(?::\s*string)?\s*=\s*'([^']+)'/.exec(wasmSource)[1],'base64');
const shipping=gunzipSync(shippingCompressed);

async function stageSize(compressed){
  const wasmModule=resolve(repository,'packages/core/dist/wasm.js').replaceAll('\\','/');
  const result=await build({root:repository,configFile:false,publicDir:false,logLevel:'silent',plugins:[{name:'isolated-kernel-blueprint',load(id){if(id.replaceAll('\\','/')===wasmModule)return 'export const wasmBase64='+JSON.stringify(compressed.toString('base64'))+';';}}],build:{write:false,minify:true,target:'es2022',lib:{entry:join(repository,'packages/margoengine/dist/index.js'),formats:['es']},rollupOptions:{external:external.filter(name=>!name.startsWith('@margoengine/core')),output:compactOutput}}});
  const code=result[0].output.filter(item=>item.type==='chunk').map(item=>item.code).join('\n');
  return {raw:Buffer.byteLength(code),gzip:gzipSync(code).length};
}
report.shipping={wasmRaw:shipping.length,wasmGzip:shippingCompressed.length,...await stageSize(shippingCompressed)};
for(const [name,optimization] of [['speed',3],['size','z']]){
  const project=join(output,name);await mkdir(join(project,'src'),{recursive:true});
  for(const filename of ['Cargo.lock','src/lib.rs'])await copyFile(join(repository,'packages/kernel',filename),join(project,filename));
  const manifest=(await readFile(join(repository,'packages/kernel/Cargo.toml'),'utf8')).replace('opt-level = 3','opt-level = '+JSON.stringify(optimization));
  await writeFile(join(project,'Cargo.toml'),manifest);
  const env={...environment,CARGO_TARGET_DIR:join(project,'target')};
  console.log('Compiling isolated kernel opt-level='+optimization);
  run(cargo,['build','--offline','--manifest-path',join(project,'Cargo.toml'),'--target','wasm32-unknown-unknown','--release'],{...env,RUSTFLAGS:'-C target-feature=+simd128'});
  const wasmPath=join(project,'target/wasm32-unknown-unknown/release/margoengine_kernel.wasm'),optimizedPath=join(project,'optimized.wasm');
  run(process.execPath,[join(repository,'node_modules/binaryen/bin/wasm-opt'),wasmPath,'-O3','--enable-simd','--enable-bulk-memory','--enable-bulk-memory-opt','--enable-nontrapping-float-to-int','--strip-debug','--strip-producers','--strip-target-features','--converge','-o',optimizedPath]);
  const bytes=await readFile(optimizedPath),compressed=gzipSync(bytes,{level:5,memLevel:6,windowBits:12});
  assert.ok(WebAssembly.validate(bytes));assert.deepEqual(gunzipSync(compressed),bytes);
  const nativeTests=run(cargo,['test','--offline','--manifest-path',join(project,'Cargo.toml'),'--release'],{...env,RUSTFLAGS:''});
  report.variants[name]={optimization,wasmRaw:bytes.length,wasmGzip:compressed.length,wasmSha256:digest(bytes),...await stageSize(compressed),nativeTests:nativeTests.trim()};
  await writeFile(join(project,'native-tests.txt'),nativeTests);
}

async function kernel(name,capacity,kind){
  const bytes=name==='shipping'?shipping:await readFile(join(output,name,'optimized.wasm'));
  const {instance}=await WebAssembly.instantiate(bytes),api=instance.exports,handle=api.kernel_new(capacity),at=api.kernel_data(handle),flagAt=api.kernel_flags(handle);
  assert.ok(handle);const data=new Float32Array(api.memory.buffer,at,capacity*70+24),flags=new Uint8Array(api.memory.buffer,flagAt,capacity*5);
  for(let id=0;id<capacity;id++){
    flags[id]=1;data[id]=id%32-16;data[capacity+id]=Math.floor(id/32)%32-16;data[2*capacity+id]=id%5;
    data[6*capacity+id]=1;for(let lane=7;lane<10;lane++)data[lane*capacity+id]=1;
    data[27*capacity+id*4+3]=.5;
    if(kind==='hierarchy'&&id%16)data[10*capacity+id]=id-1;
    if(kind==='limits'){
      flags[2*capacity+id]=56;
      for(let axis=0;axis<3;axis++){data[35*capacity+24+id*3+axis]=1.5;const limit=38*capacity+24+id*12+(axis+3)*2;data[limit]=-1;data[limit+1]=1;}
    }
  }
  for(let plane=0;plane<6;plane++){data[35*capacity+plane*4+Math.floor(plane/2)]=plane%2?1:-1;data[35*capacity+plane*4+3]=32;}
  return {data,flags,tick(){assert.equal(api.kernel_tick(handle,kind==='culling'?1:0),0);},close(){api.kernel_drop(handle);}};
}
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
for(const capacity of [1000,10000])for(const kind of ['flat','hierarchy','limits','culling']){
  const reference=await kernel('speed',capacity,kind),candidate=await kernel('size',capacity,kind),current=await kernel('shipping',capacity,kind);
  try{
    reference.tick();candidate.tick();current.tick();
    assert.deepEqual(candidate.data,reference.data,kind+' candidate data parity');assert.deepEqual(candidate.flags,reference.flags,kind+' candidate flags parity');
    assert.deepEqual(current.data,reference.data,kind+' shipping data parity');assert.deepEqual(current.flags,reference.flags,kind+' shipping flags parity');
    for(let index=0;index<100;index++){reference.tick();candidate.tick();current.tick();}
    const batch=capacity===1000?100:20,samples={speed:[],size:[],shipping:[]},items={speed:reference,size:candidate,shipping:current};
    for(let sample=0;sample<31;sample++)for(const name of sample%2?['size','shipping','speed']:['speed','shipping','size']){
      const started=performance.now();for(let tick=0;tick<batch;tick++)items[name].tick();samples[name].push((performance.now()-started)/batch);
    }
    const values={capacity,kind,batch,samples:31,speedMs:median(samples.speed),sizeMs:median(samples.size),shippingMs:median(samples.shipping)};
    report.benchmarks.push({...values,sizeVsSpeed:values.sizeMs/values.speedMs,sizeVsShipping:values.sizeMs/values.shippingMs});
    console.log(JSON.stringify(report.benchmarks.at(-1)));
  }finally{reference.close();candidate.close();current.close();}
}
report.decision={gzipDropVsShipping:report.variants.size.gzip<report.shipping.gzip,gzipDropVsSpeed:report.variants.size.gzip<report.variants.speed.gzip,slowerScenarios:report.benchmarks.filter(sample=>sample.sizeVsSpeed>1.02||sample.sizeVsShipping>1.02).map(sample=>({capacity:sample.capacity,kind:sample.kind,sizeVsSpeed:sample.sizeVsSpeed,sizeVsShipping:sample.sizeVsShipping}))};
report.decision.keep=report.decision.gzipDropVsShipping&&report.decision.gzipDropVsSpeed&&report.decision.slowerScenarios.length===0;
for(const [name,hash] of protectedHashes)assert.equal(digest(await readFile(join(repository,name))),hash,'Experiment must preserve '+name);
await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({shipping:report.shipping,variants:report.variants,decision:report.decision},null,2));
