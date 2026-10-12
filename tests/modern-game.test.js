import test from 'node:test';
import assert from 'node:assert/strict';
import {Camera,Engine,TransformStore} from '../packages/core/dist/extension.js';
import {GLTFAsset,PBRModel} from '../packages/gltf-pro/dist/index.js';
import {Animation} from '../packages/animation/dist/index.js';
import {Shadows,cascadeSplits,fitCascades} from '../packages/shadows/dist/index.js';
import {Clustered} from '../packages/clustered/dist/index.js';
import {VFX} from '../packages/vfx/dist/index.js';
import {Animator,blend1D,blend2D,solveTwoBoneIK} from '../packages/animator/dist/index.js';
import {Terrain,clipmapGrid} from '../packages/terrain/dist/index.js';
import {animatedTriangle} from './support/gltf-pro-fixture.js';

test('four practical cascades cover their frustum slices and snap small camera motion',()=>{
  assert.deepEqual([...cascadeSplits(1,100,0)],[25.75,50.5,75.25,100]);
  const splits=cascadeSplits(1,100,1);assert.ok(Math.abs(splits[0]-Math.sqrt(10))<1e-6);assert.equal(splits[3],100);
  const camera=new Camera({near:1,far:100,position:[0,0,0],target:[0,0,-1]}),{matrices}=fitCascades(camera,1,[0,1,0],1024,splits);
  let near=1;for(let cascade=0;cascade<4;cascade++){const m=matrices.subarray(cascade*16,cascade*16+16);for(const depth of [near,splits[cascade]])for(const sx of [-1,1])for(const sy of [-1,1]){
    const p=[sx*depth*Math.tan(Math.PI/6),sy*depth*Math.tan(Math.PI/6),-depth],projected=[0,1,2].map(r=>m[r]*p[0]+m[4+r]*p[1]+m[8+r]*p[2]+m[12+r]);assert.ok(Math.abs(projected[0])<=1&&Math.abs(projected[1])<=1&&projected[2]>=0&&projected[2]<=1);
  }near=splits[cascade];}
  camera.position=[0.00001,0,0];camera.target=[0.00001,0,-1];const moved=fitCascades(camera,1,[0,1,0],1024,splits).matrices;assert.deepEqual(moved,matrices);
  assert.throws(()=>cascadeSplits(0,100),/splits/);assert.throws(()=>fitCascades(camera,1,[0,0,0],1024,splits),/direction/);
});

test('blend weights are continuous, normalized and reproduce exact samples',()=>{
  assert.deepEqual([...blend1D([0,1,3],2)],[0,0.5,0.5]);assert.deepEqual([...blend1D([0,1],-2)],[1,0]);
  assert.deepEqual([...blend2D([[0,0],[1,0],[0,1]],1,0)],[0,1,0]);const weights=blend2D([[0,0],[1,0],[0,1],[1,1]],0.5,0.5);assert.deepEqual([...weights],[0.25,0.25,0.25,0.25]);
  assert.throws(()=>blend1D([1,1],0),/samples/);assert.throws(()=>blend2D([[0,0],[0,0]],0,0),/samples/);
});

test('analytical IK preserves bone lengths for reachable, distant and coincident targets',()=>{
  for(const target of [[1,1,0],[100,0,0],[0,0,0]]){const result=solveTwoBoneIK([0,0,0],[1,0,0],[2,0,0],target,[0,1,0]);assert.ok(Math.abs(Math.hypot(...result.knee)-1)<1e-7);assert.ok(Math.abs(Math.hypot(...result.ankle.map((v,i)=>v-result.knee[i]))-1)<1e-7);assert.ok(result.knee.every(Number.isFinite));}
  assert.throws(()=>solveTwoBoneIK([0,0,0],[0,0,0],[1,0,0],[1,1,0],[0,1,0]),/zero length/);
});

test('clipmap rings leave a central hole, use bounded indices and wind upward',()=>{
  const {vertices,center,ring}=clipmapGrid(8);assert.equal(center.length,8*8*6);assert.equal(ring.length,(8*8-4*4)*6);assert.ok([...ring].every(i=>i<vertices.length/2));
  for(let i=0;i<ring.length;i+=3){const points=[0,1,2].map(k=>[vertices[ring[i+k]*2],vertices[ring[i+k]*2+1]]),x=points.reduce((sum,p)=>sum+p[0]/3,0),z=points.reduce((sum,p)=>sum+p[1]/3,0);assert.ok(Math.abs(x)>=2||Math.abs(z)>=2);const [a,b,c]=points;assert.ok((b[1]-a[1])*(c[0]-a[0])-(b[0]-a[0])*(c[1]-a[1])>0);}
  assert.throws(()=>clipmapGrid(10),/multiple/);
});

test('game modules reject bad inputs before allocating GPU resources',()=>{
  for(const options of [{resolution:0},{lambda:2},{distance:NaN},{normalBias:-1}])assert.throws(()=>new Shadows(options),/options/);
  assert.throws(()=>new Clustered({grid:[0,9,24]}),/grid/);const lights=new Clustered();assert.throws(()=>lights.setLights([{position:[0,0,0],range:0}]),/range/);assert.throws(()=>lights.setLights([{position:[0,0,0],range:1,direction:[0,0,0],outerAngle:0.2}]),/cone/);assert.throws(()=>lights.setLights(Array(1025).fill({position:[0,0,0],range:1})),/1,024/);
  for(const options of [{capacity:1000001},{lifetime:[0,1]},{bounce:2},{gravity:[NaN,0,0]},{emissionExtent:[-1,0,0]},{emissionExtent:[0,NaN,0]},{intensity:17}])assert.throws(()=>new VFX(options));assert.throws(()=>new VFX({capacity:10}).burst(11),/burst/);
  assert.throws(()=>new Terrain({textures(){},layers:[],size:[100,100]}),/options/);
});

test('animator blends transforms/morphs, masks additive layers and switches gameplay states',async()=>{
  const store=await TransformStore.create(32),engine=new Engine({width:256,height:256,clientWidth:256,clientHeight:256},store,{backend:'webgl2',add(){},remove(){},render(){},dispose(){}});
  const f=animatedTriangle();f.doc.animations.push({...structuredClone(f.doc.animations[0]),name:'Idle',channels:[]});
  const morph=new Float32Array([0,1]),id=f.buffers.length;f.buffers.push(morph);f.doc.buffers.push({byteLength:morph.byteLength});f.doc.bufferViews.push({buffer:id,byteLength:morph.byteLength});f.doc.accessors.push({bufferView:id,componentType:5126,count:2,type:'SCALAR'});f.doc.animations.push({name:'Smile',channels:[{sampler:0,target:{node:0,path:'weights'}}],samplers:[{input:f.doc.animations[0].samplers[0].input,output:id}]});
  const model=new PBRModel(engine,new GLTFAsset(f.doc,f.buffers)),animation=new Animation(model);
  try{
    const animator=new Animator(animation,{states:{locomotion:{parameter:'speed',samples:[{value:0,clip:'Idle'},{value:1,clip:'Move'}]},idle:'Idle'},initial:'locomotion',parameters:{speed:0.5},transitions:[{from:'locomotion',to:'idle',when:p=>p.speed<0,duration:0.1}]});
    animator.onPreUpdate(0.5);assert.ok(Math.abs(model.nodes[1].position.x-0.1)<1e-6);
    const remove=animator.addLayer({clip:'Move',weight:0.5,mask:[1]});animator.onPreUpdate(0);assert.ok(Math.abs(model.nodes[1].position.x-0.2)<1e-6);assert.equal(model.nodes[0].position.x,0);remove();
    const removeSmile=animator.addLayer({clip:'Smile',weight:0.5,mask:[0]});animator.onPreUpdate(0);assert.ok(Math.abs(model.primitives[0].weights[0]-0.25)<1e-6);assert.ok(Math.abs(model.nodes[1].position.x-0.1)<1e-6);removeSmile();
    animator.parameters.speed=-1;animator.onPreUpdate(0.1);assert.equal(animator.state,'idle');assert.equal(model.nodes[1].position.x,0);
    assert.throws(()=>animator.transition('missing'),/transition/);animator.dispose();assert.throws(()=>animator.addLayer({clip:'Move',weight:1,mask:[1]}),/layer/);
  }finally{model.dispose();engine.dispose();}
});
