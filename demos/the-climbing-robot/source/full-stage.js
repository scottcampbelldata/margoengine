import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { parseGLTFAsync } from '@margoengine/gltf/pbr';
import { MeshoptDecoder } from '@margoengine/decoders/meshopt';
import { Climb,contactPoint,matFoot } from 'margo-boulder/climb';
import { Climber } from 'margo-boulder/climber';
import { MAT_TOP,buildWall } from 'margo-boulder/wall';
import { makeTestCell } from './test-cell.js';

const step=.05;
const {holds,routes}=buildWall(24);
const routeByName=Object.fromEntries(routes.map(route=>[route.name,route]));

export async function openFull(canvas,bytes,compatibility,signal,progress) {
  if(compatibility || !navigator.gpu) {
    const [compat]=await Promise.all([import('@margoengine/webgl2-compat'),import('@margoengine/webgl2-compat/device')]);
    await compat.install({force:compatibility,signal});
  }
  const engine=await Engine.create(canvas,{
    backend:'webgpu',signal,exactSize:true,antialias:false,startupTimeout:9000,capacity:384,
    camera:{position:[2.25,1.55,3.65],target:[0,1,.58],fov:42,near:.06,far:29},
  });
  progress('device');
  engine.scene.background='#283739';
  engine.lighting.direction.set([-.45,.78,.36,2.6]);
  engine.lighting.radiance.set([1,.86,.66,.27]);
  engine.lighting.ambient.set([.39,.53,.50]);
  makeTestCell(engine,holds);
  let model;
  try {
    model=await parseGLTFAsync(engine,bytes,{signal,decoders:{meshopt:MeshoptDecoder}});
    progress('model');
    const climb=new Climb(holds), climber=new Climber(engine,model,climb);
    climber.breathing=false;
    progress('solvers');
    const store=engineRuntime(engine).store;
    const anchors=[[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
    let route, frameIndex=0, attempt=0, contacts=0, reachedShort=false;
    let cameraEye,cameraTarget;
    function snap(name) {
      route=routeByName[name];
      const on=[...route.start,-1,-1];
      contactPoint(0,holds[on[0]],anchors[0]);
      contactPoint(1,holds[on[1]],anchors[1]);
      const center=(anchors[0][0]+anchors[1][0])*.5;
      matFoot(2,center,MAT_TOP,anchors[2]);
      matFoot(3,center,MAT_TOP,anchors[3]);
      climb.teleport(on,anchors);
      climber.snap();
      // Restore the animator’s initial look blend for repeatable route playback.
      cameraEye=[2.25,1.55,3.65];
      cameraTarget=[0,1,.58];
      contacts=attempt=frameIndex=0;
      reachedShort=false;
    }
    function focus(delta) {
      const [x,y,z]=climb.pelvis;
      const aim=[x-.12,Math.max(1.02,y+.35),Math.max(.39,z-.33)];
      const eye=[x+1.66,aim[1]+.45,Math.max(3.29,z+2.74)];
      const mix=delta===0?1:1-Math.exp(-delta*4);
      for(let axis=0;axis<3;axis++){
        cameraTarget[axis]+=(aim[axis]-cameraTarget[axis])*mix;
        cameraEye[axis]+=(eye[axis]-cameraEye[axis])*mix;
      }
    }
    function plan() {
      if(climb.moving<0&&attempt<route.moves.length&&!reachedShort){
        const next=route.moves[attempt];
        if(climb.move(next.limb,next.hold))attempt++;
        else reachedShort=true;
      }
    }
    function update(delta) {
      climber.onPreUpdate(delta);
      climber.animator.onPreUpdate(delta);
      store.tick(false);
    }
    climb.onEvent=type=>{
      if(type==='contact')contacts++;
      if(type==='short')reachedShort=true;
    };
    snap('red');
    focus(0);
    update(1/60);
    let began=false;
    return {engine, async render(request) {
      const {name,index,width,height,fov}=request;
      if(!began || route.name!==name || index<frameIndex){
        snap(name);
        focus(0);
        update(0);
        began=true;
      }
      const advanced=index>frameIndex && !reachedShort;
      while(frameIndex+1<index && !reachedShort && contacts<route.moves.length){
        plan();
        focus(step);
        update(step);
        frameIndex++;
      }
      if(advanced && !reachedShort && contacts<route.moves.length){
        plan();
        focus(step);
        frameIndex++;
      }
      if(canvas.width!==width)canvas.width=width;
      if(canvas.height!==height)canvas.height=height;
      engine.camera.position=request.eye??cameraEye;
      engine.camera.target=request.look??cameraTarget;
      engine.camera.fov=fov;
      engine.render({delta:advanced&&!reachedShort?step:0});
      await engine.gpu.queue.onSubmittedWorkDone();
      const pose=climber.measure();
      const gap=Math.min(pose.wallGap[0],pose.wallGap[1],pose.bodyGap[0],pose.bodyGap[1]);
      return {...request,index,contacts,moving:climb.moving,pelvis:climb.pelvis[1],gap,reachedShort,
        travel:climb.travel[0],complete:contacts===route.moves.length&&climb.moving<0,
        backend:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu'};
    },dispose(){model.dispose();engine.dispose();}};
  } catch(error) {
    model?.dispose();
    engine.dispose();
    throw error;
  }
}
