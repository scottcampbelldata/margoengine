import {Physics} from '@margoengine/physics';
import {
  hz,radius,capsuleHalf,ankleSpan,stairTop,stairExit,stairEntrance,stepHeight,stairCount,pathWidth,
  ramp,rampLow,rampHigh,walkways,ferryHome,ferryAway,ferrySize,ferryY,start,finishZ,ease,
} from './layout.js';

const delta=1/hz;
const platformTrip=3.05;
const deckRail=.75;
const boxShape=(size,position)=>({shape:'box',halfExtents:size.map(v=>v/2),offset:position});

export async function createCourse(signal){
  await Physics.load({signal});
  signal?.throwIfAborted();
  const world=new Physics(null,{fixedTimestep:delta,predictionDistance:.015,substeps:4,iterations:2,interpolate:false});
  for(const piece of [...walkways,ramp]){
    const rotation=piece.tilt?[Math.sin(piece.tilt/2),0,0,Math.cos(piece.tilt/2)]:undefined;
    world.addBody(null,{type:'fixed',position:piece.position,rotation,colliders:boxShape(piece.size)});
  }
  for(const z of [8.00,1.66,-7.35,-13.91]){
    const y=z>5||z< -10?0:stairTop;
    for(const sign of [-1,1]){
      world.addBody(null,{type:'fixed',position:[sign*(pathWidth*.5+.016),y+.45,z],
        colliders:boxShape([.105,.90,z===8?5.02:2.1])});
    }
  }
  const ferry=world.addBody(null,{type:'kinematicPosition',position:[0,ferryY,ferryHome],
    colliders:[
      boxShape(ferrySize),boxShape([.10,deckRail,1.86],[-1.49,.145+deckRail/2,0]),
      boxShape([.10,deckRail,1.86],[ 1.49,.145+deckRail/2,0]),
    ]});
  const body=world.addBody(null,{type:'kinematicPosition',position:[start[0],start[1]+ankleSpan+.014,start[2]],
    colliders:{shape:'capsule',halfHeight:capsuleHalf,radius}});
  const walker=world.createCharacterController(body,{offset:.014,autostep:{maxHeight:.265,minWidth:.18},
    snapToGround:.239,maxSlopeClimbAngle:Math.PI*38/180,minSlopeSlideAngle:Math.PI*34/180,
    inheritPlatformVelocity:true});
  let ticking,ride='home',clock=0,board=0,returnTimer=0,deckZ=ferryHome;
  let stairs=0,crossed=false,seenSlope=false,finished=false,fell=0;
  let prev=[...body.position],walked=0,stepDistance=0,lastInput=0;
  let jumpLatched=false;
  function reset(){
    ride='home';clock=board=returnTimer=0;deckZ=ferryHome;
    stairs=0;crossed=seenSlope=finished=false;fell=0;walked=stepDistance=0;
    body.setPosition([start[0],start[1]+ankleSpan+.021,start[2]]);
    ferry.setPosition([0,ferryY,ferryHome]);
    walker.restoreState([0,0,0,0,0,0]);
    prev=[...body.position];
  }
  function motion(){
    if(ride==='home'&&walker.platform===ferry&&Math.abs(body.position[2]-deckZ)<.48){
      board+=delta;
      if(board>=.39){ride='outbound';clock=0;}
    }else if(ride==='home')board=0;
    if(ride==='outbound'||ride==='returning'){
      clock=Math.min(platformTrip,clock+delta);
      const blend=ease(clock/platformTrip);
      deckZ=ride==='outbound'?ferryHome+(ferryAway-ferryHome)*blend:ferryAway+(ferryHome-ferryAway)*blend;
      if(clock===platformTrip){
        ride=ride==='outbound'?'far':'home';
        returnTimer=0;
      }
    }else if(ride==='far'){
      if(walker.platform!==ferry) returnTimer+=delta;
      else returnTimer=0;
      if(returnTimer>=4.3){ride='returning';clock=0;}
    }
    ferry.setNextPosition([0,ferryY,deckZ]);
  }
  function guided(){
    if(finished)return [0,0];
    const [x,y,z]=body.position;
    const align=Math.max(-.75,Math.min(.75,-x*2.0));
    if((ride==='outbound'&&walker.platform===ferry)||(ride==='home'&&walker.platform===ferry&&z<=ferryHome+.09))return [align,0];
    if(z<1.20&&z>ferryHome+.62&&ride!=='home'&&walker.platform!==ferry)return [align,0];
    if(y<-.75)return [0,0];
    return [align,-1];
  }
  function step({x=0,z=0,jump=false,guide=false}={}){
    motion();
    let movement=guide?guided():[x,z];
    const magnitude=Math.hypot(...movement);
    if(magnitude>1)movement=movement.map(v=>v/magnitude);
    if(jump&&!jumpLatched&&walker.grounded)walker.jump(4.45);
    jumpLatched=jump;
    const stroke=walker.walk([movement[0]*2.11,0,movement[1]*2.11]);
    world.step();
    const [px,py,pz]=body.position;
    const bottom=py-ankleSpan-.014;
    if(pz<stairEntrance+.05&&pz>stairExit-.22&&walker.grounded){
      stairs=Math.max(stairs,Math.min(stairCount,Math.round(bottom/stepHeight)));
    }
    if(pz<-6.47&&pz>rampHigh&&walker.grounded)crossed=true;
    if(pz<rampHigh-.10&&pz>rampLow+.10&&walker.grounded&&walker.slopeAngle>.16)seenSlope=true;
    if(crossed&&pz<finishZ&&walker.grounded)finished=true;
    if(bottom<-2.40){
      fell++;
      const saved=crossed?[0,stairTop,-7.30]:[0,stairs===stairCount?stairTop:0,stairs===stairCount?1.85:start[2]];
      body.setPosition([saved[0],saved[1]+ankleSpan+.025,saved[2]]);
      walker.restoreState([0,0,0,0,0,0]);
      prev=[...body.position];
    }
    const lateral=Math.hypot(body.position[0]-prev[0],body.position[2]-prev[2]);
    stepDistance=magnitude>.03?Math.min(lateral,.08):0;
    walked+=stepDistance;
    prev=[...body.position];
    lastInput=magnitude;
    ticking=stroke;
  }
  function state(){
    const [x,y,z]=body.position;
    const foot=[x,y-ankleSpan-.014,z];
    return {foot,stairs,crossed,seenSlope,finished,fell,ferryZ:ferry.position[2],ride,
      onFerry:walker.platform===ferry,grounded:walker.grounded,slope:walker.slopeAngle,walked,stepDistance,
      collisions:ticking?.collisions??0,input:lastInput};
  }
  function dispose(){walker.dispose();world.dispose();}
  step();
  return {step,state,reset,dispose};
}
