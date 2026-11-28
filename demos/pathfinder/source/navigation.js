import { Crowd,NavMesh } from '@margoengine/navmesh';

export const board={halfWidth:5.72,halfDepth:3.68,gap:.62,bridge:[-3.68,-2.12]};
export const launchLinks=[
  {start:[-.86,0,-.83],end:[.86,0,-.83],direction:1},
  {start:[.86,0,.83],end:[-.86,0,.83],direction:-1},
];
export const gardens=[{x:-3.035,z:.12,width:.69,depth:1.69},{x:3.035,z:.12,width:.69,depth:1.69}];
export const leadStart=[-4.83,0,2.13],defaultGoal=[4.69,0,2.16];

const gridX=[-5.50,-4.42,-3.62,-2.45,-1.44,-.73,.73,1.44,2.45,3.62,4.42,5.50];
const gridZ=[-3.48,-2.34,-1.62,-.97,.10,1.22,2.50,3.48];
const spawns=[
  [leadStart,defaultGoal,1.98,'gold'],
  [[-4.68,0,-1.55],[4.69,0,-1.65],1.71,'ink'],
  [[-2.03,0,1.83],[4.78,0,.13],1.68,'ink'],
  [[-4.63,0,-2.93],[4.65,0,-2.93],1.71,'ink'],
  [[4.72,0,1.27],[-4.69,0,.66],1.72,'teal'],
  [[4.61,0,-1.47],[-4.78,0,-1.55],1.75,'teal'],
  [[1.99,0,.93],[-4.76,0,2.56],1.75,'teal'],
  [[4.60,0,-2.37],[-4.39,0,-2.54],1.66,'teal'],
];
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[2]-b[2]);

export function makeNav(){
  const vertices=gridZ.flatMap(z=>gridX.map(x=>[x,0,z]));
  const polygons=[];
  for(let row=0;row<gridZ.length-1;row++){
    for(let column=0;column<gridX.length-1;column++){
      const x=(gridX[column]+gridX[column+1])*.5,z=(gridZ[row]+gridZ[row+1])*.5;
      const canal=Math.abs(x)<.73&&z>-2.34;
      const basin=Math.abs(x)>2.45&&Math.abs(x)<3.62&&z>-.97&&z<1.22;
      if(canal||basin)continue;
      const i=row*gridX.length+column,j=i+gridX.length;
      polygons.push([i,i+1,j+1,j]);
    }
  }
  return new NavMesh(vertices,polygons);
}

export function arcHeight(position){
  const t=Math.max(0,Math.min(1,(position[0]+.86)/1.72));
  return 1.72*t*(1-t);
}

export function makeWorld(jump=true){
  const nav=makeNav();
  const links=[];
  if(jump){
    for(const link of launchLinks)links.push(nav.addOffMeshLink(link.start,link.end,{bidirectional:false}));
  }
  const crowd=new Crowd(nav,{neighborDistance:3.9,maxNeighbors:10,timeHorizon:1.65});
  const carts=spawns.map(([start,destination,maxSpeed,color],i)=>{
    const agent=crowd.addAgent({position:start,radius:.195,maxSpeed,maxAcceleration:6.5,
      arrivalDistance:i===0?.10:.125,slowDownDistance:.39,mass:8});
    agent.setTarget(destination);
    return {agent,start,destination,color,returning:false,dwell:0,jumps:0,wasAirborne:false,heading:0};
  });
  const lead=carts[0];
  let goal=defaultGoal.slice(),pending=null,elapsed=0,closePairs=0,avoidance=0;
  let minimumGap=Infinity,revision=0,routeRevision=0;
  let planned=nav.route(lead.agent.position,goal);
  function setGoal(position){
    const landing=nav.closestPoint(position);
    if(!landing||distance(landing.point,goal)<.027)return false;
    goal=landing.point.slice();
    revision++;
    if(lead.agent.state==='offmesh')pending=goal;
    else{
      lead.agent.setTarget(goal);
      planned=nav.route(lead.agent.position,goal);
      routeRevision=revision;
    }
    return true;
  }
  function update(dt){
    elapsed+=dt;
    for(const cart of carts.slice(1)){
      if(cart.agent.state!=='arrived'){cart.dwell=0;continue;}
      cart.dwell+=dt;
      if(cart.dwell>.58){
        cart.returning=!cart.returning;
        cart.agent.setTarget(cart.returning?cart.start:cart.destination);
        cart.dwell=0;
      }
    }
    crowd.update(dt);
    for(const cart of carts){
      const {agent}=cart,airborne=agent.state==='offmesh';
      if(airborne&&!cart.wasAirborne)cart.jumps++;
      cart.wasAirborne=airborne;
    }
    if(pending&&lead.agent.state!=='offmesh'){
      lead.agent.setTarget(pending);
      planned=nav.route(lead.agent.position,pending);
      routeRevision=revision;
      pending=null;
    }
    for(let i=0;i<carts.length;i++){
      const a=carts[i].agent;
      if(a.state==='offmesh')continue;
      for(let j=i+1;j<carts.length;j++){
        const b=carts[j].agent;
        if(b.state==='offmesh')continue;
        const between=distance(a.position,b.position);
        minimumGap=Math.min(minimumGap,between-a.radius-b.radius);
        if(between>1.1||a.state!=='moving'||b.state!=='moving')continue;
        closePairs++;
        const changes=[a,b].some(agent=>{
          const [px,,pz]=agent.preferredVelocity,[x,,z]=agent.velocity;
          return Math.hypot(x,z)>.15&&Math.hypot(px,pz)>.27&&Math.abs(px*z-pz*x)>.14;
        });
        if(changes)avoidance++;
      }
    }
  }
  function observation(){
    const active=carts.filter(({agent})=>agent.state==='offmesh');
    return {goal,revision,routeRevision,elapsed,route:planned,lead:lead.agent.position,leadState:lead.agent.state,
      leadJumps:lead.jumps,leadHeight:lead.agent.state==='offmesh'?arcHeight(lead.agent.position):0,
      totalJumps:carts.reduce((sum,c)=>sum+c.jumps,0),airborne:active.length,
      airborneHeight:Math.max(0,...active.map(({agent})=>arcHeight(agent.position))),
      closePairs,avoidance,minimumGap:Number.isFinite(minimumGap)?minimumGap:null,linkCount:links.length};
  }
  return {nav,crowd,carts,setGoal,update,observation,dispose:()=>crowd.dispose()};
}
