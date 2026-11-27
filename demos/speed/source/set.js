
import {PbrMaterial,Geometry,box} from '@margoengine/core';

const paint=(color,roughness=.62,metalness=0)=>new PbrMaterial({color,roughness,metalness});
const matt=paint('#24363d',.90),deck=paint('#4d5654',.83),ridge=paint('#7c9194',.53,.34),
  copper=paint('#b17637',.45,.49),gold=paint('#d2a258',.38,.55),steel=paint('#9ea5a1',.31,.76),
  basalt=paint('#373a38',.71),asphalt=paint('#273436',.94),silver=paint('#9ab0b1',.39,.36),
  saffron=paint('#b54e30',.43,.3),glass=paint('#223848',.27,.21),glint=paint('#d0be81',.45),
  hood=paint('#4b585a',.68),trackBed=paint('#3c464a'),lightStone=paint('#afb2aa',.68),metalFrame=paint('#31434b',.63,.38);
const tau=2*Math.PI;

function builder(){
  const groups=new Map();
  function append(material,geometry,point=[0,0,0],yaw=0){
    if(!groups.has(material))groups.set(material,{positions:[],normals:[],indices:[]});
    const data=geometry.vertices,group=groups.get(material),start=group.positions.length/3;
    const c=Math.cos(yaw),s=Math.sin(yaw);
    for(let i=0;i<data.length;i+=6){
      group.positions.push(c*data[i]+s*data[i+2]+point[0],data[i+1]+point[1],c*data[i+2]-s*data[i]+point[2]);
      group.normals.push(c*data[i+3]+s*data[i+5],data[i+4],c*data[i+5]-s*data[i+3]);
    }
    for(const index of geometry.indices)group.indices.push(start+index);
  }
  function install(engine,root){
    for(const [material,group] of groups){
      const mesh=engine.createMesh().setGeometry(new Geometry(group.positions,group.normals,group.indices)).setMaterial(material);
      if(root)mesh.setParent(root);
    }
  }
  return {append,block(material,size,at,yaw){append(material,box(...size),at,yaw);},install};
}
function spinProfile(rings,sectors=60,angle=tau,start=0){
  const p=[],n=[],ix=[];
  for(let i=0;i<rings.length;i++){
    const [y,r]=rings[i],lower=rings[Math.max(0,i-1)],upper=rings[Math.min(rings.length-1,i+1)];
    const dr=lower[1]-upper[1],dy=upper[0]-lower[0],length=Math.hypot(dr,dy)||1;
    for(let j=0;j<=sectors;j++){
      const t=start+angle*j/sectors,c=Math.cos(t),s=Math.sin(t);
      p.push(r*c,y,r*s);n.push(dy*c/length,dr/length,dy*s/length);
      if(i&&j){
        const d=i*(sectors+1)+j,c=d-1,b=d-sectors-1,a=b-1;
        ix.push(a,c,d,a,d,b);
      }
    }
  }
  return new Geometry(p,n,ix);
}
function trainShell(){
  const positions=[],normals=[],indices=[],sides=26;
  const shape=[[-6.75,.50,.45,1.12],[-6.59,.55,.56,1.12],[-5.63,1.31,.81,1.19],
    [-4.64,1.45,1.23,1.37],[-3.38,1.46,1.32,1.39],[5.08,1.46,1.32,1.39],[5.24,1.39,1.28,1.37]];
  for(let row=0;row<shape.length;row++){
    const [x,height,width,centre]=shape[row];
    for(let i=0;i<=sides;i++){
      const angle=tau*i/sides,s=Math.sin(angle),c=Math.cos(angle);
      const y=centre+height*Math.sign(s)*Math.abs(s)**.6,z=width*Math.sign(c)*Math.abs(c)**.65;
      positions.push(x,y,z);
      const forward=row<=3?[.84,.64,.35,.10][row]:0,n=Math.hypot(forward,s,c);
      normals.push(-forward/n,s/n,c/n);
      if(i&&row){
        const d=row*(sides+1)+i,c=d-1,b=d-sides-1,a=b-1;
        indices.push(a,b,d,a,d,c);
      }
    }
  }
  return new Geometry(positions,normals,indices);
}
function installRolling(engine){
  const rail=builder(),stock=trainShell(),root=engine.createMesh();
  for(let i=0;i<3;i++){
    const x=12.0*i;
    rail.append(i===0?silver:ridge,stock,[x,0,0]);
    rail.block(saffron,[10.23,.135,2.59],[x-.39,1.32,0]);
    rail.block(hood,[8.91,.2,2.13],[x+.35,.54,0]);
    rail.block(steel,[9.9,.08,2.68],[x+.28,1.53,0]);
    rail.block(basalt,[1.94,.29,2.2],[x-3.00,.32,0]);
    rail.block(basalt,[1.94,.29,2.2],[x+3.22,.32,0]);
    for(const side of [-1,1]){
      rail.block(saffron,[9.95,.124,.037],[x+.03,1.31,side*1.32]);
      rail.block(ridge,[10.14,.57,.046],[x+.09,2.29,side*1.258]);
      for(let window=0;window<7;window++){
        rail.block(glass,[1.08,.41,.036],[x+1.32*window-3.95,2.29,side*1.288]);
        const w=.55+.1*(window%3);
        rail.block(glint,[w,.084,.027],[x+1.32*window-3.78,2.18,side*1.311]);
      }
      rail.block(steel,[.78,1.52,.046],[x+4.53,1.52,side*1.328]);
    }
  }
  rail.block(glass,[.76,.29,1.34],[-5.35,2.18,0],0);
  for(const side of [-1,1])rail.block(glint,[.10,.17,.35],[-6.63,1.13,side*.31]);
  rail.install(engine,root);
  return root;
}
function installRotor(engine){
  const base=builder(),disc=builder(),root=engine.createMesh();
  const table=spinProfile([[0,.0],[0,1.03],[.035,1.08],[.072,1.08],[.087,1.05],[.31,1.05],[.335,1.02],[.341,0]]);
  base.append(basalt,table,[-1.62,0,1.05]);
  base.append(ridge,spinProfile([[0,.16],[.026,.19],[.20,.19],[.225,.155],[.225,0]]),[-1.62,.34,1.05]);
  for(let i=0;i<10;i++){
    const t=i*tau/10;
    base.block(steel,[.045,.024,.10],[-1.62+.94*Math.cos(t),.352,1.05+.94*Math.sin(t)],Math.PI*.5-t);
  }
  const rim=spinProfile([[-.084,.84],[-.084,.94],[-.058,.986],[.015,.986],[.030,.948],[.030,.84]]);
  disc.append(silver,rim);
  disc.append(steel,spinProfile([[-.086,0],[-.086,.223],[-.050,.257],[.069,.247],[.081,.204],[.081,0]]));
  for(let i=0;i<12;i++){
    const a=i*tau/12,w=.26;
    const sector=spinProfile([[0,.29],[.022,.30],[.032,.314],[.032,.925]],13,w,a+.098);
    disc.append(i%3===0?lightStone:i%3===1?copper:hood,sector);
    const t=a+.24;
    disc.block(i%2?gold:steel,[.65,.037,.056],[.573*Math.cos(t),-.039,.573*Math.sin(t)],-t);
  }
  base.install(engine);
  disc.install(engine,root);
  root.setPosition([-1.62,.655,1.05]);
  return root;
}
export function installSet(engine){
  const depot=builder();
  depot.block(deck,[28,.30,9],[0,-.208,1.73]);
  depot.block(hood,[3.45,.038,2.89],[-1.61,-.039,1.05]);
  for(const x of [-3.34,.12])depot.block(copper,[.040,.011,2.91],[x,-.014,1.055]);
  for(const z of [-.41,2.51])depot.block(copper,[3.49,.011,.040],[-1.61,-.014,z]);
  depot.block(trackBed,[92,.40,5.3],[0,-.31,-6.26]);
  for(const z of [-5.22,-7.30])depot.block(steel,[92,.15,.073],[0,-.02,z]);
  for(let i=0;i<112;i++)depot.block(basalt,[.23,.092,2.81],[-43+i*.78,-.082,-6.26]);
  depot.block(asphalt,[46,.21,14],[0,-.55,-11.12]);
  depot.block(hood,[28,.31,.39],[0,-.11,-2.69]);
  depot.block(gold,[28,.023,.054],[0,-.036,-2.79]);
  for(let i=0;i<27;i++)depot.block(glint,[.43,.02,.073],[-13+i*.99,-.048,-2.56]);
  const back=-10.92;
  depot.block(matt,[48,5.3,.27],[0,2.53,back]);
  depot.block(metalFrame,[48,.32,.52],[0,4.93,back+.14]);
  depot.block(metalFrame,[48,.25,.48],[0,2.74,back+.14]);
  for(let i=0;i<11;i++){
    const x=(i-5)*3.25;
    depot.block(metalFrame,[.13,5.03,.39],[x,2.42,back+.14]);
    depot.block(glass,[2.96,1.6,.04],[x+1.58,3.72,back+.15]);
    depot.block(glint,[.72,.061,.041],[x+1.56,3.86,back+.178]);
    depot.block(ridge,[2.72,.063,.046],[x+1.57,2.96,back+.172]);
  }
  for(const x of [-10.6,-5.15,4.88,10.1]){
    depot.block(matt,[.35,5.6,.48],[x,2.62,-4.28]);
    depot.block(copper,[.36,.10,.5],[x,2.98,-4.28]);
    depot.block(metalFrame,[.68,.31,.76],[x,.068,-4.30]);
  }
  depot.block(metalFrame,[24,.27,.31],[0,5.52,-4.28]);
  depot.block(metalFrame,[10,.23,.52],[0,5.71,-.2]);
  depot.install(engine);
  return {rotor:installRotor(engine),train:installRolling(engine)};
}
