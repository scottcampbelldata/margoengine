import { Physics } from '@margoengine/physics';
import { ballStart,boardTurn,deck,fixed,goal,opening,pivot,radius,rails,start,toBoard,tray } from './layout.js';

export const loadPhysics=signal=>Physics.load({signal});
const tiltFrequency=14;
const tiltDecay=Math.exp(-fixed*tiltFrequency);
const boxPart=({offset,size})=>({shape:'box',offset,halfExtents:size.map(value=>value/2)});
const boardParts=[...deck,...rails].map(boxPart);

export function openRig(boardMesh=null,ballMesh=null){
  const world=new Physics(null,{fixedTimestep:fixed,substeps:5});
  const board=world.addBody(boardMesh,{type:'kinematicPosition',position:pivot,colliders:{
    shape:'compound',parts:boardParts,friction:.61,restitution:.035,
  }});
  const ball=world.addBody(ballMesh,{position:ballStart,ccd:true,canSleep:false,linearDamping:.85,angularDamping:.35,
    colliders:{shape:'sphere',radius,density:2500,friction:.58,restitution:.042}});
  const catchTray=world.addBody(null,{type:'fixed',colliders:{
    shape:'compound',parts:tray.map(boxPart),friction:.86,restitution:.02}});
  const actual=[0,0],rate=[0,0];
  let want=[0,0],solved=false,crossing=null,contacts=0;
  function aim(x,z){
    const scale=Math.max(1,Math.hypot(x,z));
    want=solved?[0,0]:[x/scale,z/scale];
  }
  world.on('beforestep',()=>{
    // Exact critically damped response for one fixed interval. Reversals preserve angular velocity.
    for(let i=0;i<2;i++){
      const difference=actual[i]-want[i];
      const tangent=rate[i]+tiltFrequency*difference;
      actual[i]=want[i]+(difference+tangent*fixed)*tiltDecay;
      rate[i]=(rate[i]-tiltFrequency*tangent*fixed)*tiltDecay;
    }
    board.setNextRotation(boardTurn(...actual));
  });
  world.on('afterstep',()=>{
    if(world.touching(ball,board))contacts++;
    if(solved)return;
    const p=toBoard(ball.position,board.rotation);
    if(p[1]<-radius*.34&&Math.abs(p[0]-goal[0])<opening/2&&Math.abs(p[2]-goal[1])<opening/2){
      solved=true;
      crossing={position:p,step:world.stepCount};
      want=[0,0];
    }
  });
  function stats(){
    const position=toBoard(ball.position,board.rotation);
    return {position,velocity:ball.linearVelocity,tilt:[...actual],solved,crossing,contacts,steps:world.stepCount,
      traveled:Math.hypot(position[0]-start[0],position[2]-start[1]),caught:world.touching(ball,catchTray)};
  }
  return {world,board,ball,aim,stats,dispose:()=>world.dispose()};
}
