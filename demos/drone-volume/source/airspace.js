import {NavVolume} from '@margoengine/navmesh/volume';

export const volumeBounds={min:[-5.36,.18,-3.69],max:[5.36,5.92,3.74]};
export const voxelSize=.24,flightRadius=.29;
export const obstacleBoxes=[
  {id:'root',min:[-2.55,.13,-2.75],max:[-1.23,2.97,2.51]},
  {id:'canopy',min:[-.49,2.53,-2.60],max:[.76,5.88,2.73]},
  {id:'bench',min:[1.50,.13,-2.93],max:[2.73,2.84,1.88]},
  {id:'mast',min:[3.07,1.32,-1.86],max:[3.60,4.22,-.76]},
];
export const stations=[
  {label:'Upper canopy',short:'Upper',height:4.25,ports:[[4.46,4.50,-1.98],[4.40,4.25,.42],[4.46,4.68,2.17]]},
  {label:'Lower intake',short:'Lower',height:1.26,ports:[[4.46,1.07,-1.98],[4.40,1.32,.42],[4.46,1.63,2.17]]},
  {label:'Launch bay',short:'Launch',height:2.63,ports:[[-4.37,1.13,-1.31],[-4.38,2.58,.39],[-4.35,4.09,1.27]]},
];
export const start=stations[2].ports;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export const span=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const sample=(a,b,t)=>a.map((v,j)=>v+(b[j]-v)*t);

function surfaces(){
  const positions=[],indices=[];
  for(const {min:[x,y,z],max:[u,v,w]} of obstacleBoxes){
    const offset=positions.length/3;
    positions.push(x,y,z,u,y,z,u,y,w,x,y,w,x,v,z,u,v,z,u,v,w,x,v,w);
    for(const i of [0,1,2,0,2,3,4,7,6,4,6,5,0,4,5,0,5,1,1,5,6,1,6,2,2,6,7,2,7,3,3,7,4,3,4,0])
      indices.push(i+offset);
  }
  return {positions,indices};
}
export function clearance(point){
  let smallest=Infinity;
  for(const {min,max} of obstacleBoxes){
    const d=point.map((v,j)=>Math.max(min[j]-v,v-max[j],0));
    smallest=Math.min(smallest,Math.hypot(...d));
  }
  return smallest;
}
function protectSegments(volume,points){
  let minimum=Infinity;
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],d=span(a,b),n=Math.max(1,Math.ceil(d/.059));
    if(!volume.lineOfSight(a,b))throw new Error('The navigation volume returned a blocked segment.');
    let lower=Infinity;
    for(let j=0;j<=n;j++)lower=Math.min(lower,clearance(sample(a,b,j/n)));
    minimum=Math.min(minimum,lower-d/(2*n));
  }
  if(points.length===1)minimum=clearance(points[0]);
  return minimum;
}
function measure(points){
  const lengths=[0];
  for(let i=1;i<points.length;i++)lengths[i]=lengths[i-1]+span(points[i-1],points[i]);
  const elevations=points.map(p=>p[1]);
  return {points,lengths,length:lengths.at(-1),minimumY:Math.min(...elevations),maximumY:Math.max(...elevations)};
}
function pointAt(plan,metres){
  const {points,lengths,length}=plan;
  if(points.length<2||metres>=length)return points.at(-1).slice();
  if(metres<=0)return points[0].slice();
  const finish=lengths.findIndex(d=>d>=metres),previous=finish-1;
  return sample(points[previous],points[finish],(metres-lengths[previous])/Math.max(1e-7,lengths[finish]-lengths[previous]));
}
function progress(t,delay,duration){
  const u=clamp((t-delay)/duration,0,1),lip=.15,normal=1-lip;
  if(u<lip)return (u*u/(2*lip))/normal;
  if(u>1-lip)return 1-(1-u)**2/(2*lip*normal);
  return (u-lip/2)/normal;
}
function atTime(plan,t,delay){
  return pointAt(plan,plan.length*progress(t,delay,plan.duration));
}
function safeDispatch(plans,delays){
  if(plans.length<2)return Infinity;
  const last=Math.max(...plans.map((p,i)=>p.duration+delays[i]));
  let smallest=Infinity;
  for(let sec=0;sec<=last+.018;sec+=.016){
    const a=plans.map((plan,i)=>atTime(plan,sec,delays[i]));
    for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)smallest=Math.min(smallest,span(a[i],a[j]));
    if(smallest<.62)return smallest;
  }
  return smallest;
}
function departure(plans){
  const candidates=[[0,.37,.68],[0,.61,1.15],[0,.22,.95],[0,1.01,.29],[.74,0,.38],[.38,.79,0],[.84,.29,0]];
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)if(i!==j){
    const times=[1.15,1.15,1.15];times[i]=0;times[j]=2.3;candidates.push(times);
  }
  for(const delays of candidates){
    const distance=safeDispatch(plans,delays);
    if(distance>=.62)return {delays,distance};
  }
  return null;
}
export function createAirspace(){
  const {positions,indices}=surfaces();
  const volume=new NavVolume(positions,indices,{voxelSize,radius:flightRadius,...volumeBounds});
  const yaw=Math.PI/2;
  const drones=start.map((position,index)=>({position:position.slice(),yaw,tilt:0,index,speed:0,done:true}));
  let time=0,stepTime=0,planList=[],revision=0,site=stations[0],clear=0,separation=0,distance=0;
  function prepare(station){
    const plans=drones.map((drone,index)=>{
      const from=drone.position,goal=station.ports[index];
      if(span(from,goal)<.001){
        return {...measure([goal]),clearance:clearance(goal),duration:.33,direct:true};
      }
      const points=volume.path(from,goal);
      if(!points)return null;
      const record=measure(points);
      return {...record,duration:Math.max(.52,record.length/[1.69,1.92,1.80][index]),
        clearance:protectSegments(volume,points),direct:volume.lineOfSight(from,goal)};
    });
    if(plans.some(plan=>!plan))return null;
    const slots=departure(plans);
    if(!slots)return null;
    return {plans,slots,site:station};
  }
  function apply(prepared,active){
    const {plans,slots}=prepared;
    site=prepared.site;
    planList=plans.map((plan,i)=>({...plan,delay:slots.delays[i]}));
    clear=Math.min(...plans.map(p=>p.clearance));separation=slots.distance;
    distance=plans.reduce((total,plan)=>total+plan.length,0);
    stepTime=0;revision++;
    for(const drone of drones){drone.speed=0;drone.done=!active;}
  }
  function preview(station){
    const prepared=prepare(station);
    if(!prepared)return false;
    apply(prepared,false);
    return true;
  }
  function launch(station){
    const prepared=prepare(station);
    if(!prepared)return false;
    apply(prepared,true);
    return true;
  }
  function reset(){
    for(const [i,drone] of drones.entries()){
      drone.position=start[i].slice();drone.yaw=yaw;drone.done=true;drone.tilt=0;drone.speed=0;
    }
    time=0;
    if(!preview(stations[0]))throw new Error('The upper route could not be dispatched.');
  }
  reset();
  function step(delta){
    time+=delta;stepTime+=delta;
    for(const [i,drone] of drones.entries()){
      const plan=planList[i];
      if(drone.done||stepTime<plan.delay)continue;
      const before=drone.position,after=atTime(plan,stepTime,plan.delay);
      const next=atTime(plan,stepTime+.11,plan.delay);
      const turn=[next[0]-after[0],next[1]-after[1],next[2]-after[2]];
      const velocity=span(after,before)/Math.max(.0001,delta);
      if(Math.hypot(turn[0],turn[2])>.008){
        const wanted=Math.atan2(turn[0],turn[2]);
        drone.yaw+=Math.atan2(Math.sin(wanted-drone.yaw),Math.cos(wanted-drone.yaw))*(1-Math.exp(-7.3*delta));
      }
      const pitch=clamp(-turn[1]*1.04,-.23,.23),t=1-Math.exp(-6.1*delta);
      drone.tilt+=(pitch-drone.tilt)*t;
      drone.position=after;drone.speed=velocity;
      if(stepTime>=plan.duration+plan.delay)drone.done=true;
    }
  }
  function stats(){
    const airborne=drones.filter(drone=>!drone.done).length;
    return {time,stepTime,revision,site,distance,clearance:clear,separation,airborne,
      nodeCount:volume.nodeCount,byteLength:volume.byteLength,plans:planList,
      drones:drones.map(drone=>({...drone,position:drone.position.slice()}))};
  }
  return {volume,launch,preview,step,stats,reset};
}
