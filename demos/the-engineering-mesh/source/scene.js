import {Figure} from '@margoengine/sciviz';
import {clipGrid} from '@margoengine/sciviz/clip';
import {gridSurface,meshLayer,sliceGrid} from '@margoengine/sciviz/grids';
import {frameBounds,halfLength,initialOffset,makeGrid,outside,palette,sectionEdges,shellPalette,temperatures,withoutCutFace} from './mesh-data.mjs';
import {buildInstrument} from './instrument.js';
import {sectionPass} from './section-pass.js';

const by=id=>document.getElementById(id);
const slider=by('plane'),edges=by('edges'),views=[...document.querySelectorAll('button[data-mode]')];
const stage=document.body.dataset;
const modelView={
  axes:false,legend:false,tooltips:false,limits:frameBounds,aspect:[halfLength,outside,outside],
};
let main,special,volume,grid,observer,signal,fail,fit,controls,activeCanvas;
let yaw=.52,pitch=.34,pointer,drawn=-1,activeMode='section',wantedMode='section',showEdges=true;
let queued=false,running=false,wanted=initialOffset,frame,revision=0,lastSection;

function planarCut(mesh,mm){
  return sliceGrid(mesh,{normal:[0,-1,0],offset:mm*.001},{values:'point'});
}

async function cut(mesh,millimetres,signal) {
  const offset=millimetres*.001;
  const section=planarCut(mesh,millimetres);
  const clipped=await clipGrid(mesh,{kind:'plane',normal:[0,1,0],offset},{signal});
  const shell=withoutCutFace(gridSurface(clipped,{values:'point'}),offset);
  return {section,shell,edges:sectionEdges(section,offset)};
}

export async function prepare(signal) {
  const data=makeGrid();
  const contents=await cut(data,initialOffset,signal);
  performance.mark('mesh-prepared');
  return {grid:data,contents};
}

function camera(view) {
  const {canvas,engine}=view;
  const ratio=canvas.clientWidth/Math.max(1,canvas.clientHeight);
  const close=ratio<1.27,focus=[0,-.051,0];
  const distance=close?1.019:1.072;
  const floor=Math.cos(pitch)*distance;
  engine.camera.fov=close?45:40;
  engine.camera.target=focus;
  engine.camera.position=[focus[0]+floor*Math.sin(yaw),focus[1]+distance*Math.sin(pitch),focus[2]+floor*Math.cos(yaw)];
}

function target(mode){
  return mode==='volume'&&special?special:main;
}

function render(mode=activeMode){
  const view=target(mode);
  camera(view);
  view.draw();
}

function setPlane(millimetres) {
  const offset=millimetres*.001;
  main.instrument.position(offset);
  special?.instrument.position(offset);
  if(volume){
    const [,,lower,upper]=volume.bounds;
    volume.source.clip=[{normal:[0,1,0],offset:(offset+lower)/(upper-lower)}];
  }
}

function displayStatistics(section,millimetres){
  const count=new Set(section.cells).size;
  let maximum=-Infinity;
  for(const value of section.values)maximum=Math.max(maximum,value);
  const formatted=millimetres<0?'−'+Math.abs(millimetres):millimetres>0?'+'+millimetres:'0';
  by('offset').textContent=formatted+' mm';
  by('cut-count').textContent=count.toLocaleString('en-US');
  by('peak').textContent=Number.isFinite(maximum)?maximum.toFixed(1)+' °C':'—';
  stage.offset=String(millimetres);
  stage.intersected=String(count);
  stage.triangles=String(section.cells.length);
  stage.peak=maximum.toFixed(3);
}

function bindCamera(canvas){
  const events={signal};
  canvas.addEventListener('pointerdown',event=>{
    if(!event.isPrimary||event.button!==0||activeCanvas!==canvas)return;
    pointer=[event.pointerId,event.clientX,event.clientY];
    canvas.setPointerCapture(event.pointerId);
  },events);
  canvas.addEventListener('pointermove',event=>{
    if(pointer?.[0]!==event.pointerId||activeCanvas!==canvas)return;
    yaw+=(pointer[1]-event.clientX)*.006;
    pitch=Math.min(.68,Math.max(.12,pitch+(event.clientY-pointer[2])*.004));
    pointer=[event.pointerId,event.clientX,event.clientY];
    render();
  },events);
  for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,()=>{pointer=undefined;},events);
}

async function openVolume() {
  if(volume)return true;
  let engine,canvas,figure,instrument;
  try {
    const source=import('@margoengine/sciviz/tetvolume');
    if(main.preview){
      canvas=document.createElement('canvas');
      canvas.className='volume-canvas';
      canvas.setAttribute('aria-hidden','true');
      main.canvas.after(canvas);
      fit(canvas);
      const [{Engine},{install}]=await Promise.all([
        import('@margoengine/core'),import('@margoengine/webgl2-compat'),
      ]);
      await install({force:true,signal});
      engine=await Engine.create(canvas,{
        backend:'webgpu',signal,exactSize:true,antialias:false,capacity:112,camera:{near:.06,far:14},
      });
      engine.onError=fail;
      engine.scene.background='#344556';
      instrument=buildInstrument(engine);
      figure=Figure.attach(engine,modelView);
    }else{
      figure=main.figure;
    }
    const {tetrahedralVolume}=await source;
    signal.throwIfAborted();
    volume=tetrahedralVolume(figure,grid,{
      range:temperatures,colormap:palette,opacity:[[0,.025],[.25,.07],[.65,.31],[1,.66]],
      referenceStep:.022,density:1.25,mode:'composite',quality:1.3,shading:true,signal,
    });
    volume.visible=false;
    await figure.ready();
    if(main.preview){
      special={
        canvas,engine,figure,instrument,draw:()=>figure.render(),settle:()=>engine.gpu.queue.onSubmittedWorkDone(),
      };
      bindCamera(canvas);
    }
    stage.volumeCells=String(volume.cellCount);
    return true;
  }catch(reason){
    volume?.dispose();
    volume=undefined;
    if(main.preview){figure?.dispose();instrument?.dispose();engine?.dispose();canvas?.remove();}
    if(signal.aborted)return false;
    if(!main.preview||!['unsupported','no-adapter'].includes(reason?.code))throw reason;
    const button=views.find(view=>view.dataset.mode==='volume');
    button.disabled=true;
    by('volume-requirements').hidden=false;
    return false;
  }
}

function layers(mode){
  const sectional=mode==='section';
  main.layers.section.visible=sectional;
  main.layers.shell.visible=sectional;
  main.layers.edges.visible=sectional&&showEdges;
  if(volume)volume.visible=!sectional;
}

function presentation(mode){
  const sectional=mode==='section';
  if(special){
    special.canvas.classList.toggle('shown',!sectional);
    special.canvas.setAttribute('aria-hidden',String(sectional));
    main.canvas.setAttribute('aria-hidden',String(!sectional));
    if(!sectional)special.canvas.setAttribute('aria-label',main.canvas.getAttribute('aria-label'));
  }
  activeCanvas=target(mode).canvas;
  for(const button of views)button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
  edges.disabled=!sectional;
  by('mode-description').textContent=sectional
    ?'Each colored face is a cross-section through a tetrahedral cell.'
    :'Rays traverse the clipped tetrahedra and blend their temperatures.';
  stage.presentation=special&&!sectional?'raycast':'section';
}

async function paintControls() {
  queued=false;
  if(running||signal.aborted)return;
  running=true;
  try {
    while(drawn!==wanted||activeMode!==wantedMode||main.layers.edges.visible!==(showEdges&&activeMode==='section')){
      const request=revision,offset=wanted,mode=wantedMode;
      if(mode==='volume'&&!volume){
        const available=await openVolume();
        if(signal.aborted)return;
        if(!available){wantedMode='section';continue;}
      }
      if(request!==revision)continue;
      let section=lastSection;
      if(mode==='section'){
        if(drawn!==offset||activeMode!=='section'){
          const update=await cut(grid,offset,signal);
          if(request!==revision)continue;
          section=update.section;
          main.layers.shell.update(update.shell);
          main.layers.section.update(section);
          main.layers.edges.update(update.edges);
        }
      }else if(drawn!==offset){
        section=planarCut(grid,offset);
      }
      if(request!==revision)continue;
      lastSection=section;
      setPlane(offset);
      layers(mode);
      render(mode);
      await target(mode).settle();
      if(signal.aborted)return;
      presentation(mode);
      drawn=offset;
      activeMode=mode;
      displayStatistics(section,offset);
      stage.mode=mode;
      stage.edges=String(main.layers.edges.visible);
      if(!performance.getEntriesByName('first-control-frame').length)performance.mark('first-control-frame');
      performance.mark('control-frame');
    }
  }finally{
    running=false;
  }
}

function schedule(){
  revision++;
  if(queued||running)return;
  queued=true;
  frame=requestAnimationFrame(()=>void paintControls().catch(fail));
}

function input(){
  const events={signal};
  slider.addEventListener('input',()=>{wanted=Number(slider.value);schedule();},events);
  edges.addEventListener('change',()=>{showEdges=edges.checked;schedule();},events);
  for(const button of views)button.addEventListener('click',()=>{wantedMode=button.dataset.mode;schedule();},events);
  bindCamera(main.canvas);
}

export async function open(initial){
  ({signal,fail,fit,controls}=initial);
  const {engine,canvas,data,status,compatibility,overlay}=initial;
  grid=data.grid;
  const instrument=buildInstrument(engine);
  const preview=compatibility?sectionPass(engine,data.contents):undefined;
  const figure=preview?undefined:Figure.attach(engine,modelView);
  const {section,shell,edges:wire}=data.contents;
  const layerset=preview??{
    shell:meshLayer(figure,shell,{colormap:shellPalette,range:temperatures}),
    section:meshLayer(figure,section,{colormap:palette,range:temperatures}),
    edges:meshLayer(figure,wire,{colormap:['#163943','#163943'],range:[0,1],opacity:.49}),
  };
  main={
    engine,canvas,instrument,figure,preview,layers:layerset,
    draw:preview?preview.render:()=>figure.render(),
    settle:preview?preview.settle:()=>engine.gpu.queue.onSubmittedWorkDone(),
  };
  lastSection=section;
  setPlane(initialOffset);
  await figure?.ready();
  presentation(activeMode);
  render();
  await main.settle();
  signal.throwIfAborted();
  drawn=initialOffset;
  stage.renderer=compatibility?'webgl2':'webgpu';
  stage.mode=activeMode;
  stage.edges='true';
  stage.cells=String(grid.types.length);
  by('cell-count').textContent=grid.types.length.toLocaleString('en-US');
  displayStatistics(section,initialOffset);
  input();
  observer=new ResizeObserver(()=>{
    const changed=fit(main.canvas);
    const resizedVolume=special?fit(special.canvas):false;
    if(changed||resizedVolume)render();
  });
  observer.observe(canvas);
  controls.disabled=false;
  if(status.ready())overlay.hidden=true;
  performance.mark('engineering-ready');
}

export function close(){
  if(frame)cancelAnimationFrame(frame);
  observer?.disconnect();
  volume?.dispose();
  special?.figure.dispose();
  special?.instrument.dispose();
  special?.engine.dispose();
  main?.figure?.dispose();
  main?.preview?.dispose();
  main?.instrument.dispose();
}
