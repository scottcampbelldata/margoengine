import {createCompute} from '@margoengine/compute';
import {Figure} from '@margoengine/sciviz';
import {GPUGraphLayout,gpuGraphLayer} from '@margoengine/sciviz/graph-gpu';
import {GpuPicking} from '@margoengine/sciviz/pick-gpu';
import {openingPasses,openingPositions} from './opening.mjs';
import {adjacency,bounds,graph,hubs,layoutOptions,ports,routes} from './network.mjs';
import {background,graphStyle,margin,pickRadius,resizeCanvas,screenPoint} from './presentation.mjs';

export async function completeView(engine,canvas,renderer,signal){
  resizeCanvas(canvas);
  engine.scene.background=background;
  let compute,figure,layout,drawing,picker,pointLayer,routeGraph;
  let positions=openingPositions,active=-1;
  function dispose(){
    picker?.dispose();
    figure?.dispose();
    layout?.dispose();
    routeGraph?.dispose();
    compute?.dispose();
    engine.dispose();
  }

  try {
    const computeReady=createCompute({engine,fastMath:true,signal});
    figure=Figure.attach(engine,{mode:'2d',axes:false,legend:false,tooltips:false,limits:bounds,margin});
    const pins=figure.scatter({positions},{size:1.7,color:'#faf2d4'});
    [compute,pointLayer]=await Promise.all([computeReady,pins]);
    signal.throwIfAborted();
    layout=new GPUGraphLayout(compute,graph,{
      ...layoutOptions,positions,temperature:layoutOptions.temperature*layoutOptions.cooling**openingPasses,
    });
    performance.mark('graph-layout-ready');
    function display(selected){
      const next=gpuGraphLayer(figure,layout,graphStyle(selected));
      drawing=drawing?figure.replace(drawing,next):next;
      active=selected;
    }
    display(-1);
    await figure.ready();
    picker=new GpuPicking(figure);
    figure.render();
    await compute.device.queue.onSubmittedWorkDone();
    performance.mark('graph-frame');
    const area=()=>figure.plotArea;
    const position=id=>screenPoint(positions,id,area(),figure.bounds);
    const [x,y]=position(hubs[0]);
    const sample=await picker.pick(x,y,{radius:4.5,signal,timeout:5000});
    if(sample?.layer!==pointLayer||sample.index!==hubs[0])throw new Error('The projected harbour could not be picked.');
    performance.mark('picking-ready');

    return {
      canvas,area,position,renderer,full:true,pickMode:'gpu',
      async update(id) {
        if(id!==active)display(id);
        figure.render();
        await compute.device.queue.onSubmittedWorkDone();
      },
      async pick(x,y){
        const hit=await picker.pick(x,y,{radius:pickRadius,signal,timeout:3500});
        return hit?.layer===pointLayer?hit.index:-1;
      },
      resize(){if(resizeCanvas(canvas))figure.render();},
      onDraw(callback){engine.onFrame(callback);},
      work(){
        const {iterations,dispatches}=layout.work;
        return {iterations:openingPasses+iterations,dispatches};
      },
      async advance(){
        layout.step(8);
        positions=await layout.read({signal});
        pointLayer.cloud.updatePositions(0,positions);
        figure.render();
        await compute.device.queue.onSubmittedWorkDone();
      },
      async transfers(id,requestSignal){
        const {graph:upload,bfs}=await import('@margoengine/compute/graph');
        requestSignal.throwIfAborted();
        if(!routeGraph)routeGraph=upload(compute,{
          vertices:ports.length,directed:false,sources:routes.map(r=>r.start),targets:routes.map(r=>r.end),
        });
        const result=await bfs(routeGraph,id,{signal:requestSignal,checkEvery:2});
        try {
          const distances=await result.distances.read({signal:requestSignal});
          if(distances.some((hops,port)=>(hops===1)!==adjacency[id].includes(port)))
            throw new Error('Ferry graph neighbourhood differs from its sailing records.');
          return distances.reduce((count,hops)=>count+Number(hops===2),0);
        }finally{
          result.distances.dispose();
          result.predecessors.dispose();
        }
      },
      dispose,
    };
  }catch(reason){
    dispose();
    throw reason;
  }
}
