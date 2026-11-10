import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from '../../../scripts/browser.js';
import {runComputeOnCPU} from '@margoengine/webgl2-compat/compute';
import {DENOISE_ML} from '../src/denoise-ml-shader.ts';
import {WEIGHTS} from '../src/denoise-ml-weights.ts';
function reference(image){
 const params=new Uint32Array([image.width,image.height,0,0]);new Float32Array(params.buffer)[2]=image.samples;
 const count=image.width*image.height,out=new Float32Array(count*3),alpha=image.alpha?new Float32Array(image.alpha):new Float32Array(count).fill(1);
 runComputeOnCPU({source:DENOISE_ML,entryPoint:'denoiseML',workgroups:[Math.ceil(image.width/8),Math.ceil(image.height/8)],workBudget:50_000_000,buffers:new Map([['0:0',params],['0:1',new Float32Array(WEIGHTS)],['0:2',new Float32Array(image.color)],['0:3',new Float32Array(image.albedo)],['0:4',new Float32Array(image.normal)],['0:5',alpha],['0:6',out]])});return out;
}
const rows=[];let fixture;
for(const compat of [false,true]){
 const context=await openBrowser({startPath:'/packages/voxel-pathtracer/tests/denoise-ml.html',port:'free',...(compat&&process.platform==='win32'?{args:['--use-angle=vulkan']}:{})});const errors=[];context.page.on('pageerror',e=>errors.push(e.message));context.page.on('console',m=>{if(m.text().startsWith('ml phase'))console.log(m.text());});
 try{
  await context.page.waitForFunction(()=>window.ready,null,{timeout:120000});
  const result=await context.page.evaluate(({compat,fixture})=>window.run(compat,fixture),{compat,fixture});
  await writeFile(`test-results/denoise-ml-${compat?'compat':'native'}-raw.json`,JSON.stringify(result));
  assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[]);assert.deepEqual(result.messages,[]);assert.ok(result.constantError<1e-5);assert.equal(result.alphaPreserved,true);assert.equal(result.replacement,true);
  const returnedFixture=result.fixture;fixture??=returnedFixture;
  for(const [name,input,output] of [['synthetic',result.synthetic,result.syntheticOutput],['real Box',fixture.raw,result.realOutput]]){
   const cpu=reference(input);let maximumError=0;for(let i=0;i<cpu.length;i++)maximumError=Math.max(maximumError,Math.abs(cpu[i]-output[i]));assert.ok(maximumError<1e-4,`${name}: ${maximumError}`);result[`${name}CPUError`]=maximumError;
  }
  assert.ok(result.syntheticMSE.network<result.syntheticMSE.raw,JSON.stringify(result.syntheticMSE));assert.ok(result.realMSE.network<result.realMSE.raw,JSON.stringify(result.realMSE));
  delete result.fixture;delete result.synthetic;delete result.syntheticOutput;delete result.realOutput;
  console.log(JSON.stringify({compat,hardware:context.hardware,result}));rows.push({compat,hardware:context.hardware,result});
 }finally{await context.close();}
}
await writeFile('test-results/voxel-pathtracer-denoise-ml.json',JSON.stringify({training:'tests/fixtures/denoise-ml-training.json',asset:fixture.asset,referenceSamples:fixture.referenceSamples,rows},null,2));
