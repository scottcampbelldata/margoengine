import {planActions} from '@margoengine/behavior/goap';
import {planTasks} from '@margoengine/behavior/htn';

export const target={meal:true,rested:true};
export const initial=()=>({rain:false,fuel:false,fire:false,meal:false,rested:false,fuelSource:'none'});
export const steps=[
  {name:'chop',label:'Split firewood',station:'stump',cost:2,seconds:2.25,
    preconditions:{rain:false,fuel:false,fire:false},effects:{fuel:true,fuelSource:'wood'}},
  {name:'kindling',label:'Fetch covered kindling',station:'rack',cost:3.6,seconds:1.25,
    preconditions:{fuel:false,fire:false},effects:{fuel:true,fuelSource:'shelf'}},
  {name:'light',label:'Light the stove',station:'stove',cost:1.1,seconds:1.35,
    preconditions:{fuel:true,fire:false},effects:{fire:true,fuel:false}},
  {name:'cook',label:'Cook supper',station:'stove',cost:1.5,seconds:2.45,
    preconditions:{fire:true,meal:false},effects:{meal:true}},
  {name:'rest',label:'Rest on the cot',station:'cot',cost:1.2,seconds:1.30,
    preconditions:{meal:true,rested:false},effects:{rested:true}},
];
export const byName=new Map(steps.map(action=>[action.name,action]));
const tasks=[
  {name:'Evening',methods:[{subtasks:['Supper','Recovery']}]},
  {name:'Supper',methods:[{when:{meal:true},subtasks:[]},{subtasks:['Stove','cook']}]},
  {name:'Stove',methods:[{when:{fire:true},subtasks:[]},{subtasks:['Fuel','light']}]},
  {name:'Fuel',methods:[{when:{fuel:true},subtasks:[]},{subtasks:['kindling']},{subtasks:['chop']}]},
  {name:'Recovery',methods:[{when:{rested:true},subtasks:[]},{subtasks:['rest']}]},
  ...steps.map(({name,preconditions,effects})=>({name,preconditions,effects})),
];
export const holds=(state,terms)=>Object.entries(terms).every(([key,value])=>state[key]===value);
export function plan(state,mode){
  const answer=mode==='cheap'?planActions(state,target,steps,{maxNodes:96}):planTasks(tasks,'Evening',state);
  if(!answer)throw new Error('The lookout domain did not find a safe evening plan.');
  const concrete=(answer.actions??answer.tasks).map(action=>byName.get(action.name));
  const cost=concrete.reduce((sum,action)=>sum+action.cost,0);
  return {concrete,cost};
}
export function apply(state,action){
  if(!holds(state,action.preconditions))return false;
  Object.assign(state,action.effects);
  return true;
}
