import { Engine } from '@margoengine/core';
import { SpriteLayer } from '@margoengine/sprites';
import { SkeletalLayer } from '@margoengine/sprites/skeletal';
import { parseDragonBonesJSON } from '@margoengine/sprites/dragonbones';
import { createArt } from './art.js';
import { documentFor,height,inspected,names,width } from './rig.js';

function worldPoint(bone,x=0,y=0){
  const [a,b,c,d,tx,ty]=bone.world;
  return [a*x+c*y+tx,b*x+d*y+ty];
}

export async function animate(canvas,{compatibility,signal,report,firstInput,fail}){
  const drawing=createArt();
  const data=parseDragonBonesJSON(documentFor(drawing.parts),{atlas:drawing.atlas,signal});
  const rig=data.createArmature('Keeper'),meta=rig.armature.animations.get('signal');
  const wrist=rig.bone(names.nearHand),light=rig.bone(names.lantern),cloth=rig.slot('silk').mesh;
  let engine,halo,moths,limbs=[];
  let x=0,playing=false,showBones=false,prior=0,frame=0,receipt=null,marked=false,disposed=false;
  function close(){
    if(disposed)return;
    disposed=true;
    cancelAnimationFrame(frame);
    engine?.dispose();
  }
  signal.addEventListener('abort',close,{once:true});
  function frameView(){
    signal.throwIfAborted();
    rig.pose('signal',x,{playTimes:1});
    rig.update();
    const source=worldPoint(light,0,46),hand=worldPoint(wrist);
    [halo.x,halo.y]=source;
    halo.alpha=.83+.075*Math.sin(x*7.35);
    for(const [index,moth] of moths.entries()){
      const phase=x*(1.04+index*.06)+index*1.86;
      const distance=59+13*index;
      moth.x=source[0]+Math.cos(phase)*distance+8*Math.sin(phase*3);
      moth.y=source[1]+Math.sin(phase)*distance*.67-12;
      moth.rotation=Math.sin(phase*3.9)*.56;
      moth.scaleX=(.30+index*.027)*(.54+.46*Math.abs(Math.cos(x*18+index)));
      moth.alpha=.54+index*.065;
    }
    if(showBones)for(const {bone,point,line} of limbs){
      const [bx,by]=worldPoint(bone),[a,b]=bone.parent?worldPoint(bone.parent):[bx,by];
      point.x=bx;point.y=by;
      const length=Math.hypot(bx-a,by-b);
      line.x=a;line.y=b;line.rotation=Math.atan2(by-b,bx-a);line.scaleX=Math.max(.001,length/21);
    }
    engine.render({delta:0});
    const ribbon=cloth.deform();
    const selected=inspected.map(name=>worldPoint(rig.bone(name)));
    report({time:x,duration:meta.duration,playing,showBones,hand,source,ribbon:[ribbon[4],ribbon[5]],
      jointPositions:selected,bones:rig.bones.length,slots:rig.slots.length,warnings:data.warnings.length,
      compatibility});
    if(receipt&&!marked&&Math.hypot(hand[0]-receipt[0],hand[1]-receipt[1])>3){
      marked=true;
      performance.mark('skeleton-first-gesture-submitted');
      void engine.gpu.queue.onSubmittedWorkDone().then(()=>{if(!signal.aborted)firstInput();}).catch(fail);
    }
  }
  function schedule(){
    if(!frame&&!signal.aborted&&!document.hidden)frame=requestAnimationFrame(tick);
  }
  function tick(timestamp){
    frame=0;
    if(!playing||signal.aborted||document.hidden)return;
    try{
      const step=prior?Math.max(0,Math.min(.055,(timestamp-prior)/1000)):1/60;
      prior=timestamp;
      x=Math.min(meta.duration,x+step);
      if(x===meta.duration){playing=false;prior=0;}
      frameView();
      if(playing)schedule();
    }catch(error){fail(error);}
  }
  function pause(){
    playing=false;
    prior=0;
    cancelAnimationFrame(frame);
    frame=0;
  }
  function takeReceipt(trusted){
    if(trusted&&!receipt&&!marked)receipt=worldPoint(wrist);
  }
  function action(fn){
    try{fn();}catch(error){fail(error);}
  }
  function play(trusted){
    action(()=>{
      if(playing)pause();
      else {
        if(x===meta.duration)x=0;
        takeReceipt(trusted);
        playing=true;
        schedule();
      }
      frameView();
    });
  }
  function seek(time,trusted){
    action(()=>{
      takeReceipt(trusted);
      pause();
      x=Math.max(0,Math.min(meta.duration,time));
      frameView();
    });
  }
  function bones(visible){
    action(()=>{
      showBones=visible;
      for(const {point,line} of limbs){point.visible=visible;line.visible=visible;}
      frameView();
    });
  }
  function onVisibility(){
    if(document.hidden)pause();
    else action(frameView);
  }

  try{
    engine=await Engine.create(canvas,{backend:'webgpu',exactSize:[width,height],signal,startupTimeout:9500});
    engine.onError=fail;
    engine.scene.background='#142632';
    performance.mark('skeleton-device');
    SpriteLayer.attach(engine,{atlas:drawing.backdrop,order:7}).add();
    const effect=SpriteLayer.attach(engine,{atlas:drawing.effects,order:9,snap:false,ySort:false});
    effect.add({x:533,y:544,rect:[267,151,100,34],pivotX:.5,pivotY:.5,scaleX:1.47,scaleY:.61,z:0});
    halo=effect.add({rect:[0,0,249,249],pivotX:.5,pivotY:.5,scaleX:1.23,scaleY:1.23,z:1});
    moths=Array.from({length:4},(_,index)=>effect.add({rect:[262,34,31,30],pivotX:.5,pivotY:.5,
      scaleX:.40,scaleY:.33+index*.04,z:2}));
    SkeletalLayer.attach(engine,{atlas:drawing.character,order:12}).addSkeleton(rig);
    const guides=SpriteLayer.attach(engine,{atlas:drawing.effects,order:16,snap:false});
    limbs=rig.bones.map(bone=>{
      const line=guides.add({rect:[263,105,21,11],pivotX:0,pivotY:.5,scaleY:.15,alpha:.72,visible:false,z:0});
      const point=guides.add({rect:[266,73,16,16],pivotX:.5,pivotY:.5,scaleX:.64,scaleY:.64,visible:false,z:1});
      return {bone,point,line};
    });
    frameView();
    performance.mark('skeleton-scene-submitted');
    await engine.gpu.queue.onSubmittedWorkDone();
    signal.throwIfAborted();
  }catch(error){close();throw error;}
  document.addEventListener('visibilitychange',onVisibility,{signal});
  return {play,seek,bones,close};
}
