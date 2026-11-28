export const maskSize=76;
export const renderTile=88;
export const outlineOptions={threshold:128,tolerance:.63,minArea:4};
export const boardSize=[512,420];
export const dropScale=1.14;
export const maxCutouts=10;

export const layouts={
  wide:{width:1120,height:490,plate:[17,17,449,454],chamber:[492,17,611,454],drawing:[110,103,263,263]},
  phone:{width:480,height:676,plate:[12,9,456,318],chamber:[12,341,456,324],drawing:[124,65,232,232]},
};
export function placement(phone){
  const design=phone?layouts.phone:layouts.wide;
  const [x,y,w,h]=design.chamber;
  const scale=Math.min(w/boardSize[0],h/boardSize[1]);
  return {...design,workplace:[x+(w-boardSize[0]*scale)*.5,y+(h-boardSize[1]*scale)*.5],scale};
}
export const balks=[
  {name:'leftwall',x:44,y:214,w:16,h:292,rotation:0},
  {name:'rightwall',x:468,y:214,w:16,h:292,rotation:0},
  {name:'anvil',x:256,y:375,w:440,h:22,rotation:0},
  {name:'upper ramp',x:164,y:212,w:193,h:18,rotation:.48},
  {name:'lower ramp',x:344,y:307,w:186,h:17,rotation:-.26},
];
export const guides=[
  {name:'upper wheel',x:304,y:192,radius:18},
  {name:'lower wheel',x:165,y:309,radius:15},
];
export const release=[227,81];
