import {chooseBest,combineConsiderations,curves} from '@margoengine/behavior';
import {SmartObject,SmartObjects} from '@margoengine/behavior/smart-objects';

export const choices=[
  {id:'water',label:'Draw water',need:'thirst',color:'#70b5bd'},
  {id:'food',label:'Eat at the bakehouse',need:'hunger',color:'#e7a375'},
  {id:'rest',label:'Rest under the arbor',need:'fatigue',color:'#c7af6f'},
  {id:'orchard',label:'Work the orchard',need:'work',color:'#a1ba83'},
];
export const stations=[
  {id:'spring',use:'water',name:'Spring well',x:2.6,z:.8,slots:[[.45,0],[-.45,0]],time:1.35,relief:.87},
  {id:'cistern',use:'water',name:'Orchard cistern',x:-3.2,z:-2.12,slots:[[0,.65]],time:1.2,relief:.75},
  {id:'bakehouse',use:'food',name:'Bakehouse',x:-4.2,z:1.83,slots:[[.45,.42],[-.36,.42]],time:2.1,relief:.81},
  {id:'arbor',use:'rest',name:'Shade arbor',x:4.51,z:-2.15,slots:[[.46,.82],[-.46,.82]],time:2.9,relief:.83},
  {id:'orchard',use:'orchard',name:'Orchard gate',x:.15,z:-3.14,slots:[[-.31,.23],[.35,.23]],time:2.3,relief:.72},
];
const roster=[
  {name:'Mara',color:'#f0ad73',at:[-.8,0,2.25],traits:{hunger:.70,thirst:.32,fatigue:.26,work:.58},pace:1.38},
  {name:'Ellis',color:'#6ac2c8',at:[3.28,0,2.53],traits:{hunger:.24,thirst:.53,fatigue:.28,work:.62},pace:1.46},
  {name:'Inez',color:'#d7c274',at:[1.2,0,-1.0],traits:{hunger:.29,thirst:.31,fatigue:.73,work:.49},pace:1.30},
];
const urgency=curves.logistic(10,.53);
const clamp=curves.linear();
const near=curves.inverse();
const avoid=curves.power(1.4);
const stationById=new Map(stations.map(s=>[s.id,s]));

const lane=[
  [-4.1,0,.65],[-2.15,0,.65],[0,0,.62],[2.2,0,.62],[4.2,0,.62],
  [-3.1,0,-1.29],[-1.82,0,-1.32],[0,0,-1.35],[2.2,0,-1.33],[4.2,0,-1.34],
  [-2,0,2.45],[0,0,2.42],[2.2,0,2.4],[4.2,0,2.2],
];
const edges=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[8,9],[4,9],[1,6],[2,7],[3,8],[0,10],[10,11],[11,12],[12,13],[3,12],[4,13]];
const squared=(a,b)=>(a[0]-b[0])**2+(a[2]-b[2])**2;
function nearest(p){return lane.reduce((best,point,i)=>squared(p,point)<squared(p,lane[best])?i:best,0);}
function seekPath(from,to){
  const first=nearest(from),last=nearest(to);
  const costs=lane.map(()=>Infinity),parent=lane.map(()=>-1),open=new Set(lane.map((_,i)=>i));
  costs[first]=0;
  while(open.size){
    let node=-1;
    for(const i of open)if(node<0||costs[i]<costs[node])node=i;
    if(node===last)break;
    open.delete(node);
    for(const [a,b] of edges){
      const other=a===node?b:b===node?a:-1;
      if(!open.has(other))continue;
      const cost=costs[node]+Math.sqrt(squared(lane[node],lane[other]));
      if(cost<costs[other]){costs[other]=cost;parent[other]=node;}
    }
  }
  const points=[to];
  for(let node=last;node!==-1;node=parent[node])points.unshift(lane[node]);
  if(squared(from,points[0])<.04)points.shift();
  return points;
}

export function makeVillage(){
  const world=new SmartObjects();
  const people=roster.map(profile=>({...profile,position:[...profile.at],needs:{...profile.traits},scores:{},
    action:'',destination:'',claim:null,route:[],workTime:0,done:0,revision:0,reason:'',phase:'Waiting'}));
  for(const s of stations){
    const need=choices.find(c=>c.id===s.use).need;
    world.add(new SmartObject({
      id:s.id,position:[s.x,0,s.z],
      uses:[{name:s.use,advertises:{[need]:s.relief},attenuation:.09,
        slots:s.slots.map(([x,z])=>({offset:[x,0,z]})),
        run(agent,_station,dt){agent.workTime+=dt;return agent.workTime>=s.time?'success':'running';}}],
    }));
  }
  let time=0,heat=false,pickTimer=0;
  function recalculate(person,allowRedirect=false){
    const current=person.claim?.object.id;
    const options=choices.map(({id,need})=>{
      const offer=world.offers(person,{use:id})[0];
      const held=person.action===id&&person.claim?.active;
      const distance=offer?.distance??(held?Math.sqrt(squared(person.position,person.claim.position())):0);
      const proximity=.62+.38*near(distance/9);
      const priority=id==='orchard'
        ? .36+.38*person.needs.work*avoid(1-Math.max(person.needs.thirst,person.needs.hunger,person.needs.fatigue))
        : urgency(person.needs[need]);
      const score=person.scores[id]=(offer||held)?combineConsiderations([priority,proximity]):0;
      return {value:{id,offer,score},score};
    });
    const winner=chooseBest(options,.025);
    if(!winner)return;
    if(person.claim?.active){
      const continuing=person.scores[person.action];
      if(winner.id===person.action||!allowRedirect||person.phase==='Using'||winner.score<continuing+.055)return;
    }
    if(!winner.offer||current===winner.offer.object.id)return;
    const claim=world.claim(winner.offer,person);
    if(!claim)return;
    person.claim?.release();
    person.claim=claim;
    person.action=winner.id;
    person.destination=claim.object.id;
    person.route=seekPath(person.position,claim.position());
    person.workTime=0;
    person.phase='Walking';
    person.revision++;
    person.reason=idToNeed(winner.id);
  }
  function idToNeed(id){return choices.find(choice=>choice.id===id).need;}
  function updateNeeds(person,delta){
    const [hunger,thirst,fatigue,work]=[.010,heat ? .024 : .011,.009,.018];
    person.needs.hunger=clamp(person.needs.hunger+delta*hunger);
    person.needs.thirst=clamp(person.needs.thirst+delta*thirst);
    person.needs.fatigue=clamp(person.needs.fatigue+delta*fatigue);
    person.needs.work=clamp(person.needs.work+delta*work);
  }
  function advance(dt){
    time+=dt;pickTimer+=dt;
    const think=pickTimer>=.26;
    if(think)pickTimer%=.26;
    for(const person of people){
      updateNeeds(person,dt);
      if(think||!person.claim)recalculate(person);
      if(!person.claim) continue;
      const next=person.route[0];
      if(next){
        const distance=Math.sqrt(squared(next,person.position));
        const travel=Math.min(distance,person.pace*dt);
        if(distance>0){
          person.position[0]+=(next[0]-person.position[0])*travel/distance;
          person.position[2]+=(next[2]-person.position[2])*travel/distance;
        }
        if(distance<=travel+.0001)person.route.shift();
      }else{
        person.phase='Using';
        if(person.claim.update(dt)!=='running'){
          person.done++;
          person.claim=null;
          person.phase='Waiting';
          recalculate(person);
        }
      }
    }
  }
  function setNeed(person,need,value){
    if(!Object.hasOwn(person.needs,need))return;
    person.needs[need]=clamp(value);
    recalculate(person,true);
  }
  function changeHeat(on){
    if(heat===on)return;
    heat=on;
    if(on)for(const person of people)person.needs.thirst=clamp(person.needs.thirst+.66);
    for(const person of people)recalculate(person,true);
  }
  function slots(id){
    const count=people.filter(p=>p.claim?.active&&p.claim.object.id===id).length;
    return [count,stationById.get(id).slots.length];
  }
  for(const person of people)recalculate(person);
  return {people,advance,setNeed,changeHeat,slots,get time(){return time;},get heat(){return heat;}};
}
