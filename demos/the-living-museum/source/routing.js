import { BehaviorTree, Blackboard, action, condition, reactiveSelector, reactiveSequence } from '@margoengine/behavior';
import { Perception, perceptionLevel, perceptionPosition, perceptionVisible } from '@margoengine/behavior/perception';
import { Crowd, NavMesh } from '@margoengine/navmesh';
import { blocked, rooms } from './gallery.js';

export const entry=[2.86,0,4.70];
export const crossing=[-2.25,0,3.90];
export const alcove=[1.14,0,.39];
const initialGuard=[-2.21,0,-.66];
const patrol=[[-2.23,0,3.48],[-4.93,0,4.28],[-6.13,0,-3.77],[.15,0,-4.80],[3.13,0,3.92]];
const tours=[
  [[-5.34,0,3.43],[-5.40,0,-3.72],[-2.20,0,-4.94]],
  [[4.95,0,4.74],[3.10,0,-3.1],[3.38,0,1.28]],
  [[1.94,0,-4.77],[-4.22,0,-4.55],[-2.51,0,3.72]],
];
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[2]-b[2]);

function boundaries(padding){
  return blocked.map(b=>({
    min:[b.x-b.w/2-padding,0,b.z-b.d/2-padding],
    max:[b.x+b.w/2+padding,b.height,b.z+b.d/2+padding],
  }));
}

export function makeNavigation() {
  const borders=boundaries(.31);
  const world={min:[rooms.minX+.3,0,rooms.minZ+.3],max:[rooms.maxX-.3,0,rooms.maxZ-.3]};
  const limits=axis=>[...new Set([world.min[axis],world.max[axis],
    ...borders.flatMap(rect=>[rect.min[axis],rect.max[axis]])])].sort((a,b)=>a-b);
  const x=limits(0), z=limits(2), vertices=[], surfaces=[];
  const contains=(point,rect)=>point[0]>rect.min[0]&&point[0]<rect.max[0]&&point[2]>rect.min[2]&&point[2]<rect.max[2];
  for(const north of z)for(const east of x)vertices.push([east,0,north]);
  for(let j=1;j<z.length;j++)for(let i=1;i<x.length;i++){
    const midpoint=[(x[i-1]+x[i])/2,0,(z[j-1]+z[j])/2];
    if(!contains(midpoint,world)||borders.some(rect=>contains(midpoint,rect)))continue;
    const a=(j-1)*x.length+i-1;
    surfaces.push([a,a+1,a+x.length+1,a+x.length]);
  }
  return new NavMesh(vertices,surfaces);
}

const occluders=boundaries(0);
export function lineOfSight(from,to) {
  for(const {min,max} of occluders){
    let start=0,end=1;
    for(let axis=0;axis<3&&start<=end;axis++){
      const delta=to[axis]-from[axis];
      if(Math.abs(delta)<1e-9){
        if(from[axis]<min[axis] || from[axis]>max[axis])start=2;
        continue;
      }
      const t1=(min[axis]-from[axis])/delta,t2=(max[axis]-from[axis])/delta;
      start=Math.max(start,Math.min(t1,t2));
      end=Math.min(end,Math.max(t1,t2));
    }
    if(start<=end)return false;
  }
  return true;
}

export function createSimulation() {
  const nav=makeNavigation(), crowd=new Crowd(nav,{neighborDistance:3.7,maxNeighbors:7,timeHorizon:1.25});
  const player=crowd.addAgent({position:entry,radius:.30,maxSpeed:1.95,maxAcceleration:4.1});
  const guard=crowd.addAgent({position:initialGuard,radius:.31,maxSpeed:1.38,maxAcceleration:3.1});
  const guests=tours.map((tour,i)=>({tour,agent:crowd.addAgent({position:tour[0],radius:.30,maxSpeed:.93+i*.10,maxAcceleration:2.8}),
    index:0,release:1+i*.9}));
  const blackboard=new Blackboard();
  const gaze={position:guard.position,forward:[0,0,1]};
  const optics=()=>new Perception(gaze,{blackboard,eyeHeight:1.61,forgetTime:4.1,
    sight:[{kind:'cone',range:6.9,fov:1.65,nearTime:.16,farTime:.56}],lineOfSight});
  let senses=optics(), mode='Patrolling', command, patrolIndex=0, searchIndex=0, elapsed=0, sightings=0;
  let lastSeen=null, lastCommand=null;
  const target={id:'player',position:[0,1.42,0],velocity:[0,0,0]};
  const assign=(next,point)=>{
    if(mode!==next || !command || distance(command,point)>.27){
      guard.setTarget(point);
      command=[...point];
    }
    mode=next;
    return 'running';
  };
  const memory=()=>blackboard.get(perceptionPosition);
  const tree = new BehaviorTree(reactiveSelector(
    reactiveSequence(condition('inView'),action('approach')),
    reactiveSequence(condition('remembers'),action('lookAround')),
    action('patrol'),
  ),{blackboard,handlers:{
    conditions:{
      inView:()=>blackboard.get(perceptionVisible) && blackboard.get(perceptionLevel)==='aware',
      remembers:()=>Boolean(lastSeen && memory() && blackboard.get(perceptionLevel)!=='calm'),
    },
    actions:{
      approach:()=>{
        if(mode!=='Spotted you')sightings++;
        lastSeen=memory();
        searchIndex=0;
        return assign('Spotted you',lastSeen);
      },
      lookAround:()=>{
        if(mode!=='Searching')searchIndex=0;
        const points=[lastSeen,[lastSeen[0]+.88,0,lastSeen[2]+.65],[lastSeen[0]-.86,0,lastSeen[2]-.61]];
        if(guard.state==='arrived'&&mode==='Searching') searchIndex=(searchIndex+1)%points.length;
        return assign('Searching',points[searchIndex]);
      },
      patrol:()=>{
        if(guard.state==='arrived'&&mode==='Patrolling')patrolIndex=(patrolIndex+1)%patrol.length;
        lastSeen=null;
        return assign('Patrolling',patrol[patrolIndex]);
      },
    },
  }});
  return {
    nav,crowd,player,guard,guests,
    get mode(){return mode;},get seen(){return sightings;},
    get awareness(){return blackboard.get(perceptionLevel);},
    get focus(){return gaze.forward;},get destination(){return lastCommand;},
    move(position){
      lastCommand=[...position];
      player.setTarget(position);
    },
    update(delta){
      elapsed+=delta;
      gaze.position=guard.position;
      const velocity=guard.velocity;
      const planarSpeed=Math.hypot(velocity[0],velocity[2]);
      if(planarSpeed>.12){
        const a=1-Math.exp(-delta*7);
        gaze.forward[0]+=(velocity[0]/planarSpeed-gaze.forward[0])*a;
        gaze.forward[2]+=(velocity[2]/planarSpeed-gaze.forward[2])*a;
        const length=Math.hypot(gaze.forward[0],gaze.forward[2]) || 1;
        gaze.forward[0]/=length;
        gaze.forward[2]/=length;
      }
      target.position[0]=player.position[0];
      target.position[2]=player.position[2];
      target.velocity=player.velocity;
      senses.update(delta,[target]);
      tree.tick(delta);
      for(const guest of guests){
        if(guest.release===null&&guest.agent.state==='arrived')guest.release=elapsed+1.3;
        if(guest.release!==null&&elapsed>=guest.release){
          guest.index=(guest.index+1)%guest.tour.length;
          guest.agent.setTarget(guest.tour[guest.index]);
          guest.release=null;
        }
      }
      crowd.update(delta);
    },
    reset(){
      player.teleport(entry);
      guard.teleport(initialGuard);
      gaze.forward.splice(0,3,0,0,1);
      senses=optics();
      blackboard.clear();
      mode='Patrolling';
      command=lastSeen=lastCommand=null;
      patrolIndex=searchIndex=sightings=elapsed=0;
      for (const [i,guest] of guests.entries()) {
        guest.agent.teleport(guest.tour[0]);
        guest.index=0;
        guest.release=1+i*.9;
      }
      tree.halt();
    },
    dispose(){tree.dispose();},
  };
}
