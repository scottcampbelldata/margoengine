import {FlowField,WALL} from '@margoengine/behavior/flowfield';

export const columnCount=72,rowCount=52,cell=.16;
export const minX=-columnCount*cell/2,minZ=-rowCount*cell/2,maxX=-minX,maxZ=-minZ;
export const unitCount=12000,floorY=.018;
export const targets=[{label:'East landing',point:[4.38,floorY,.61]},
  {label:'South pass',point:[3.57,floorY,2.83]},{label:'West channel',point:[-4.01,floorY,.94]},
  {label:'North shelf',point:[3.79,floorY,-2.62]}];

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function generator(seed){
  return ()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return (seed>>>0)/4294967296;};
}
function rotate(x,z,angle){
  const c=Math.cos(angle),s=Math.sin(angle);return [c*x-s*z,s*x+c*z];
}
function ellipse(x,z,cx,cz,w,d,angle){
  const [a,b]=rotate(x-cx,z-cz,angle);
  return (a/w)**2+(b/d)**2;
}
export function profile(x,z){
  const main=ellipse(x,z,-.51,-.06,1.47,2.37,-.43)+.11*Math.sin(3.2*x+1.8*z)+.052*Math.cos(z*8.3);
  const nord=ellipse(x,z,1.91,-2.77,1.05,.54,.33)+.055*Math.cos(x*9.3+z);
  const port=ellipse(x,z,-3.68,2.81,.83,.49,-.39)+.063*Math.cos(2*x+11*z);
  const reef=ellipse(x,z,2.81,1.58,.68,.52,.21)+.09*Math.cos(7*x-4*z);
  const basin=Math.min(main,nord,port,reef);
  if(basin<1)return {cost:WALL,height:.51+1.52*(1-basin)**.68+.047*Math.cos(8*x+z),part:basin===main?0:basin===nord?1:basin===port?2:3};
  const slow=ellipse(x,z,-1.19,2.79,2.38,.81,.09)<1||ellipse(x,z,3.52,-.91,1.38,.74,-.36)<1;
  return {cost:slow?4:1,height:floorY,part:-1};
}
export function center(index){
  return [minX+(index%columnCount+.5)*cell,floorY,minZ+(Math.floor(index/columnCount)+.5)*cell];
}
export function labelTarget(position){
  const column=clamp(Math.floor((position[0]-minX)/cell)+1,1,columnCount);
  const row=clamp(Math.floor((position[2]-minZ)/cell)+1,1,rowCount);
  return 'Cell '+column+' / '+row;
}
export function makeFlow(){
  const shapes=Array.from({length:columnCount*rowCount},(_,i)=>{
    const [x,,z]=center(i);return profile(x,z);
  });
  const field=new FlowField({min:[minX,minZ],size:[columnCount,rowCount],cell,cost:shapes.map(shape=>shape.cost)});
  const positions=new Float32Array(unitCount*3),colors=new Uint8Array(unitCount*4),sizes=new Float32Array(unitCount);
  const groupSize=unitCount/3;
  const cohorts=[1.22,1.73,2.43].map(speed=>({speed,x:new Float32Array(groupSize),z:new Float32Array(groupSize)}));
  let random=generator(34190);
  const jitter=new Float32Array(unitCount);
  const palette=[[71,198,246],[148,218,231],[248,166,62],[223,106,36],[234,190,114],[108,145,229]];
  let goal,targetCell=-1,sequence=0,arrived=0,moved=0,time=0,solves=0,reachable=0;
  function spawnZone(which){
    return which%11<2?2:which%7<3?1:0;
  }
  function opening(which){
    const zone=spawnZone(which),a=random()*Math.PI*2,r=Math.sqrt(random());
    const x=(zone===2?maxX-.99:minX+1.06)+r*.80*Math.cos(a);
    const z=(zone===2?-2.13:zone===1?-2.46:1.46)+r*.67*Math.sin(a)+.18*Math.cos(a)*r;
    return [x,z];
  }
  function legal(x,z){
    const i=field.cellAt([x,0,z]);
    return i>=0&&i!==targetCell&&Number.isFinite(field.integration[i]);
  }
  function entry(which,first=false){
    let x,z,tries=0;
    do{
      if(first&&tries===0){
        x=minX+.25+(maxX-minX-.50)*random();
        z=minZ+.26+(maxZ-minZ-.52)*random();
      }else [x,z]=opening(which);
      tries++;
    }while(tries<32&&!legal(x,z));
    if(!legal(x,z)){
      const spare=field.integration.findIndex((v,i)=>i!==targetCell&&Number.isFinite(v));
      [x,,z]=center(spare);
    }
    return [x,z];
  }
  function transit(which,first=false){
    const cohort=cohorts[Math.floor(which/groupSize)],j=which%groupSize,[x,z]=entry(which,first);
    cohort.x[j]=x;cohort.z[j]=z;
  }
  function seedRoute(){
    const size=90,steps=73, x=new Float32Array(size),z=new Float32Array(size),collections=[[],[],[]];
    for(let i=0;i<size;i++){
      const [xx,zz]=entry(i);
      x[i]=xx;z[i]=zz;collections[spawnZone(i)].push(i);
    }
    const track=Array.from({length:steps},()=>{
      field.steer({x,z},size,1.86,.067);
      return [x.slice(),z.slice()];
    });
    for(let i=0;i<unitCount;i++){
      if(i%6===0){transit(i,true);continue;}
      const options=collections[spawnZone(i)],j=options[Math.floor(random()*options.length)];
      const [samplesX,samplesZ]=track[Math.floor(random()*steps)];
      let px=samplesX[j]+(random()-.5)*.19,pz=samplesZ[j]+(random()-.5)*.19;
      if(!legal(px,pz)){px=samplesX[j];pz=samplesZ[j];}
      if(!legal(px,pz)){transit(i);continue;}
      cohorts[Math.floor(i/groupSize)].x[i%groupSize]=px;
      cohorts[Math.floor(i/groupSize)].z[i%groupSize]=pz;
    }
  }
  function setGoal(target,label){
    const i=field.cellAt(target);
    if(i<0||field.cost[i]===WALL)return false;
    if(!field.setGoal(target))return false;
    goal={point:[target[0],floorY,target[2]],label:label??labelTarget(target)};
    sequence++;solves++;targetCell=i;
    reachable=0;
    for(const value of field.integration)if(Number.isFinite(value))reachable++;
    return true;
  }
  function paint(){
    for(let i=0;i<unitCount;i++){
      const cohort=cohorts[Math.floor(i/groupSize)],n=i%groupSize,j=i*3;
      positions[j]=cohort.x[n];positions[j+1]=.044+jitter[i]*.081+.014*Math.sin(.009*i+time*4.9);
      positions[j+2]=cohort.z[n];
    }
  }
  function reset(){
    arrived=0;moved=0;time=0;random=generator(38133);
    seedRoute();
    paint();
  }
  setGoal(targets[0].point,targets[0].label);
  for(let i=0;i<unitCount;i++){
    const index=i%7<3?(i%5===0?4:i%2?2:3):(i%11===0?5:i%3?0:1),color=palette[index];
    const intensity=.72+random()*.27;
    for(let c=0;c<3;c++)colors[i*4+c]=Math.round(color[c]*intensity);
    colors[i*4+3]=166+Math.floor(random()*88);
    sizes[i]=.68+1.12*random()**2.6;jitter[i]=random();
  }
  reset();
  const probe=[0,0,0];
  function step(dt,speed=1){
    moved=0;
    for(const [group,cohort] of cohorts.entries()){
      moved+=field.steer(cohort,groupSize,speed*cohort.speed,dt);
      for(let j=0;j<groupSize;j++){
        probe[0]=cohort.x[j];probe[2]=cohort.z[j];
        if(field.cellAt(probe)===targetCell){arrived++;transit(group*groupSize+j);}
      }
    }
    time+=dt;paint();
  }
  function stats(){return {goal,arrived,moved,time,sequence,solves,reachable,targetCell};}
  return {field,shapes,positions,colors,sizes,setGoal,step,reset,stats};
}
