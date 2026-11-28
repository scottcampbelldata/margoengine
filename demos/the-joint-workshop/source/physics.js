import {Physics} from '@margoengine/physics';

export const loadPhysics=signal=>Physics.load({signal});
import {fixedDelta,gates,linkLength,roof,stopAngle} from './layout.js';
const degrees=180/Math.PI;

export function createWorkshop(){
  const world=new Physics(null,{fixedTimestep:fixedDelta,gravity:[0,-9.81,0]});
  const doors=gates.map(gate=>{
    const {pin,sign,width,y,z,height}=gate;
    const p=[pin,y,z];
    const anchor=world.addBody(null,{type:'fixed',position:p,colliders:[]});
    const half=-sign*width*.5;
    const door=world.addBody(null,{
      position:[pin+half,y,z],
      colliders:{shape:'box',halfExtents:[width*.5,height*.5,.042],density:'oak'},
      gravityScale:0,angularDamping:.32,canSleep:false
    });
    const hinge=world.addJoint(anchor,door,{
      type:'revolute',axis:[0,1,0],anchorB:[-half,0,0],
      limits:sign<0?[-stopAngle,0]:[0,stopAngle]
    });
    return {door,hinge,sign};
  });
  const links=[];
  let parent=world.addBody(null,{type:'fixed',position:roof,colliders:[]});
  const bound=.27;
  const jointLimits={angX:[-bound,bound],angY:[-.17,.17],angZ:[-bound,bound]};
  for(let i=0;i<5;i++){
    const position=[roof[0],roof[1]-linkLength*(i+.5),roof[2]];
    const bob=i===4;
    const collider=bob?{shape:'sphere',radius:.124,density:2090}:
      {shape:'capsule',radius:.036,halfHeight:.105,density:'oak'};
    const body=world.addBody(null,{position,colliders:collider,linearDamping:.09,angularDamping:.34,canSleep:false});
    const ball=world.addJoint(parent,body,{
      type:'spherical',
      anchorA:i===0?[0,0,0]:[0,-linkLength/2,0],
      anchorB:[0,linkLength/2,0],limits:jointLimits
    });
    parent=body;
    links.push({body,ball,bob});
  }
  function drive(index,open){
    for(const [i,item] of doors.entries()){
      if(index!==null&&i!==index)continue;
      item.hinge.setMotor({targetPosition:open?item.sign*1.66:0,frequency:2.3,dampingRatio:1.05,maxForce:32});
    }
  }
  function tap(){
    links.at(-1).body.applyImpulse([9.2,.55,4.7]);
  }
  function angles(){
    return doors.map(({door})=>{
      const [,y,,w]=door.rotation;
      return Math.abs(2*Math.atan2(y,w))*degrees;
    });
  }
  function chainOffset(){
    const p=links.at(-1).body.position;
    return Math.hypot(p[0]-roof[0],p[2]-roof[2]);
  }
  drive(null,false);
  for(let i=0;i<12;i++)world.step();
  return {world,doors,links,drive,tap,angles,chainOffset,step:()=>world.step(),dispose:()=>world.dispose()};
}
