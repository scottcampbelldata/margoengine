import {Physics} from '@margoengine/physics';
import {fixedDelta,ballR,start,batLength,batLocal,pivots,bumpers,guides,guidePose,yawQuat,kickPosition} from './layout.js';

export const loadPhysics=signal=>Physics.load({signal});

export function makeGame(onCue=()=>{}){
  const physics=new Physics(null,{fixedTimestep:fixedDelta,gravity:[0,-9.75,1.04]});
  let score=0,balls=3,phase='ready',launches=0,steps=0,latestHit=-1,flash=0,impacts=0,kicked=false;
  const motorRecords=[],bodies=new Map();
  function staticBox(p,size,settings={}){
    return physics.addBody(null,{
      type:'fixed',position:p,rotation:yawQuat(settings.yaw??0),
      colliders:{shape:'box',halfExtents:size.map(value=>value*.5),friction:settings.friction??.39,
        restitution:settings.bounce??.31,events:settings.events??false}
    });
  }
  staticBox([0,.010,-.008],[.589,.032,1.15],{friction:.22,bounce:.045});
  for(const {a,b,kind} of guides){
    const pose=guidePose(a,b,kind);
    staticBox(pose.p,pose.size,{yaw:pose.yaw,friction:.32,bounce:kind==='turn'?.61:.30});
  }
  for(const [index,bumper] of bumpers.entries()){
    const body=physics.addBody(null,{
      type:'fixed',position:bumper.p,colliders:{
        shape:'cylinder',halfHeight:.023,radius:bumper.radius,friction:.17,restitution:.86,
        restitutionCombine:'max',events:true
      }
    });
    bodies.set(body,index);
    const switchRing=physics.addBody(null,{
      type:'fixed',position:bumper.p,colliders:{
        shape:'cylinder',halfHeight:.033,radius:bumper.radius+.013,sensor:true,events:true
      }
    });
    bodies.set(switchRing,index);
  }
  for(const pivot of pivots){
    const anchor=physics.addBody(null,{type:'fixed',position:pivot.p,colliders:[]});
    const body=physics.addBody(null,{
      position:pivot.p,gravityScale:0,canSleep:false,
      colliders:{
        shape:'box',halfExtents:[batLength*.5,.011,.019],
        offset:batLocal(pivot.yaw),rotation:yawQuat(pivot.yaw),density:900,friction:.48,restitution:.21
      }
    });
    const hinge=physics.addJoint(anchor,body,{type:'revolute',axis:[0,1,0],
      limits:pivot.sign>0?[0,1.03]:[-1.03,0]
    });
    motorRecords.push({body,hinge,sign:pivot.sign,down:false});
  }
  const ball=physics.addBody(null,{
    position:start,ccd:true,linearDamping:.019,angularDamping:.011,canSleep:false,
    colliders:{shape:'sphere',radius:ballR,density:7700,friction:.22,restitution:.34}
  });
  const kickSwitch=physics.addBody(null,{
    type:'fixed',position:kickPosition,colliders:{
      shape:'box',halfExtents:[.024,.023,.037],sensor:true,events:true
    }
  });
  physics.on('intersectionstart',({bodyA,bodyB})=>{
    if(phase!=='live'||kicked||!((bodyA===ball&&bodyB===kickSwitch)||(bodyB===ball&&bodyA===kickSwitch)))return;
    kicked=true;
    ball.applyImpulse([.142,0,-.025]);
    onCue('kickback',0);
  });
  const cool=[-100,-100,-100];
  function bumperContact({bodyA,bodyB}){
    if(phase!=='live'||(bodyA!==ball&&bodyB!==ball))return;
    const index=bodies.get(bodyA===ball?bodyB:bodyA);
    if(index===undefined||steps-cool[index]<16)return;
    cool[index]=steps;
    const bumper=bumpers[index],p=ball.position;
    const dx=p[0]-bumper.p[0],dz=p[2]-bumper.p[2],length=Math.hypot(dx,dz);
    if(length<.007)return;
    ball.applyImpulse([dx*.115/length,.001,dz*.115/length]);
    score+=bumper.score;
    flash=20;
    latestHit=index;
    impacts++;
    onCue('bumper',index);
  }
  physics.on('contactstart',bumperContact);
  physics.on('intersectionstart',bumperContact);
  function hold(index,down){
    const item=motorRecords[index];
    if(item.down===down&&item.initialized)return false;
    item.down=down;item.initialized=true;
    item.hinge.setMotor({targetPosition:down?item.sign*.98:0,frequency:13.5,dampingRatio:.87,maxForce:1.7});
    if(down)onCue('flipper',index);
    return true;
  }
  hold(0,false);
  hold(1,false);
  function launch(){
    if(phase!=='ready')return false;
    ball.setPosition(start);
    ball.setLinearVelocity([.008,0,-3.75]);
    ball.setAngularVelocity([-3.75/ballR,0,0]);
    phase='live';launches++;kicked=false;
    onCue('launch',0);
    return true;
  }
  function setWaiting(){
    ball.setPosition(start);
    ball.setLinearVelocity([0,0,0]);
    ball.setAngularVelocity([0,0,0]);
    phase=balls>0?'ready':'ended';
  }
  function step(){
    physics.step();steps++;
    if(flash)flash--;
    if(phase==='live'){
      const p=ball.position;
      if(p[1]<-.035||p[2]>.587||Math.abs(p[0])>.349){
        balls--;
        setWaiting();
        onCue('drain',0);
      }
    }else setWaiting();
  }
  function state(){
    return {phase,score,balls,launches,steps,latestHit,flash,impacts,
      ball:ball.position,ballRotation:ball.rotation,flippers:motorRecords.map(x=>x.body.rotation)};
  }
  return {launch,hold,state,step,dispose(){physics.dispose();}};
}
