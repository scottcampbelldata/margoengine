import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {bounds,crossing,naturalHeight,earthPaint,roadPaint,salt,grades} from './terrain-art.js';

const pineColors=['#465a4a','#54684d','#69734d'],bark='#62564b';
const paint=color=>new PbrMaterial({color,roughness:.91,metalness:0});
function batch(){return {p:[],n:[],i:[]};}
function join(batch,geometry,point){
  const offset=batch.p.length/3,v=geometry.vertices;
  for(let i=0;i<v.length;i+=6){
    batch.p.push(v[i]+point[0],v[i+1]+point[1],v[i+2]+point[2]);batch.n.push(v[i+3],v[i+4],v[i+5]);
  }
  for(const i of geometry.indices)batch.i.push(offset+i);
}
function pine(p,scale,seed){
  const body=batch();
  for(let ring=0;ring<4;ring++){
    const elevation=scale*(.38+.105*ring),height=scale*(.44-.042*ring);
    const radius=scale*(.235-.031*ring),sides=11,twist=2*Math.PI*seed+ring*.22;
    const center=body.p.length/3;
    body.p.push(p[0]+.05*ring,p[1]+elevation+height,p[2]);body.n.push(0,1,0);
    for(let step=0;step<sides;step++){
      const angle=twist+2*Math.PI*step/sides,c=Math.cos(angle),s=Math.sin(angle);
      const wobble=1.+(salt(step,ring)-.48)*.45;
      body.p.push(p[0]+radius*c*wobble,p[1]+elevation-scale*.09*salt(step,ring+15),p[2]+radius*s*wobble);
      body.n.push(c*.84,.54,s*.84);
      body.i.push(center,center+1+(step+1)%sides,center+step+1);
    }
  }
  return new Geometry(body.p,body.n,body.i);
}
function distanceSq(a,b,p){
  const vx=b[0]-a[0],vz=b[1]-a[1],denom=vx*vx+vz*vz;
  const t=Math.max(0,Math.min(1,((p[0]-a[0])*vx+(p[1]-a[1])*vz)/denom));
  return (p[0]-a[0]-vx*t)**2+(p[1]-a[1]-vz*t)**2;
}
export function gallery(engine){
  let network=[],landscape=[];
  const road=roadPaint.map(paint),earth=earthPaint.map(paint);
  const foliage=pineColors.map(paint),trunk=paint(bark);
  const get=(b,material)=>engine.createMesh().setGeometry(new Geometry(b.p,b.n,b.i)).setMaterial(material);
  const from=(values,colors)=>values.flatMap((v,i)=>v.i.length?[get(v,colors[i])]:[]);
  const mesa=box(bounds.width+2,3,bounds.depth+2);
  engine.createMesh().setGeometry(mesa).setMaterial(paint('#696153')).setPosition([0,-4.6,0]);
  const rim=box(bounds.width+3,1.4,bounds.depth+3);
  engine.createMesh().setGeometry(rim).setMaterial(paint('#433c3b')).setPosition([0,-6.65,0]);
  const iron=paint('#554c42'),sign=paint('#ead7a3');
  const axle=box(.27,3.32,.33),head=box(2.84,.96,.24);
  for(const [x,z] of [[-15,-1],[33,-4],[-58,15]]){
    const y=naturalHeight(x,z);
    engine.createMesh().setGeometry(axle).setMaterial(iron).setPosition([x,y+1.66,z]);
    engine.createMesh().setGeometry(head).setMaterial(sign).setPosition([x,y+3.15,z]).setRotation([0,-.15,0]);
  }
  function reload(data){
    const nextRoad=from(data.rows,road),ground=from(data.earth,earth);
    const green=foliage.map(batch),brown=batch();
    const trail=data.pts.flatMap(line=>line.slice(1).map((b,index)=>[line[index],b]));
    for(let zi=-70;zi<=69;zi+=4)for(let xi=-92;xi<=90;xi+=4.3){
      const random=salt(xi,zi);
      if(random<.45||Math.cos(xi*.103-zi*.1)+Math.sin(zi*.146)<-.18)continue;
      const x=xi+(salt(xi+4,zi)-.5)*4.1,z=zi+(salt(xi,zi+4)-.5)*3.8;
      const y=naturalHeight(x,z);
      if(y<3.2||grades(x,z)>.63||trail.some(([a,b])=>distanceSq(a,b,[x,z])<60))continue;
      const size=2.0+random*3.07;
      join(green[Math.floor(random*6)%3],pine([x,y,z],size,random),[0,0,0]);
      join(brown,box(size*.071,size*.51,size*.072),[x,y+size*.255,z]);
    }
    for(let k=0;k<green.length;k++)if(green[k].i.length)ground.push(get(green[k],foliage[k]));
    if(brown.i.length)ground.push(get(brown,trunk));
    for(const item of [...network,...landscape])item.dispose();
    network=nextRoad;landscape=ground;
  }
  const marker=engine.createMesh().setGeometry(box(2.0,.46,2.0)).setMaterial(paint('#e6b36a'));
  const [x,z]=crossing;
  marker.setPosition([x,naturalHeight(x,z)+2.8,z]);marker.setRotation([0,Math.PI/4,0]);marker.visible=false;
  return {reload,draft(active){marker.visible=active;},dispose(){for(const item of [...network,...landscape])item.dispose();}};
}
