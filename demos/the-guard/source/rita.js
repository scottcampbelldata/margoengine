import {Geometry,PbrMaterial} from '@margoengine/core';
import actorURL from './rita.rig?url';

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

export async function openRita(signal){
  const response=await fetch(actorURL,{signal});
  if(!response.ok||!response.body)throw new Error('Rita’s gallery model could not load.');
  const value=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  signal.throwIfAborted();
  const data=new DataView(value),header=data.getUint32(0,true);
  if(header>value.byteLength-4)throw new Error('Rita’s gallery model is incomplete.');
  const {groups,bones,frames,cycleMetres,shoeFloor,neck}=JSON.parse(new TextDecoder().decode(new Uint8Array(value,4,header)));
  let offset=4+header;
  const half=()=>{const v=data.getInt16(offset,true);offset+=2;return v;};
  const unsigned=()=>data.getUint8(offset++);
  const signed=()=>data.getInt8(offset++);
  const meshes=groups.map(({key,color,vertices,indices:indexCount})=>{
    const points=new Float32Array(vertices*3),normals=new Float32Array(points.length);
    const joints=new Uint8Array(vertices*4),weights=new Float32Array(vertices*4);
    for(let axis=0;axis<3;axis++){
      let position=0;
      for(let i=0;i<vertices;i++){position+=half();points[i*3+axis]=position/4096;}
    }
    for(let i=0;i<normals.length;i++)normals[i]=signed()/127;
    for(let k=0;k<4;k++)for(let i=0;i<vertices;i++)joints[i*4+k]=unsigned();
    for(let k=0;k<3;k++)for(let i=0;i<vertices;i++)weights[i*4+k]=unsigned()/255;
    for(let i=0;i<weights.length;i+=4)weights[i+3]=Math.max(0,1-weights[i]-weights[i+1]-weights[i+2]);
    let prior=0;
    const indices=new Uint32Array(indexCount);
    for(let i=0;i<indices.length;i++){prior+=half();indices[i]=prior;}
    return {key,color,points,normals,weights,joints,indices,p:new Float32Array(points.length),n:new Float32Array(points.length)};
  });
  const table=Array.from({length:frames},()=>new Float32Array(bones*12));
  for(let i=0;i<bones*12;i++){
    let previous=0;
    for(const frame of table){previous+=half();frame[i]=previous/8192;}
  }
  if(offset!==data.byteLength)throw new Error('Rita’s motion or mesh channels are incomplete.');
  return {meshes,table,cycleMetres,shoeFloor,neck};
}

export function placeRita(engine,{meshes,table,cycleMetres,shoeFloor,neck}){
  const root=engine.createMesh();
  root.name='Rita_GalleryAttendant';
  const rows=new Float32Array(table[0].length);
  const subjects=meshes.map(group=>({...group,mesh:engine.createMesh(root).setMaterial(new PbrMaterial({
    color:group.color,roughness:group.key==='shoe'?.61:.84,doubleSided:group.key.startsWith('hair'),
  }))}));
  let face=3.11,amplitude=0,lastAppearance=-1,groundLift=-shoeFloor;
  const state={phase:0,lift:groundLift,bodyAngle:face,step:0,footprint:0,soleContacts:[]};
  const ageBy=(a,b)=>Math.atan2(Math.sin(a-b),Math.cos(a-b));
  function pose(input,dt,force=false){
    if(force&&dt===0){face=input.facing;amplitude=0;}
    amplitude+=(clamp(input.speed/.78,0,1)-amplitude)*(1-Math.exp(-9.7*dt));
    const gap=ageBy(input.facing,face);
    const desired=input.speed>.06||input.state!=='Searching';
    if(desired)face+=clamp(gap,-4.60*dt,4.60*dt);
    state.bodyAngle=face;
    root.setRotation([0,face,0]);
    if(force||input.elapsed-lastAppearance>=.028){
      lastAppearance=input.elapsed;
      const phase=(input.distance/cycleMetres)%1,count=table.length-1;
      const x=phase*count,index=Math.floor(x),alpha=x-index;
      const prev=table[1+index],next=table[1+(index+1)%count],quiet=table[0];
      for(let i=0;i<rows.length;i++)rows[i]=quiet[i]+(prev[i]+(next[i]-prev[i])*alpha-quiet[i])*amplitude;
      const looking=clamp(ageBy(input.facing,face),-.58,.58)*(input.state==='Searching'?1:.4)+
        Math.sin(input.elapsed*1.89)*.024*(1-amplitude);
      for(const [i,joint] of neck.entries()){
        const angle=looking*(i===0?.53:.83),c=Math.cos(angle),s=Math.sin(angle),b=joint*12;
        for(let a=0;a<4;a++){
          const x=rows[b+a],z=rows[b+8+a];
          rows[b+a]=c*x+s*z;rows[b+8+a]=-s*x+c*z;
        }
      }
      const lowest=[[0,Infinity,0],[0,Infinity,0]];
      for(const group of subjects){
        const {points,normals,weights,joints,indices,p,n,mesh}=group;
        for(let vertex=0;vertex<points.length/3;vertex++){
          const ix=vertex*3,i=vertex*4,x=points[ix],y=points[ix+1],z=points[ix+2];
          const nx=normals[ix],ny=normals[ix+1],nz=normals[ix+2];
          let px=0,py=0,pz=0,nx2=0,ny2=0,nz2=0;
          for(let k=0;k<4;k++){
            const w=weights[i+k];
            if(w<=0)continue;
            const j=12*joints[i+k];
            px+=w*(rows[j]*x+rows[j+1]*y+rows[j+2]*z+rows[j+3]);
            py+=w*(rows[j+4]*x+rows[j+5]*y+rows[j+6]*z+rows[j+7]);
            pz+=w*(rows[j+8]*x+rows[j+9]*y+rows[j+10]*z+rows[j+11]);
            nx2+=w*(rows[j]*nx+rows[j+1]*ny+rows[j+2]*nz);
            ny2+=w*(rows[j+4]*nx+rows[j+5]*ny+rows[j+6]*nz);
            nz2+=w*(rows[j+8]*nx+rows[j+9]*ny+rows[j+10]*nz);
          }
          const foot=x>=0?0:1;
          if(group.key==='shoe'&&py<lowest[foot][1])lowest[foot]=[px,py,pz];
          p[ix]=px;p[ix+1]=py;p[ix+2]=pz;
          const length=Math.hypot(nx2,ny2,nz2)||1;
          n[ix]=nx2/length;n[ix+1]=ny2/length;n[ix+2]=nz2/length;
        }
        mesh.setGeometry(new Geometry(p,n,indices));
      }
      // Real lowest deformed tread sets the common floor offset for the walk and standing capture.
      const floor=Math.min(lowest[0][1],lowest[1][1]);
      groundLift=.010-floor;
      const c=Math.cos(face),v=Math.sin(face);
      state.soleContacts=lowest.map(([x,y,z])=>[input.position[0]+c*x+v*z,y+groundLift-.006,input.position[2]-v*x+c*z]);
      state.phase=phase;state.lift=groundLift;state.footprint=floor+groundLift-.006;state.step++;
    }
    root.setPosition([input.position[0],groundLift,input.position[2]]);
  }
  return {pose,state};
}
