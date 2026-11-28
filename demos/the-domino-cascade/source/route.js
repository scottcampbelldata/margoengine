export const count = 2000;
export const tile = { width: .054, height: .108, thick: .0162 };
export const spiral = { x:-3.0, z:0, start:.64, end:3.85, turns:5.18 };
export const stair = { x:3.64, z:-2.79, run:.203, rise:.013, count:17, width:.61 };
export const bridge = { x:3.64, z0:stair.z+stair.run*stair.count, z1:3.39, width:.61 };
export const rise = stair.rise*stair.count;
export const terrace = { x0:4.08, x1:9.75, z0:-2.63, z1:4.77, height:rise };
export const zones = ['Spiral','Approach','Stair','Bridge','Final stretch'];

const tau = 2*Math.PI;
const half = Math.PI*.5;
const samples = [];

function add(x,z,zone){
  const before=samples.at(-1);
  const arc=before ? before.arc + Math.hypot(x-before.x,z-before.z) : 0;
  samples.push({x,z,arc,zone});
}
for(let i=0;i<=3900;i++){
  const t=i/3900;
  const angle=-half-tau*spiral.turns*(1-t);
  const radius=spiral.start+(spiral.end-spiral.start)*t;
  add(spiral.x+radius*Math.cos(angle),spiral.z+radius*Math.sin(angle),0);
}
const controls=[[-3.0,-3.85],[-1.73,-3.882],[1.12,-3.96],[2.80,-3.96]];
for(let i=1;i<=230;i++){
  const t=i/230, p=1-t;
  const weights=[p*p*p,3*p*p*t,3*p*t*t,t*t*t];
  const point=controls.reduce(([x,z],[a,b],k)=>[x+a*weights[k],z+b*weights[k]],[0,0]);
  add(...point,1);
}
function turn(angle,amount,radius,zone){
  const {x,z}=samples.at(-1);
  const n=Math.ceil(radius*Math.abs(amount)/.023);
  const orientation=Math.sign(amount);
  for(let i=1;i<=n;i++){
    const a=angle+amount*i/n;
    add(x+radius*orientation*(Math.sin(a)-Math.sin(angle)),
      z+radius*orientation*(Math.cos(angle)-Math.cos(a)),zone);
  }
}
function straight(x1,z1,zone){
  const {x,z}=samples.at(-1);
  const n=Math.ceil(Math.hypot(x1-x,z1-z)/.026);
  for(let i=1;i<=n;i++)add(x+(x1-x)*i/n,z+(z1-z)*i/n,zone);
}
turn(0,half,.84,1);
straight(stair.x,stair.z,1);
straight(stair.x,bridge.z0,2);
straight(stair.x,bridge.z1,3);
turn(half,-half,.86,3);
straight(8.64,4.25,4);
turn(0,-Math.PI,.82,4);
straight(4.97,2.61,4);
turn(-Math.PI,Math.PI,.76,4);
straight(8.64,1.09,4);
turn(0,-Math.PI,.82,4);
straight(4.88,-.55,4);

export const length = samples.at(-1).arc;
export const pitch = length/(count-1);

function horizontal(distance){
  const d=Math.max(0,Math.min(length,distance));
  let lo=0,hi=samples.length-1;
  while(hi-lo>1){
    const k=(hi+lo)>>1;
    if(samples[k].arc<=d)lo=k;
    else hi=k;
  }
  const a=samples[lo], b=samples[hi];
  const part=(d-a.arc)/(b.arc-a.arc);
  const x=a.x+(b.x-a.x)*part;
  const z=a.z+(b.z-a.z)*part;

  const yaw=Math.atan2(b.x-a.x,b.z-a.z);
  return {x,z,yaw,zone:b.zone};
}

const placements = Array.from({length:count},(_,index)=>horizontal(index*pitch));
export const risers = Array.from({length:stair.count},(_,i)=>{
  const nominal = stair.z+i*stair.run;
  const j = placements.findIndex(p=>p.zone===2 && p.z>=nominal);
  const before=placements[j-1], after=placements[j];
  return (before.z+after.z)*.5;
});
const apron = { x0:4.02, x1:terrace.x0, z0:3.62, z1:4.46 };
const deckEnd=4.38;

export function surface(x,z){
  if(x>=terrace.x0 && x<=terrace.x1 && z>=terrace.z0 && z<=terrace.z1)return rise;
  if(x>=apron.x0 && x<=apron.x1 && z>=apron.z0 && z<=apron.z1)return rise;
  if(Math.abs(x-stair.x)>.38 || z<risers[0] || z>=deckEnd)return 0;
  let height=0;
  for(const edge of risers){
    if(z<edge)break;
    height+=stair.rise;
  }
  return height;
}

export function sample(distance){
  const p=horizontal(distance);
  return {...p,y:surface(p.x,p.z)};
}

export const layout = placements.map(p=>({...p,y:surface(p.x,p.z)}));
export const mark = layout.findIndex(p=>p.zone===2);

// Actual contact boxes share the landing heights with their rendered deck.
export function platforms(){
  const boxes=[{center:[0,-.099,0],half:[11.5,.099,7.4],zone:0}];
  for(let i=0;i<stair.count;i++){
    const y=(i+1)*stair.rise;
    const z0=risers[i], z1=risers[i+1]??bridge.z0;
    boxes.push({center:[stair.x,y/2,(z0+z1)/2],half:[.38,y/2,(z1-z0)/2],zone:2});
  }
  const deckStart=bridge.z0;
  boxes.push({center:[bridge.x,rise-.036,(deckStart+deckEnd)/2],
    half:[.38,.036,(deckEnd-deckStart)/2],zone:3});
  boxes.push({center:[(terrace.x0+terrace.x1)/2,rise-.044,(terrace.z0+terrace.z1)/2],
    half:[(terrace.x1-terrace.x0)/2,.044,(terrace.z1-terrace.z0)/2],zone:4});
  boxes.push({center:[(apron.x0+apron.x1)/2,rise-.060,(apron.z0+apron.z1)/2],half:[(apron.x1-apron.x0)/2,.060,(apron.z1-apron.z0)/2],zone:3});
  return boxes;
}
