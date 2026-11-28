import {Geometry,PbrMaterial} from '@margoengine/core';
import {Skeleton,Skin} from '@margoengine/animation';

const costume={
  skin:['#ba8765',.60],eyes:['#aa9c7e',.40],hair:['#423936',.68],
  linen:['#dbae85',.82],fasteners:['#624331',.52],trousers:['#364653',.83],leather:['#684032',.48],
};

function smoothNormals(position,index,normal){
  for(let i=0;i<index.length;i+=3){
    const a=index[i]*3,b=index[i+1]*3,c=index[i+2]*3;
    const x1=position[b]-position[a],y1=position[b+1]-position[a+1],z1=position[b+2]-position[a+2];
    const x2=position[c]-position[a],y2=position[c+1]-position[a+1],z2=position[c+2]-position[a+2];
    const x=y1*z2-z1*y2,y=z1*x2-x1*z2,z=x1*y2-y1*x2;
    for(const offset of [a,b,c]){normal[offset]+=x;normal[offset+1]+=y;normal[offset+2]+=z;}
  }
  for(let i=0;i<normal.length;i+=3){
    const scale=1/(Math.hypot(normal[i],normal[i+1],normal[i+2])||1);
    normal[i]*=scale;normal[i+1]*=scale;normal[i+2]*=scale;
  }
}

export function readPerformer(bytes){
  const source=new DataView(bytes),header=source.getUint32(0,true);
  const {bones,parts}=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,4,header)));
  let offset=4+header;
  const meshes=parts.map(({name,vertices,indices:count})=>{
    const position=new Float32Array(vertices*3),normal=new Float32Array(vertices*3);
    for(let axis=0;axis<3;axis++){
      let m=0;
      for(let i=0;i<vertices;i++){
        m+=source.getInt16(offset,true);offset+=2;
        position[i*3+axis]=m/8192;
      }
    }

    const joints=new Uint8Array(vertices*4),weights=new Uint8Array(vertices*4);
    for(let i=0;i<vertices;i++){
      for(let channel=0;channel<4;channel++)joints[i*4+channel]=source.getUint8(offset++);
      for(let channel=0;channel<4;channel++)weights[i*4+channel]=source.getUint8(offset++);
    }
    const index=new Uint32Array(count);
    let accumulated=0;
    for(let i=0;i<count;i++){
      let value=0,shift=0,byte;
      do{
        byte=source.getUint8(offset++);
        value|=(byte&127)<<shift;shift+=7;
        if(shift>28)throw new Error('The performer mesh has an invalid index.');
      }while(byte&128);
      accumulated+=(value>>>1)^-(value&1);
      index[i]=accumulated;
    }
    smoothNormals(position,index,normal);
    return {name,position,normal,joints,weights,index};
  });
  if(offset!==bytes.byteLength)throw new Error('The performer package length is inconsistent.');
  return {bones,meshes};
}

function contactGeometry(){
  const p=[0,0,0],n=[0,1,0],indices=[];
  for(let i=0;i<32;i++){
    const a=i*Math.PI/16;p.push(Math.cos(a),0,Math.sin(a));n.push(0,1,0);
    indices.push(0,(i+1)%32+1,i+1);
  }
  return new Geometry(p,n,indices);
}

export function performer(engine,{bones,meshes}){
  const skeleton=new Skeleton(bones),root=engine.createMesh().setRotation([0,-.36,0]);
  root.name='Elias · actor';
  const layers=meshes.map(({name,position,normal,joints,weights,index})=>{
    const [color,roughness]=costume[name];
    const mesh=engine.createMesh(root).setMaterial(new PbrMaterial({color,roughness,doubleSided:name==='hair'}));
    mesh.name='Elias · '+name;
    return {name,position,normal,index,mesh,skin:new Skin(skeleton,joints,weights)};
  });
  const disc=contactGeometry();
  const shadows=['LeftFoot','RightFoot'].map(name=>{
    const contact=engine.createMesh(root).setGeometry(disc);
    const finish=new PbrMaterial({color:'#544037',roughness:.95});
    contact.name='Shoe contact shade';
    contact.setMaterial(finish);
    return {contact,finish,bone:skeleton.index(name)};
  });
  return {
    skeleton,
    setAngle(yaw){root.setRotation([0,yaw,0]);},
    draw(){
      let ground=0;
      for(const {name,mesh,skin,position,normal,index} of layers){
        const result=skin.pose(position,normal);
        if(name==='leather'){
          ground=Infinity;
          for(let i=1;i<result.positions.length;i+=3)ground=Math.min(ground,result.positions[i]);
        }
        mesh.setGeometry(new Geometry(result.positions,result.normals,index));
      }
      root.setPosition([.92,.008-ground,0]);
      const matrices=skeleton.matrices;
      for(const {contact,finish,bone} of shadows){
        const i=bone*16;
        const h=Math.max(0,Math.min(1,(matrices[i+13]-ground-.075)/.22));
        contact.setPosition([matrices[i+12]+.02*h,ground-.005,
          matrices[i+14]+.071+.08*h]);
        contact.setScale([.067+.029*h,1,.148+.034*h]);
        finish.set({color:[.105+.067*h,.070+.051*h,.050+.043*h]});
      }
      return ground;
    },
  };
}
