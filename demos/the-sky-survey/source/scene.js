import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { catalogFilters, direction, loadDetails } from './survey.js';

const radius=1.325, center=[0,.17,0], rad=Math.PI/180;
const mix=(a,b,k)=>a+(b-a)*k;
const add=([a,b,c],[d,e,f])=>[a+d,b+e,c+f];
const scale=([x,y,z],n)=>[x*n,y*n,z*n];
const dot=([a,b,c],[d,e,f])=>a*d+b*e+c*f;
const cross=([a,b,c],[d,e,f])=>[b*f-c*e,c*d-a*f,a*e-b*d];
const unit=v=>scale(v,1/Math.hypot(...v));
const position=(d,r=radius)=>add(center,scale(d,r));
const fmt=new Intl.NumberFormat('en-US');
const markerColors=['#596f9a','#7391c3','#8fafd7','#b2c0e9','#dfc7d1','#efc297','#f4c47c','#fbd1a1','#ffe6ba','#fff1d5'];

function geo() { return {points:[],normals:[],faces:[]}; }
function quad(target,points,normals) {
  const index=target.points.length/3;
  for(const [i,p] of points.entries()){
    target.points.push(...p);
    target.normals.push(...normals[i]);
  }
  target.faces.push(index,index+1,index+2,index,index+2,index+3);
}
function geometry({points,normals,faces}) { return new Geometry(points,normals,faces); }
function place(engine,shape,name,color,roughness=.5,metalness=0) {
  const part=engine.createMesh();
  part.name=name;
  part.setGeometry(shape).setMaterial(new PbrMaterial({color,roughness,metalness}));
  return part;
}

function sphere() {
  const mesh=geo(), columns=96, rows=48;
  for(let j=1;j<rows;j++){
    for(let i=0;i<columns;i++){
      const normal=direction(i*360/columns,j*180/rows-90);
      mesh.points.push(...position(normal));
      mesh.normals.push(...normal);
    }
  }
  const south=mesh.points.length/3;
  mesh.points.push(...position([0,-1,0]),...position([0,1,0]));
  mesh.normals.push(0,-1,0,0,1,0);
  for(let i=0;i<columns;i++){
    const next=(i+1)%columns, last=(rows-2)*columns;
    mesh.faces.push(south,next,i,south+1,last+i,last+next);
    for(let k=0;k<rows-2;k++){
      const a=k*columns+i, b=k*columns+next;
      mesh.faces.push(a,b,b+columns,a,b+columns,a+columns);
    }
  }
  return geometry(mesh);
}

function ring(normal,diameter,width,depth,start=0,end=360) {
  normal=unit(normal);
  const a=unit(cross(normal,Math.abs(normal[1])>.9?[0,0,1]:[0,1,0]));
  const b=unit(cross(normal,a));
  const v=degrees=>add(scale(a,Math.cos(degrees*rad)),scale(b,Math.sin(degrees*rad)));
  const mesh=geo(), segments=Math.ceil((end-start)/2.5);
  const corners=[[-width/2,-depth/2],[width/2,-depth/2],[width/2,depth/2],[-width/2,depth/2]];
  const orient=[[0,-1],[1,0],[0,1],[-1,0]];
  for(let i=0;i<segments;i++){
    const p=v(mix(start,end,i/segments)), q=v(mix(start,end,(i+1)/segments));
    for(let side=0;side<4;side++){
      const c=corners[side], d=corners[(side+1)%4];
      const at=(r,j)=>add(position(r,diameter+j[0]),scale(normal,j[1]));
      const [u,w]=orient[side];
      const n=add(scale(p,u),scale(normal,w)), m=add(scale(q,u),scale(normal,w));
      quad(mesh,[at(p,c),at(q,c),at(q,d),at(p,d)],[n,m,m,n]);
    }
  }
  return geometry(mesh);
}

function grid() {
  const mesh=geo();
  const r=radius+.002;
  const addStrip=(sample,width,sides)=>{
    for(let i=0;i<sides;i++){
      const directions=[sample(i/sides,-width),sample((i+1)/sides,-width),
        sample((i+1)/sides,width),sample(i/sides,width)];
      quad(mesh,directions.map(d=>position(d,r)),directions);
    }
  };
  for(const latitude of [-60,-30,30,60])addStrip((a,b)=>direction(a*360,latitude+b),.11,144);
  for(let lon=0;lon<360;lon+=30)addStrip((a,b)=>direction(lon+b,-88+a*176),.12,72);
  return geometry(mesh);
}

function ticks() {
  const mesh=geo();
  for(let l=0;l<360;l+=5){
    const a=direction(l-.18,0), b=direction(l+.18,0), p=1.454, q=l%30===0?1.502:1.483;
    quad(mesh,[position(a,p),position(b,p),position(b,q),position(a,q)],[[0,1,0],[0,1,0],[0,1,0],[0,1,0]]);
  }
  return geometry(mesh);
}

function base() {
  const mesh=geo(), sides=96;
  const bands=[[.58,-1.42],[.59,-1.45],[.70,-1.49],[.72,-1.54],[.72,-1.62],[.66,-1.65],[.03,-1.65]];
  for(let i=0;i<sides;i++){
    const a=2*Math.PI*i/sides,b=2*Math.PI*(i+1)/sides;
    const v=(t,r,y)=>[r*Math.sin(t),y,r*Math.cos(t)];
    for(let k=0;k<bands.length-1;k++){
      const [r1,y1]=bands[k], [r2,y2]=bands[k+1];
      const side=(t)=>unit(v(t,Math.abs(y1-y2),r2-r1));
      quad(mesh,[v(b,r1,y1),v(a,r1,y1),v(a,r2,y2),v(b,r2,y2)],[side(b),side(a),side(a),side(b)]);
    }
  }
  return geometry(mesh);
}

function armillary(engine) {
  place(engine,box(28,.035,28),'Museum platform','#111725',.92).setPosition([0,-1.672,0]);
  place(engine,sphere(),'Galactic coordinate globe','#222a44',.69);
  place(engine,grid(),'Thirty-degree Galactic grid','#465474',.85);
  place(engine,ring([0,1,0],radius+.005,.015,.013),'Galactic equator','#9d6d54',.79);
  place(engine,ring([0,1,0],1.525,.038,.046),'Outer graduated brass equator','#926540',.42,.55);
  place(engine,ring([0,1,0],1.508,.009,.054),'Polished equator bevel','#d9a775',.38,.54);
  place(engine,ticks(),'Galactic longitude graduations','#b78362',.42,.38);
  place(engine,ring([.87,.13,.49],1.446,.038,.055),'Fixed meridian hoop','#a57048',.45,.54);
  place(engine,ring([.87,.13,.49],1.44,.010,.060),'Meridian edge polish','#d4a574',.39,.44);
  place(engine,base(),'Armillary pedestal','#7b6555',.48,.30);
  place(engine,ring([0,1,0],.689,.018,.017),'Pedestal brass inlay','#957954',.41,.46).setPosition([0,-1.699,0]);
  place(engine,ring([0,1,0],.724,.010,.011),'Pedestal lower ring','#a38261',.44,.35).setPosition([0,-1.765,0]);
}

function pointsVisible(source,filter){ return catalogFilters[filter](source); }

function markers(rows,filter) {
  const palettes=markerColors.map(geo);
  let count=0;
  for(const source of rows){
    if(!pointsVisible(source,filter))continue;
    count++;
    const d=source.direction, focus=position(d,radius+.008);
    const east=unit(cross([0,1,0],d)), north=cross(d,east);
    const strength=Number.isFinite(source.significance)?Math.min(1,Math.log1p(source.significance)/Math.log(420)):0;
    const reach=.0040+.012*Math.pow(strength,2.4);
    const offset=(axis,k)=>add(focus,scale(axis,k));
    const bucket=Math.min(palettes.length-1,Math.floor((.16+.84*strength)*palettes.length));
    quad(palettes[bucket],[offset(east,-reach),offset(north,-reach),offset(east,reach),offset(north,reach)],[d,d,d,d]);
  }
  return {count,shapes:palettes.map(p=>p.faces.length?geometry(p):null)};
}

const headerText={
  all:'Point size follows detection significance.',
  plane:'Sources within 10° of the Galactic equator.',
  pulsars:'Catalogued pulsars and millisecond pulsars.',
};
const formatCoord=(angle,digits=1)=>angle.toFixed(digits)+'°';

export async function open({canvas,rows,engine,fit,status,signal,notice,fail}) {
  const filters=[...document.querySelectorAll('[data-filter]')];
  const views=[...document.querySelectorAll('[data-orient]')];
  const count=document.querySelector('#count'), selection=document.querySelector('#selection');
  const lonOut=document.querySelector('#longitude'), latOut=document.querySelector('#latitude');
  const core=document.querySelector('#core'), north=document.querySelector('#north');
  const cursor=document.querySelector('#source-marker'), detail=document.querySelector('#inspect');
  const pretty={
    psr:'Pulsar',msp:'Millisecond pulsar',bcu:'Blazar candidate',bll:'BL Lac',
    fsrq:'Quasar',snr:'Supernova remnant',pwn:'Pulsar wind nebula',
    glc:'Globular cluster',agn:'Active galactic nucleus',spp:'Galactic candidate',
  };
  let viewLon=12, viewLat=15, filter='all', liveCount=rows.length, grabbed, picked=-1, pending, selectedVersion=0;
  let frame=0, version=0;
  let eye=direction(viewLon,viewLat);
  const cache=new Map();
  const points=markerColors.map((color,k)=>place(engine,null,'Fermi source significance ' + k,color,.78));
  engine.onError=fail;
  canvas.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'compatibility':'webgpu';
  engine.scene.background='#111624';
  engine.lighting.direction.set(new Float32Array([-3,5,4,2.2]));
  engine.lighting.radiance.set(new Float32Array([1,.90,.81,.64]));
  engine.lighting.ambient.set(new Float32Array([.66,.77,.94]));
  armillary(engine);

  function applyFilter(next) {
    if(!cache.has(next))cache.set(next,markers(rows,next));
    const {count,shapes}=cache.get(next);
    liveCount=count;
    points.forEach((point,i)=>point.setGeometry(shapes[i]));
    for(const button of filters)button.setAttribute('aria-pressed',String(button.dataset.filter===next));
    selection.textContent=headerText[next];
    if(picked>=0&&!pointsVisible(rows[picked],next)){
      picked=-1;
      delete canvas.dataset.picked;
      delete canvas.dataset.sourceName;
      selectedVersion++;
      detail.textContent='Tap a source on the globe to inspect it.';
    }
  }

  function project([x,y,z]) {
    const m=engine.camera.matrix;
    const w=m[3]*x+m[7]*y+m[11]*z+m[15];
    return [(.5+(m[0]*x+m[4]*y+m[8]*z+m[12])/(2*w))*canvas.clientWidth,
      (.5-(m[1]*x+m[5]*y+m[9]*z+m[13])/(2*w))*canvas.clientHeight];
  }
  function label(element,normal,run=radius+.02) {
    const visible=dot(normal,eye)>.215;
    element.hidden=!visible;
    if(!visible)return;
    const [x,y]=project(position(normal,run));
    element.style.left=x+'px'; element.style.top=y+'px';
  }
  function render() {
    eye=direction(viewLon,viewLat);
    engine.camera.position=add(center,scale(eye,7));
    engine.camera.target=[0,.03,0];
    engine.camera.up=Math.abs(viewLat)>89?[0,0,-1]:[0,1,0];
    engine.render({delta:0});
    lonOut.value=formatCoord(viewLon,0);
    latOut.value=formatCoord(viewLat,0);
    label(core,direction(0,0));
    label(north,direction(0,90),radius+.06);
    if(picked<0)cursor.hidden=true;
    else label(cursor,rows[picked].direction,radius+.012);
  }
  function schedule() {
    if(frame)return;
    frame=requestAnimationFrame(()=>{frame=0;if(!signal.aborted)render();});
  }
  engine.camera.project=(out,aspect,isWebGPU)=>{
    const extent=1.77;
    out[0]=1/(extent*Math.max(1,aspect));
    out[5]=1/(extent*Math.max(1,1/aspect));
    const {near,far}=engine.camera;
    out[10]=(isWebGPU?1:2)/(far-near);
    out[14]=(isWebGPU?far:far+near)/(far-near); out[15]=1;
  };
  async function applied(mark) {
    const serial=++version;
    render();
    await engine.gpu.queue.onSubmittedWorkDone();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    if(signal.aborted||serial!==version)return;
    count.value=fmt.format(liveCount);
    canvas.dataset.filter=filter;
    canvas.dataset.count=String(liveCount);
    canvas.dataset.longitude=String(viewLon);
    canvas.dataset.latitude=String(viewLat);
    performance.mark(mark);
  }
  function orient(longitude,latitude) {
    viewLon=(longitude+360)%360;
    viewLat=Math.max(-90,Math.min(90,latitude));
  }
  function probe(x,y) {
    let index=-1,best=16*16;
    for(const [i,source] of rows.entries()){
      if(!pointsVisible(source,filter)||dot(source.direction,eye)<.23)continue;
      const [sx,sy]=project(position(source.direction,radius+.008));
      const d=(sx-x)**2+(sy-y)**2;
      if(d<best){best=d;index=i;}
    }
    if(index<0)return;
    picked=index;
    const target=rows[index], number=++selectedVersion;
    const where='l '+formatCoord(target.lon)+' · b '+formatCoord(target.lat);
    const detection=Number.isFinite(target.significance)?target.significance.toFixed(1)+'σ':'Significance unavailable';
    detail.textContent=where+' · '+detection;
    label(cursor,target.direction,radius+.012);
    canvas.dataset.picked=String(index);
    pending??=loadDetails(signal);
    pending.then(data=>{
      if(signal.aborted||selectedVersion!==number)return;
      const name=data.Source_Name[index], association=data.ASSOC1[index];
      const type=pretty[target.type.toLowerCase()]??target.type;
      const flux=data.Energy_Flux100[index].toExponential(2)+' erg cm⁻² s⁻¹';
      detail.textContent=(association||name)+(association?' · '+name:'')+' · '+where+
        ' · '+detection+(type?' · '+type:'')+' · '+flux;
      canvas.dataset.sourceName=name;
    }).catch(()=>{
      if(!signal.aborted&&selectedVersion===number)detail.textContent+= ' · Catalog identifier unavailable';
    });
  }

  for(const button of filters)button.addEventListener('click',()=>{
    const next=button.dataset.filter;
    if(next===filter)return;
    filter=next; applyFilter(next);
    applied('sky-filter-applied').catch(fail);
  },{signal});
  for(const button of views)button.addEventListener('click',()=>{
    const pole=button.dataset.orient==='pole';
    orient(0,pole?90:0);
    applied('sky-orientation-applied').catch(fail);
  },{signal});
  canvas.addEventListener('pointerdown',event=>{
    if(event.button!==0||!canvas.dataset.ready)return;
    grabbed={id:event.pointerId,x:event.clientX,y:event.clientY,lon:viewLon,lat:viewLat,moved:false};
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(grabbed?.id!==event.pointerId)return;
    const dx=event.clientX-grabbed.x, dy=event.clientY-grabbed.y;
    if(Math.hypot(dx,dy)>3)grabbed.moved=true;
    if(!grabbed.moved)return;
    orient(grabbed.lon-dx*.32,grabbed.lat+dy*.28); schedule();
  },{signal});
  canvas.addEventListener('pointerup',event=>{
    if(grabbed?.id!==event.pointerId)return;
    const moved=grabbed.moved;
    grabbed=undefined;
    if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);
    if(moved){applied('sky-orientation-applied').catch(fail);return;}
    const box=canvas.getBoundingClientRect();
    probe(event.clientX-box.left,event.clientY-box.top);
  },{signal});
  canvas.addEventListener('pointercancel',()=>{grabbed=undefined;},{signal});
  const keys={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,10],ArrowDown:[0,-10]};
  canvas.addEventListener('keydown',event=>{
    if(!keys[event.key]||!canvas.dataset.ready)return;
    event.preventDefault();
    const [dl,db]=keys[event.key];
    orient(viewLon+dl,viewLat+db);
    applied('sky-orientation-applied').catch(fail);
  },{signal});
  const resize=new ResizeObserver(()=>{if(fit())schedule();});
  resize.observe(canvas);
  signal.addEventListener('abort',()=>{resize.disconnect();if(frame)cancelAnimationFrame(frame);},{once:true});
  applyFilter(filter);
  await applied('margo-first-usable-frame');
  signal.throwIfAborted();
  notice.hidden=true;
  if(status.ready())for(const button of [...filters,...views])button.disabled=false;
}
