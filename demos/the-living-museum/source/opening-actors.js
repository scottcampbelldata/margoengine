import { Geometry, PbrMaterial } from '@margoengine/core';
import { palettes } from './palettes.js';

const skin=[.37,.196,.121], jacket=[.43,.29,.16];
const colors=[skin,'#392c27','#372c2a','#5b554f',jacket,'#393232','#4c372b','#41474b'];

function decode(bytes) {
  const view=new DataView(bytes);
  const version=view.getUint8(0), frames=view.getUint8(1), groups=view.getUint8(2);
  if(version!==2 || frames!==3 || groups!==7)throw new Error('The opening visitor mesh has an unexpected format.');
  let cursor=4;
  const parts=[];
  for(let part=0;part<groups;part++) {
    const length=3*view.getUint32(cursor,true), indexCount=view.getUint32(cursor+4,true);
    cursor+=8;
    const poses=[];
    for(let frame=0;frame<frames;frame++) {
      const positions = new Float32Array(length), normals = new Float32Array(length);
      const prior=[0,0,0], priorNormal=[0,0,0];
      for(let i=0;i<length;i++) {
        const axis=i%3;
        const delta=view.getUint8(cursor+i)|(view.getInt8(cursor+length+i)<<8);
        prior[axis]=((prior[axis]+delta+32768)&65535)-32768;
        priorNormal[axis]=((priorNormal[axis]+view.getUint8(cursor+2*length+i)+128)&255)-128;
        positions[i]=prior[axis]/12000+(frame===0?0:poses[0].positions[i]);
        normals[i]=priorNormal[axis]/120;
      }
      cursor+=length*3;
      poses.push({positions,normals});
    }
    const indices=new Uint32Array(indexCount);
    for(let i=0;i<indices.length;i++)indices[i]=view.getUint16(cursor+2*i,true);
    cursor+=indexCount*2;
    if(part===4) {
      const lower=[],upper=[];
      for(let i=0;i<indices.length;i+=3) {
        const triangle=indices.subarray(i,i+3);
        let y=0;
        for(const corner of triangle)y+=poses[0].positions[corner*3+1];
        (y<2.59?lower:upper).push(...triangle);
      }
      parts.push({part:7,poses,indices:lower},{part,poses,indices:upper});
    } else parts.push({part,poses,indices});
  }
  if(cursor!==bytes.byteLength)throw new Error('The opening visitor packet has trailing data.');
  return parts.map(({part,poses,indices})=>({part,frames:poses.map(({positions,normals})=>new Geometry(positions,normals,indices))}));
}

export function buildOpeningActors(engine,world,bytes) {
  const parts=decode(bytes);
  const agents=[world.player,world.guard,...world.guests.map(guest=>guest.agent)];
  return agents.map((agent,index)=>{
    const root=engine.createMesh();
    const palette=palettes[index];
    root.setScale([palette.size,palette.size,palette.size]);
    const meshes=parts.map(({part,frames})=>{
      const swatch=colors[part], transform=part===0?palette.skin:part===4?palette.coat:null;
      const color=transform?swatch.map((value,channel)=>value*transform[channel]):swatch;
      const mesh=engine.createMesh(root).setGeometry(frames[0]).setMaterial(new PbrMaterial({color,roughness:.82}));
      return {mesh,frames};
    });
    let yaw=index===1?0:Math.PI*.96,gait=index*.17,current=0;
    return {
      update(delta) {
        const [x,,z]=agent.velocity;
        const speed=Math.hypot(x,z);
        if(speed>.09) {
          const turn=Math.atan2(x,z)-yaw;
          yaw+=(1-Math.exp(-delta*8.1))*Math.atan2(Math.sin(turn),Math.cos(turn));
        }
        gait=(gait+speed*delta/(1.20*palette.size))%1;
        const cycle=Math.sin(gait*Math.PI*2);
        const next=speed<.14||Math.abs(cycle)<.55?0:cycle>0?1:2;
        if(next!==current) {
          for(const {mesh,frames} of meshes)mesh.setGeometry(frames[next]);
          current=next;
        }
        root.setPosition([agent.position[0],-.012,agent.position[2]]).setRotation([0,yaw,0]);
      },
      dispose(){ for(const {mesh} of meshes)mesh.dispose();root.dispose(); },
    };
  });
}
