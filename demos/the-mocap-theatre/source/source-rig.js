import {Geometry,PbrMaterial} from '@margoengine/core';

function roundShape(bone=false){
  const position=[],normal=[],indices=[],rows=bone?1:8,sectors=14;
  for(let row=0;row<=rows;row++)for(let col=0;col<=sectors;col++){
    const a=col*Math.PI*2/sectors,t=row*Math.PI/rows;
    const y=bone?row-.5:Math.cos(t),r=bone?1:Math.sin(t);
    position.push(r*Math.cos(a),y,r*Math.sin(a));
    normal.push(r*Math.cos(a),bone?0:y,r*Math.sin(a));
    if(row&&col){
      const d=row*(sectors+1)+col,c=d-1,b=d-sectors-1,a0=b-1;
      if(bone)indices.push(a0,c,b,b,c,d);
      else indices.push(a0,b,c,b,d,c);
    }
  }
  return new Geometry(position,normal,indices);
}
const baseline=[0,0,0,1];
function rotateFromY(x,y,z){
  if(y<-.999999)return [1,0,0,0];
  const norm=Math.hypot(z,1+y,x);
  return norm?[z/norm,0,-x/norm,(1+y)/norm]:baseline;
}
function toPoint(m,at,end){
  return [m[at+12]+m[at]*end[0]+m[at+4]*end[1]+m[at+8]*end[2],
    m[at+13]+m[at+1]*end[0]+m[at+5]*end[1]+m[at+9]*end[2],
    m[at+14]+m[at+2]*end[0]+m[at+6]*end[1]+m[at+10]*end[2]];
}
export function showRig(engine){
  const root=engine.createMesh().setRotation([0,-.36,0]),bars=[],dots=[];
  root.name='Live capture hierarchy';
  const cylinder=roundShape(true),sphere=roundShape();
  const cobalt=new PbrMaterial({color:'#7fcdd3',roughness:.51}),pearl=new PbrMaterial({color:'#d5eddf',roughness:.46});
  for(let i=0;i<63;i++){
    const rod=engine.createMesh(root).setGeometry(cylinder).setMaterial(cobalt);
    rod.name='Source joint link';
    bars.push(rod);
  }
  for(let i=0;i<32;i++){
    const joint=engine.createMesh(root).setGeometry(sphere).setMaterial(pearl).setScale([.024,.024,.024]);
    joint.name='Source joint marker';
    dots.push(joint);
  }
  return {
    setAngle(yaw){root.setRotation([0,yaw,0]);},
    draw({source,bones}){
    const matrices=source.matrices,points=bones.map((_,i)=>[matrices[i*16+12],matrices[i*16+13],matrices[i*16+14]]);
    const tips=bones.map((bone,i)=>bone.endSite?toPoint(matrices,i*16,bone.endSite):points[i]);
    let lowest=Infinity,count=0;
    for(let i=0;i<bones.length;i++)lowest=Math.min(lowest,points[i][1],tips[i][1]);
    function link(a,b){
      const x=b[0]-a[0],y=b[1]-a[1],z=b[2]-a[2],length=Math.hypot(x,y,z);
      if(length<.005)return;
      const rod=bars[count++];
      rod.visible=true;
      rod.setPosition([a[0]+x*.5,a[1]+y*.5,a[2]+z*.5]).setScale([.0145,length,.0145])
        .setQuaternion(rotateFromY(x/length,y/length,z/length));
    }
    for(let i=0;i<bones.length;i++){
      const {parent,endSite}=bones[i];
      const p=points[i];
      dots[i].visible=true;
      dots[i].setPosition(p);
      if(parent>=0)link(points[parent],p);
      // Draw terminal tips only, so Acclaim's shared endpoints do not overprint links.
      if(endSite&&!bones.some(next=>next.parent===i))link(p,tips[i]);
    }
    for(let i=count;i<bars.length;i++)bars[i].visible=false;
    for(let i=bones.length;i<dots.length;i++)dots[i].visible=false;
    root.setPosition([-.99,.022-lowest,0]);
      return points[Math.min(15,bones.length-1)];
    },
  };
}
