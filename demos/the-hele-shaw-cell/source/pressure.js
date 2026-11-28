// The Hele-Shaw bench's dimensions. The gap-averaged pressure field, the face flows and the dye streamlines come from
// @margoengine/physics/groundwater (`solveConfinedFlow` with the cell's transmissivity b³/12μ, `traceStreamlines`).
import { heleShawTransmissivity, solveConfinedFlow, streamlinePoint, traceStreamlines } from '@margoengine/physics/groundwater';

export const length=.42;
export const width=.24;
export const gap=.001;
export const viscosity=.080;
export const pressureDrop=420;
export const centerX=.010;
export const minDiameter=48;
export const maxDiameter=158;
export const baseline=gap**2/(12*viscosity)*pressureDrop/length;
export const unobstructed=baseline*width*gap;

const columns=84,rows=48,cellSize=length/columns;
const transmissivity=heleShawTransmissivity(gap,viscosity);
const seeds=Array.from({length:18},(_,k)=>.035+.93*k/17);

export function solve(input){
  const diameter=Math.max(minDiameter,Math.min(maxDiameter,input));
  const radius=diameter*.0005;
  const active=new Uint8Array(columns*rows);
  for(let row=0;row<rows;row++)for(let col=0;col<columns;col++){
    const x=(col+.5)*cellSize-length/2,z=(row+.5)*cellSize-width/2;
    active[col+row*columns]=+(Math.hypot(x-centerX,z)>=radius);
  }
  const cell=solveConfinedFlow({
    columns,rows,cellSize,active,transmissivity,thickness:gap,
    sides:{minX:pressureDrop,maxX:0},origin:[-length/2,-width/2],
  });
  const lanes=traceStreamlines(cell,{seeds,minSpeed:baseline*.04});
  // The drawn dye keeps clear of the smooth drawn disk, which the grid follows only to a cell.
  for(const lane of lanes)for(let i=0;i<lane.x.length;i++){
    if(Math.abs(lane.x[i]-centerX)>=radius+.001)continue;
    const clearance=Math.sqrt((radius+.001)**2-(lane.x[i]-centerX)**2);
    if(Math.abs(lane.z[i])<clearance)lane.z[i]=Math.sign(lane.z[i])*clearance;
  }
  return {diameter,radius,inletFlow:cell.inflow,outletFlow:cell.outflow,iteration:cell.iterations,
    maxSpeed:cell.maxSpeed,maxResidual:cell.maxResidual,lanes};
}

export const sample=(lane,t)=>streamlinePoint(lane,t);
