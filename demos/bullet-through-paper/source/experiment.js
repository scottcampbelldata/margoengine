export const divider=[.00976,.48,.50];
export const testBlock=[.06014,.120,.165];
export const start=[-3.388,.44,.22564];
export const laneGap=.83;
export const sampleLimit=3;
const presetOrientation=[0,Math.sin(1.8054),0,Math.cos(1.8054)];

export function openingPose(){
  return {position:[...start],rotation:[...presetOrientation],sweep:false,contacts:0};
}
export function makeExperiment(KernelWorld){
  const world=new KernelWorld(8,8).setGravity(0,0,0);
  world.substeps=1;
  world.setSolver({adaptiveSubsteps:false});
  const dividerId=world.addBody('fixed');
  world.setPose(dividerId,[0,.44,0],[0,0,0,1]);
  world.addCollider(dividerId,'box',divider,{restitution:.40});
  const block=world.addBody('dynamic');
  world.setPose(block,start,presetOrientation);
  world.addCollider(block,'box',testBlock,{restitution:.40});
  const c=world.columns;
  c.linearX[block]=19.618;
  c.angularY[block]=13.838;
  c.angularZ[block]=4.6655;
  const baseline=world.snapshot();
  function capture(){
    const c=world.columns;
    return {
      position:[c.positionX[block],c.positionY[block],c.positionZ[block]],
      rotation:[c.rotationX[block],c.rotationY[block],c.rotationZ[block],c.rotationW[block]],
      sweep:world.isCcdActive(block),contacts:world.contacts().length,
    };
  }
  function trace(ccd){
    world.restore(baseline);
    world.setCcd(block,ccd);
    const samples=[capture()];
    for(let i=0;i<sampleLimit;i++){
      world.step(.16633);
      samples.push(capture());
    }
    return samples;
  }
  return ()=>({discrete:trace(false),continuous:trace(true)});
}
