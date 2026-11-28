import { Vector2 } from '@margoengine/math/vector2';
import { cauchyFromAbbe, cauchyIndex, snell, tracePolygon } from '@margoengine/optics/refraction';
import { flintGlass, prismFootprint } from './glasshouse.js';

const v2=([x,z])=>new Vector2(x,z);
const along=(point,direction,distance)=>[point[0]+direction[0]*distance,point[1]+direction[1]*distance];
const turn=([x,z],r)=>[x*Math.cos(r)-z*Math.sin(r),x*Math.sin(r)+z*Math.cos(r)];

export const bands=[
  [435.8,'#9680ff'],[486.1,'#4f9aff'],[518,'#52dbc7'],[546.1,'#8cd848'],
  [577,'#edce60'],[613,'#f0a45c'],[656.3,'#e86a66'],
];
const dispersion=cauchyFromAbbe(flintGlass.index,flintGlass.abbe);
export function indexAt(wavelength,fixed=false) {
  return fixed?flintGlass.index:cauchyIndex(wavelength,dispersion);
}

const vertices=prismFootprint();
// Light enters the first face at the angle that puts it 30 degrees off the face normal inside the flint.
const [a,b]=vertices;
const face=v2(b).sub(v2(a));
const inward=new Vector2(-face.y,face.x).normalize();
const entry=v2(a).addScaledVector(face,.47).toArray();
const incoming=turn(inward.toArray(),-snell(flintGlass.index,1,Math.PI/6));
const source=along(entry,incoming,-.87);

function through(wavelength,fixed) {
  const ray=tracePolygon(vertices,source,incoming,indexAt(wavelength,fixed));
  if(!ray||ray.entryEdge!==0)throw new Error('The ray did not pass through the prism.');
  return ray;
}

const chief=through(587.6,true);
const center=along(chief.exit,chief.direction,1.43);
const receiverDirection=turn(chief.direction,Math.PI/2);

export function rayStudy(fixed=false) {
  const rays=(fixed?[[587.6,'#fae8b4']]:bands).map(([wavelength,color])=>{
    const {exit,direction}=through(wavelength,fixed);
    const distance=v2(center).sub(v2(exit)).dot(v2(chief.direction))/v2(direction).dot(v2(chief.direction));
    const hit=along(exit,direction,distance);
    return {wavelength,color,exit,hit,across:v2(hit).sub(v2(center)).dot(v2(receiverDirection)),direction};
  });
  const width=Math.abs(rays[0].across-rays.at(-1).across);
  return {vertices,source,entry,rays,width,center,receiverDirection};
}
