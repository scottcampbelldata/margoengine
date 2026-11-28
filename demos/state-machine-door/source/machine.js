import {StateMachine} from '@margoengine/fsm';
import {ParallelRegions} from '@margoengine/fsm/parallel';
import {MachineTrace,snapshotMachine} from '@margoengine/fsm/trace';

export const driveNames={
  sealed:'Sealed',withdraw:'Retract bolts',swingOut:'Swing open',
  open:'Open',swingIn:'Swing closed',extend:'Extend bolts',
};
export const lampNames={dark:'Off',lit:'On'};
const maxAngle=105;
const stroke=(from,to,seconds)=>({from,to,seconds});
const movements={
  withdraw:{bolt:stroke(1,0,.61)},
  swingOut:{angle:stroke(0,maxAngle,1.73)},
  swingIn:{angle:stroke(maxAngle,0,1.73)},
  extend:{bolt:stroke(0,1,.62)},
};

export function createDoor(){
  const pose={bolt:1,angle:0,light:false};
  let regions;
  function move(name){
    const [key,travel]=Object.entries(movements[name])[0];
    let elapsed=0;
    return {
      parent:'cycle',
      update(_context,dt){
        elapsed=Math.min(travel.seconds,elapsed+dt);
        const t=elapsed/travel.seconds;
        const ease=t*t*(3-2*t);
        pose[key]=travel.from+(travel.to-travel.from)*ease;
        if(t===1){elapsed=0;regions.raise('strokeComplete');}
      },
    };
  }
  regions=new ParallelRegions({
    drive:{
      initial:'cycle',
      states:{
        cycle:{initial:'sealed',history:'deep'},
        sealed:{parent:'cycle'},withdraw:move('withdraw'),swingOut:move('swingOut'),
        open:{parent:'cycle'},swingIn:move('swingIn'),extend:move('extend'),
      },
      transitions:[
        {from:'sealed',to:'withdraw',event:'open'},
        {from:'withdraw',to:'swingOut',event:'strokeComplete',guard:()=>pose.bolt===0},
        {from:'swingOut',to:'open',event:'strokeComplete',guard:()=>pose.angle===maxAngle},
        {from:'open',to:'swingIn',event:'close',guard:()=>pose.bolt===0},
        {from:'swingIn',to:'extend',event:'strokeComplete',guard:()=>pose.angle===0},
        {from:'extend',to:'sealed',event:'strokeComplete',guard:()=>pose.bolt===1},
      ],
    },
    lamp:{
      initial:'dark',
      states:{dark:{enter:()=>{pose.light=false;}},lit:{enter:()=>{pose.light=true;}}},
      transitions:[{from:'dark',to:'lit',event:'light'},{from:'lit',to:'dark',event:'light'}],
    },
  },pose,{history:true});
  const machine=new StateMachine({
    service:{initial:'mechanism',history:'deep'},
    mechanism:{parent:'service',initial:'operating'},
    operating:{...regions.asState(),parent:'mechanism'},
    hold:{},
  },'service',pose,[
    {from:'service',to:'hold',event:'hold'},
    {from:'hold',to:'service',event:'resume'},
  ]);
  const trace=new MachineTrace(machine,{capacity:28});
  return {machine,regions,trace,pose,snapshot:()=>snapshotMachine(machine)};
}
