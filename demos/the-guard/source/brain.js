import {BehaviorTree,Blackboard,action,blackboardKey,condition,reactiveSelector,reactiveSequence} from '@margoengine/behavior';
import {OccupancyMap,Perception,perceptionLevel,perceptionPosition,perceptionTarget} from '@margoengine/behavior/perception';
import {arrive} from '@margoengine/behavior/steering';
import {distance,occupied,patrol,routeTo,sightLine,start} from './plan.js';

const assignment=blackboardKey('investigation',null);
const checkpoint=blackboardKey('patrol stop',0);
const status=blackboardKey('guard status','Patrol');
const looking=blackboardKey('cleared locations',0);
const angleDelta=(a,b)=>Math.atan2(Math.sin(a-b),Math.cos(a-b));
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const label=(node,name)=>({...node,label:name});

export const nodes=[
  {name:'Choose response',path:'root',depth:0},
  {name:'Investigate sound',path:'root.children[0]',depth:1},
  {name:'Sound remembered?',path:'root.children[0].children[0]',depth:2},
  {name:'Walk to sound',path:'root.children[0].children[1]',depth:2},
  {name:'Search nearby',path:'root.children[0].children[2]',depth:2},
  {name:'Return to route',path:'root.children[1]',depth:1},
  {name:'Search ended?',path:'root.children[1].children[0]',depth:2},
  {name:'Resume patrol',path:'root.children[1].children[1]',depth:2},
  {name:'Patrol gallery',path:'root.children[2]',depth:1},
];
const root=label(reactiveSelector(
  label(reactiveSequence(
    label(condition('remembered'),'Sound remembered?'),
    label(action('approach'),'Walk to sound'),
    label(action('search'),'Search nearby')),'Investigate sound'),
  label(reactiveSequence(
    label(condition('ended'),'Search ended?'),
    label(action('resume'),'Resume patrol')),'Return to route'),
  label(action('patrol'),'Patrol gallery')),'Choose response');

export function makeGuard(){
  const blackboard=new Blackboard();
  const position=start.slice(),velocity=[0,0,0],forward=[.03,0,-1],agent={position,velocity,forward,maxSpeed:1.26};
  const nearby=OccupancyMap.grid({min:[-4.29,-3.9],size:[11,10],cell:.78,y:.88,blocked:occupied,diffusion:.36});
  const perception=new Perception(agent,{
    blackboard,eyeHeight:1.57,sight:[{kind:'cone',range:4.45,fov:1.5,nearTime:.18,farTime:.65}],
    lineOfSight:sightLine,soundDistance:(source,p)=>Math.hypot(source[0]-p[0],source[1]-p[1]-1.57,source[2]-p[2]),
    suspiciousAt:.28,forgetTime:12.4,
  });
  let isIdle=false,facing=Math.atan2(forward[0],forward[2]),speed=0,stepDistance=0,scanAge=0,cullIn=0,sourceId=null;
  let goto=null,route=[],lastHeard=null,lastSound=null,clock=0,arrived=false,retargeted=false;
  let seekPosition=null;
  const steering=[0,0,0];
  function head(goal,dt,rate=5.6){
    facing+=limitTurn(angleDelta(goal,facing),rate*dt);
    forward[0]=Math.sin(facing);forward[2]=Math.cos(facing);
  }
  const limitTurn=(theta,limit)=>clamp(theta,-limit,limit);
  function destination(point){
    if(goto===point)return;
    goto=point;route=routeTo(position,point);seekPosition=route[0]??null;
  }
  function walk(point,dt,maximum,radius=.52){
    destination(point);
    agent.maxSpeed=maximum;
    const target=route[0];
    if(!target){
      speed*=Math.exp(-12*dt);velocity[0]=velocity[2]=0;
      return true;
    }
    const remaining=distance(position,target);
    if(remaining<.09){
      route.shift();seekPosition=route[0]??null;
      if(!seekPosition){speed*=Math.exp(-12*dt);velocity[0]=velocity[2]=0;return true;}
      return false;
    }
    const x=target[0]-position[0],z=target[2]-position[2];
    const prior=angleDelta(Math.atan2(x,z),facing);
    head(Math.atan2(x,z),dt);
    const turnScale=clamp(1-Math.abs(prior)/1.12,0,1);
    // Margo's arrive acceleration approaches the chosen stop with a deceleration zone.
    arrive(agent,target,steering,route.length>1?.22:radius);
    const desired=clamp(speed+(steering[0]*x+steering[2]*z)/Math.max(remaining,.01)*dt*3.2,0,maximum);
    const requestedSpeed=desired*turnScale;
    speed+=(requestedSpeed-speed)*(1-Math.exp(-7*dt));
    const moved=Math.min(speed*dt,remaining);
    position[0]+=x/remaining*moved;position[2]+=z/remaining*moved;
    velocity[0]=x/remaining*speed;velocity[2]=z/remaining*speed;
    stepDistance+=moved;
    return false;
  }
  function halt(dt){
    speed*=Math.exp(-12*dt);velocity[0]=velocity[2]=0;
  }
  const tree=new BehaviorTree(root,{
    blackboard,trace:true,
    handlers:{
      conditions:{
        remembered:tick=>tick.blackboard.get(perceptionPosition)!==null&&tick.blackboard.get(assignment)!==null,
        ended:tick=>tick.blackboard.get(assignment)!==null,
      },
      actions:{
        approach:tick=>{
          const station=tick.blackboard.get(assignment);
          if(arrived)return 'success';
          tick.blackboard.set(status,'Investigating');
          arrived=walk(station.stop,tick.delta,1.36);
          return arrived?'success':'running';
        },
        search:tick=>{
          halt(tick.delta);
          const station=tick.blackboard.get(assignment);
          tick.blackboard.set(status,'Searching');
          scanAge+=tick.delta;
          const toward=Math.atan2(station.point[0]-position[0],station.point[2]-position[2]);
          head(toward+Math.sin(scanAge*1.86)*.87,tick.delta,1.8);
          cullIn-=tick.delta;
          if(cullIn<=0){
            cullIn=.36;nearby.diffuse();
            const removed=nearby.cull(point=>perception.canSee(point));
            if(removed>.001)tick.blackboard.set(looking,tick.blackboard.get(looking)+1);
          }
          return 'running';
        },
        resume:tick=>{
          tick.blackboard.set(status,'Returning');
          const target=patrol[tick.blackboard.get(checkpoint)];
          if(!walk(target,tick.delta,1.22))return 'running';
          tick.blackboard.set(assignment,null);tick.blackboard.set(looking,0);
          tick.blackboard.set(checkpoint,(tick.blackboard.get(checkpoint)+1)%patrol.length);
          return 'success';
        },
        patrol:tick=>{
          tick.blackboard.set(status,'Patrol');
          const i=tick.blackboard.get(checkpoint);
          if(walk(patrol[i],tick.delta,1.20))tick.blackboard.set(checkpoint,(i+1)%patrol.length);
          return 'running';
        },
      },
    },
  });
  function ring(station,radius){
    perception.update(0,[]);
    const heard=perception.hear({position:station.point,radius,priority:1,source:'gallery chime'});
    const before=blackboard.get(assignment);
    const metres=Math.hypot(station.point[0]-position[0],station.point[1]-position[1]-1.57,station.point[2]-position[2]);
    lastSound={id:station.id,heard,metres,radius,time:clock};
    retargeted=heard&&before!==null&&before!==station;
    if(heard){
      lastHeard=station.id;
      sourceId=blackboard.get(perceptionTarget);
      blackboard.set(assignment,station);blackboard.set(looking,0);
      arrived=false;scanAge=0;cullIn=0;nearby.observe(station.point);
      goto=null;
    }
    return lastSound;
  }
  function tick(dt){
    if(isIdle)return;
    clock+=dt;
    perception.update(dt,[]);tree.tick(dt);
  }
  function snapshot(){
    const focus=sourceId===null?null:perception.memory.get(sourceId);
    return {
      state:blackboard.get(status),awareness:blackboard.get(perceptionLevel),certainty:focus?.awareness??0,
      remembered:blackboard.get(perceptionPosition),blackboardVersion:blackboard.version,patrol:1+blackboard.get(checkpoint),
      cleared:blackboard.get(looking),position:position.slice(),forward:forward.slice(),facing,speed,distance:stepDistance,
      route:route.map(p=>p.slice()),target:seekPosition?.slice()??null,elapsed:clock,heard:lastHeard,lastSound,retargeted,
      trace:tree.trace.map(entry=>({...entry})),
    };
  }
  return {ring,tick,snapshot,dispose(){isIdle=true;tree.dispose();}};
}
