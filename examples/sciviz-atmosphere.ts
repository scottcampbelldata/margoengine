import {Figure} from '@margoengine/sciviz/spec';
import {globeAtmosphere} from '@margoengine/sciviz/atmosphere';
import type {FlowGrid} from '@margoengine/sciviz/flow';
import type {TriangleSet} from '@margoengine/sciviz/grids';
import {element,floats,fail,exportButton} from './sciviz-demo.js';
const lifetime=new AbortController(),signal=lifetime.signal;

export const figure=await Figure.create(element<HTMLCanvasElement>('viewport'),{axes:false,aspect:[1,1,1],limits:[-1.12,1.12,-1.12,1.12,-1.12,1.12]});
if(figure.controls)figure.controls.minDistance=1.02;
export const globe=await globeAtmosphere(figure,{date:new Date('2024-01-01T12:00:00Z'),signal});
const nx=49,ny=19,size=nx*ny,day=86400;
try{
 const data=await floats(new URL('./assets/sciviz/wind.bin',import.meta.url));
 const frames=Array.from({length:8},(_,d)=>({time:d*day,u:data.slice(d*2*size,(d*2+1)*size),v:data.slice((d*2+1)*size,(d*2+2)*size)}));
 const grid:FlowGrid={dims:[nx,ny,1],bounds:[-100,20,20,65,20000,20000],frames};
 exportButton(figure,'noaa-atmospheric-globe');
 const particles=await globe.flow(grid,{count:2048,trails:32,width:2,lifetime:2*day,color:'#d5f7ff',seeding:{kind:'random',seed:171}});
 await particles.advance(day/4,{step:600,signal});
 const pos:number[]=[],values:number[]=[],normal:number[]=[];
 for(let y=0;y<ny-1;y++)for(let x=0;x<nx-1;x++){
  for(const [dx,dy]of [[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]]){
   const i=(y+dy)*nx+x+dx;pos.push(-100+(x+dx)*2.5,20+(y+dy)*2.5,1000);values.push(Math.hypot(frames[0].u[i],frames[0].v[i]));normal.push(0,0,1);
  }
 }
 const set:TriangleSet={positions:Float32Array.from(pos),normals:Float32Array.from(normal),values:Float32Array.from(values),cells:new Uint32Array(pos.length/9),bounds:[-100,20,20,65,1000,1000]};
 const scalar=globe.mesh(set,{opacity:0.65,range:[0,35]});
 const points=globe.points([-70,40,100000,-40,50,100000,-10,30,100000],[1,2,3],{radius:80000,range:[0,4]});
 let busy=false;
 element('next').addEventListener('click',()=>{if(busy)return;busy=true;void particles.advance(Math.min(7*day,particles.time+day/4),{step:600,signal}).then(()=>{element('status').textContent=`Wind data time ${new Date(Date.UTC(2024,0,1)+particles.time*1000).toISOString()}`;}).catch(fail).finally(()=>{busy=false;});});
 element<HTMLInputElement>('time').addEventListener('change',event=>{const value=(event.target as HTMLInputElement).value,date=new Date(value+'Z');if(!value||Number.isNaN(date.getTime())){element('status').textContent='Pick a UTC date and time to place the Sun; the globe keeps the last valid time.';return;}globe.setDate(date);});
 element<HTMLInputElement>('scalar').addEventListener('change',event=>{scalar.visible=(event.target as HTMLInputElement).checked;});
 element<HTMLInputElement>('points').addEventListener('change',event=>{points.visible=(event.target as HTMLInputElement).checked;});
 await figure.ready();
 Object.assign(globalThis,{atmosphereDemo:{particles,scalar,points}});
 element('status').textContent='NOAA North Atlantic wind, January 1-8 2024. Drag to orbit, scroll to zoom.';
 element('viewport').dataset.ready='true';
}catch(error){fail(error);}
window.addEventListener('pagehide',()=>{lifetime.abort();figure.dispose();},{once:true});
