import { flintGlass, prismFootprint } from './glasshouse.js';

const fLine=.4861,dLine=.5876,cLine=.6563;
const invSquare=value=>1/(value*value);
const add=([x,z],[u,v])=>[x+u,z+v];
const sub=([x,z],[u,v])=>[x-u,z-v];
const scale=([x,z],n)=>[x*n,z*n];
const dot=([x,z],[u,v])=>x*u+z*v;
const cross=([x,z],[u,v])=>x*v-z*u;
const unit=vector=>scale(vector,1/Math.hypot(...vector));
const turn=([x,z],r)=>[x*Math.cos(r)-z*Math.sin(r),x*Math.sin(r)+z*Math.cos(r)];

export const bands=[
  [435.8,'#9680ff'],[486.1,'#4f9aff'],[518,'#52dbc7'],[546.1,'#8cd848'],
  [577,'#edce60'],[613,'#f0a45c'],[656.3,'#e86a66'],
];
export function indexAt(wavelength,fixed=false) {
  const {index,abbe}=flintGlass;
  if(fixed)return index;
  const cauchy=(index-1)/(abbe*(invSquare(fLine)-invSquare(cLine)));
  return index+cauchy*(invSquare(wavelength/1000)-invSquare(dLine));
}

function refract(direction,normal,ratio) {
  const c=-dot(direction,normal), d=1-ratio*ratio*(1-c*c);
  if(d<0)return undefined;
  return unit(add(scale(direction,ratio),scale(normal,ratio*c-Math.sqrt(d))));
}

const vertices=prismFootprint();
const edges=vertices.map((a,i)=>{
  const vector=sub(vertices[(i+1)%vertices.length],a);
  return {a,vector,normal:unit([vector[1],-vector[0]])};
});
const entry=add(edges[0].a,scale(edges[0].vector,.47));
const angle=Math.asin(flintGlass.index*Math.sin(Math.PI/6));
const incoming=turn(scale(edges[0].normal,-1),-angle);
const source=sub(entry,scale(incoming,.87));

function through(wavelength,fixed) {
  const index=indexAt(wavelength,fixed);
  const interior=refract(incoming,edges[0].normal,1/index);
  if(!interior)throw new Error('The ray missed the entrance face.');
  const hits=edges.slice(1).flatMap(({a,vector,normal})=>{
    const denominator=cross(interior,vector);
    const offset=sub(a,entry);
    const distance=cross(offset,vector)/denominator, across=cross(offset,interior)/denominator;
    return distance>1e-6&&across>=0&&across<=1?[{distance,normal}]:[];
  });
  const hit=hits.sort((a,b)=>a.distance-b.distance)[0];
  if(!hit)throw new Error('The ray missed the exit face.');
  const exit=add(entry,scale(interior,hit.distance));
  const direction=refract(interior,scale(hit.normal,-1),index);
  if(!direction)throw new Error('The ray was internally reflected.');
  return {exit,direction};
}

const chief=through(587.6,true);
const center=add(chief.exit,scale(chief.direction,1.43));
const receiverDirection=turn(chief.direction,Math.PI/2);

export function rayStudy(fixed=false) {
  const rays=(fixed?[[587.6,'#fae8b4']]:bands).map(([wavelength,color])=>{
    const {exit,direction}=through(wavelength,fixed);
    const distance=dot(sub(center,exit),chief.direction)/dot(direction,chief.direction);
    const hit=add(exit,scale(direction,distance));
    return {wavelength,color,exit,hit,across:dot(sub(hit,center),receiverDirection),direction};
  });
  const width=Math.abs(rays[0].across-rays.at(-1).across);
  return {vertices,source,entry,rays,width,center,receiverDirection};
}
