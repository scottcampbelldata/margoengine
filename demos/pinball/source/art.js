import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {sphereGeometry,cylinderGeometry,torusGeometry} from '@margoengine/geometry';
import {roundedBoxGeometry} from '@margoengine/geometry/extras';
import {surface,ballR,batLength,batLocal,pivots,bumpers,guides,guidePose,start,kickPosition} from './layout.js';

const ink={
  room:['#3b394e',.88,.0], black:['#101c2b',.62,.23], slate:['#303551',.51,.38],
  board:['#162c45',.66,.14], edge:['#61778d',.40,.68], jade:['#69c5b0',.40,.22],
  rust:['#f49c68',.51,.17], darkRust:['#926061',.57,.15], violet:['#626ca3',.43,.31],
  pale:['#e7f0de',.43,.11], mist:['#477280',.55,.18], bolt:['#b1bac9',.39,.66],
  ball:['#dbeafa',.235,.54], flash:['#f0fcb5',.26,.05], coal:['#2a2a3f',.64,.2]
};
const core=d=>new Geometry(d.positions,d.normals,d.indices);
const rounded=(size,r)=>core(roundedBoxGeometry(...size,2,r));
const cylinder=(r,h,segments=36)=>core(cylinderGeometry(r,r,h,segments));
const ring=(radius,tube)=>core(torusGeometry(radius,tube,8,48));

export function buildCabinet(engine){
  const mats=Object.fromEntries(Object.entries(ink).map(([name,[color,roughness,metalness]])=>{
    return [name,new PbrMaterial({color,roughness,metalness,doubleSided:false})];
  }));
  const unit=box(1,1,1);
  function part(name,p,g=unit,s=[1,1,1],root=null){
    return engine.createMesh(root).setGeometry(g).setMaterial(mats[name]).setPosition(p).setScale(s);
  }
  function housing(name,p,s,r,root=null){return part(name,p,rounded(s,r),[1,1,1],root);}
  function stroke(name,a,b,y,width,root=null){
    const dx=b[0]-a[0],dz=b[1]-a[1];
    const line=part(name,[(a[0]+b[0])*.5,y,(a[1]+b[1])*.5],unit,[Math.hypot(dx,dz),.0006,width],root);
    line.rotation.y=Math.atan2(-dz,dx);
    return line;
  }
  function flatRing(name,r,tube,x,y,z,root=null){
    const object=part(name,[x,y,z],ring(r,tube),[1,1,1],root);
    object.rotation.x=Math.PI/2;
    return object;
  }
  part('room',[0,-.27,0],unit,[10,.2,10]);
  housing('black',[0,-.110,-.009],[.69,.10,1.28],.037);
  housing('slate',[0,-.059,-.009],[.667,.084,1.257],.025);
  housing('edge',[0,-.012,-.009],[.645,.031,1.226],.012);
  housing('board',[0,.013,-.008],[.605,.026,1.182],.009);
  for(const sign of [-1,1]){
    housing('black',[sign*.317,.035,-.011],[.044,.078,1.187],.012);
    housing('violet',[sign*.314,.076,-.013],[.019,.011,1.152],.004);
    for(const z of [-.526,.532])part('bolt',[sign*.311,.083,z],cylinder(.0075,.004,12));
    stroke('mist',[sign*.254,-.488],[sign*.254,.517],surface+.0013,.0028);
    stroke('mist',[sign*.240,-.479],[sign*.240,.507],surface+.0014,.0014);
    for(let i=0;i<18;i++){
      const z=.50-i*.052;
      stroke(i%4===0?'pale':'mist',[sign*.240,z],[sign*(i%4===0?.219:.228),z],surface+.0009,.002);
    }
  }
  housing('black',[0,.057,-.597],[.631,.124,.035],.011);
  housing('slate',[0,.120,-.600],[.622,.018,.044],.006);
  housing('rust',[0,.132,-.598],[.532,.005,.024],.002);
  for(let j=0;j<9;j++)part('pale',[-.24+j*.06,.136,-.595],unit,[.019,.004,.011]);

  // Fired-in arc stripes and instrument dots are original cabinet graphics.
  for(let lane=0;lane<4;lane++){
    const r=.091+lane*.044,col=lane===0?'jade':lane===3?'mist':'violet';
    for(let j=0;j<37;j++){
      const ang=j*.105+.29,next=(j+1)*.105+.29;
      const start=[r*Math.cos(ang),-.105+r*.95*Math.sin(ang)];
      const finish=[r*Math.cos(next),-.105+r*.95*Math.sin(next)];
      stroke(col,start,finish,surface+.002+lane*.00009,lane===0?.0042:.0024);
    }
  }
  for(let j=0;j<21;j++){
    const x=-.205+(j%7)*.0611,z=.044+Math.floor(j/7)*.039+Math.sin(j*1.81)*.007;
    const star=part(j%4===0?'pale':'mist',[x,surface+.001,z],unit,[j%4===0?.007:.004,.0013,j%4===0?.007:.004]);
    star.rotation.y=Math.PI/4;
  }
  stroke('rust',[.171,.432],[.269,.432],surface+.003,.003);
  stroke('jade',[-.085,.495],[.085,.495],surface+.003,.006);
  for(let i=0;i<4;i++)stroke('edge',[-.072+i*.035,.533],[-.064+i*.035,.549],surface+.003,.004);
  for(const guide of guides){
    const q=guidePose(guide.a,guide.b,guide.kind);
    const color=guide.kind==='turn'?'rust':guide.kind==='sling'?'darkRust':'edge';
    const rail=housing(color,q.p,q.size,Math.min(...q.size)*.38);
    rail.rotation.y=q.yaw;
    for(const end of [guide.a,guide.b]){
      if(guide.kind==='outer')continue;
      part('edge',[end[0],q.p[1]+q.size[1]*.5+.0015,end[1]],cylinder(.0031,.003,10));
    }
  }
  const caps=bumpers.map(({p,radius},i)=>{
    const [x,y,z]=p;
    const main=i===0?'jade':i===1?'violet':'rust';
    flatRing('mist',radius+.013,.0012,x,surface+.003,z);
    part('black',[x,y-.012,z],cylinder(radius,.023));
    part('edge',[x,y+.008,z],cylinder(radius*.98,.025));
    part(main,[x,y+.024,z],cylinder(radius*.81,.015));
    flatRing('pale',radius*.56,.0016,x,y+.033,z);
    const hub=part(main,[x,y+.033,z],cylinder(radius*.43,.006,36));
    for(let j=0;j<10;j++){
      const a=j*Math.PI/5;
      const dot=part(j===0?'pale':'black',[x+Math.cos(a)*radius*.67,y+.033,z+Math.sin(a)*radius*.67],unit,[.004,.0012,.004]);
      dot.rotation.y=a;
    }
    return {hub,main};
  });
  const [kx,,kz]=kickPosition;
  flatRing('mist',.020,.001,kx,surface+.003,kz);
  part('jade',[kx,surface+.003,kz],cylinder(.009,.003,14));
  const flippers=pivots.map(({p,yaw})=>{
    const root=engine.createMesh().setPosition(p);
    const leaf=engine.createMesh(root).setPosition(batLocal(yaw));
    leaf.rotation.y=yaw;
    housing('darkRust',[0,0,0],[batLength,.022,.039],.010,leaf);
    housing('rust',[0,.010,0],[batLength*.96,.012,.036],.005,leaf);
    housing('pale',[.012,.017,0],[batLength*.66,.003,.005],.001,leaf);
    part('edge',[0,.015,0],cylinder(.013,.005,18),[1,1,1],root);
    part('black',[p[0],surface+.005,p[2]],cylinder(.024,.010,25));
    return root;
  });
  const ball=part('ball',start,core(sphereGeometry(ballR,42,28)));
  function sync(state){
    ball.setPosition(state.ball).setQuaternion(state.ballRotation);
    for(const [i,flipper] of flippers.entries())flipper.setQuaternion(state.flippers[i]);
    for(const [i,{hub,main}] of caps.entries())hub.setMaterial(mats[state.flash&&state.latestHit===i?'flash':main]);
  }
  return {sync};
}
