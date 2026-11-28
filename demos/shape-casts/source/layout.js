export const span=7.64;
export const origin=[-3.82,1.07,-.02];
export const targets=[
  {id:'ramp-block',name:'Angled block',color:'copper',shape:'box',p:[-2.02,1.01,-.12],halfExtents:[.36,.36,.40],axis:'y',angle:.46},
  {id:'ceramic-capsule',name:'Ceramic capsule',color:'ceramic',shape:'capsule',p:[-.60,.96,.16],radius:.29,halfHeight:.32,axis:'z',angle:-.23},
  {id:'spindle',name:'Bronze spindle',color:'gold',shape:'cylinder',p:[.92,1.02,-.21],radius:.29,halfHeight:.42,axis:'z',angle:.30},
  {id:'survey-ball',name:'Datum sphere',color:'blue',shape:'sphere',p:[2.56,1.03,.07],radius:.385,axis:'y',angle:0}
];
export const probes={
  sphere:{label:'Sphere',shape:'sphere',radius:.204},
  box:{label:'Box',shape:'box',halfExtents:[.208,.236,.230]},
  capsule:{label:'Capsule',shape:'capsule',halfHeight:.188,radius:.157}
};
export function rotation(axis,angle){
  const seed=Math.sin(angle*.5);
  return [axis==='x'?seed:0,axis==='y'?seed:0,axis==='z'?seed:0,Math.cos(angle*.5)];
}
export function path(height,yaw){
  const angle=yaw*Math.PI/180;
  return {start:[origin[0],height,origin[2]],dir:[Math.cos(angle),0,Math.sin(angle)]};
}
