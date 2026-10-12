import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {cpus} from 'node:os';
import {Engine,TransformStore,box} from '../packages/core/dist/extension.js';
import {SurfacePhysics,AssemblyBVH} from '../packages/machinery/dist/index.js';
const count=500,e=new Engine({width:1,height:1,clientWidth:1,clientHeight:1},await TransformStore.create(count+2),{backend:'webgl2',add(){},remove(){},render(){},dispose(){}},undefined,null);
const summary=(values)=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length*0.5)],p95Ms:values[Math.floor(values.length*0.95)],maxMs:values.at(-1)};};
try{
 const motor=e.createMesh(),gate=e.createMesh(),nodes=Array.from({length:count},(_,i)=>e.createMesh().setGeometry(box()).setPosition([i,0,0]));
 const s=await SurfacePhysics.create(nodes.map((node,i)=>({node,carrier:i===count-1?1:0,lane:0,axis:[1,0,0],halfLength:0.49,friction:1})),[{node:motor,velocity:[1,0,0]},{node:gate}],{gravity:10});e.use(s);
 for(let i=0;i<1000;i++)s.onPreUpdate(1/60);
 const whole=[],solver=[],memory=s.data.buffer;for(let i=0;i<2000;i++){let start=performance.now();s.onPreUpdate(1/60);whole.push(performance.now()-start);start=performance.now();const error=s.memory.api.surface_tick(s.memory.ptr,count,1/60,10);solver.push(performance.now()-start);assert.equal(error,0);}
 assert.equal(s.data.buffer,memory);for(let i=1;i<count;i++)assert.ok(nodes[i].position.x-nodes[i-1].position.x>=0.98-0.0003);
 e.render({culling:false});const bvh=await AssemblyBVH.create(nodes),picking=[];for(let i=0;i<1000;i++){const target=i%count,start=performance.now(),hit=bvh.raycast([nodes[target].position.x,0,4],[0,0,-1]);picking.push(performance.now()-start);assert.equal(hit.node,nodes[target]);}
 const result={cpu:cpus()[0].model,node:process.version,count,solver:summary(solver),wholeSurfaceUpdate:summary(whole),raycast6000Triangles:summary(picking),solverTargetMs:0.040,solverTargetMet:summary(solver).p95Ms<0.040,stableMemory:true};await writeFile('test-results/modern-machinery-performance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));bvh.dispose();
}finally{e.dispose();}
