import {parseASF,parseAMC,parseBVH} from '@margoengine/loaders/mocap';
import {prepareRetarget} from '@margoengine/rigging/retarget';
import {Skeleton,createKeyframeClip,applyKeyframeClip} from '@margoengine/animation';
import {Retarget,retargetRig} from '@margoengine/animation/skeleton-utils';
import {axisAngleToQuaternion,multiplyQuaternions} from '@margoengine/math/quat';

export const recordings={
  walk:{name:'Natural walk',credit:'Carnegie Mellon · ASF / AMC',width:'35_01 optical capture'},
  // Held off the stage (KB-RIG-ARMS2): its elbows sit past straight on every frame, in the capture itself.
  brisk:{name:'Arms-wide walk',credit:'Ian Mason · BVH',width:'100STYLE “Aeroplane” capture',held:'KB-RIG-ARMS2'},
};

// The takes the stage offers: every recording that is not held.
export const listed=Object.keys(recordings).filter(name=>!recordings[name].held);

const xSensHumanoid={Hips:'hips',Chest:'spine',Chest2:'chest',Chest4:'upperChest',Neck:'neck',Head:'head'};
for(const side of ['Left','Right']){
  for(const [source,target] of Object.entries({
    Collar:'Shoulder',Shoulder:'UpperArm',Elbow:'LowerArm',Wrist:'Hand',
    Hip:'UpperLeg',Knee:'LowerLeg',Ankle:'Foot',Toe:'Toes',
  }))xSensHumanoid[side+source]=side.toLowerCase()+target;
}

export function readCapture(name,text){
  const description=recordings[name];
  let data,preset;
  if(name==='walk'){
    const [asf,amc]=text.split('\n---MOCAP-MOTION---\n');
    data=parseAMC(amc,parseASF(asf,{scale:.0254/.45}),{frameTime:1/30,name:description.name});
    preset='cmu';
  }else{
    data=parseBVH(text,{scale:.01,name:description.name});
    for(const bone of data.bones)bone.name=xSensHumanoid[bone.name]??bone.name;
    for(const track of data.clip.tracks)track.target=xSensHumanoid[track.target]??track.target;
    preset='humanoid';
  }
  return {data,preset};
}

export function capture(name,recorded,target){
  const {data,preset}=recorded,source=new Skeleton(data.bones),input=retargetRig(source);
  const prepared=prepareRetarget(input,retargetRig(target),{from:preset,to:'mixamo'});
  const transfer=new Retarget(input,prepared.target,{...prepared,hipScale:.95});
  const hips=source.root,root=data.bones[hips].name;
  const rotation=data.clip.tracks.find(track=>track.target===root&&track.path==='rotation');
  const travel=data.clip.tracks.find(track=>track.target===root&&track.path==='translation');
  const first=travel.keys[0].value,last=travel.keys.at(-1).value;
  const dx=last[0]-first[0],dz=last[2]-first[2],heading=Math.atan2(dx,dz);
  const level=travel.keys.reduce((sum,key)=>sum+key.value[1],0)/travel.keys.length;
  const turn=axisAngleToQuaternion([0,1,0],-heading);
  const tracks=data.clip.tracks.map(track=>{
    if(track===travel)return {...track,keys:track.keys.map(key=>({time:key.time,value:[0,key.value[1]-level,0]}))};
    if(track===rotation)return {...track,keys:track.keys.map(key=>({time:key.time,value:multiplyQuaternions(turn,key.value)}))};
    return track;
  });
  const clip=createKeyframeClip({...data.clip,tracks});
  return {name,source,bones:data.bones,clip,
    duration:(data.frames-1)*data.frameTime,
    mapped:transfer.map.reduce((sum,id)=>sum+(id>=0),0),
    original:Math.hypot(dx,dz),
    draw(time){
      applyKeyframeClip(clip,source,time);
      transfer.apply(source,target);
    },
  };
}
