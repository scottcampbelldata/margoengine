import {Physics} from '@margoengine/physics';
import {span,targets,probes,rotation,path} from './layout.js';

export const loadPhysics=signal=>Physics.load({signal});
export function queryBench(){
  const physics=new Physics(null,{gravity:[0,0,0]});
  const names=new Map();
  for(const item of targets){
    const {shape,halfExtents,radius,halfHeight}=item;
    const body=physics.addBody(null,{
      type:'fixed',position:item.p,rotation:rotation(item.axis,item.angle),
      colliders:{shape,halfExtents,radius,halfHeight}
    });
    names.set(body,item);
  }
  physics.step();
  function cast(kind,height,yaw){
    const query=probes[kind];
    if(!query)throw Error('Unknown probe shape.');
    const {start,dir}=path(height,yaw);
    const orientation=kind==='box'?rotation('y',.38):rotation('y',0);
    const ignored=new Set(),hits=[];
    for(let i=0;i<targets.length;i++){
      const raw=physics.shapeCast(query,start,orientation,dir,{
        maxDistance:span,predicate:(_,col)=>!ignored.has(col)
      });
      if(!raw)break;
      ignored.add(raw.collider);
      const hit=names.get(raw.body);
      hits.push({
        id:hit.id,name:hit.name,color:hit.color,distance:raw.distance,
        point:raw.point,normal:raw.normal,probePoint:raw.queryPoint,
        at:start.map((coordinate,index)=>coordinate+dir[index]*raw.distance)
      });
    }
    return {hits,start,dir};
  }
  return {cast,dispose(){physics.dispose();}};
}
