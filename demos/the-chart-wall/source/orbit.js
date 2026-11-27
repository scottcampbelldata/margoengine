import { Engine } from '@margoengine/core';
import { Figure } from '@margoengine/sciviz';
import { encodingLegend } from '@margoengine/sciviz/colormaps';
import url from './tools/planets.bin?url';
import detailUrl from './tools/detail.bin?url';
import provenance from './tools/source.json';
import { methods, selection, orbitBounds } from './archive.mjs';

const theme = {
  background:'#fcfaf2', axis:'#89907e', grid:'#deddd0', text:'#424a3e',
  fontFamily:'Segoe UI, Arial, sans-serif', fontSize:12,titleSize:12,gridWidth:.85,axisWidth:1.1,tickSize:3,
};

async function readSnapshot(resource, signal) {
  const res = await fetch(resource, { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) });
  if (!res.ok || !res.body) throw new Error('The archive snapshot could not be downloaded.');
  const unpacked = new Response(res.body.pipeThrough(new DecompressionStream('gzip')));
  const data = await unpacked.json();
  if (!Array.isArray(data) || data.length !== provenance.rowCount) throw new Error('The archive snapshot has an unexpected row count.');
  return data;
}

const pointChannels = rows => ({ x: rows.map(row => row[2]), y: rows.map(row => row[3]) });

function measured(value, upper, lower) {
  const scalar = Number(value.toPrecision(4));
  if (!Number.isFinite(upper) || !Number.isFinite(lower)) return String(scalar);
  return scalar + ' +' + Number(upper.toPrecision(2)) + '/−' + Number(Math.abs(lower).toPrecision(2));
}

export async function openOrbits(canvas, { signal, fail, renderer, describe }) {
  const outcomes = await Promise.allSettled([
    readSnapshot(url, signal),
    Engine.create(canvas, { backend: 'webgpu', antialias: false, signal }),
  ]);
  const rejection = outcomes.find(value => value.status === 'rejected');
  if (rejection) {
    if (outcomes[1].status === 'fulfilled') outcomes[1].value.dispose();
    throw rejection.reason;
  }
  const [data, engine] = outcomes.map(value => value.value);
  let figure, legend;
  try {
    signal.throwIfAborted();
    const kind = engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
    if (kind!==renderer) throw new Error('Both charts must use the same renderer.');
    engine.scene.background=theme.background;
    engine.onError=fail;
    const rows=data.map((row,index)=>[...row,index]);
    const groups=new WeakMap();
    let plotted, previous, marks, details, pending;
    const tooltip=hit=>{
      const row=plotted?.points[groups.get(hit.layer)]?.[hit.index];
      if(!row)return null;
      const [,group,period,radius,index]=row,rowDetails=details?.[index];
      const p=measured(period,rowDetails?.[2],rowDetails?.[3]);
      const r=measured(radius,rowDetails?.[4],rowDetails?.[5]);
      return (rowDetails?rowDetails[0]+' · ':'')+p+' days · '+r+' Earth radii · '+(rowDetails?.[1]??methods[group].name);
    };
    figure=Figure.attach(engine,{
      mode:'2d',theme,ticks:5,legend:false,scale:{x:'log'},limits:orbitBounds,
      titles:{x:'Orbital period (days, log)',y:'Radius (Earth radii)'},tooltips:tooltip,
      margin:{left:66,right:25,top:33,bottom:50},
    });
    legend=encodingLegend(figure,methods.map(method=>({
      name:method.name,color:method.color,shape:method.shape==='round'?'dot':'square',
    })),{position:'top-left'});
    for(const event of ['wheel','pointerdown','dblclick'])
      canvas.addEventListener(event,e=>e.stopImmediatePropagation(),{capture:true,signal});
    canvas.addEventListener('pointerenter',()=>{
      if(details||pending)return;
      pending=readSnapshot(detailUrl,signal).then(value=>{details=value;}).catch(error=>{
        if(!signal.aborted)describe('Point names are unavailable. '+error.message);
      });
    },{signal});
    return {
      async render(snapshot){
        if(snapshot.cutoff!==previous){
          const next=selection(rows,snapshot.cutoff);
          const amount=next.points.reduce((sum,group)=>sum+group.length,0);
          if(amount!==snapshot.plotted||next.total!==snapshot.total)
            throw new Error('The orbit points did not reconcile with the archive totals.');
          if(marks)await Promise.all(marks.map((layer,i)=>figure.updateData(layer,pointChannels(next.points[i]),{signal})));
          else {
            marks=await Promise.all(methods.map(({name,color,size,shape},i)=>
              figure.scatter(pointChannels(next.points[i]),{name,color,size,shape})));
            marks.forEach((layer,i)=>groups.set(layer,i));
          }
          plotted=next;
          previous=snapshot.cutoff;
        }
        await figure.ready();
        figure.render();
        await engine.gpu.queue.onSubmittedWorkDone();
        signal.throwIfAborted();
      },
      export:()=>figure.toSVG({vector:true}),
      dispose(){legend.dispose();figure.dispose();engine.dispose();},
    };
  } catch(error) {
    legend?.dispose();
    figure?.dispose();
    engine.dispose();
    throw error;
  }
}
