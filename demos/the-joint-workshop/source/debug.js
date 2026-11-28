import {PbrMaterial,box} from '@margoengine/core';
import {PhysicsDebugView} from '@margoengine/physics/debug-view';

export function jointOverlay(engine){
  const geometry=box(1,1,1),pool=[],palette=new Map();
  let view;
  function use(world){
    view?.dispose();
    view=new PhysicsDebugView(world,{world:{
      colliders:false,joints:true,jointFrames:true,
      style:{jointFrameLength:.105,jointLimit:[.98,.69,.27,1]}
    }});
  }
  function draw(show){
    let count=0;
    if(show&&view){
      const {vertices,colors}=view.collect();
      for(let i=0;i<vertices.length;i+=6){
        const p=vertices.subarray(i,i+3),q=vertices.subarray(i+3,i+6);
        const d=q.map((value,axis)=>value-p[axis]);
        const length=Math.hypot(...d);
        if(length<1e-7)continue;
        const rgb=Array.from(colors.subarray(i/6*8,i/6*8+3));
        const key=rgb.join(',');
        if(!palette.has(key))palette.set(key,new PbrMaterial({color:rgb,roughness:.48}));
        pool[count]??=engine.createMesh().setGeometry(geometry);
        const shape=pool[count++];
        const end=d.map(value=>value/length);
        const orientation=end[1]<-.99999?[1,0,0,0]:[end[2],0,-end[0],1+end[1]];
        shape.setMaterial(palette.get(key))
          .setPosition(Array.from(p,(value,axis)=>(value+q[axis])*.5+(axis===2?.13:0)))
          .setScale([.0095,length,.0095])
          .setQuaternion(orientation);
        shape.visible=true;
      }
    }
    for(let i=count;i<pool.length;i++)pool[i].visible=false;
    return count;
  }
  return {use,draw,dispose(){view?.dispose();}};
}
