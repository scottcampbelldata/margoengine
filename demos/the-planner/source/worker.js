import {Geometry,PbrMaterial} from '@margoengine/core';
import {Skeleton,Skin} from '@margoengine/animation';
import {solveSkeletonIK} from '@margoengine/rigging/ik';
import {axisAngleToQuaternion,conjugateQuaternion,multiplyQuaternions,rotationToQuaternion} from '@margoengine/math/quat';
import {axis} from './geometry.js';
import {captureSamples} from './measured-walk.js';

const costume={
  skin:['#bb8d6c',.60],eyes:['#aa9b82',.40],hair:['#41352f',.74],
  shirt:['#cdc0a2',.85],overalls:['#a56849',.83],leather:['#4e4f4e',.55],
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

export function readWorker(bytes){
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
        if(shift>28)throw new Error('The worker mesh has an invalid index.');
      }while(byte&128);
      accumulated+=(value>>>1)^-(value&1);
      index[i]=accumulated;
    }
    smoothNormals(position,index,normal);
    return {name,position,normal,joints,weights,index};
  });
  if(offset!==bytes.byteLength)throw new Error('The worker package length is inconsistent.');
  return {bones,meshes};
}

const xAxis=[1,0,0],tau=Math.PI*2;
const signFor=side=>side==='Left'?1:-1;
const footChain=side=>[side+'UpLeg',side+'Leg',side+'Foot'];
const handChain=side=>[side+'Arm',side+'ForeArm',side+'Hand'];
const ease=x=>x*x*(3-2*x);
const limit=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const mix=(a,b,t)=>a+(b-a)*t;
function gaitAt(phase){
  const sample=phase*(captureSamples.length-1);
  const i=Math.floor(sample),t=sample-i;
  return captureSamples[i].map((value,j)=>mix(value,captureSamples[i+1][j],t)*.0001);
}

export function worker(engine,workshop,prepared){
  const {bones,meshes}=prepared;
  const {block,add,rod,sphere}=workshop;
  const skeleton=new Skeleton(bones),root=engine.createMesh();
  root.name='Nessa · lookout operator';
  const layers=meshes.map(({name,position,normal,joints,weights,index})=>{
    const [color,roughness]=costume[name];
    const mesh=engine.createMesh(root).setMaterial(new PbrMaterial({color,roughness,doubleSided:name==='hair'}));
    mesh.name='Nessa · '+name;
    return {name,position,normal,index,mesh,skin:new Skin(skeleton,joints,weights)};
  });
  const point=name=>{
    const at=skeleton.index(name)*16,m=skeleton.matrices;
    return Array.from(m.subarray(at+12,at+15));
  };
  const rotation=name=>{
    const at=skeleton.index(name)*16,m=skeleton.matrices;
    return rotationToQuaternion(m.subarray(at,at+16));
  };
  const ankle=['Left','Right'].map(side=>point(side+'Foot'));
  const sides=['Left','Right'];
  const footRest=sides.map(side=>rotation(side+'Foot'));
  const soleAngle=sides.map((side,i)=>{
    const toeName=side+'ToeBase';
    const toe=skeleton.index(toeName)>=0?point(toeName):null;
    return toe?Math.atan2(toe[1]-ankle[i][1],toe[2]-ankle[i][2]):-0.43;
  });
  const hip=skeleton.index('Hips'),restHips=skeleton.getPose(hip).translation;
  const spine=skeleton.index('Spine'),spineRest=skeleton.getPose(spine).rotation;
  const head=skeleton.index('Head'),headRest=skeleton.getPose(head).rotation;

  const toolRoot=engine.createMesh(root);
  const axeHandle=add('Hickory hatchet handle',rod,'#9a7451',[0,0,0],undefined,.73,toolRoot);
  const axeHead=block('Forged hatchet head','#78838a',[0,0,0],[.209,.083,.072],.45,toolRoot);
  const axeBevel=block('Honed hatchet edge','#adada2',[0,0,0],[.04,.082,.075],.44,toolRoot);
  const spoon=add('Wooden spoon shaft',rod,'#a3845c',[0,0,0],undefined,.67,toolRoot);
  const spoonBowl=add('Wooden spoon bowl',sphere,'#b18f66',[0,0,0],[.039,.010,.053],.72,toolRoot);
  const kindling=add('Carried kindling',rod,'#c8a071',[0,0,0],undefined,.78,toolRoot);
  const shade=add('Contact on floor below lookout',sphere,'#685443',[0,0,0],[.29,.003,.18],.85);

  function hands(activity,phase){
    const cycle=Math.sin(phase*tau),stroke=.5-.5*Math.cos(phase*Math.PI*4);
    if(activity==='chop')return [[.125,1.13+.251*stroke,.30-.171*stroke],[-.106,1.08+.286*stroke,.309-.169*stroke]];
    if(activity==='kindling')return [[.123,1.02+.088*cycle,.283],[-.125,1.01+.084*cycle,.279]];
    if(activity==='light')return [[.163,1.005,.14],[-.117,.918+.055*cycle,.356]];
    if(activity==='cook')return [[.175,1.011,.227],[-.120+.055*cycle,1.091,.311+.047*Math.cos(phase*tau)]];
    if(activity==='rest')return [[.152,.722,.239],[-.151,.716,.244]];
    return [[.232,.878,.034],[-.232,.883,.022]];
  }
  function displayTools(activity,phase){
    const cutting=activity==='chop',stirring=activity==='cook',collecting=activity==='kindling';
    axeHandle.visible=cutting;axeHead.visible=cutting;axeBevel.visible=cutting;
    spoon.visible=stirring;spoonBowl.visible=stirring;kindling.visible=collecting;
    if(cutting){
      const [x,y,z]=point('RightHand'),high=.5-.5*Math.cos(phase*Math.PI*4),angle=2.48-2.71*high;
      const blade=[x+.055,y+Math.cos(angle)*.67,z+Math.sin(angle)*.67];
      axis(axeHandle,[x,y,z],blade,.019);
      axeHead.setPosition(blade).setRotation([angle,.24,0]);
      axeBevel.setPosition([blade[0]+.091,blade[1],blade[2]]).setRotation([angle,.24,0]);
    }
    if(stirring){
      const hand=point('RightHand'),tip=[hand[0]-.022,hand[1]-.253,hand[2]+.179];
      axis(spoon,hand,tip,.010);
      spoonBowl.setPosition(tip).setRotation([-.43,0,.11]);
    }
    if(collecting){
      const [x,y,z]=point('RightHand');
      axis(kindling,[x-.20,y+.021,z+.071],[x+.27,y+.038,z+.066],.059);
    }
  }
  return {
    draw({at,yaw,phase=0,activity='idle',walking=false,gaitWeight=1,stopped=false}){
      skeleton.restorePose();
      const seated=activity==='rest'?ease(phase):0;
      const bend=activity==='chop'?.17+.13*Math.cos(phase*Math.PI*4):activity==='light'?.24:activity==='cook'?.08:0;
      const gait=walking?gaitAt(phase):null;
      const [sway,bob,pelvisYaw,ribYaw,roll,pitch]=gait??[0,0,0,0,0,0];
      const motion=walking?ease(gaitWeight):0;
      const bodyBend=walking?mix(0,.035+.37*pitch,motion):bend;
      skeleton.setPose(hip,{translation:[restHips[0]+sway*.75*motion,
        restHips[1]-.224*seated+(bob*.70-.017)*motion,restHips[2]-.136*seated]});
      const ribTurn=axisAngleToQuaternion([0,1,0],(ribYaw-pelvisYaw)*.60*motion);
      const twist=multiplyQuaternions(ribTurn,axisAngleToQuaternion([0,0,1],roll*.22*motion));
      const upper=multiplyQuaternions(twist,axisAngleToQuaternion(xAxis,bodyBend-.054*seated));
      skeleton.setPose(spine,{rotation:multiplyQuaternions(spineRest,upper)});
      skeleton.setPose(head,{rotation:multiplyQuaternions(headRest,axisAngleToQuaternion(xAxis,
        activity==='rest'?.12:activity==='idle'?.10:Math.min(.23,bodyBend*.7)))});

      const goals=hands(activity,phase);
      for(const [i,side] of sides.entries()){
        const sign=signFor(side),a=ankle[i];
        const track=gait?.slice(6+i*12,18+i*12);
        const [sideStep,rise,travel,footPitch,knee,clearance]=track??[0,0,0,soleAngle[i],0,0];
        const anklePitch=limit((soleAngle[i]-footPitch)*.63,-.34,.43)*motion;
        const rolled= Math.max(0,Math.sin(anklePitch))*.057+Math.max(0,-Math.sin(anklePitch))*.124;
        const lift=(Math.min(.105,.67*rise,.60*clearance+rolled)+.70*rolled)*motion;
        const target=[a[0]+sideStep*.20*motion,a[1]+lift,a[2]+travel*.88*motion+(.276+sign*.044)*seated];
        solveSkeletonIK(skeleton,{joints:footChain(side),target,pole:[sign*.16,.42,.59+knee*.23*motion],iterations:10});
        const footWorld=multiplyQuaternions(axisAngleToQuaternion(xAxis,anklePitch),footRest[i]);
        const relative=multiplyQuaternions(conjugateQuaternion(rotation(side+'Leg')),footWorld);
        skeleton.setPose(skeleton.index(side+'Foot'),{rotation:relative});
        const grip=goals[i].slice();
        if(track){
          const shoulder=point(side+'Arm');
          const wrist=[shoulder[0]+(track[9]+sign*.065)*.84,shoulder[1]+track[10]*.84,shoulder[2]+track[11]*.84];
          for(let axis=0;axis<3;axis++)grip[axis]=mix(grip[axis],wrist[axis],motion);
        }
        if(activity==='rest')grip[1]+=.184*(1-seated);
        solveSkeletonIK(skeleton,{joints:handChain(side),target:grip,pole:[sign*.55,.78,.17],iterations:10});
      }
      let lowest=Infinity;
      for(const {name,mesh,skin,position,normal,index} of layers){
        const pose=skin.pose(position,normal);
        if(name==='leather')for(let i=1;i<pose.positions.length;i+=3)lowest=Math.min(lowest,pose.positions[i]);
        mesh.setGeometry(new Geometry(pose.positions,pose.normals,index));
      }
      const y=.055-Math.min(.061,lowest);
      root.setPosition([at[0],y,at[1]]).setRotation([0,yaw,0]);
      shade.setPosition([at[0],.057,at[1]]).setRotation([0,yaw,0]);
      displayTools(walking||stopped?'idle':activity,phase);
      return {pivot:[at[0],y,at[1]],hand:point('RightHand')};
    },
  };
}
