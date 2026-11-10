// Actual compute dispatch/readback and existing volume/isosurface integration on BOTH backends.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/derive.html', port: 5279, compat });
  const errors = [];
  browser.page.on('pageerror', e => errors.push(e.message));
  browser.page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  browser.page.setDefaultTimeout(180_000);
  try {
    const report = await browser.page.evaluate(async () => {
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { deriveFlow, deriveFlowGPU } = await import('/packages/sciviz/dist/derive.js');
      const check = (c, m) => { if (!c) throw new Error(m); };
      const figure = await Figure.create(document.querySelector('canvas'), { axes: false, controls: false });
      figure.engine.stop();
      const gpu = await figure.renderer.compute();
      gpu.device.addEventListener('uncapturederror', e => { throw e.error; });
      const sample = (fn, dims=[5,4,3], bounds=[-2,2,-3,3,-1,1]) => {
        const u=[],v=[],w=[];
        for(let z=0;z<dims[2];z++)for(let y=0;y<dims[1];y++)for(let x=0;x<dims[0];x++){
          const p=[x,y,z].map((k,a)=>bounds[2*a]+(dims[a]===1?0:k/(dims[a]-1)*(bounds[2*a+1]-bounds[2*a])));
          const value=fn(...p);u.push(value[0]);v.push(value[1]);w.push(value[2]);
        } return {u,v,w,dims,bounds};
      };
      const cases=[
        ['rotation',sample((x,y)=>[-3*y,3*x,0])],
        ['shear',sample((x,y)=>[4*y,0,0])],
        ['quadratic',sample((x,y,z)=>[x*x+2*y*y,y*y+3*z*z,z*z+4*x*x])],
        ['nonlinear',sample((x,y,z)=>[Math.sin(x)+y*z,Math.cos(y)+x*z,Math.sin(z)+x*y],[9,7,5],[3,-2,-7,4,9,2])],
        ['two samples',sample((x,y,z)=>[x+2*y,y-3*z,4*z],[2,2,2],[4,-1,2,6,-2,7])],
        ['planar',sample((x,y)=>[-y,x,0],[7,5,1],[-1,1,-2,2,4,4])],
        ['singleton',sample(()=>[2,3,4],[1,1,1],[7,7,-3,-3,9,9])],
        ['near-cancelling strain and rotation',sample((x,y)=>[10000*x+(10000+1/1024)*y,-(10000+1/1024)*x-10000*y,0],[3,3,3],[-1,1,-1,1,-1,1])],
        ['constant offset',sample((x,y,z)=>[1e7+2*x,1e7+4*y,1e7+8*z])],
        ['small scale',sample((x,y,z)=>[1e-20*x,2e-20*y,-3e-20*z])],
        ['subnormal high inverse spacing',sample(x=>[0.01*x,0,0],[2,1,1],[0,1e-38,0,0,0,0])],
        ['subnormal',sample((x,y)=>[1e-40*x,-1e-40*y,0])],
      ];
      const masked=sample((x,y,z)=>[x,y,z]);masked.u[17]=NaN;masked.mask=masked.u.map((_,i)=>i===35?0:1);cases.push(['masked',masked]);
      const rotation=[[-2/3,2/3,1/3],[2/3,1/3,2/3],[1/3,2/3,-2/3]];
      for(const eig of [[1,1,1],[1,1.0001,-3],[0,1e-4,2],[-2,2,1]])for(const scale of [1e-12,1,1e12]){
        const j=rotation.map(row=>rotation.map(col=>row.reduce((s,v,k)=>s+v*eig[k]*col[k]*scale,0)));
        cases.push([`eigen ${eig} scale ${scale}`,sample((...p)=>j.map(row=>row.reduce((s,v,k)=>s+v*p[k],0)))]);
      }
      const summaries=[];
      try {
        for(const [name,grid] of cases){
          const cpu=await deriveFlow(grid), result=await deriveFlowGPU(gpu,grid);
          const maxima={};
          try {
            for(const key of ['gradient','divergence','curl','vorticity','q','lambda2']){
              const values=await result[key].read();let max=0;
              check(values.length===cpu[key].length,`${name} ${key} length`);
              for(let i=0;i<values.length;i++){
                if(Number.isNaN(cpu[key][i])){check(Number.isNaN(values[i]),`${name} ${key} mask ${i}`);continue;}
                check(Number.isFinite(values[i]),`${name} ${key} nonfinite ${i}`);
                const delta=Math.abs(values[i]-cpu[key][i]);max=Math.max(max,delta);
                check(delta<=cpu.floatBound[key],`${name} ${key}[${i}] ${values[i]} vs ${cpu[key][i]}, delta ${delta} bound ${cpu.floatBound[key]}`);
              }
              maxima[key]=max;
              if(name==='rotation'&&['q','lambda2','vorticity'].includes(key)){
                const expected=key==='q'?9:key==='lambda2'?-9:6;
                check(values.every(v=>Math.abs(v-expected)<1e-5),`independent solid rotation ${key}`);
              }
              if(name==='shear'&&['q','lambda2'].includes(key))check(values.every(v=>Math.abs(v)<1e-6),`independent shear ${key}`);
            }
            check(result.q.offset===0&&result.lambda2.offset===0&&result.q.contiguous,'direct scalar buffer shape');
          }finally{result.dispose();result.dispose();}
          summaries.push({name,maxima,bound:cpu.floatBound});
        }
        const dim=17;
        const vortex=sample((x,y)=>{const a=Math.exp(-2*(x*x+y*y));return [-y*a,x*a,0];},[dim,dim,dim],[-1,1,-1,1,-1,1]);
        const fields=await deriveFlowGPU(gpu,vortex);
        try {
          const volume=figure.volume(fields.vorticity,{bounds:vortex.bounds,range:[0,2],opacity:[[0,0],[0.15,0],[1,0.18]],shading:false});
          const iso=await figure.isosurface(fields.lambda2,-0.12,{bounds:vortex.bounds,color:'#ffb640'});
          check(iso.triangles>0,'lambda2 vortex-core triangles');await figure.ready();figure.engine.render();
          const bitmap=await createImageBitmap(figure.engine.canvas), copy=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=copy.getContext('2d');
          ctx.drawImage(bitmap,0,0);bitmap.close();const bytes=ctx.getImageData(0,0,copy.width,copy.height).data;
          const background=Array.from(bytes.subarray(0,3));let lit=0;
          for(let i=0;i<bytes.length;i+=4)if(Math.max(...[0,1,2].map(c=>Math.abs(bytes[i+c]-background[c])))>24)lit++;
          check(lit>500,`volume/isosurface lit pixels ${lit}`);figure.remove(volume);figure.remove(iso);
          return {summaries,lit,triangles:iso.triangles,device:gpu.device.limits.maxStorageBuffersPerShaderStage};
        }finally{fields.dispose();}
      }finally{figure.dispose();}
    });
    assert.deepEqual(errors, []);reports.push({compat,hardware:browser.hardware,...report});
    console.log(`derive ${compat?'WebGL2':'WebGPU'}: ${report.summaries.length} numerical cases, ${report.triangles} triangles, ${report.lit} lit pixels`);
  } finally { await browser.close(); }
}
await writeFile('test-results/sciviz-fixes/derive-gpu.json', JSON.stringify(reports,null,2));
