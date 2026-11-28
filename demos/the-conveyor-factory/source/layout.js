export const fixedDelta=1/120;
export const lanes=[-.83,0,.83];
export const belt={start:-2.48,end:1.48,top:1.62,width:.63,depth:.12};
export const chute={start:[1.44,1.62],end:[2.34,.67],width:.63,depth:.095};
export const bin={center:2.63,width:1.13,depth:.71,base:.13,wall:.072,height:.48};
export const speed=[.86,1.35,1.92];
export const approvedLimit=48;

export const chuteAngle=Math.atan2(chute.end[1]-chute.start[1],chute.end[0]-chute.start[0]);
export const chuteLength=Math.hypot(chute.end[1]-chute.start[1],chute.end[0]-chute.start[0]);
export const chuteCenter=[
  (chute.start[0]+chute.end[0])*.5+Math.sin(chuteAngle)*chute.depth*.5,
  (chute.start[1]+chute.end[1])*.5-Math.cos(chuteAngle)*chute.depth*.5
];

export function objectsForLane(z){
  const side=bin.depth*.5,front=bin.center+bin.width*.5-bin.wall*.5;
  return [
    {p:[(belt.start+belt.end)*.5,belt.top-belt.depth*.5,z],s:[belt.end-belt.start,belt.depth,belt.width],kind:'belt'},
    {p:[chuteCenter[0],chuteCenter[1],z],s:[chuteLength,chute.depth,chute.width],roll:chuteAngle,kind:'chute'},
    {p:[bin.center,bin.base*.5,z],s:[bin.width,bin.base,bin.depth],kind:'floor'},
    {p:[front,bin.base+bin.height*.5,z],s:[bin.wall,bin.height,bin.depth],kind:'front'},
    ...[-1,1].flatMap(sign=>[
      {p:[(belt.start+belt.end)*.5,belt.top+.105,z+sign*(belt.width*.5+.024)],s:[belt.end-belt.start,.235,.054],kind:'rail'},
      {p:[chuteCenter[0],chuteCenter[1]+.085,z+sign*(chute.width*.5+.022)],s:[chuteLength,.195,.055],roll:chuteAngle,kind:'rail'},
      {p:[bin.center,bin.base+bin.height*.5,z+sign*(side-bin.wall*.5)],s:[bin.width,bin.height,bin.wall],kind:'side'}
    ])
  ];
}
