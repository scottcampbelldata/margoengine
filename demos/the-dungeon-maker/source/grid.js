export const width=13,depth=11,tile=4.4;
export const entrance=[2,2],sanctuary=[width-3,depth-3];
export const cardinal=[[1,0],[-1,0],[0,1],[0,-1]];
export const plot=(x,z)=>[(x-(width-1)*.5)*tile,(z-(depth-1)*.5)*tile];
export const floorId=id=>id>=1&&id<=5;
export function floorAt(solved,x,z){
  if(x<0||z<0||x>=width||z>=depth)return 0;
  return solved[x+2*width*z];
}
export function roofAt(solved,x,z){return solved[x+width*(1+z*2)];}
export function fingerprint(solved){
  let hash=0x811c9dc5;
  for(const id of solved)hash=Math.imul(hash^id,0x01000193);
  return (hash>>>0).toString(16).padStart(8,'0');
}
