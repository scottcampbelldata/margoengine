import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
for (const compat of [false,true]) {
  const browser=await openBrowser({startPath:'/examples/sciviz-contour.html',port:'free',compat}), errors=[];
  browser.page.on('pageerror',e=>errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(()=>document.querySelector('#status').textContent.includes('segments,'));
    const report=await browser.page.evaluate(async()=>{
      const {contourGrid,contourGridGPU}=await import('/packages/sciviz/dist/contour.js');
      const demo=await import('/examples/sciviz-contour.ts'),gpu=await demo.figure.renderer.compute();
      const check=(v,m)=>{if(!v)throw new Error(m);};
      const compare=async(grid,levels)=>{
        const cpu=await contourGrid(grid,levels), actual=await contourGridGPU(gpu,grid,levels);let delta=0;
        for(const kind of ['triangles','lines']){
          check(JSON.stringify([...cpu[kind].cells])===JSON.stringify([...actual[kind].cells]),`${kind} topology`);
          for(let i=0;i<cpu[kind].positions.length;i++){const d=Math.abs(cpu[kind].positions[i]-actual[kind].positions[i]);delta=Math.max(delta,d);check(d<=cpu.floatBound,`${kind} coordinate ${i}: ${d} > ${cpu.floatBound}`);}
          if(kind==='triangles')check(JSON.stringify([...cpu[kind].normals])===JSON.stringify([...actual[kind].normals]),'gradient normals');
        }
        return {triangles:cpu.triangles.cells.length,lines:cpu.lines.cells.length,delta,bound:cpu.floatBound};
      };
      const checks=[];
      for(let mask=0;mask<16;mask++)checks.push(await compare({points:[0,0,0,1,0,0,0,1,0,0,0,1],connectivity:[0,1,2,3],offsets:[4],types:[10],pointData:Array.from({length:4},(_,i)=>(mask>>i)&1)},[0,0.5,1]));
      const cube=[0,0,0,1,0,0,1,1,0,0,1,0,0,0,1,1,0,1,1,1,1,0,1,1];
      checks.push(await compare({points:cube,connectivity:[0,1,2,3,4,5,6,7],offsets:[8],types:[12],pointData:[0,1,3,2,4,5,7,6]},[0.1,2.7,4.9]));
      checks.push(await compare({points:[0,0,0,1,0,0,0,1,0,0,0,1,1,0,1,0,1,1],connectivity:[0,1,2,3,4,5],offsets:[6],types:[13],pointData:[0,1,2,3,4,5]},[0.3,2,4.8]));
      checks.push(await compare({points:[0,0,0,1,0,0,1,1,0,0,1,0,0.5,0.5,1],connectivity:[0,1,2,3,4],offsets:[5],types:[14],pointData:[0,1,3,2,4.5]},[0.3,2.2,4]));
      const nasa=await compare(demo.grid,demo.levels);check(nasa.lines>100,'real NASA isolines');
      await demo.figure.ready();demo.figure.engine.render();
      const bitmap=await createImageBitmap(await demo.figure.toPNG({overlays:false})),canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');
      context.drawImage(bitmap,0,0);bitmap.close();const bytes=context.getImageData(0,0,canvas.width,canvas.height).data;let lit=0;
      for(let i=0;i<bytes.length;i+=4)if(Math.max(...[0,1,2].map(k=>Math.abs(bytes[i+k]-bytes[k])))>30)lit++;
      check(lit>100,'rendered isolines');demo.figure.dispose();return {checks,nasa,lit};
    });
    assert.deepEqual(errors,[]);console.log(`contours ${compat?'WebGL2':'WebGPU'}: ${JSON.stringify(report)}`);
  } finally {await browser.close();}
}
