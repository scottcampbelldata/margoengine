import {Physics} from '@margoengine/physics';
import {fixedDelta,lanes,belt,bin,speed,objectsForLane,approvedLimit} from './layout.js';

export const loadPhysics=signal=>Physics.load({signal});
const rotateZ=angle=>[0,0,Math.sin(angle*.5),Math.cos(angle*.5)];

export function createFactory(){
  const parcels=[],counters=[0,0,0],sensors=new Map(),bodies=new Map();
  let active=false,gear=1,drive=0,pointer=0,serial=0,steps=0;
  const world=new Physics(null,{
    fixedTimestep:fixedDelta,gravity:[0,-9.81,0],
    contactModifier(contact){
      const sign=contact.first.body.type==='fixed'?1:-1;
      contact.surfaceVelocity=[sign*drive,0,0];
    }
  });
  function fixed(p,s,roll=0,options={}){
    return world.addBody(null,{
      type:'fixed',position:p,rotation:rotateZ(roll),colliders:{
        shape:'box',halfExtents:s.map(value=>value*.5),friction:.83,events:false,...options
      }
    });
  }
  fixed([0,-.085,0],[15,.16,9]);
  lanes.forEach((z,index)=>{
    for(const part of objectsForLane(z)){
      fixed(part.p,part.s,part.roll,part.kind==='belt'?{friction:1,modifyContacts:true}:{});
    }
    const sensor=fixed([bin.center+.05,.39,z],[.91,.43,bin.depth-.14],0,{sensor:true,events:true});
    sensors.set(sensor,index);
  });
  world.on('intersectionstart',({bodyA,bodyB})=>{
    const a=sensors.has(bodyA);
    const lane=sensors.get(a?bodyA:bodyB);
    const item=bodies.get(a?bodyB:bodyA);
    if(lane===undefined||!item||item.arrived!==null)return;
    item.arrived=lane;
    counters[lane]++;
  });
  function spawn(lane,x,y,variant){
    if(parcels.length>=approvedLimit)return;
    const z=lanes[lane];
    const size=[
      .205+(variant%3)*.041,
      .176+((variant+1)%3)*.033,
      .192+((variant+2)%4)*.026
    ];
    const yaw=((variant*13)%11-5)*.035;
    const body=world.addBody(null,{
      position:[x,y+size[1]*.5,z+((variant+1)%3-1)*.048],
      rotation:[0,Math.sin(yaw*.5),0,Math.cos(yaw*.5)],
      colliders:{shape:'box',halfExtents:size.map(value=>value*.5),density:445,friction:.88,restitution:.07},
      linearDamping:.02,angularDamping:.08
    });
    const item={id:serial++,lane,size,body,variant,arrived:null};
    parcels.push(item);bodies.set(body,item);
    return item;
  }
  for(let lane=0;lane<lanes.length;lane++)for(let order=0;order<3;order++){
    spawn(lane,-2.17+order*.61,belt.top+.001,lane*3+order);
  }
  for(let i=0;i<4;i++)world.step();
  function motor(enabled,selected=gear){
    if(!Number.isInteger(selected)||selected<0||selected>=speed.length)throw RangeError('Invalid conveyor setting');
    active=enabled;gear=selected;drive=enabled?speed[selected]:0;
    for(const item of parcels)if(item.arrived===null)item.body.wakeUp();
  }
  function add(){
    if(parcels.length>=approvedLimit)return null;
    for(let i=0;i<3;i++){
      const lane=(pointer+i)%3;
      const blocked=parcels.some(item=>{
        if(item.arrived!==null||item.lane!==lane)return false;
        const [x,y]=item.body.position;
        return x< -1.69 && y>belt.top-.15;
      });
      if(blocked)continue;
      pointer=(lane+1)%3;
      return spawn(lane,-2.17,belt.top+.52,serial);
    }
    return null;
  }
  function step(){world.step();steps++;}
  function state(){return {steps,active,gear,drive,counters:[...counters],parcels,waiting:parcels.filter(item=>item.arrived===null).length};}
  return {world,parcels,motor,add,step,state,dispose:()=>world.dispose()};
}
