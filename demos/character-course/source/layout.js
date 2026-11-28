export const hz=60;
export const radius=.289;
export const capsuleHalf=.534;
export const ankleSpan=radius+capsuleHalf;
export const stepHeight=.18;
export const stairCount=6;
export const stairTop=stepHeight*stairCount;
export const stairDepth=.45;
export const stairEntrance=5.5;
export const stairExit=stairEntrance-stairDepth*stairCount;
export const pathWidth=3.22;
export const rampHigh=-8.46;
export const rampLow=-11.88;
export const rampAngle=Math.atan2(stairTop,rampHigh-rampLow);
export const ferryHome=-.55;
export const ferryAway=-5.20;
export const ferrySize=[3.15,.29,2.18];
export const ferryY=stairTop-ferrySize[1]/2;
export const start=[0,0,7.70];
export const finishZ=-13.23;

const levels=[
  {key:'court',x:0,start:stairEntrance,end:10.57,top:0},
  ...Array.from({length:stairCount},(_,i)=>({
    key:'tread',x:0,start:stairEntrance-(i+1)*stairDepth,end:stairEntrance-i*stairDepth,
    top:(i+1)*stepHeight,
  })),
  {key:'dock',x:0,start:.51,end:stairExit,top:stairTop},
  {key:'landing',x:0,start:rampHigh,end:-6.25,top:stairTop},
  {key:'finish',x:0,start:-15.98,end:rampLow,top:0},
];
export const walkways=levels.map(({key,x,start,end,top})=>{
  const depth=.40;
  return {key,size:[pathWidth,depth,end-start],position:[x,top-depth/2,(end+start)/2],top};
});
const rampThickness=.4;
export const ramp={
  key:'ramp',
  tilt:-rampAngle,
  size:[pathWidth,rampThickness,Math.hypot(stairTop,rampHigh-rampLow)],
  position:[0,stairTop/2-rampThickness/2*Math.cos(rampAngle),(rampLow+rampHigh)/2+rampThickness/2*Math.sin(rampAngle)],
};
export const floorHeight=z=>{
  if(z>=stairEntrance||z<=rampLow)return 0;
  if(z>=stairExit)return Math.min(stairCount,Math.ceil((stairEntrance-z)/stairDepth))*stepHeight;
  if(z<rampHigh)return Math.max(0,(z-rampLow)*Math.tan(rampAngle));
  return stairTop;
};
export function ease(x){
  const v=Math.max(0,Math.min(1,x));
  return v*v*(3-2*v);
}
