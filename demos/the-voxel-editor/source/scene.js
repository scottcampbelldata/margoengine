import {OrbitControls} from '@margoengine/controls/orbit';
import {combineGrids,cellIndex,insideGrid} from '@margoengine/voxel-edit';
import {boxCells,lineCells,sphereCells,stampCells} from '@margoengine/voxel-edit/edit';
import {pickRay,raycastGrid,groundCell} from '@margoengine/voxel-edit/pick';
import {VoxelHistory} from '@margoengine/voxel-edit/history';
import {harbor,palette,sampleBeacon,stampAnchor} from './model.js';
import {harborView,prepareHarbor} from './render.js';

const byId=id=>document.getElementById(id);
const sharedPalette=Uint8Array.from({length:256},(_,index)=>index);
const toolHints={
  orbit:'Drag to orbit. Choose a brush to edit.',
  paint:'Tap a face or drag across several to repaint them.',
  fill:'Tap a face to add material next to it.',
  erase:'Tap a face or drag across several to remove cells.',
  select:'Tap the first corner, then tap the opposite corner. You can also drag between them.'
};
function summarize(grid){
  let cells=0,key=2166136261;
  for(const value of grid.voxels){cells+=Number(value!==0);key=Math.imul(key^value,16777619);}
  return {cells,key:(key>>>0).toString(16).padStart(8,'0')};
}

export function prepare(){
  const stock=harbor();
  return {stock, world:prepareHarbor(stock)};
}

export async function connect(bench,signal,fail,opening,onResize){
  const {engine,canvas}=bench,root=document.body.dataset;
  const stamp=byId('stamp'),status=byId('status'),tools=[...document.querySelectorAll('[data-tool]')];
  const selection=byId('selection'),undo=byId('undo'),redo=byId('redo'),radius=byId('radius');
  const {stock}=opening,history=new VoxelHistory(stock,{maxBytes:1024*1024});
  const beacon=sampleBeacon();
  const callbacks={signal};
  let mode='orbit',color=9,grid=history.current,revision=0,busy=false;
  let a=null,b=null,gesture=null,cursor=[13,22,17],frame=0;
  let latestCount=summarize(grid).cells;
  const view=harborView(bench,opening.world);
  const orbit=new OrbitControls(engine.camera,canvas);
  orbit.enablePan=false;
  orbit.minDistance=36; orbit.maxDistance=125; orbit.maxPolarAngle=1.5;
  function render(){
    if(orbit.enabled)orbit.update(0);
    engine.render({delta:0});
  }
  function schedule(){
    if(frame||signal.aborted)return;
    frame=requestAnimationFrame(()=>{
      frame=0;
      try{render();}catch(error){fail(error);}
    });
  }
  async function settle(){
    const limit=performance.now()+7000;
    for(;;){
      signal.throwIfAborted();
      render();
      const stats=view.stats;
      if(!stats.pending&&!stats.compiling&&(latestCount===0||stats.draws>0)){
        await engine.gpu.queue.onSubmittedWorkDone();
        signal.throwIfAborted();
        return stats;
      }
      if(performance.now()>limit)throw Error('The harbor mesh did not finish updating.');
      await new Promise(resolve=>requestAnimationFrame(resolve));
    }
  }
  function info(){
    const {cells,key}=summarize(grid);
    latestCount=cells;
    root.model=key;root.cells=String(cells);root.revision=String(revision);
    root.undo=String(history.canUndo);root.redo=String(history.canRedo);
    root.tool=mode;root.color=String(color);
    stamp.disabled=busy;
    byId('count').value=cells.toLocaleString('en-US');
    undo.disabled=!history.canUndo||busy;redo.disabled=!history.canRedo||busy;
  }
  function controlReceipt(trusted){
    if(!trusted||performance.getEntriesByName('margo-first-input-rendered').length)return;
    performance.mark('margo-first-input-rendered');
  }
  async function apply(next,message,trusted){
    const edits=view.load(grid,next);
    grid=next;revision++;
    info();
    const metrics=await settle();
    root.quads=String(metrics.quads);
    root.changed=String(edits);
    status.textContent=message+' · '+edits.toLocaleString('en-US')+' '+(edits===1?'cell':'cells')+' changed.';
    controlReceipt(trusted);
  }
  async function transact(make,message,event){
    if(busy)return;
    busy=true;info();
    try{
      const next=make();
      if(next)await apply(next,message,event?.isTrusted);
      else status.textContent='No cells changed.';
    }catch(error){if(!signal.aborted)fail(error);}
    finally{busy=false;if(!signal.aborted)info();}
  }
  function edit(operation,indices,label,event){
    void transact(()=>{
      const result=stampCells(grid,indices,{operation,color});
      if(result.changed===0)return;
      return history.push(result.grid,label);
    },label,event);
  }
  function chooseTool(tool){
    mode=tool;orbit.enabled=tool==='orbit';
    canvas.dataset.tool=tool;
    for(const switcher of tools)switcher.setAttribute('aria-pressed',String(switcher.dataset.tool===tool));
    if(tool==='orbit'&&!a)view.selection(null,null);
    status.textContent=toolHints[tool];
    info();schedule();
  }
  function changeColor(value){
    color=value;info();
    byId('swatch-name').value=palette[color][0];
    for(const swatch of byId('palette').children)swatch.setAttribute('aria-pressed',String(Number(swatch.dataset.color)===value));
  }
  palette.slice(1).forEach(([label,hex],i)=>{
    const swatch=document.createElement('button');
    swatch.type='button';
    swatch.dataset.color=String(i+1);
    swatch.setAttribute('aria-label',label);
    swatch.title=label;
    swatch.style.setProperty('--swatch',hex);
    swatch.addEventListener('click',()=>changeColor(i+1),callbacks);
    byId('palette').append(swatch);
  });
  function corners(left,right){
    a=left;
    b=right;
    view.selection(a,b??a);
    root.selection=b?String(boxCells(a,b).length):a?'anchor':'0';
    selection.hidden=!b;
    schedule();
  }
  function rayAt(event){
    const rect=canvas.getBoundingClientRect();
    return pickRay(engine.camera.matrix,2*(event.clientX-rect.left)/rect.width-1,1-2*(event.clientY-rect.top)/rect.height,{backend:engine.backend});
  }
  function find(event){
    const ray=rayAt(event);
    if(!ray)return null;
    const hit=raycastGrid(grid,ray);
    const cell=mode==='fill'?hit?.adjacent??groundCell(grid.size,ray):hit?.cell;
    return cell&&insideGrid(grid.size,...cell)?cell:null;
  }
  function sample(from,to,indices){
    const width=Number(radius.value);
    for(const cell of lineCells(from,to)){
      for(const near of sphereCells(cell,width)){
        if(insideGrid(grid.size,...near))indices.add(cellIndex(grid.size,...near));
      }
    }
    cursor=to;
  }
  function preview(event){
    const cell=find(event);
    if(!cell)return;
    if(gesture){
      if(gesture.id!==event.pointerId)return;
      gesture.to=cell;
      if(mode!=='select'){
        sample(gesture.previous,cell,gesture.indices);
        gesture.previous=cell;
        view.selection(cell,cell);
      }else view.selection(a&&!b?a:gesture.from,cell);
    }else if(!a&&event.pointerType==='mouse')view.selection(cell,cell);
    schedule();
  }
  canvas.addEventListener('pointerdown',event=>{
    if(!root.ready||mode==='orbit'||busy||event.button!==0||!event.isPrimary)return;
    const cell=find(event);
    if(!cell)return;
    canvas.setPointerCapture(event.pointerId);
    gesture={id:event.pointerId,from:cell,to:cell,previous:cell,indices:new Set()};
    if(mode!=='select')sample(cell,cell,gesture.indices);
    preview(event);
  },callbacks);
  canvas.addEventListener('pointermove',event=>{if(mode!=='orbit')preview(event);},callbacks);
  canvas.addEventListener('pointerup',event=>{
    if(!gesture||event.pointerId!==gesture.id)return;
    preview(event);
    const finished=gesture;
    gesture=null;
    if(mode==='select'){
      if(a&&!b)corners(a,finished.to);
      else if(finished.from.some((value,axis)=>value!==finished.to[axis]))corners(finished.from,finished.to);
      else corners(finished.from,null);
      status.textContent=b?root.selection+' cells selected. Fill the volume or cut it away.':'First corner set. Choose the opposite corner.';
    }else edit(mode,[...finished.indices],{paint:'Paint',fill:'Add material',erase:'Erase'}[mode],event);
  },callbacks);
  for(const type of ['pointercancel','lostpointercapture'])canvas.addEventListener(type,()=>{
    if(!gesture)return;
    gesture=null;
    view.selection(a,b??a);
    schedule();
  },callbacks);
  canvas.addEventListener('pointerleave',()=>{
    if(gesture||mode==='orbit')return;
    view.selection(a,b??a);
    schedule();
  },callbacks);
  canvas.addEventListener('keydown',event=>{
    if(mode==='orbit'||busy)return;
    const offsets={ArrowLeft:[-1,0,0],ArrowRight:[1,0,0],ArrowUp:[0,0,-1],ArrowDown:[0,0,1],PageUp:[0,1,0],PageDown:[0,-1,0]};
    if(event.key==='Escape'){corners(null,null);return;}
    if(event.key==='Enter'||event.key===' '){
      event.preventDefault();
      if(mode==='select'){
        if(!a||b)corners(cursor,null);
        else corners(a,cursor);
      }else{
        const indices=new Set();
        sample(cursor,cursor,indices);
        edit(mode,[...indices],{paint:'Paint',fill:'Add material',erase:'Erase'}[mode],event);
      }
      return;
    }
    const step=offsets[event.key];
    if(!step)return;
    event.preventDefault();
    cursor=cursor.map((value,axis)=>Math.max(0,Math.min(grid.size[axis]-1,value+step[axis])));
    view.selection(cursor,cursor);
    schedule();
  },callbacks);
  for(const item of tools)item.addEventListener('click',()=>chooseTool(item.dataset.tool),callbacks);
  byId('stamp').addEventListener('click',event=>void transact(()=>{
    const result=combineGrids(grid,beacon,{offset:stampAnchor,operation:'union',paletteMap:sharedPalette});
    if(result.changed===0)return;
    return history.push(result.grid,'Dock beacon');
  },'Dock beacon stamped',event),callbacks);
  byId('reset').addEventListener('click',event=>{
    corners(null,null);
    void transact(()=>history.push(stock,'Reset'),'Original harbor restored',event);
  },callbacks);
  undo.addEventListener('click',event=>void transact(()=>history.canUndo?history.undo():null,'Undo',event),callbacks);
  redo.addEventListener('click',event=>void transact(()=>history.canRedo?history.redo():null,'Redo',event),callbacks);
  const selectedIndices=()=>boxCells(a,b).map(cell=>cellIndex(grid.size,...cell));
  byId('fill-selection').addEventListener('click',event=>{if(a&&b)edit('fill',selectedIndices(),'Fill selection',event);},callbacks);
  byId('erase-selection').addEventListener('click',event=>{if(a&&b)edit('erase',selectedIndices(),'Cut selection',event);},callbacks);
  byId('clear-selection').addEventListener('click',()=>corners(null,null),callbacks);
  byId('export').addEventListener('click',async ()=>{
    if(busy)return;
    const button=byId('export');
    button.disabled=true;
    const snapshot=grid;
    try{
      const {download}=await import('./save.js');
      if(signal.aborted)return;
      root.exportBytes=String(download(snapshot));
      status.textContent='Harbor Signal exported as a .vox file.';
    }catch(error){if(!signal.aborted)fail(error);}
    finally{button.disabled=false;}
  },callbacks);
  orbit.addEventListener('change',schedule);
  canvas.addEventListener('wheel',schedule,{...callbacks,passive:true});
  root.renderer=bench.renderer==='compatibility'?'webgl2':'webgpu';
  root.openingCells=String(latestCount);
  root.openingModel=summarize(grid).key;
  root.stampReady='true';
  info();
  performance.mark('voxel-editor-display-ready');
  const stats=await settle();
  onResize(schedule);
  changeColor(color);
  corners(null,null);
  root.quads=String(stats.quads);
  root.lighting='complete';
  root.ready='true';
  performance.mark('margo-first-usable-frame');
  byId('loading').hidden=true;
  byId('editor-tools').inert=false;
  return {dispose(){
    cancelAnimationFrame(frame);
    orbit.dispose();
    view.dispose();
  }};
}
