import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GPUParticles} from '../packages/creative/dist/particles.js';

const baseline=process.execArgv.includes('--conditions=deep-obstacle-baseline');
let baselineObstacles;
if(baseline){
 const source=await readFile(new URL('../test-results/deep-second-pass-baseline/packages/creative/src/particles.ts',import.meta.url),'utf8');
 const method=source.slice(source.indexOf(' private obstacles():void {'),source.indexOf(' setTexture(source:ParticleTexture)'));
 baselineObstacles=new Function('return function()'+method.slice(method.indexOf('{')).trim())();
}
function create(options){const particles=new GPUParticles(options);if(baseline){particles.obstacles=baselineObstacles;particles.obstacles();}return particles;}

test('Mutable particle obstacles preserve packed float bytes without per-frame temporary arrays or callbacks',()=>{
 const sphere={kind:'sphere',center:[-0,1,2],radius:0.5},box={kind:'box',center:[3,-0,-2],halfSize:[1,2,3]},options={count:1,obstacles:[sphere,box]},particles=create(options);
 const frame=particles.frame,originalSet=Float32Array.prototype.set,originalForEach=Array.prototype.forEach,originalIncludes=Array.prototype.includes,originalEvery=Array.prototype.every;
 const counts={packed:0,kinds:0,loops:0,sphereExtents:0};
 const expected=[];
 for(let i=0;i<120;i++){sphere.center[0]=i%2?-0:i/10;sphere.radius=0.5+i/100;box.center[1]=i%2?-0:i/20;expected.push(new Float32Array([...sphere.center,0,sphere.radius,sphere.radius,sphere.radius,0,...box.center,1,...box.halfSize,0]));}
 const captured=[];
 try{
  Float32Array.prototype.set=function(values,...rest){if(this===frame&&Array.isArray(values)&&values.length===8)counts.packed++;return Reflect.apply(originalSet,this,[values,...rest]);};
  Array.prototype.forEach=function(...args){if(this===options.obstacles)counts.loops++;return Reflect.apply(originalForEach,this,args);};
  Array.prototype.includes=function(...args){if(this.length===2&&this[0]==='sphere'&&this[1]==='box')counts.kinds++;return Reflect.apply(originalIncludes,this,args);};
  Array.prototype.every=function(...args){if(this!==sphere.center&&this!==box.center&&this!==box.halfSize&&this.length===3&&this[0]===sphere.radius&&this[1]===sphere.radius&&this[2]===sphere.radius)counts.sphereExtents++;return Reflect.apply(originalEvery,this,args);};
  for(let i=0;i<120;i++){sphere.center[0]=i%2?-0:i/10;sphere.radius=0.5+i/100;box.center[1]=i%2?-0:i/20;particles.obstacles();captured.push(frame.slice(48,64));}
 }finally{Float32Array.prototype.set=originalSet;Array.prototype.forEach=originalForEach;Array.prototype.includes=originalIncludes;Array.prototype.every=originalEvery;}
 for(let i=0;i<120;i++)assert.deepEqual(new Uint8Array(captured[i].buffer),new Uint8Array(expected[i].buffer));
 assert.deepEqual(counts,{packed:0,kinds:0,loops:0,sphereExtents:0},JSON.stringify(counts));
 options.obstacles=[{kind:'box',center:[-0,2,-0],halfSize:[4,5,6]}];particles.obstacles();assert.equal(frame[45],1);
 assert.deepEqual(new Uint8Array(frame.slice(48,56).buffer),new Uint8Array(new Float32Array([-0,2,-0,1,4,5,6,0]).buffer));
 options.obstacles=[];particles.obstacles();assert.equal(frame[45],0);
 options.obstacles=undefined;particles.obstacles();assert.equal(frame[45],0);
});

test('Mutable particle obstacle count, vector, extent and radius validation survives malformed input and recovery',()=>{
 const sphere={kind:'sphere',center:[0,1,2],radius:1},options={count:1,obstacles:[sphere]},particles=create(options);
 const bad=[{kind:'capsule',center:[0,0,0],radius:1},{kind:'sphere',center:[0,0],radius:1},{kind:'sphere',center:[0,0,0,0],radius:1},{kind:'sphere',center:[NaN,0,0],radius:1},{kind:'sphere',center:[Infinity,0,0],radius:1},{kind:'sphere',center:[Number.MAX_VALUE,0,0],radius:1},...[0,-1,NaN,Infinity,Number.MAX_VALUE].map(radius=>({kind:'sphere',center:[0,0,0],radius})),{kind:'box',center:[0,0,0],halfSize:[1,1]},{kind:'box',center:[0,0,0],halfSize:[1,1,NaN]},{kind:'box',center:[0,0,0],halfSize:[1,0,1]},{kind:'box',center:[0,0,0],halfSize:[1,-1,1]}];
 for(const obstacle of bad){options.obstacles=[obstacle];assert.throws(()=>particles.obstacles(),{name:'RangeError',message:/Invalid wind obstacle/});options.obstacles=[sphere];particles.obstacles();assert.deepEqual([...particles.frame.slice(48,56)],[0,1,2,0,1,1,1,0]);}
 options.obstacles=Array.from({length:65},()=>sphere);assert.throws(()=>particles.obstacles(),/Obstacle limit is 64/);
 options.obstacles=[{kind:'sphere',center:[-0,0,0],radius:Number.MIN_VALUE}];particles.obstacles();assert.equal(particles.frame[52],0);assert.ok(Object.is(particles.frame[48],-0));
 options.obstacles=Array.from({length:64},()=>sphere);particles.obstacles();assert.equal(particles.frame[45],64);
});
