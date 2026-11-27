export const glassIndex=1.49;
export const focalDistance=.450;
export const minDistance=.300;
export const maxDistance=.650;
export const baseDepth=.0046;
export const centerRadius=.024;
export const ringWidth=.0176;
const ringCount=10;
export const lensRadius=centerRadius+ringWidth*ringCount;
export const targetPlane=.610;
const inverseSnell=(r,d)=>Math.asin(Math.sin(Math.atan2(r,d))/glassIndex);

function midpointRay(mid,depth){
  let low=0,high=mid;
  for(let i=0;i<32;i++){
    const radius=(low+high)/2;
    const hit=radius+depth*Math.tan(inverseSnell(radius,focalDistance));
    if(hit<mid)low=radius;
    else high=radius;
  }
  return (low+high)/2;
}
function designFacet(inner,outer){
  const half=(outer-inner)/2;
  const mid=inner+half;
  let low=0,high=1;
  for(let i=0;i<38;i++){
    const beta=(low+high)/2;
    const depth=baseDepth+half*Math.tan(beta);
    const inside=inverseSnell(midpointRay(mid,depth),focalDistance);
    const required=Math.atan2(glassIndex*Math.sin(inside),glassIndex*Math.cos(inside)-1);
    if(beta<required)low=beta;
    else high=beta;
  }
  const normal=(low+high)/2;
  const slope=-Math.tan(normal);
  return {
    inner,outer,normal,slope,innerDepth:baseDepth-(outer-inner)*slope,
    entry:midpointRay(mid,baseDepth-half*slope),
  };
}
export const facets=Array.from({length:ringCount},(_,i)=>{
  const inside=centerRadius+ringWidth*i;
  return designFacet(inside,inside+ringWidth);
});

export function traceFacet(distance,index){
  const facet=facets[index];
  const entry=facet.entry;
  const incident=Math.atan2(entry,distance);
  const inside=inverseSnell(entry,distance);
  const tangent=Math.tan(inside);
  // At this radius the ray intersects the conical optical face before either radial step.
  const depth=(facet.innerDepth+facet.slope*(entry-facet.inner))/(1-facet.slope*tangent);
  const exit=entry+depth*tangent;
  const exterior=facet.normal+Math.asin(glassIndex*Math.sin(inside-facet.normal));
  return {entry,incident,inside,depth,exit,exterior};
}

export function targetRadius(ray){
  return ray.exit+(targetPlane-ray.depth)*Math.tan(ray.exterior);
}

export function beamMeasure(distance){
  const edge=traceFacet(distance,facets.length-1);
  const spread=2*Math.abs(edge.exterior)*180/Math.PI;
  return {spread,state:spread<.035?'Parallel':edge.exterior>0?'Diverging':'Converging'};
}
