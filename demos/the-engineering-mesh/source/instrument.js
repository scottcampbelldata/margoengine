import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {bore,halfLength,outside} from './mesh-data.mjs';

function ring(profile,sides=96){
  const p=[],n=[],indices=[];
  for(let j=1;j<profile.length;j++){
    const [x0,r0]=profile[j-1],[x1,r1]=profile[j];
    const dx=x1-x0,dr=r1-r0,span=Math.hypot(dx,dr),base=p.length/3;
    for(let i=0;i<sides;i++){
      const a=2*Math.PI*i/sides, y=Math.cos(a), z=Math.sin(a);
      p.push(x0,r0*y,r0*z,x1,r1*y,r1*z);
      n.push(-dr/span,dx*y/span,dx*z/span,-dr/span,dx*y/span,dx*z/span);
    }
    for(let i=0;i<sides;i++){
      const a=base+i*2,b=base+((i+1)%sides)*2;
      if(r0>0)indices.push(a,b,a+1);
      if(r1>0)indices.push(b,b+1,a+1);
    }
  }
  return new Geometry(p,n,indices);
}

function tray(width,depth,height,chamfer){
  const p=[],n=[],indices=[];
  const rows=[
    [-(height/2),width/2-chamfer,depth/2-chamfer],
    [-height/2+chamfer,width/2,depth/2],
    [height/2-chamfer,width/2,depth/2],
    [height/2,width/2-chamfer,depth/2-chamfer],
  ];
  const corners=([y,w,d])=>[[-w,y,-d],[-w,y,d],[w,y,d],[w,y,-d]];
  const add=(a,b,c,d)=>{
    const s=b.map((v,i)=>v-a[i]),t=c.map((v,i)=>v-a[i]);
    const cross=[s[1]*t[2]-s[2]*t[1],s[2]*t[0]-s[0]*t[2],s[0]*t[1]-s[1]*t[0]];
    const l=Math.hypot(...cross),i=p.length/3;
    p.push(...a,...b,...c,...d);
    for(let j=0;j<4;j++)n.push(...cross.map(v=>v/l));
    indices.push(i,i+1,i+2,i,i+2,i+3);
  };
  for(let k=1;k<rows.length;k++){
    const a=corners(rows[k-1]),b=corners(rows[k]);
    for(let i=0;i<4;i++){const j=(i+1)%4;add(a[i],a[j],b[j],b[i]);}
  }
  add(...corners(rows.at(-1)));
  add(...corners(rows[0]).reverse());
  return new Geometry(p,n,indices);
}

function cyclorama(){
  const profile=[[0,-.224],[.54,-.224],[1.20,-.224],[1.64,-.224],[1.86,-.207],
    [2.06,-.148],[2.22,-.043],[2.36,.114],[2.45,.315],[2.48,.549],[2.49,.82],[2.49,1.56],[2.49,2.8]];
  const p=[],n=[],indices=[],sectors=96;
  for(const [row,[r,y]] of profile.entries()){
    const a=profile[Math.max(0,row-1)],b=profile[Math.min(row+1,profile.length-1)];
    const dr=b[0]-a[0],dy=b[1]-a[1],distance=Math.hypot(dr,dy);
    for(let k=0;k<sectors;k++){
      const angle=k*(2*Math.PI)/sectors,dx=Math.cos(angle),dz=Math.sin(angle);
      p.push(r*dx,y,r*dz);
      n.push(-dy/distance*dx,dr/distance,-dy/distance*dz);
      if(!row)continue;
      const i=(row-1)*sectors+k,j=(row-1)*sectors+(k+1)%sectors;
      if(row>1)indices.push(i,j,i+sectors);
      indices.push(j,j+sectors,i+sectors);
    }
  }
  return new Geometry(p,n,indices);
}

export function buildInstrument(engine) {
  const paint=(color,roughness=.55,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const ink=paint('#293d50',.45);
  const deck=paint('#45596b',.56);
  const cut=paint('#60798d',.54);
  const graphite=paint('#293648',.63);
  const smooth=paint('#99a6ae',.39,1);
  const warm=paint('#c49456',.41,1);
  const stripe=paint('#c18c51',.63);
  const insert=paint('#354956',.54);
  const bg=paint('#45566a',.84);
  const light=paint('#d3aa61',.55);
  const parts=[];

  function add(name,geometry,material,position=[0,0,0]){
    const mesh=engine.createMesh().setGeometry(geometry).setMaterial(material);
    mesh.name=name;
    mesh.setPosition(position);
    parts.push(mesh);
    return mesh;
  }

  engine.lighting.direction.set([-.36,.81,.54,2.35]);
  engine.lighting.radiance.set([1,.93,.84,.58]);
  engine.lighting.ambient.set([.62,.75,1]);
  add('Curved studio backdrop',cyclorama(),bg);
  add('Beveled instrument case',tray(.682,.416,.057,.009),ink,[0,-.190,0]);
  add('Inset specimen deck',tray(.636,.372,.024,.004),deck,[0,-.156,0]);
  add('Front panel recess',tray(.227,.007,.023,.002),graphite,[0,-.185,.208]);
  add('Front calibration stripe',box(.588,.002,.003),stripe,[0,-.172,.208]);

  for(const x of [-.265,.265]){
    const left=x<0;
    const inner=bore-.006,wide=outside+.012;
    const flange=ring([
      [-.019,inner+.004],[-.021,inner+.008],[-.021,wide-.006],[-.018,wide],
      [-.010,wide],[-.007,wide-.008],[.011,wide-.008],[.016,wide-.012],
      [.017,inner+.008],[.015,inner+.004],[-.019,inner+.004],
    ]);
    add(left?'Intake flange':'Return flange',flange,cut,[x,0,0]);
    const groove=ring([[-.013,wide-.0001],[-.013,wide+.0008],[-.010,wide+.0008],[-.010,wide-.0001],[-.013,wide-.0001]]);
    add('Brass ring in flange groove',groove,warm,[x,0,0]);
    const ferrule=ring([[-.016,bore-.006],[-.016,bore-.003],[.010,bore-.003],[.014,bore-.006],[-.016,bore-.006]],72);
    add('Machined bore ferrule',ferrule,smooth,[x,0,0]);
    add('Pedestal bracket',tray(.060,.224,.064,.007),graphite,[x,-.128,0]);
    add('Pedestal foot',tray(.081,.249,.012,.004),insert,[x,-.140,0]);

    const bolt=ring([[-.003,0],[-.003,.008],[-.0018,.010],[.0018,.010],[.003,.008],[.003,0]],6);
    for(let i=0;i<8;i++){
      const angle=i*2*Math.PI/8+.19,r=wide-.020;
      add('Flange socket screw',bolt,smooth,[x+(left?-.024:.021),r*Math.cos(angle),r*Math.sin(angle)]);
    }
  }

  const tickSmall=box(.006,.0014,.0011),tickLarge=box(.012,.0014,.00145);
  const rail=tray(.015,.333,.016,.003),head=tray(.021,.022,.016,.003);
  const runners=[];
  for(const [i,x] of [-halfLength-.081,halfLength+.081].entries()){
    add('Cut position rail',rail,graphite,[x,-.130,0]);
    for(let j=-7;j<=7;j++){
      const major=j%2===0;
      add('Cut position graduation',major?tickLarge:tickSmall,major?stripe:smooth,[x,-.121,j*.018]);
    }
    const profile=tray(.017,.012,.309,.003);
    const upright=add('Moving cut-plane guide',profile,stripe,[x,.023,0]);
    const grip=add('Guide carriage',head,light,[x,-.119,0]);
    const cap=add('Guide reference shoe',tray(.027,.018,.017,.004),i?light:warm,[x,.178,0]);
    runners.push([x,upright,grip,cap]);
  }

  return {
    position(offset){
      for(const [x,guide,grip,cap] of runners){
        guide.position.set(x,.023,offset);
        grip.position.set(x,-.119,offset);
        cap.position.set(x,.178,offset);
      }
    },
    dispose(){
      for(const mesh of parts)mesh.dispose();

    },
  };
}
