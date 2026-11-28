import {Geometry,PbrMaterial} from '@margoengine/core';
import personURL from './inspector.rig?url';
import {floorHeight,ferrySize,stairTop} from './layout.js';

const tau=2*Math.PI;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const smooth=v=>v*v*(3-2*v);
const lerp=(a,b,t)=>a+(b-a)*t;
const identity=[1,0,0,0,0,1,0,0,0,0,1,0];

export async function loadInspector(signal){
  const response=await fetch(personURL,{signal});
  if(!response.ok||!response.body)throw new Error('The inspector model could not load.');
  const bytes=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  signal.throwIfAborted();
  const view=new DataView(bytes),metadata=view.getUint32(0,true);
  if(metadata>bytes.byteLength-4)throw new Error('The inspector model is incomplete.');
  const {joints,meshes}=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,4,metadata)));
  let offset=4+metadata;
  const groups=meshes.map(({name,color,vertices,indices:indexCount})=>{
    const p=new Float32Array(vertices*3),n=new Float32Array(vertices*3),bone=new Uint8Array(vertices*3),weight=new Float32Array(vertices*3);
    for(let axis=0;axis<3;axis++){
      let running=0;
      for(let i=0;i<vertices;i++){
        running+=view.getInt16(offset,true);offset+=2;
        p[i*3+axis]=running/2048;
      }
    }
    for(let i=0;i<vertices;i++){
      let x=view.getInt8(offset++)/92,z=view.getInt8(offset++)/92;
      const y=1-Math.abs(x)-Math.abs(z),fold=Math.max(0,-y);
      x-=Math.sign(x)*fold;z-=Math.sign(z)*fold;
      const inv=1/Math.hypot(x,y,z);
      n[i*3]=x*inv;n[i*3+1]=y*inv;n[i*3+2]=z*inv;
    }
    for(let axis=0;axis<3;axis++)for(let i=0;i<vertices;i++)bone[i*3+axis]=view.getUint8(offset++);
    for(let axis=0;axis<2;axis++)for(let i=0;i<vertices;i++)weight[i*3+axis]=view.getUint8(offset++)/255;
    for(let i=0;i<vertices;i++)weight[i*3+2]=Math.max(0,1-weight[i*3]-weight[i*3+1]);
    const indices=new Uint32Array(indexCount);
    let previous=0;
    for(let i=0;i<indexCount;i++){
      let shift=0,value=0,byte;
      do{byte=view.getUint8(offset++);value|=(byte&127)<<shift;shift+=7;}while(byte&128);
      previous+=(value>>>1)^-(value&1);
      indices[i]=previous;
    }
    return {name,color,vertices,p,n,bone,weight,indices,posedP:new Float32Array(p.length),posedN:new Float32Array(n.length)};
  });
  if(offset!==bytes.byteLength)throw new Error('The inspector model has a mismatched geometry stream.');
  return {joints,groups};
}
function transform(out,parent,[x,y,z],[pitch,yaw,roll],height=0){
  const a=Math.cos(pitch),b=Math.sin(pitch),c=Math.cos(yaw),d=Math.sin(yaw),e=Math.cos(roll),f=Math.sin(roll);
  const t00=c*e,t01=-c*f,t02=d;
  const t10=a*f+b*d*e,t11=a*e-b*d*f,t12=-b*c;
  const t20=b*f-a*d*e,t21=b*e+a*d*f,t22=a*c;
  const tx=x-t00*x-t01*y-t02*z,ty=y-t10*x-t11*y-t12*z+height,tz=z-t20*x-t21*y-t22*z;
  for(let i=0;i<12;i+=4){
    const A=parent[i],B=parent[i+1],C=parent[i+2];
    out[i]=A*t00+B*t10+C*t20;
    out[i+1]=A*t01+B*t11+C*t21;
    out[i+2]=A*t02+B*t12+C*t22;
    out[i+3]=A*tx+B*ty+C*tz+parent[i+3];
  }
}
function skin(group,matrices){
  const {p,n,bone,weight,posedP,posedN}=group;
  for(let i=0;i<p.length;i+=3){
    const x=p[i],y=p[i+1],z=p[i+2],a=n[i],b=n[i+1],c=n[i+2];
    let py=0,px=0,pz=0,na=0,nb=0,nc=0;
    for(let j=0;j<3;j++){
      const w=weight[i+j];
      if(w===0)continue;
      const m=matrices[bone[i+j]];
      px+=w*(m[0]*x+m[1]*y+m[2]*z+m[3]);
      py+=w*(m[4]*x+m[5]*y+m[6]*z+m[7]);
      pz+=w*(m[8]*x+m[9]*y+m[10]*z+m[11]);
      na+=w*(m[0]*a+m[1]*b+m[2]*c);
      nb+=w*(m[4]*a+m[5]*b+m[6]*c);
      nc+=w*(m[8]*a+m[9]*b+m[10]*c);
    }
    const inv=1/(Math.hypot(na,nb,nc)||1);
    posedP[i]=px;posedP[i+1]=py;posedP[i+2]=pz;
    posedN[i]=na*inv;posedN[i+1]=nb*inv;posedN[i+2]=nc*inv;
  }
  return new Geometry(posedP,posedN,group.indices);
}
export function createInspector(engine,{joints,groups}){
  const root=engine.createMesh();
  root.name='Nora_InspectionRig';
  const byName=new Map(joints.map(([name],index)=>[name,index]));
  const matrices=joints.map(()=>new Float32Array(12)),angles=joints.map(()=>[0,0,0]);
  const meshes=groups.map(group=>{
    const mesh=engine.createMesh(root).setMaterial(new PbrMaterial({
      color:group.color,roughness:group.name==='boot'?.63:.81,metalness:0,doubleSided:group.name==='hair',
    })).setGeometry(new Geometry(group.p,group.n,group.indices));
    mesh.name='Nora_'+group.name;
    return mesh;
  });
  const legs=['Left','Right'].map((side,i)=>{
    const ids=['UpLeg','Leg','Foot','Arm','ForeArm','Hand'].map(k=>byName.get(side+k));
    const [h,k,a]=ids.slice(0,3).map(index=>joints[index][2]);
    const u=Math.hypot(h[1]-k[1],h[2]-k[2]),l=Math.hypot(k[1]-a[1],k[2]-a[2]);
    return {ids,h,a,u,l,sign:i===0?1:-1,phase:i*.5,
      thigh:Math.atan2(k[2]-h[2],h[1]-k[1]),shin:Math.atan2(a[2]-k[2],k[1]-a[1])};
  });
  let face=Math.PI,belt=0,smoothedY,activity=0,time=0,nextPose=0,lastDistance=0,version=0,poseStats={};
  function poseLeg(leg,phase,state,footY,bob){
    const {ids,h,a,u,l,sign,thigh,shin}=leg;
    const move=.63,stance=.60,stride=move*stance;
    let fz,fy;
    if(phase<stance){
      fz=stride/2-move*phase;
      fy=0;
    }else{
      const s=(phase-stance)/(1-stance);
      fz=(smooth(s)-.50)*stride;
      fy=Math.sin(Math.PI*s)**1.24*.155;
    }
    fz*=activity;
    const probeZ=state.foot[2]+Math.cos(face)*(a[2]+fz)-Math.sin(face)*a[0]*.68;
    const ferry=state.onFerry&&Math.abs(probeZ-state.ferryZ)<ferrySize[2]*.5+.12;
    const support=ferry?stairTop:floorHeight(probeZ);
    const ground=state.grounded?clamp(support-footY,-.245,.26)*activity:0;
    const ankleY=a[1]+ground+fy*activity+(state.grounded?0:.15+.04*sign);
    const ankleZ=a[2]+fz+(state.grounded?0:.09*sign);
    let dy=ankleY-h[1]-bob,dz=ankleZ-h[2];
    const reach=clamp(Math.hypot(dy,dz),.13,u+l-.004);
    const direction=Math.atan2(dz,-dy);
    dy=-Math.cos(direction);dz=Math.sin(direction);
    const adjacent=(u*u-l*l+reach*reach)/(2*reach),opposite=Math.sqrt(Math.max(0,u*u-adjacent*adjacent));
    const ky=dy*adjacent+dz*opposite,kz=dz*adjacent-dy*opposite;
    const a0=thigh-Math.atan2(kz,-ky),a1=shin-Math.atan2(dz*reach-kz,ky-dy*reach);
    angles[ids[0]][0]=a0;
    angles[ids[0]][2]=-.069*sign*activity;
    angles[ids[1]][0]=a1-a0;
    angles[ids[2]][0]=-a1+(state.grounded?-state.slope*.45*activity:-.27);
    const swing=-Math.cos(phase*tau)*activity;
    angles[ids[3]][0]=.40*swing-(state.grounded?0:.26);
    angles[ids[4]][0]=-.11-(.05+.095*Math.max(0,swing))*activity;
    angles[ids[5]][0]=.045*swing;
    return {stride:fz,lift:fy*activity};
  }
  function advance(state,dt,heading,now,force=false){
    time+=dt;
    const [x,y,z]=state.foot;
    const [dx,dz]=heading;
    if(Math.hypot(dx,dz)>.04){
      const goal=Math.atan2(dx,dz);
      face+=Math.atan2(Math.sin(goal-face),Math.cos(goal-face))*(1-Math.exp(-14*dt));
    }
    if(smoothedY===undefined||Math.abs(y-smoothedY)>.7||force)smoothedY=y;
    else smoothedY=lerp(smoothedY,y,1-Math.exp(-22*dt));
    root.setPosition([x,smoothedY+.007,z]);
    root.setRotation([0,face,0]);
    if(!force&&now<nextPose)return;
    nextPose=now+34;
    const advance=Math.max(0,state.walked-lastDistance);
    lastDistance=state.walked;
    const next=advance>.002?1:0;
    activity=force?0:lerp(activity,next,.24);
    belt+=advance/.63;
    const bob=-.026-.031*activity+.016*activity*Math.sin(belt*tau*2)+.004*Math.sin(time*1.87);
    angles[byName.get('Spine1')][1]=.056*activity*Math.sin(belt*tau);
    angles[byName.get('Spine2')][0]=-.051*activity-(state.grounded?.02:.08);
    angles[byName.get('Head')][0]=.022*Math.sin(time*.73)+.055*activity;
    const stats=legs.map(leg=>poseLeg(leg,(belt+leg.phase)%1,state,smoothedY,bob));
    for(let i=0;i<joints.length;i++){
      const [,parent,center]=joints[i];
      transform(matrices[i],parent<0?identity:matrices[parent],center,angles[i],parent<0?bob:0);
    }
    for(let i=0;i<meshes.length;i++)meshes[i].setGeometry(skin(groups[i],matrices));
    poseStats={gait:++version,phase:(belt%1).toFixed(3),stride:stats.map(s=>s.stride.toFixed(3)).join(','),
      feet:stats.map(s=>s.lift.toFixed(3)).join(',')};
  }
  return {root,advance,stats:()=>poseStats};
}
