import { Engine } from '@margoengine/core';
import { PixelCamera,LayerCompositor } from '@margoengine/pixel';
import { SpriteLayer } from '@margoengine/sprites';
import { TileMap } from '@margoengine/tilemap';
import { SoftLighting2D } from '@margoengine/lighting2d/soft';
import { makeArt } from './art.js';
import { blockers,finish,lanterns,map,samples,spawn,viewHeight,viewWidth,width } from './level.js';

const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));

export async function start(canvas,{compatibility,prepared,signal,state,fail,firstInput}){
  const output=[viewWidth*2,viewHeight*2];
  const art=makeArt();
  let engine;
  let frame=0,last=0,lag=0,elapsed=0,until=0;
  let rig,createRig,fixed,receipt=null,verified=false,jumpQueued=false,direction=0;
  let lights,actors,background,bump,actorLight,beacon,beaconLight,hero,tiles,sources;
  let mode='soft',visual,beam,disposed=false;
  const crystals=[];
  const pulses=[];
  function cleanup(){
    if(disposed)return;
    disposed=true;
    cancelAnimationFrame(frame);
    rig?.dispose();
    engine?.dispose();
  }
  signal.addEventListener('abort',cleanup,{once:true});
  function schedule(){
    if(!frame&&!signal.aborted&&!document.hidden)frame=requestAnimationFrame(cycle);
  }
  function report(){
    state(visual,tiles.stats.draws,compatibility,mode);
  }
  function draw(){
    const [x,y]=visual.position;
    const progress=clamp(x-107,0,width-viewWidth);
    background.x=Math.floor(progress);
    const moving=Math.abs(visual.velocity[0])>14;
    const phase=!visual.grounded?3:moving?1+Math.floor(visual.steps/6)%2:0;
    hero.rect=[phase*24,180,24,27];
    hero.x=x;hero.y=y+9;
    hero.flipX=visual.facing<0;
    actorLight.x=x+visual.facing*7;
    actorLight.y=y-3;
    actorLight.intensity=1.13+.06*Math.sin(elapsed*11.9)+.035*Math.cos(elapsed*28);
    beacon.visible=visual.victory;
    if(visual.victory&&!beam){
      beam=lights.addLight({kind:'spot',x:finish[0],y:32,angle:Math.PI+.105,
        cone:.17,softness:.72,radius:278,color:'#ffe0ab',height:120,falloff:1.3,
        intensity:.83,shadows:false});
    }else if(!visual.victory&&beam){
      lights.removeLight(beam);
      beam=null;
    }
    if(beam)beam.angle=Math.PI+.105+.06*Math.sin(elapsed*2.1);
    beaconLight.intensity=visual.victory?.94+.08*Math.sin(elapsed*3):0;
    for(const [i,sprite] of crystals.entries()){
      sprite.visible=!visual.collected[i];
      sprite.y=samples[i].y+Math.round(1.25*Math.sin(elapsed*2.8+i));
      pulses[i].intensity=sprite.visible?.16+.045*Math.sin(elapsed*4+i):0;
    }
    engine.render({delta:0});
    report();
  }
  function cycle(timestamp){
    frame=0;
    if(signal.aborted||document.hidden)return;
    try{
      const dt=last?clamp((timestamp-last)/1000,0,.066):fixed;
      last=timestamp;
      elapsed+=dt;
      lag+=dt;
      while(lag+1e-9>=fixed){
        rig.step(direction,jumpQueued);
        jumpQueued=false;
        lag-=fixed;
      }
      visual=rig.state();
      draw();
      if(receipt&&!verified){
        const moved=receipt.kind==='jump'
          ?visual.jumps>receipt.jumps&&visual.position[1]<receipt.position[1]-2.5
          :Math.abs(visual.position[0]-receipt.position[0])>2.5;
        if(moved){
          verified=true;
          performance.mark('pixel-first-move-submitted');
          void engine.gpu.queue.onSubmittedWorkDone().then(()=>{if(!signal.aborted)firstInput();}).catch(fail);
        }
      }
      if(timestamp<until||direction||!visual.grounded||Math.abs(visual.velocity[0])>.4)schedule();
      else last=lag=0;
    }catch(error){fail(error);}
  }
  function kick(){
    until=performance.now()+400;
    schedule();
  }
  function move(value,trusted=false){
    if(value&&trusted&&!verified)receipt={kind:'move',position:visual.position};
    direction=value;
    kick();
  }
  function jump(trusted){
    if(trusted&&!verified)receipt={kind:'jump',jumps:visual.jumps,position:visual.position};
    jumpQueued=true;
    kick();
  }
  function reset(){
    cancelAnimationFrame(frame);
    frame=last=lag=elapsed=until=direction=0;
    receipt=null;
    jumpQueued=false;
    rig.dispose();
    rig=createRig();
    visual=rig.state();
    draw();
  }
  function compare(kind){
    mode=kind;
    for(const [i,light] of sources.entries())light.sourceRadius=kind==='hard'?0:i===0?12:10;
    lights.setNormals(kind==='flat'?undefined:bump.target);
    draw();
  }
  try{
    engine=await Engine.create(canvas,{backend:'webgpu',signal,exactSize:output,startupTimeout:10000});
    engine.onError=fail;
    performance.mark('pixel-device');
    engine.scene.background='#252044';
    background=new PixelCamera({width:viewWidth,height:viewHeight,zoom:2});
    const compositor=LayerCompositor.attach(engine,{camera:background});
    function farLayer(image,parallax,z){
      const layer=compositor.addLayer({width:image.width,height:image.height,anchor:'world',parallax,z});
      layer.write(image);
      return layer;
    }
    farLayer(art.sky,.28,0);
    const ridges=[.36,.48,.58];
    for(const [i,image] of art.ridges.entries())farLayer(image,ridges[i],i+1);
    farLayer(art.surf,.54,4);
    const rock=compositor.addLayer({z:5});
    const paint=compositor.addLayer({z:6});
    const shade=compositor.addLayer({z:7,blend:'multiply'});
    const glow=compositor.addLayer({z:8});
    bump=compositor.addLayer({visible:false});
    tiles=TileMap.attach(engine,{map,atlases:{basalt:art.tiles},target:rock.target,camera:rock.camera,parallax:false});
    actors=SpriteLayer.attach(engine,{atlas:art.atlas,target:paint.target,camera:paint.camera,
      normals:{atlas:art.normals,target:bump.target},order:11});
    actors.add({x:0,y:0,rect:[0,0,640,180],z:0});
    hero=actors.add({x:spawn[0],y:spawn[1]+9,rect:[0,180,24,27],pivotX:.5,pivotY:25/27,z:3});
    for(const item of samples)crystals.push(actors.add({x:item.x,y:item.y,rect:[100,182,14,20],pivotX:.5,pivotY:.5,z:2}));
    const emissive=SpriteLayer.attach(engine,{atlas:art.windows,target:glow.target,camera:glow.camera,order:12});
    beacon=emissive.add({x:finish[0],y:32,pivotX:.5,pivotY:.5,visible:false});
    lights=SoftLighting2D.attach(engine,{target:shade.target,normals:bump.target,camera:shade.camera,
      ambient:'#81809a',samples:12,sourceRadius:5,occluders:blockers});
    actorLight=lights.addLight({x:spawn[0],y:spawn[1],color:'#ffc279',height:23,radius:90,
      falloff:1.65,intensity:1.13,sourceRadius:12});
    sources=[actorLight];
    for(const {x,y,color} of lanterns)sources.push(lights.addLight({x,y,color,radius:85,falloff:1.55,
      height:24,intensity:.93,sourceRadius:10}));
    for(const point of samples)pulses.push(lights.addLight({...point,color:'#82d3b8',radius:25,height:12,
      falloff:1.5,intensity:.16,shadows:false}));
    beaconLight=lights.addLight({x:finish[0],y:35,color:'#ffdba2',radius:107,height:22,
      intensity:0,falloff:1.5,shadows:false});
    visual={position:spawn,velocity:[0,0],steps:0,jumps:0,grounded:true,flag:false,attempts:0,
      lit:0,victory:false,facing:1,collected:samples.map(()=>false)};
    draw();
    performance.mark('pixel-first-scene-submitted');
    const [module]=await Promise.all([prepared,engine.gpu.queue.onSubmittedWorkDone()]);
    if(module.error)throw module.error;
    signal.throwIfAborted();
    ({createRig,fixed}=module);
    rig=createRig();
    visual=rig.state();
    report();
  }catch(error){cleanup();throw error;}
  function pause(){
    if(document.hidden){
      cancelAnimationFrame(frame);
      frame=last=lag=direction=0;
      jumpQueued=false;
    }
  }
  document.addEventListener('visibilitychange',pause,{signal});
  return {move,jump,reset,compare};
}
