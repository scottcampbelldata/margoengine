import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {openBrowser} from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..',import.meta.url)));
for(const compat of [false,true]){
  const browser=await openBrowser({startPath:'/examples/sciviz-probe.html',port:'free',compat}),errors=[];
  browser.page.on('pageerror',e=>errors.push(e.message));browser.page.setDefaultTimeout(120000);
  try{
    await Promise.race([browser.page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Ready.')),new Promise((_,reject)=>browser.page.once('pageerror',reject))]);
    const result=await browser.page.evaluate(async()=>{
      const demo=await import('/examples/sciviz-probe.ts'),check=(v,m)=>{if(!v)throw new Error(m);};
      const lit=async figure=>{const image=await createImageBitmap(await figure.toPNG({overlays:false})),c=new OffscreenCanvas(image.width,image.height),ctx=c.getContext('2d');ctx.drawImage(image,0,0);image.close();const p=ctx.getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<p.length;i+=4)if(Math.max(...[0,1,2].map(k=>Math.abs(p[i+k]-p[k])))>30)n++;return n;};
      const pixels=[];
      for(const [view,chart,profile,link]of [[demo.nasa,demo.nasaChart,demo.nasaProfile,demo.nasaLink],[demo.mri,demo.mriChart,demo.mriProfile,demo.mriLink]]){
        const at=profile.valid.findIndex((x,i)=>x&&i>=40);check(at>=40,'profile interior valid');link.moveTo(at);
        for(let a=0;a<3;a++)check(Math.abs(link.marker.positions[a]-profile.positions[3*at+a])<1e-5,'linked marker coordinates');
        const target=at+5,apply=(m,p)=>[0,1,2,3].map(r=>[0,1,2,3].reduce((s,c)=>s+m[4*c+r]*p[c],0));
        const clip=apply(chart.engine.camera.matrix,apply(chart.model,[profile.distance[target],profile.pointData[target],0,1])),canvas=chart.engine.canvas,rect=canvas.getBoundingClientRect();
        canvas.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.left+(clip[0]/clip[3]+1)*rect.width/2,clientY:rect.top+(1-clip[1]/clip[3])*rect.height/2}));
        for(let a=0;a<3;a++)check(Math.abs(link.marker.positions[a]-profile.positions[3*target+a])<1e-5,'chart hover updates 3D marker');
        check(profile.pointData.some(x=>x>0),'real scalar samples');pixels.push(await lit(view),await lit(chart));
      }
      check(pixels.every(x=>x>100),'four visible data views');check(demo.mriResampled.valid.every(x=>x===1),'MRI resample coverage');
      let max=0;for(let i=0;i<101;i++)if(demo.nasaProfile.valid[i])max=Math.max(max,Math.abs(demo.nasaProfile.pointData[i]-demo.nasaResampled.grid.pointData[i]));check(max===0,'dataset resample agrees with profile samples');
      const before=demo.nasa.layers.length;demo.nasaLink.dispose();demo.nasaLink.dispose();check(demo.nasa.layers.length===before-2,'owned 3D path and marker removed');
      const report={pixels,mriPoints:demo.mriResampled.valid.length,nasaValid:demo.nasaProfile.valid.reduce((a,b)=>a+b,0),area:demo.nasaIntegral.area.measure,integral:demo.nasaIntegral.area.pointData,max};
      demo.mriLink.dispose();demo.nasaLocator.dispose();demo.mriLocator.dispose();for(const f of [demo.nasa,demo.mri,demo.nasaChart,demo.mriChart])f.dispose();return report;
    });
    assert.deepEqual(errors,[]);console.log(`probe ${compat?'WebGL2':'WebGPU'} ${JSON.stringify(result)}`);
  }finally{await browser.close();}
}
