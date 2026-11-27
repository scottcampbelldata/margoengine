export const bounds={width:194,depth:150,origin:[-97,-75]};
export const crossing=[-3,-7];
export const mainWest=[[-91,38],[-72,25],[-55,21],[-42,9],[-29,-3],[-20,-7],[-11,-7]];
export const mainEast=[[5,-7],[15,-7],[37,-9],[54,-30],[74,-40],[91,-36]];
export const defaultSpur=[[-3,-15],[-3,-23],[4,-37],[21,-44],[31,-59],[29,-69]];
export const clip=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));

export function naturalHeight(x,z){
  const hill=(a,b,sx,sz,h)=>h*Math.exp(-(((x-a)/sx)**2+((z-b)/sz)**2));
  const ravine=5.2*Math.exp(-(((z-19-8*Math.sin(x*.043))/10)**2));
  return 2.6+hill(-61,-30,37,28,24)+hill(57,41,51,34,22)+hill(56,-61,42,18,13)+
    hill(-49,60,41,36,10.5)-ravine+1.43*Math.sin(x*.087+z*.041)*Math.cos(z*.062);
}
export function grades(x,z){
  const gx=naturalHeight(x+.28,z)-naturalHeight(x-.28,z);
  const gz=naturalHeight(x,z+.28)-naturalHeight(x,z-.28);
  return Math.hypot(gx,gz)/.56;
}
export function salt(x,z){
  let y=Math.imul((x|0)+2389,0x297a2d39)^Math.imul((z|0)+13,0x1b873593);
  y=Math.imul(y^(y>>>16),0x7feb352d);
  return ((y^(y>>>16))>>>0)/4294967295;
}
export const earthPaint=['#b0a27c','#9c8e65','#a89d71','#85885d','#8e9864','#728258','#647953','#b7ac92','#93877f','#8e7762','#66594a'];
export const roadPaint=['#45464b','#aaaa9d','#e2d8b3','#e6bb60','#b49e7b','#4a7370','#e1c682'];
export function terrainColor(x,y,z){
  const mottled=(.53*Math.sin(x*.22+z*.13)+.29*Math.cos(z*.27-x*.12)+.21*Math.cos(z*.71-x*.61));
  const slope=grades(x,z);
  if(slope>.75&&y>8)return (y+mottled*3)%5>2.0?7:8;
  if(y<1.7)return mottled>.36?7:1;
  const lush=(y>12?1.0:.6)+.52*Math.sin(x*.092-z*.061)+.51*Math.cos(z*.108)+mottled*.2;
  if(lush>1.70)return 6;
  if(lush>1.30)return 5;
  if(lush>1.04)return 4;
  if(lush>.81)return 3;
  if(lush>.48)return 2;
  return mottled < -.25?1:0;
}
