export const limits={left:-1.24,right:1.24,back:-.80,front:.80};
export const cell=.020;
export const tileCells=16;
export const radius=.040;
export const origin=[limits.left,0,limits.back];
export const start=[-1.080,0,.530];
export const goal=[1.080,0,-.527];

export const fixed=[
  {x:-.325,z:-.661,width:.111,depth:.280},
  {x:-.325,z:.662,width:.111,depth:.277},
  {x:.395,z:-.661,width:.111,depth:.280},
  {x:.395,z:.662,width:.111,depth:.277},
  {x:-.972,z:.045,width:.534,depth:.091},
  {x:.988,z:-.075,width:.502,depth:.102},
  {x:.009,z:.006,width:.129,depth:.111},
];
export const gates=[
  {name:'copper',x:-.325,width:.111,depth:.644,stops:[-.196,.196],initial:1},
  {name:'jade',x:.395,width:.111,depth:.644,stops:[-.196,.196],initial:0},
];
export function obstacle({x,z,width,depth}){
  return {min:[x-width*.5,0,z-depth*.5],max:[x+width*.5,.145,z+depth*.5]};
}
export const floor=[
  limits.left,0,limits.back,limits.right,0,limits.back,
  limits.right,0,limits.front,limits.left,0,limits.front,
];
export const triangles=[0,2,1,0,3,2];
