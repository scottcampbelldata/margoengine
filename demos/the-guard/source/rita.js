import {Geometry,PbrMaterial} from '@margoengine/core';
import {bakeSkin} from '@margoengine/geometry/utils';
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
    return {key,color,points,normals,weights,joints,indices};
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
  const rows=new Float32Array(table[0].length),palette=new Float32Array(rows.length/12*16);
  for(let j=15;j<palette.length;j+=16)palette[j]=1;
  const subjects=meshes.map(group=>({...group,bind:{positions:group.points,normals:group.normals,indices:group.indices},mesh:engine.createMesh(root).setMaterial(new PbrMaterial({
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
      for(let j=0;j<rows.length/12;j++)for(let r=0;r<3;r++)for(let c=0;c<4;c++)palette[j*16+c*4+r]=rows[j*12+r*4+c];
      const lowest=[[0,Infinity,0],[0,Infinity,0]];
      for(const group of subjects){
        const posed=bakeSkin(group.bind,{joints:group.joints,weights:group.weights,matrices:palette});
        if(group.key==='shoe')for(let i=0;i<posed.positions.length;i+=3){
          const foot=group.points[i]>=0?0:1,y=posed.positions[i+1];
          if(y<lowest[foot][1])lowest[foot]=[posed.positions[i],y,posed.positions[i+2]];
        }
        group.mesh.setGeometry(new Geometry(posed.positions,posed.normals,group.indices));
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
