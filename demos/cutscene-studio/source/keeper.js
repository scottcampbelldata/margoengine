import {Geometry,PbrMaterial} from '@margoengine/core';

export function readKeeper(buffer){
  const data=new DataView(buffer),length=data.getUint32(0,true);
  if(length===0||length>12000||length+4>=data.byteLength)throw new Error('The keeper asset is incomplete.');
  const table=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,4,length)));
  let at=4+length;
  const parts=table.map(({vertices,indices,color,roughness,shapes})=>{
    const p=new Float32Array(vertices*3),n=new Float32Array(vertices*3);
    for(let i=0;i<p.length;i++,at+=2)p[i]=data.getInt16(at,true)/24576;
    for(let i=0;i<n.length;i++,at++)n[i]=data.getInt8(at)/127;
    const faces=new Uint32Array(indices);
    for(let i=0;i<faces.length;i++,at+=2)faces[i]=data.getUint16(at,true);
    const morphs=new Map();
    for(const [shape,count] of Object.entries(shapes)){
      const rows=new Int16Array(count*7);
      for(let i=0;i<rows.length;i++,at+=2)rows[i]=data.getInt16(at,true);
      morphs.set(shape,rows);
    }
    return {p,n,faces,color,roughness,morphs};
  });
  if(at!==data.byteLength)throw new Error('The keeper asset length is invalid.');
  return parts;
}
const clamp=v=>Math.max(0,Math.min(1,v));
export function makeKeeper(engine,parts){
  const turn=engine.createMesh().setPosition([.98,1.51,-.28]).setRotation([0,.37,0]);
  const surfaces=parts.map(({p,n,faces,color,roughness,morphs})=>({
    p,n,faces,morphs,posed:p.slice(),normal:n.slice(),
    mesh:engine.createMesh(turn).setGeometry(new Geometry(p,n,faces)).setMaterial(new PbrMaterial({color,roughness})),
  }));
  let previous='',shown;
  return {
    pose(visible,mouth,time){
      if(visible!==shown){
        for(const {mesh} of surfaces)mesh.visible=visible;
        shown=visible;
      }
      if(!visible)return 0;
      const pick=key=>mouth[key]??0;
      const lids=Math.max(0,1-Math.abs(time-3.34)/.128,1-Math.abs(time-5.78)/.116);
      const weights={
        AH:clamp(.84*pick('aa')+.31*pick('TH')+.22*pick('DD')+.20*pick('kk')),
        EE:clamp(.92*pick('E')+.63*pick('ih')+.29*pick('SS')+.30*pick('FF')),
        OO:clamp(.83*pick('oh')+.73*pick('ou')+.15*pick('RR')+.20*pick('CH')),
        M:clamp(.80*pick('PP')+.57*pick('nn')),
        Blink:lids,
      };
      const key=Object.values(weights).map(value=>value.toFixed(4)).join(',');
      turn.setRotation([-.032*Math.sin(time*1.88),.32+.053*Math.sin((time-2.3)*2.17),.018*Math.sin(time*2.6)]);
      if(key!==previous){
        for(const {p,n,faces,morphs,mesh,posed,normal} of surfaces){
          if(!morphs.size)continue;
          posed.set(p);normal.set(n);
          for(const [shape,rows] of morphs){
            const weight=weights[shape];
            if(weight<.0001)continue;
            for(let at=0;at<rows.length;at+=7){
              const index=rows[at]*3;
              for(let k=0;k<3;k++){
                posed[index+k]+=rows[at+1+k]*weight/24576;
                normal[index+k]+=rows[at+4+k]*weight/14000;
              }
            }
          }
          mesh.setGeometry(new Geometry(posed,normal,faces));
        }
        previous=key;
      }
      return Math.max(weights.AH,weights.EE,weights.OO,weights.M);
    },
  };
}
