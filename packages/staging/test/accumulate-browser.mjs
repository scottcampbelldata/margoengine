import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { rasterContains } from './raster-reference.mjs';
const context=await openBrowser({startPath:'/packages/staging/test/accumulate-browser.html',port:'free'});
const {page}=context,errors=[];
page.on('pageerror',e=>errors.push(e.message));
// Independent ray-plane rectangle oracle, including D3D's specified 8-bit coordinate snapping.
// A continuous-ray test alone wrongly treats raster boundary quantization as accumulation error.
const lights=frames=>Array.from({length:frames},(_,i)=>{
  const binary=(i+1).toString(2),v=[...binary].reverse().reduce((s,b,k)=>s+Number(b)*2**(-k-1),0);
  const r=2*Math.sqrt(v),angle=(i+1)*Math.PI*(3-Math.sqrt(5));
  return [1.2+r*Math.cos(angle),8,-0.8+r*Math.sin(angle)];
});
const oracle=(h,frames)=>{
  const samples=lights(frames),values=[];
  for(let y=0;y<64;y++)for(let x=0;x<64;x++){
    let hits=0;
    for(const light of samples){
      // Solve the light-to-rectangle corner rays at y=0, without the production matrix.
      const at=(edge,axis)=>(edge*light[1]-h*light[axis])/(light[1]-h);
      const left=(at(-0.5,0)/6+0.5)*64,right=(at(0.5,0)/6+0.5)*64;
      const top=(0.5-at(0.5,2)/6)*64,bottom=(0.5-at(-0.5,2)/6)*64;
      if(rasterContains(x+0.5,y+0.5,left,top,right,bottom))hits++;
    }
    values.push(hits);
  }
  return values;
};
try{
  await page.waitForFunction(()=>window.ready,null,{timeout:30000});
  const rows=[];
  for(const height of [0,0.25,1.3]){
    const actual=await page.evaluate(h=>window.check.scene(h),height);
    assert.deepEqual(actual.errors,[]);
    assert.equal(actual.samples,64);
    const expected=oracle(height,64);
    assert.deepEqual(actual.values,expected,`all 4096 exact visibility sums at height ${height}`);
    const held=await page.evaluate(()=>window.check.hold());
    assert.deepEqual(held,{values:expected,samples:64},'completed shadow stays byte-identical');
    rows.push({height,partial:expected.filter(v=>v>0&&v<64).length});
  }
  assert.equal(rows[0].partial,0,'contact is sharp');
  assert(rows[2].partial>rows[1].partial*2,'penumbra grows with receiver separation');
  const pbr=await page.evaluate(()=>window.check.scene(1.3,64,2,true));
  assert.deepEqual(pbr.errors,[]);
  assert.deepEqual(pbr.values,oracle(1.3,64),'all 4096 PBR caster texels match the independent oracle');
  const resized=await page.evaluate(()=>window.check.resize());
  assert.equal(resized.samples,1);assert.equal(resized.values.length,1024);
  const empty=await page.evaluate(()=>window.check.remove());
  assert.equal(empty.samples,1);assert(empty.values.every(v=>v===0),'removed geometry leaves no stale shadow');
  const maximum=await page.evaluate(()=>window.check.maximum());
  assert.equal(maximum.samples,1024);assert(maximum.values.every(v=>v===0),'maximum budget and empty scene');
  const opaqueMaximum=await page.evaluate(()=>window.check.scene(0,1024,0));
  assert.equal(opaqueMaximum.samples,1024);
  assert.deepEqual(opaqueMaximum.values,oracle(0,1024),'1024 opaque samples sum exactly without half-float drift');
  await page.evaluate(()=>window.check.remove());
  const restored=await page.evaluate(()=>window.check.restore());
  assert(restored.changed);assert.equal(restored.samples,1);assert(restored.values.every(v=>v===0));assert.deepEqual(restored.errors,[]);
  const native=await page.evaluate(()=>window.check.native());
  assert.equal(native.code,'unsupported');assert.match(native.message,/https:\/\/margoengine.com\/errors#/);
  assert.deepEqual(await page.evaluate(()=>window.check.owner()),{empty:true,detached:true,defaultAlive:true});
  assert.deepEqual(await page.evaluate(()=>window.check.coexist()),{contact:1,accumulated:2});
  assert.deepEqual(await page.evaluate(()=>window.check.dispose()),[]);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({backend:process.argv.includes('--compat')?'WebGL2 compatibility':'WebGPU',exactTexels:16384,rows,framesMax:1024,pbr:true}));
  console.log('accumulated shadow GPU oracle passed');
}finally{await context.close();}
