import { Engine, Geometry, PbrMaterial, box } from '@margoengine/core';
import { rayStudy } from './optics.js';

const tone=new Intl.NumberFormat('en-US',{maximumFractionDigits:1});
const subtract=(a,b)=>a.map((value,axis)=>value-b[axis]);
const cross=([x,y,z],[a,b,c])=>[y*c-z*b,z*a-x*c,x*b-y*a];
const unit=v=>{const length=Math.hypot(...v);return v.map(value=>value/length);};
const world=([x,z], y=.466)=>[x,y,z];

function tube(a,b,radius){
  const along=unit(subtract(b,a));
  const side=unit(cross(Math.abs(along[1])>.9?[1,0,0]:[0,1,0],along));
  const up=cross(along,side), positions=[], normals=[], indices=[];
  const sides=8;
  for(const center of [a,b])for(let i=0;i<sides;i++){
    const angle=i*2*Math.PI/sides;
    const n=side.map((value,axis)=>value*Math.cos(angle)+up[axis]*Math.sin(angle));
    positions.push(...center.map((value,axis)=>value+radius*n[axis]));
    normals.push(...n);
  }
  for(let i=0;i<sides;i++){
    const j=(i+1)%sides;
    indices.push(i,j,j+sides,i,j+sides,i+sides);
  }
  return new Geometry(positions,normals,indices);
}

async function device(canvas,signal){
  const force=new URLSearchParams(location.search).get('backend')==='webgl2';
  const options={backend:'webgpu',exactSize:true,antialias:true,capacity:56,signal,startupTimeout:2500,
    camera:{position:[2.66,3.91,-2.91],target:[.49,.20,.28],near:.07,far:20,fov:32}};
  if(!force&&navigator.gpu){
    try{return await Engine.create(canvas,options);}
    catch(error){if(error?.code!=='unsupported'&&error?.code!=='timeout')throw error;}
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,signal});
  return Engine.create(canvas,options);
}

export async function openDiagram({canvas,signal,fail}){
  function fit(){
    const width=Math.max(1,Math.round(canvas.clientWidth*1.65)), height=Math.max(1,Math.round(width*9/16));
    if(canvas.width===width&&canvas.height===height)return false;
    canvas.width=width;
    canvas.height=height;
    return true;
  }
  fit();
  const engine=await device(canvas,signal);
  if(signal.aborted){engine.dispose();signal.throwIfAborted();}
  engine.onError=fail;
  engine.scene.background='#182a2f';
  engine.lighting.direction.set([-3.1,6.5,3.3,3.35]);
  engine.lighting.radiance.set([1,.95,.85,.75]);
  engine.lighting.ambient.set([.88,.95,1]);
  const material=color=>new PbrMaterial({color,roughness:.62});
  const mesh=(geometry,color)=>engine.createMesh().setGeometry(geometry).setMaterial(material(color));
  const beam=(a,b,color,radius=.0058)=>mesh(tube(a,b,radius),color);
  const study=rayStudy();
  mesh(box(30,.12,30),'#21363a').setPosition([.4,-.094,.4]);
  mesh(box(3.4,.14,2.8),'#312f2a').setPosition([.6,-.006,.28]);
  mesh(box(3.34,.018,2.75),'#967158').setPosition([.6,.063,.28]);
  mesh(box(3.29,.022,2.70),'#594637').setPosition([.60,.075,.28]);
  mesh(box(.78,.075,.66),'#2f4142').setPosition([.49,.118,-.21]);
  mesh(box(.71,.016,.59),'#b19363').setPosition([.49,.158,-.21]);
  const rim=material('#a3c8c2');
  for(const [i,start] of study.vertices.entries()){
    const end=study.vertices[(i+1)%study.vertices.length];
    for(const y of [.174,.751])engine.createMesh().setGeometry(tube(world(start,y),world(end,y),.011)).setMaterial(rim);
    engine.createMesh().setGeometry(tube(world(start,.174),world(start,.751),.011)).setMaterial(rim);
  }
  const [rx,rz]=study.center,[dx,dz]=study.receiverDirection;
  const rotation=[0,Math.atan2(-dz,dx),0];
  mesh(box(.58,.43,.025),'#dfd8bf').setPosition([rx,.38,rz]).setRotation(rotation);
  mesh(box(.63,.08,.29),'#354447').setPosition([rx,.13,rz]).setRotation(rotation);
  mesh(box(.545,.017,.035),'#9c8261').setPosition([rx,.592,rz]).setRotation(rotation);
  const towards=rayStudy(true).rays[0].direction;
  for(let tick=-5;tick<=5;tick++){
    const offset=tick*.025;
    const center=[rx+dx*offset-.014*towards[0],.547,rz+dz*offset-.014*towards[1]];
    mesh(box(.004,tick%5===0?.029:.016,.003),'#8e7652').setPosition(center).setRotation(rotation);
  }
  const [sx,sz]=study.source;
  mesh(box(.23,.055,.215),'#344244').setPosition([sx,.112,sz]);
  mesh(box(.21,.29,.19),'#68736e').setPosition([sx,.32,sz]);
  mesh(box(.08,.045,.085),'#dfce85').setPosition([sx,.455,sz]);
  beam(world(study.source),world(study.entry),'#f5deb0',.014);

  let paths=[], active=true;
  const observer=new ResizeObserver(()=>{if(active&&fit())engine.render({delta:0});});
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{observer.disconnect();engine.dispose();},{once:true});
  return {
    renderer:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'compatibility':'webgpu',
    async choose(which){
      signal.throwIfAborted();
      const {rays,entry,width}=rayStudy(which==='fixed');
      for(const handle of paths)handle.dispose();
      paths=[];
      for(const ray of rays){
        paths.push(beam(world(entry),world(ray.exit),ray.color,.0047));
        const end=ray.hit.map((n,i)=>n-.011*ray.direction[i]);
        paths.push(beam(world(ray.exit),world(end),ray.color,rays.length===1?.012:.0074));
        paths.push(mesh(box(.011,.048,.008),ray.color).setPosition(world(end)).setRotation(rotation));
      }
      fit();
      engine.render({delta:0});
      await engine.gpu.queue.onSubmittedWorkDone();
      return {rays:rays.length,width,text:width>0?'435.8–656.3 nm across '+tone.format(width*100)+' cm':'One exit direction at a fixed index of 1.68'};
    },
    async snapshot(){
      signal.throwIfAborted();
      engine.render({delta:0});
      return new Promise((resolve,reject)=>canvas.toBlob(png=>{
        if(png)resolve(png);
        else reject(new Error('The ray study could not be saved.'));
      },'image/png'));
    },
    setVisible(value){active=value;},
  };
}
