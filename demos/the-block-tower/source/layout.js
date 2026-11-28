export const baseHeight=.04;
export const levels=8;
export const beamSize=[.207,.066,.036];
export const deckSize=[.228,.015,.228];
export const plinthSize=[.815,.585];
export const floorHeight=-.079;
export const rise=beamSize[1]+deckSize[1];
export const fixedDelta=1/60;
export const travel=.285;

export function towerLayout(){
  const entities=[];
  function add(id,course,slot,center,size,yaw){
    const rotation=[0,Math.sin(yaw/2),0,Math.cos(yaw/2)];
    const axis=[Math.cos(yaw),0,-Math.sin(yaw)];
    entities.push({id,course,slot,axis,center,size,rotation,removed:false});
  }
  for(let course=0;course<levels;course++){
    const yaw=-.45+course*Math.PI/10;
    const y=baseHeight+course*rise+beamSize[1]/2;
    const across=[Math.sin(yaw),0,Math.cos(yaw)];
    for(const slot of [-1,0,1]){
      const center=[across[0]*slot*.068,y,across[2]*slot*.068];
      add((course+1)+'-'+(slot+2),course,slot,center,beamSize,yaw);
    }
    add((course+1)+'-deck',course,null,[0,y+(beamSize[1]+deckSize[1])/2,0],deckSize,yaw+.12);
  }
  return entities;
}
