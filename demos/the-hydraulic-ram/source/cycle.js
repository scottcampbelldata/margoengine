export const gravity=9.80665;
export const density=998.2;
export const supplyHead=1.6;
export const atmosphericPressure=101325;
export const chamberVolume=.00230;
export const exponent=1.24;
export const compliance=7.5e-10;
export const minimumLift=2.6;
export const maximumLift=5.8;
const driveArea=Math.PI*.021**2;
const inertance=density*8/driveArea;
const incoming=density*gravity*supplyHead;
const resistance=1.14e10;
const wasteOpening=1.90e-5;
const checkOpening=5.05e-6;
const deliveryOpening=3.55e-6;
const trip=.000788;
const closeTime=.036;
const reopenTime=.055;
const reopenPressure=4900;
const holdTime=.090;
export const fixedStep=.00075;
const limit=64/fixedStep;

export function gasPressure(water) {
  return atmosphericPressure*((chamberVolume/(chamberVolume-water))**exponent-1);
}

function airWater(pressure) {
  return chamberVolume*(1-(atmosphericPressure/(atmosphericPressure+pressure))**(1/exponent));
}

function stateFlux(pressure,water,opening,head) {
  const air=gasPressure(water);
  return {
    air,
    waste:wasteOpening*opening*Math.sqrt(Math.max(0,pressure)),
    check:checkOpening*Math.sqrt(Math.max(0,pressure-air)),
    delivered:deliveryOpening*Math.sqrt(Math.max(0,air-head)),
  };
}

function valveShape(stage,time) {
  if(stage===0)return 1;
  if(stage===1)return Math.max(0,1-time/closeTime)**2;
  if(stage===2)return 0;
  return Math.min(1,time/reopenTime);
}

function integrate(lift,step=fixedStep) {
  const head=density*gravity*lift;
  let p=1700;
  let q=.0001;
  let water=airWater(head+875);
  let phase=0;
  let length=0;
  let full=0;
  let frames=[];
  let travel={drive:0,waste:0,check:0,delivered:0};
  let first=[p,water];
  let last;
  let found;
  const gradient=(drive,pressure)=>(incoming-pressure-resistance*drive*Math.abs(drive))/inertance;
  for(let tick=0;tick<limit*fixedStep/step;tick++){
    const a=stateFlux(p,water,valveShape(phase,length),head);
    const midpointP=p+(q-a.waste-a.check)/compliance*step*.5;
    const midpointQ=q+gradient(q,p)*step*.5;
    const midpointWater=water+(a.check-a.delivered)*step*.5;
    const b=stateFlux(midpointP,midpointWater,valveShape(phase,length+step*.5),head);
    p+=(midpointQ-b.waste-b.check)/compliance*step;
    q+=gradient(midpointQ,midpointP)*step;
    water+=(b.check-b.delivered)*step;
    length+=step;
    travel.drive+=midpointQ*step;travel.waste+=b.waste*step;
    travel.check+=b.check*step;travel.delivered+=b.delivered*step;
    const gate=valveShape(phase,length);
    frames.push({p,q,water,...stateFlux(p,water,gate,head),gate,phase});
    if(phase===0&&a.waste>=trip){phase=1;length=0;}
    else if(phase===1&&length>=closeTime){phase=2;length=0;}
    else if(phase===2&&length>=holdTime&&p<reopenPressure){phase=3;length=0;}
    else if(phase===3&&length>=reopenTime){
      phase=0;length=0;full++;
      const record={frames,travel,seconds:frames.length*step,first,last:[p,water]};
      if(full>3)found=record;
      const difference=last===undefined?Infinity:Math.abs(last-water);
      if(full>=9&&difference<.000000015)break;
      last=water;
      first=[p,water];
      frames=[];
      travel={drive:0,waste:0,check:0,delivered:0};
    }
  }
  if(!found||found.frames.length===0)throw new Error('No periodic ram cycle at '+lift+' m');
  return {
    ...found,lift,
    meanDelivery:60000*found.travel.delivered/found.seconds,
    meanWaste:60000*found.travel.waste/found.seconds,
    efficiency:density*gravity*lift*found.travel.delivered/(incoming*found.travel.drive),
  };
}

const cache=new Map();
export function solve(lift) {
  const head=Math.max(minimumLift,Math.min(maximumLift,lift));
  if(!cache.has(head))cache.set(head,integrate(head));
  return cache.get(head);
}
export function verifyAtStep(lift,step) {return integrate(lift,step);}
export const sample=(model,time)=>model.frames[Math.min(model.frames.length-1,
  Math.floor(((time%model.seconds+model.seconds)%model.seconds)/fixedStep))];