import { Geometry, PbrMaterial } from '@margoengine/core';

const format=new Intl.NumberFormat('en-US',{maximumFractionDigits:1});
const threshold=[0,4.8,6.1,7.9,10.0];

function unpack(bytes){
  const view=new DataView(bytes);
  if(view.getUint8(0)!==1||view.getUint8(1)!==5)throw new Error('The sculpture packets have an unexpected version.');
  let cursor=4;
  const number=(index,length)=>view.getUint8(cursor+index)|(view.getInt8(cursor+length+index)<<8);
  const levels=[];
  for(let level=0;level<5;level++){
    const coordinates=3*view.getUint32(cursor,true), corners=view.getUint32(cursor+4,true);
    cursor+=8;
    const points=new Float32Array(coordinates), indices=new Uint32Array(corners);
    const prior=[0,0,0];
    for(let i=0;i<coordinates;i++){
      const axis=i%3;
      prior[axis]=((prior[axis]+number(i,coordinates)+32768)&65535)-32768;
      points[i]=prior[axis]/10000;
    }
    cursor+=coordinates*2;
    let last=0;
    for(let i=0;i<corners;i++){
      last=(last+number(i,corners))&65535;
      if(last>=coordinates/3)throw new Error('A sculpture index is out of bounds.');
      indices[i]=last;
    }
    cursor+=corners*2;
    levels.push({points,indices,count:corners/3});
  }
  if(cursor!==bytes.byteLength)throw new Error('The sculpture archive has unexpected data.');
  return levels;
}

function surface({points,indices},flat=false){
  const positions=flat?new Float32Array(indices.length*3):points;
  const normals=new Float32Array(positions.length);
  const connectivity=flat?Uint32Array.from(indices,(_,i)=>i):indices;
  for(let i=0;i<indices.length;i+=3){
    const a=indices[i]*3,b=indices[i+1]*3,c=indices[i+2]*3;
    const ux=points[b]-points[a],uy=points[b+1]-points[a+1],uz=points[b+2]-points[a+2];
    const vx=points[c]-points[a],vy=points[c+1]-points[a+1],vz=points[c+2]-points[a+2];
    const x=uy*vz-uz*vy,y=uz*vx-ux*vz,z=ux*vy-uy*vx;
    for(let k=0;k<3;k++){
      const into=connectivity[i+k]*3;
      if(flat){
        const from=indices[i+k]*3;
        positions.set(points.subarray(from,from+3),into);
      }
      normals[into]+=x;
      normals[into+1]+=y;
      normals[into+2]+=z;
    }
  }
  for(let i=0;i<normals.length;i+=3){
    const length=Math.hypot(normals[i],normals[i+1],normals[i+2]);
    if(length>0){normals[i]/=length;normals[i+1]/=length;normals[i+2]/=length;}
    else normals[i+1]=1;
  }
  return new Geometry(positions,normals,connectivity);
}

function ring(rows){
  const sides=112,pts=[],nrm=[],idx=[];
  for(const [radius,y,ny,radial] of rows)for(let i=0;i<sides;i++){
    const phi=2*Math.PI*i/sides,x=Math.cos(phi),z=Math.sin(phi);
    pts.push(radius*x,y,radius*z);
    nrm.push(radial*x,ny,radial*z);
  }
  for(let row=0;row<rows.length-1;row++)for(let i=0;i<sides;i++){
    const a=row*sides+i,b=row*sides+(i+1)%sides;
    idx.push(a,a+sides,b+sides,a,b+sides,b);
  }
  const last=sides*(rows.length-1), center=pts.length/3;
  pts.push(0,rows.at(-1)[1],0);
  nrm.push(0,1,0);
  for(let i=0;i<sides;i++)idx.push(center,last+(i+1)%sides,last+i);
  return new Geometry(pts,nrm,idx);
}

function studioSweep(){
  const rows=[[9,-.39,1,0],[-2.7,-.39,1,0]], points=[], normals=[], indices=[];
  for(let i=1;i<=18;i++){
    const curve=Math.PI*i/36, y=Math.cos(curve), z=Math.sin(curve);
    rows.push([-2.7-2.25*z,-.39+2.25*(1-y),y,z]);
  }
  rows.push([-4.95,10,0,1]);
  for(const [z,y,ny,nz] of rows){
    points.push(-18,y,z,18,y,z);
    normals.push(0,ny,nz,0,ny,nz);
  }
  for(let i=0;i<rows.length-1;i++){
    const a=i*2;
    indices.push(a,a+1,a+3,a,a+3,a+2);
  }
  return new Geometry(points,normals,indices);
}

export async function open({engine,bytes,fit,status,notice,signal,fail}){
  const {canvas}=engine;
  const input=document.querySelector('#level');
  const label=document.querySelector('label[for=level]');
  const reading=document.querySelector('#measure');
  const count=document.querySelector('#triangles');
  const remaining=document.querySelector('#remaining');
  const source=document.querySelector('#total');
  const modes=[...document.querySelectorAll('.modes button')];
  const levels=unpack(bytes), cache=new Map();
  let view='smooth', desired='smooth', level=0, distance=3.85;
  let autoSystem,autoLoad,lod,raf,shadowTimer,inflight=false,inputSerial=0,renderedInput=0;
  const options=(geo,color,roughness,metalness=0)=>engine.createMesh().setGeometry(geo)
    .setMaterial(new PbrMaterial({color,roughness,metalness,doubleSided:false}));

  engine.onError=fail;
  engine.scene.background='#25413b';
  engine.lighting.direction.set([-3.65,5.8,4.5,4.05]);
  engine.lighting.radiance.set([1,.89,.77,.52]);
  engine.lighting.ambient.set([.67,.80,1]);
  const floor=options(studioSweep(),'#304840',.83);
  const pedestal=options(ring([[.69,-.39,0,1],[.711,-.367,-.52,.86],[.711,-.151,0,1],
    [.704,-.123,.62,.78],[.678,-.111,1,0]]),'#38494a',.83);
  const bezel=options(ring([[.705,-.132,-.4,.91],[.711,-.125,0,1],[.707,-.117,.55,.83],
    [.678,-.109,1,0]]),'#b48a62',.37,1);
  const turntable=options(ring([[.655,-.110,0,1],[.655,-.046,0,1],[.640,-.019,.63,.77],
    [.619,-.002,1,0]]),'#788176',.57);
  const statue=options(geometry(0,false),'#c6b79b',.71);
  source.value=format.format(levels[0].count);

  function geometry(index,flat){
    const key=index+'/'+flat;
    if(!cache.has(key))cache.set(key,surface(levels[index],flat));
    return cache.get(key);
  }
  function camera(){
    const ratio=canvas.width/canvas.height;
    engine.camera.fov=Math.max(34,2*Math.atan(.32/ratio)*180/Math.PI);
    const d=view==='auto'?distance:3.85;
    engine.camera.target=[0,.72,0];
    engine.camera.position=[d*.274,.72+d*.177,d*.945];
  }
  function report(){
    const index=lod?lod.level:level;
    if(index<0)return;
    const result=statue.geometry.indices.length/3;
    count.value=format.format(result);
    remaining.value=format.format(100*result/levels[0].count)+'%';
    reading.value=view==='auto'?format.format(distance)+' m':index===0?'Original':'LOD '+index;
    input.setAttribute('aria-valuetext',(view==='auto'?reading.value+', ':'')+count.value+' triangles');
    Object.assign(canvas.dataset,{level:index,triangles:result,mode:view});
  }
  function schedule(){if(raf===undefined&&!signal.aborted)raf=requestAnimationFrame(draw);}
  function draw(){
    raf=undefined;
    if(signal.aborted)return;
    try{
      if(view!=='auto'){
        const next=geometry(level,view==='facets');
        if(statue.geometry!==next)statue.setGeometry(next);
      }
      camera();
      engine.render({delta:0});
      report();
      const serial=inputSerial;
      if(serial>renderedInput&&!inflight){
        inflight=true;
        engine.gpu.queue.onSubmittedWorkDone().then(()=>{
          inflight=false;
          if(signal.aborted)return;
          renderedInput=serial;
          performance.mark('simplifier-level-applied');
          if(inputSerial>serial)schedule();
        }).catch(fail);
      }
    }catch(reason){fail(reason);}
  }
  async function switchMode(next){
    if(next===desired)return;
    desired=next;
    if(next==='auto'&&!autoSystem){
      autoLoad??=import('@margoengine/lod').then(({LODSystem})=>{
        if(!signal.aborted)return LODSystem.attach(engine,{hysteresis:0});
      });
      autoSystem=await autoLoad;
      if(signal.aborted||desired!==next)return;
    }
    lod?.remove();
    lod=undefined;
    view=next;
    for(const button of modes)button.setAttribute('aria-pressed',String(button.id===view));
    if(view==='auto'){
      label.textContent='Viewing distance';
      input.min='3.6';input.max='11.7';input.step='.1';input.value=distance;
      lod=autoSystem.add(statue,levels.map((_,index)=>({object:geometry(index,false),distance:threshold[index]})));
    }else{
      label.textContent='Level of detail';
      input.min='0';input.max='4';input.step='1';input.value=level;
    }
    schedule();
  }

  draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  if(signal.aborted)return;
  input.disabled=false;
  input.addEventListener('input',()=>{
    if(view==='auto')distance=Number(input.value);
    else level=Number(input.value);
    inputSerial++;
    schedule();
  },{signal});
  for(const button of modes){
    button.disabled=false;
    button.addEventListener('click',()=>{switchMode(button.id).catch(fail);},{signal});
  }
  const observer=new ResizeObserver(()=>{if(fit())schedule();});
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{
    observer.disconnect();
    clearTimeout(shadowTimer);
    if(raf!==undefined)cancelAnimationFrame(raf);
    lod?.remove();
  },{once:true});
  canvas.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'compatibility':'webgpu';
  if(status.ready())notice.hidden=true;
  performance.mark('margo-first-usable-frame');

  shadowTimer=setTimeout(async()=>{
    try{
      const {Shadows}=await import('@margoengine/shadows');
      if(signal.aborted)return;
      const shadows=Shadows.attach(engine,{resolution:1024,cascades:1,filter:'soft',lightSize:.07,
        samples:10,blockerSamples:7,bounds:{min:[-2.4,-.40,-2.4],max:[2.4,1.86,2.4]}});
      shadows.add(floor,{castShadow:false});
      for(const mesh of [pedestal,bezel,turntable,statue])shadows.add(mesh);
      engine.render({delta:0});
      await engine.gpu.queue.onSubmittedWorkDone();
      if(!signal.aborted)canvas.dataset.finish='studio';
    }catch(reason){fail(reason);}
  },650);
}
