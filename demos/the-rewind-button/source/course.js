export const ticks=168;
export const cadence=12;
export const interval=1/60;
export const crate=[.175,.139,.167];
export const drum=[.368,.277,0];
export const track={
  floor:{p:[0,-.15,0],half:[4.30,.15,2.18]},
  rear:{p:[0,.31,-2.14],half:[4.29,.31,.075]},
  front:{p:[0,.10,2.13],half:[4.29,.10,.06]},
  end:{p:[4.22,.32,0],half:[.082,.32,2.15]},
  start:{p:[-4.22,.16,0],half:[.082,.16,2.15]},
};
export function startPoses(){
  const poses=[{p:[-3.2,.373,.09],q:[Math.SQRT1_2,0,0,Math.SQRT1_2],ink:0}];
  for(let tier=0;tier<5;tier++)for(let depth=0;depth<3;depth++)for(let row=0;row<4;row++){
    if(tier===4&&(row===3||depth===2))continue;
    const salt=(tier*71+depth*43+row*31)%17-8;
    const twist=salt*.004;
    poses.push({
      p:[.63+row*.375+tier*.072+salt*.001,.143+tier*.283,(depth-1)*.365+salt*.0014],
      q:[0,Math.sin(twist),0,Math.cos(twist)],ink:(row+depth+2*tier+(salt+8)%3)%5,
    });
  }
  return poses;
}
