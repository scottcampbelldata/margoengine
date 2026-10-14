import test from 'node:test';
import assert from 'node:assert/strict';
import {shadowSampling} from '../src/shader.ts';
import {Shadows} from '../dist/index.js';

test('PCSS tables retain Float32 spiral direction, radial distribution and tap counts',()=>{
 const source=shadowSampling(0),tables=new Map([...source.matchAll(/const shadowDisk(\d+)=array<vec2f,\d+>\(([^;]+)\);/g)].map(match=>[Number(match[1]),[...match[2].matchAll(/vec2f\(([^,]+),([^\)]+)\)/g)].map(value=>[Number(value[1]),Number(value[2])])]));
 assert.deepEqual([...tables.keys()],[16,32]);
 for(const [count,values] of tables){
  assert.equal(values.length,count);
  for(let j=0;j<count;j++){
   const [x,y]=values[j],radius=Math.sqrt((j+0.5)/count),angle=Math.fround(j*Math.fround(2.39996323));
   const f32=Math.fround,shaderAngle=f32(f32(j)*f32(2.39996323)),shaderRadius=f32(Math.sqrt(f32((f32(j)+0.5)/count)));
   assert.equal(j,f32(j));assert.equal((j+0.5)/count,f32((f32(j)+0.5)/count));
   assert.deepEqual([x,y],[f32(f32(Math.cos(shaderAngle))*shaderRadius),f32(f32(Math.sin(shaderAngle))*shaderRadius)],`Float32 tap bits changed at ${count}/${j}`);
   assert.equal(x,Math.fround(x));assert.equal(y,Math.fround(y));
   assert.ok(Math.abs(Math.hypot(x,y)-radius)<1e-7,`Changed radial distribution at ${count}/${j}`);
   assert.ok(Math.abs(x*Math.sin(angle)-y*Math.cos(angle))<1e-7,`Changed spiral direction at ${count}/${j}`);
   assert.ok(x*Math.cos(angle)+y*Math.sin(angle)>0,'Direction was reversed');
  }
 }
 // These values distinguish Float32 angle rounding from a double-precision spiral.
 assert.deepEqual(tables.get(16)[15],[-0.12648829817771912,-0.9760894775390625]);
 assert.deepEqual(tables.get(32)[31],[0.5365933179855347,-0.8345314264297485]);
 assert.match(source,/for\(var j=0u;j<16u;j\+\+\)/);assert.match(source,/for\(var j=0u;j<32u;j\+\+\)/);
 assert.match(source,/shadowDisk16\[j\]\*search/);assert.match(source,/shadowDisk32\[j\]\*radius/);
 assert.match(source,/if\(blockers==0\)\{return 1;\}/);assert.match(source,/return visibility\/32\.0/);
 assert.doesNotMatch(source,/cos\(|sin\(|sqrt\(/);
});

test('PCSS keeps core and PBR receiver hooks and each requested bind group',()=>{
 const shadows=new Shadows({resolution:64});
 try{for(const group of [0,2]){
  for(const [input,hook] of [['let linear=direct*vec3f(1);','shadowLit(direct,i.position,i.normal)*'],['direct+ambient(s)','shadowLit(direct,i.position,s.n)+ambient(s)']]){
   const output=shadows.shader(input,group);assert.ok(output.includes(hook));assert.ok(output.includes(shadowSampling(group)));
   const bindings=[...output.matchAll(/@group\((\d+)\) @binding\((\d+)\)/g)].map(match=>[Number(match[1]),Number(match[2])]);
   assert.deepEqual(bindings,[[group,1],[group,2],[group,3]],'Tables must not add GPU uniforms or bindings');
   assert.equal(shadows.shader(input,group),output);
  }
 }}finally{shadows.dispose();}
});

test('only an exactly zero direct-light vector bypasses visibility without changing its public shader signature',()=>{
 const source=shadowSampling(0);
 assert.match(source,/fn shadowVisibility\(position:vec3f,normal:vec3f\)->f32/);
 assert.match(source,/if\(all\(direct==vec3f\(0\)\)\)\{return direct;\}return direct\*shadowVisibility\(position,normal\);/);
 assert.doesNotMatch(source,/length\(direct\)|abs\(direct\)|epsilon/);
 const shadows=new Shadows({resolution:64});
 try{assert.throws(()=>shadows.shader('direct+emissive'),/standard PBR lighting shader/);}finally{shadows.dispose();}
});
