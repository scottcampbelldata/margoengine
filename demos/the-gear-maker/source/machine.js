import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {compoundWheelAngles} from '@margoengine/procedural/gears';

const cal=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
const board=cal('#323f46',.85),recess=cal('#202b32',.74),steel=cal('#a7aca8',.38,.45);
const rail=cal('#887865',.58,.2),paint=cal('#e5cf93',.52,.08),dark=cal('#303944',.68,.17);
const finish=[
  cal('#cb895c',.42,.43),cal('#be9565',.46,.40),cal('#91b4c0',.47,.40),cal('#73969e',.44,.4)
];
const spokes=[
  cal('#ecc58f',.57,.35),cal('#d6b384',.54,.31),cal('#b9d2d8',.49,.36),cal('#9dc3c8',.51,.34)
];
const tau=2*Math.PI;
function ring(outside,inside,depth,bevel=.016,sides=56){
  const p=[],n=[],ix=[];
  const profile=[
    [inside,-depth*.5],[outside-bevel,-depth*.5],[outside,-depth*.5+bevel],
    [outside,depth*.5-bevel],[outside-bevel,depth*.5],[inside,depth*.5]
  ];
  function quad(points,normal){
    const k=p.length/3;for(const point of points){p.push(...point);n.push(...normal);}
    ix.push(k,k+1,k+2,k,k+2,k+3);
  }
  for(let j=0;j<sides;j++){
    const a=tau*j/sides,b=tau*(j+1)/sides,c=Math.cos((a+b)*.5),s=Math.sin((a+b)*.5);
    const radial=([r,z],f)=>[r*Math.cos(f),r*Math.sin(f),z];
    for(let i=0;i<profile.length;i++){
      const from=profile[i],next=profile[(i+1)%profile.length],dr=next[0]-from[0],dz=next[1]-from[1],l=Math.hypot(dr,dz);
      quad([radial(from,a),radial(from,b),radial(next,b),radial(next,a)],[dz*c/l,dz*s/l,-dr/l]);
    }
  }
  return new Geometry(p,n,ix);
}
export function bench(engine,shadows){
  const scene=[];
  const add=(geometry,m,at=[0,0,0],parent)=>{
    const piece=engine.createMesh().setGeometry(geometry).setMaterial(m).setPosition(at);
    if(parent)piece.setParent(parent);
    return piece;
  };
  const staticPart=(geometry,m,at)=>{const part=add(geometry,m,at);scene.push(part);return part;};
  const block=(size,m,at)=>staticPart(box(...size),m,at);
  block([13.5,7.45,.23],board,[0,0,-.81]);
  shadows.add(block([12.72,6.69,.16],recess,[0,0,-.69]),{castShadow:false});
  for(const sign of [-1,1]){
    block([13.6,.143,.35],rail,[0,sign*3.75,-.74]);
    block([.143,7.57,.35],rail,[sign*6.78,0,-.74]);
    block([13.23,.039,.12],paint,[0,sign*3.59,-.545]);
    block([.043,7.17,.12],paint,[sign*6.59,0,-.545]);
  }
  const tick=box(.018,.042,.019);
  for(let row=-3;row<=3;row++)for(let col=-15;col<=15;col++){
    if(row===0&&Math.abs(col)<7)continue;
    staticPart(tick,dark,[.40*col,.97*row,-.597]);
  }
  const boltHole=ring(.101,.049,.076,.014,18),bolt=ring(.064,.004,.115,.018,12);
  for(const x of [-6.38,6.38])for(const y of [-3.36,3.36]){
    staticPart(boltHole,dark,[x,y,-.550]);staticPart(bolt,steel,[x,y,-.541]);
  }
  let dynamic=[],current,cast=[];
  function install(train){
    const newObjects=[],nextCast=[];
    const wheels=[];
    for(const [k,item] of train.meshes.entries()){
      const move=engine.createMesh().setPosition([item.center[0],item.center[1],item.lane]);
      const parts=[];
      const part=(g,m,at)=>{const p=add(g,m,at,move);parts.push(p);newObjects.push(p);return p;};
      const wheel=part(new Geometry(item.positions,item.normals,item.indices),finish[k],[0,0,-item.width*.5]);
      nextCast.push(shadows.add(wheel));
      part(ring(item.bore*1.22,item.bore*.99,.056,.012,32),spokes[k],[0,0,.102]);
      part(ring(item.radius.root*.125,item.radius.root*.076,.020,.006,20),paint,[item.radius.root*.84,0,.085]);
      for(let pin=0;pin<4;pin++){
        const angle=tau*(pin+.09)/4,axis=item.radius.root*.965;
        part(ring(.034,.010,.02,.005,12),spokes[k],[axis*Math.cos(angle),axis*Math.sin(angle),.087]);
      }
      wheels.push({move,parts});newObjects.push(move);
    }
    const shaftOptions=[[train.meshes[0],.24],[train.meshes[1],.45],[train.meshes[3],.25]];
    for(const [wheel,reach] of shaftOptions){
      const [x,y]=wheel.center;
      newObjects.push(add(ring(Math.max(.14,wheel.bore*.83),.015,.62+reach,.035,32),steel,[x,y,-.44+reach*.105]));
      newObjects.push(add(ring(wheel.bore*.96,wheel.bore*.68,.098,.021,30),rail,[x,y,-.469]));
      newObjects.push(add(ring(wheel.bore*.80,wheel.bore*.345,.058,.017,20),steel,[x,y,.27+reach*.09]));
    }
    for(const dispose of cast)dispose();
    for(const piece of dynamic)piece.dispose();
    cast=nextCast;dynamic=newObjects;current={train,wheels};
  }
  function drive(angle){
    const {train,wheels}=current;
    const a=compoundWheelAngles(train.counts,angle,train.frame);
    for(const [i,key] of ['a','b','c','d'].entries())wheels[i].move.setRotation([0,0,a[key]]);
    return a;
  }
  function isolate(mode){
    current.wheels.forEach(({parts},k)=>{for(const object of parts)object.visible=mode==='all'||(k<2?mode==='first':mode==='second');});
  }
  return {install,drive,isolate,dispose(){for(const object of [...dynamic,...scene])object.dispose();}};
}
