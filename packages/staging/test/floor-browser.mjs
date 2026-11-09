import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';
const context=await openBrowser({startPath:'/packages/staging/test/floor-browser.html',port:'free'});
const {page}=context,errors=[];page.on('pageerror',e=>errors.push(e.message));
const shot=async(roughness,visible=true)=>{assert.deepEqual(await page.evaluate(o=>window.check.draw(...o),[roughness,visible]),[]);return decodePNG(await page.locator('canvas').screenshot());};
const variance=image=>{let sum=0,squares=0,n=0;for(let k=0;k<image.data.length;k++)if(k%4!==3){const v=image.data[k];sum+=v;squares+=v*v;n++;}return squares/n-(sum/n)**2;};
try{
 await page.waitForFunction(()=>window.ready,null,{timeout:30000});
 const sharp=await shot(0),rough=await shot(.4),region=await page.evaluate(()=>window.check.region());
 const empty=await shot(.4,false);await shot(.4);
 let reflectionPixels=0,blurPixels=0;
 for(let y=region;y<256;y++)for(let x=0;x<256;x++){const k=(y*256+x)*4;if([0,1,2].some(c=>Math.abs(rough.data[k+c]-empty.data[k+c])>5))reflectionPixels++;if([0,1,2].some(c=>Math.abs(rough.data[k+c]-sharp.data[k+c])>2))blurPixels++;}
 assert(reflectionPixels>100,`a real product reflects below its complete projected silhouette: ${reflectionPixels}, region ${region}`);
 assert(blurPixels>100,`roughness visibly softens the floor reflection: ${blurPixels}`);
 const mips=await page.evaluate(()=>window.check.mips());let maximumFractionOfHalfUlp=0;
 for(let level=1;level<mips.length;level++){
  const a=mips[level-1],b=mips[level];
  for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++)for(let c=0;c<4;c++){
   let expected=0;for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++)expected+=a.data[((2*y+dy)*a.width+2*x+dx)*4+c]/4;
   const halfUlp=Math.max(2**-25,2**(Math.floor(Math.log2(Math.abs(expected)||2**-14))-11));
   const delta=Math.abs(b.data[(y*b.width+x)*4+c]-expected);
   maximumFractionOfHalfUlp=Math.max(maximumFractionOfHalfUlp,delta/halfUlp);
   assert(delta<=halfUlp+5e-7,`mip ${level} (${x},${y},${c}) expected ${expected}, actual ${b.data[(y*b.width+x)*4+c]}, delta ${delta}, bound ${halfUlp+5e-7}: independent 2x2 mean within half-float rounding`);
  }
 }
 assert(variance(mips[3])<variance(mips[0]),'averaging removes product-image variance');
 assert(await page.evaluate(()=>window.check.restore()));const restored=await shot(.4);assert.deepEqual(restored.data,rough.data,'real replacement device restores every glossy floor pixel');
 const resized=await page.evaluate(()=>window.check.resize());assert.equal(resized.width,128);assert.equal(resized.height,128);assert.equal(resized.levels,8);assert.deepEqual(resized.errors,[]);
 assert.deepEqual(await page.evaluate(()=>window.check.extremes()),{invalid:4,maximum:1});await shot(1);
 const quantization=await page.evaluate(()=>window.check.quantization());assert.deepEqual(quantization.actual,quantization.expected,'ties to even, subnormals and maximum finite radiance round exactly');
 const removed=await page.evaluate(()=>window.check.empty());assert(removed.uniform,'removing the real product leaves a completely uniform fresh capture');assert(removed.pixel.every(Number.isFinite));assert.deepEqual(removed.errors,[]);
 const native=await page.evaluate(()=>window.check.native());assert.equal(native.code,'unsupported');assert.match(native.message,/https:\/\/margoengine.com\/errors#unsupported/);
 assert.deepEqual(await page.evaluate(()=>window.check.dispose()),{detached:true,errors:[]});assert.deepEqual(errors,[]);
 const report={backend:process.argv.includes('--compat')?'WebGL2 compatibility':'WebGPU',status:'SKIPPED',reuse:'@margoengine/environment/reflector',fixture:'FlightHelmet mobile glb',...await page.evaluate(()=>window.check.info),reflectionPixels,blurPixels,mipLevels:mips.length,maximumFractionOfHalfUlp,variance:[variance(mips[0]),variance(mips[3])],deviceReplacement:true,resize:true,empty:removed,quantization,disposal:true,native};
 if(process.argv.includes('--record'))writeFileSync(`examples/package-benchmarks/results/batch-56-floor${process.argv.includes('--compat')?'-compat':''}.json`,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));console.log('existing glossy product floor passed');
}finally{await context.close();}
