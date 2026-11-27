import { MultivariateData, parallelDensity } from '@margoengine/sciviz/parcoords';
import { ColumnarTable, aggregateTable } from '@margoengine/sciviz/table';
import { SelectionStore } from '@margoengine/sciviz/link';
import { Geometry, PbrMaterial } from '@margoengine/core';
import { axes } from './samples.js';

const densityWidth=229, densityHeight=124;
const scatterBounds=[8,15,.5,70];
const scatterColumns=120, scatterRows=100;
const colorSets={
  ghost:['#233638','#2b4347','#36525a','#42636b'],
  trace:['#203136','#29454c','#325a62','#3e747d','#4d9398','#71a9a3','#a6c7af','#e9ce9d'],
  scatter:['#3d5652','#f3d49a','#efc090','#ecae86','#e99b7e','#e68776'],
};
const fmt=new Intl.NumberFormat('en-US');
const media=matchMedia('(max-width:760px)');

function composition() {
  return media.matches ?
    {bounds:[-.58,7.48,-1.27,1.36],scatter:[.55,7,-1.08,-.16],divider:-.075} :
    {bounds:[-.48,11.65,-.22,1.34],scatter:[8.26,11.30,0,1],divider:null};
}

function norm(value,domain,scale) {
  const [lo,hi]=scale==='log'?domain.map(Math.log):domain;
  return ((scale==='log'?Math.log(value):value)-lo)/(hi-lo);
}

function marks(parent,canvas,layout,ranges) {
  const {bounds:[xmin,xmax,ymin,ymax],scatter:[x0,x1,y0,y1],divider}=layout;
  const {clientWidth:width,clientHeight:height}=canvas;
  const sx=n=>width*(n-xmin)/(xmax-xmin);
  const sy=n=>height*(ymax-n)/(ymax-ymin);
  const draw=document.createDocumentFragment();
  function part(label,name,left,top) {
    const element=document.createElement('span');
    element.className=name;
    element.textContent=label;
    element.style.left=sx(left)+'px';
    element.style.top=sy(top)+'px';
    draw.append(element);
    return element;
  }
  function line(from,to,y,section=false) {
    const element=part('',section?'guide-line divider':'guide-line',from,y);
    element.style.width=(sx(to)-sx(from))+'px';
  }
  if(divider!==null)line(xmin,xmax,divider,true);
  part('Parallel axes','chart-title',0,1.28);
  part('Alcohol vs. residual sugar','chart-title',x0,media.matches?y1+.045:1.28);
  for(const [i,axis] of axes.entries()){
    const {domain,short,unit,digits,scale,column}=axis;
    const guide=part('','guide-axis',i,1);
    guide.style.height=(sy(0)-sy(1))+'px';
    part(short,'axis-name',i,1.165);
    part(domain[1].toFixed(digits).replace(/\.0$/,''),'tick',i,1.055);
    part(domain[0].toFixed(digits).replace(/\.0$/,''),'tick',i,-.025);
    if(unit&&divider===null)part(unit,'axis-unit',i,-.10);
    const range=ranges.get(column);
    if(!range)continue;
    const from=Math.max(0,norm(range[0],domain,scale));
    const to=Math.min(1,norm(range[1],domain,scale));
    if(!(to>=from))continue;
    part('','brush-band',i,to).style.height=(sy(from)-sy(to))+'px';
  }
  for(const tick of [1,5,10,30,70]){
    const yTick=y0+norm(tick,scatterBounds.slice(2),'log')*(y1-y0);
    line(x0,x1,yTick);
    part(String(tick),'tick y',x0-.11,yTick);
  }
  for(const tick of [8,10,12,14]){
    const xTick=x0+norm(tick,scatterBounds.slice(0,2))*(x1-x0);
    part(String(tick),'tick',xTick,y0-.067);
  }
  part('Alcohol %','axis-unit',(x0+x1)/2,y0-.145);
  part('Sugar g/L · log',media.matches?'axis-unit axis-right':'axis-unit',
    media.matches?x1:(x0+x1)/2,y1+(media.matches?.045:.095));
  parent.replaceChildren(draw);
}

function sheet() {return {points:[],normals:[],indices:[]};}
function tile(mesh,x0,x1,y0,y1,depth=0) {
  const first=mesh.points.length/3;
  mesh.points.push(x0,y0,depth,x1,y0,depth,x1,y1,depth,x0,y1,depth);
  mesh.normals.push(0,0,1,0,0,1,0,0,1,0,0,1);
  mesh.indices.push(first,first+1,first+2,first,first+2,first+3);
}
function drawGeometry({points,normals,indices}) {
  return indices.length ? new Geometry(points,normals,indices) : null;
}
function palette(engine,group) {
  return colorSets[group].map((color,i)=>{
    const mesh=engine.createMesh().setMaterial(new PbrMaterial({color,roughness:.91}));
    mesh.name=group+' bin '+i;
    return mesh;
  });
}
function paint(meshes,shapes) {
  for(const [i,mesh] of meshes.entries())mesh.setGeometry(shapes?.[i]??null);
}
const peak=counts=>counts.reduce((a,b)=>Math.max(a,b),0);
const level=(value,max,count)=>Math.min(count-1,Math.floor(Math.log1p(value)*count/Math.log1p(max)));

export async function prepare(samples,signal) {
  const rows=new ColumnarTable(samples.columns);
  const data=new MultivariateData(rows,{axes,signal});
  const selection=new SelectionStore(data.rowIds,{history:0});
  signal.addEventListener('abort',()=>selection.dispose(),{once:true});
  const values=samples.columns;
  const cells=Uint16Array.from(values.alcohol,(reading,row)=>{
    const x=Math.min(scatterColumns-1,Math.floor(norm(reading,scatterBounds.slice(0,2))*scatterColumns));
    const y=Math.min(scatterRows-1,Math.floor(norm(values.sugar[row],scatterBounds.slice(2),'log')*scatterRows));
    return y*scatterColumns+x;
  });
  const occupied=new Uint8Array(scatterColumns*scatterRows);
  for(const cell of cells)occupied[cell]=1;
  const densityOptions={width:densityWidth,height:densityHeight,signal};
  const base=await parallelDensity(data,selection,densityOptions);
  const allPaths=densityShapes(base,'trace');
  const ghostPaths=densityShapes(base,'ghost');
  return {data,selection,kind:values.color.values,cells,occupied,densityOptions,allPaths,ghostPaths};
}

function densityShapes(counts,group) {
  const shapes=colorSets[group].map(sheet), top=peak(counts);
  const depth=group==='trace'?.005:0;
  for(let i=0;i<counts.length;i++){
    const value=counts[i];
    if(!value)continue;
    const x=i%densityWidth, y=Math.floor(i/densityWidth);
    const layer=shapes[level(value,top,shapes.length)];
    tile(layer,x*7/densityWidth,(x+1)*7/densityWidth,y/densityHeight,(y+1)/densityHeight,depth);
  }
  return shapes.map(drawGeometry);
}
function scatterShapes({kind,cells,occupied},rows,area) {
  const shapes=colorSets.scatter.map(sheet);
  const reds=new Uint16Array(occupied.length), whites=new Uint16Array(occupied.length);
  for(const row of rows){
    const counts=kind[row]===0?reds:whites;
    counts[cells[row]]++;
  }
  const [left,right,bottom,top]=area;
  const dx=(right-left)/scatterColumns, dy=(top-bottom)/scatterRows;
  for(let i=0;i<occupied.length;i++){
    if(!occupied[i])continue;
    const count=reds[i]+whites[i];
    const index=count?1+Math.round((reds[i]/count)*(shapes.length-2)):0;
    const x=left+(i%scatterColumns)*dx, y=bottom+Math.floor(i/scatterColumns)*dy;
    tile(shapes[index],x,x+dx*.88,y,y+dy*.88);
  }
  return shapes.map(drawGeometry);
}

export async function open({engine,model,canvas,size,notice,status,signal,fail}) {
  const {data,selection,kind,allPaths,ghostPaths,densityOptions}=model;
  const guides=document.querySelector('#guides');
  const count=document.querySelector('#count'), red=document.querySelector('#red'), white=document.querySelector('#white');
  const description=document.querySelector('#selection'), form=document.querySelector('.brushes');
  const measure=document.querySelector('#measure'), min=document.querySelector('#min'), max=document.querySelector('#max');
  const warning=document.querySelector('#form-error'), clear=document.querySelector('#clear');
  const presets=[...document.querySelectorAll('[data-preset]')], ranges=new Map();
  const examples={sugar:[10,70],alcohol:[12,15]}, allKinds=new ColumnarTable({kind});
  const layers=Object.fromEntries(Object.keys(colorSets).map(key=>[key,palette(engine,key)]));
  let layout=composition(), grabbed, version=0, paintedRevision=-1, frameWidth=canvas.clientWidth, frameHeight=canvas.clientHeight;
  const which=()=>axes.find(axis=>axis.column===measure.value);
  const dataPoint=event=>{
    const box=canvas.getBoundingClientRect(), [l,r,b,t]=layout.bounds;
    return [l+(event.clientX-box.left)/box.width*(r-l),t-(event.clientY-box.top)/box.height*(t-b)];
  };

  engine.onError=fail;
  engine.scene.background='#192322';
  engine.lighting.direction[3]=0;
  engine.lighting.radiance[3]=1;
  engine.camera.project=(out,_,gpu)=>{
    const [l,r,b,t]=layout.bounds, {near,far}=engine.camera, depth=far-near;
    out[0]=2/(r-l); out[5]=2/(t-b); out[10]=(gpu?1:2)/depth;
    out[12]=-(r+l)/(r-l); out[13]=-(t+b)/(t-b); out[14]=(gpu?far:far+near)/depth; out[15]=1;
  };
  canvas.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'compatibility':'webgpu';
  for(const axis of axes){
    const option=document.createElement('option');
    option.value=axis.column;
    option.textContent=axis.short+(axis.unit?' ('+axis.unit+')':'');
    option.title=axis.label;
    measure.append(option);
  }
  function selectedPreset() {
    if(!ranges.size)return 'all';
    if(ranges.size!==1)return '';
    const [name,range]=ranges.entries().next().value;
    return examples[name]?.every((value,i)=>value===range[i])?name:'';
  }
  function syncField() {
    const axis=which();
    [min.value,max.value]=ranges.get(axis.column)??axis.domain;
    clear.disabled=!ranges.has(axis.column);
    warning.hidden=true;
  }
  function sync() {
    const current=selectedPreset();
    for(const button of presets)button.setAttribute('aria-pressed',String(button.dataset.preset===current));
    const clauses=[...ranges.entries()].map(([key,[lo,hi]])=>{
      const axis=axes.find(candidate=>candidate.column===key);
      return axis.label+' '+lo.toFixed(axis.digits)+'–'+hi.toFixed(axis.digits)+(axis.unit?' '+axis.unit:'');
    });
    description.textContent=clauses.length?clauses.join(' · '):'Drag along a vertical axis to select a range.';
    syncField();
  }
  function brushing() {
    const retained=[];
    const checks=[...ranges.entries()].map(([name,range])=>[axes.findIndex(axis=>axis.column===name),range]);
    if(!checks.length){selection.clear();return;}
    for(let row=0;row<data.table.length;row++){
      if(checks.every(([axis,[lo,hi]])=>{const value=data.raw(axis,row);return value>=lo&&value<=hi;}))retained.push(row);
    }
    selection.select(retained,{source:'axis-brush',predicate:checks});
  }
  async function applied(mark,withDensity=true) {
    const current=++version, selected=selection.rowIds;
    const revision=selection.version;
    if(withDensity||paintedRevision!==revision){
      const filtered=selection.active?new ColumnarTable({kind:Uint8Array.from(selected,row=>kind[row])}):allKinds;
      const [density,totals]=await Promise.all([
        selection.active ? parallelDensity(data,selection,densityOptions) : undefined,
        aggregateTable(filtered,{x:{column:'kind',bins:2,range:[-.5,1.5]},signal}),
      ]);
      if(signal.aborted||current!==version)return;
      paint(layers.trace,density?densityShapes(density,'trace'):allPaths);
      paint(layers.ghost,density?ghostPaths:undefined);
      paintedRevision=revision;
      const [r,w]=totals.count;
      count.value=fmt.format(r+w); red.value=fmt.format(r); white.value=fmt.format(w);
    }
    paint(layers.scatter,scatterShapes(model,selected,layout.scatter));
    sync();
    marks(guides,canvas,layout,ranges);
    engine.render({delta:0});
    await engine.gpu.queue.onSubmittedWorkDone();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    if(signal.aborted||current!==version)return;
    canvas.dataset.matches=count.value.replaceAll(',','');
    canvas.dataset.red=red.value.replaceAll(',','');
    canvas.dataset.white=white.value.replaceAll(',','');
    if(mark)performance.mark(mark);
  }
  selection.addEventListener('change',()=>applied('coordinates-brush-applied').catch(fail),{signal});
  for(const trigger of presets)trigger.addEventListener('click',()=>{
    const choice=trigger.dataset.preset;
    if(choice===selectedPreset())return;
    ranges.clear();
    if(examples[choice])ranges.set(choice,examples[choice]);
    brushing();
  },{signal});
  measure.addEventListener('change',syncField,{signal});
  form.addEventListener('submit',event=>{
    event.preventDefault();
    const axis=which(), [lo,hi]=[min.valueAsNumber,max.valueAsNumber];
    if(!Number.isFinite(lo)||!Number.isFinite(hi)||hi<lo||lo<axis.domain[0]||hi>axis.domain[1]){
      warning.textContent='Enter an ordered range from '+axis.domain[0]+' to '+axis.domain[1]+'.';
      warning.hidden=false;
      return;
    }
    ranges.set(axis.column,[lo,hi]); brushing();
  },{signal});
  clear.addEventListener('click',()=>{ranges.delete(measure.value);brushing();},{signal});

  canvas.addEventListener('pointerdown',event=>{
    if(event.button!==0||!canvas.dataset.ready)return;
    const [x,y]=dataPoint(event), axis=Math.round(x);
    if(axis<0||axis>=axes.length||Math.abs(x-axis)>.23||y<0||y>1)return;
    grabbed={id:event.pointerId,axis,start:y};
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointerup',event=>{
    if(grabbed?.id!==event.pointerId)return;
    const {axis,start}=grabbed;
    grabbed=undefined;
    if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);
    const [,y]=dataPoint(event), end=Math.min(1,Math.max(0,y));
    const range=[data.physical(axis,Math.min(start,end)),data.physical(axis,Math.max(start,end))];
    ranges.set(axes[axis].column,range);
    measure.value=axes[axis].column;
    brushing();
  },{signal});
  canvas.addEventListener('pointercancel',()=>{grabbed=undefined;},{signal});

  const observer=new ResizeObserver(()=>{
    if(frameWidth===canvas.clientWidth&&frameHeight===canvas.clientHeight)return;
    frameWidth=canvas.clientWidth;
    frameHeight=canvas.clientHeight;
    size();
    layout=composition();
    applied(undefined,false).catch(fail);
  });
  signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
  guides.hidden=false;
  await applied('margo-first-usable-frame');
  signal.throwIfAborted();
  for(const control of [...presets,...form.querySelectorAll('button,input,select')])control.disabled=false;
  syncField();
  notice.hidden=true;
  status.ready();
  observer.observe(canvas);
}
