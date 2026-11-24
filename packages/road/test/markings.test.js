import test from 'node:test';
import assert from 'node:assert/strict';
import {markings} from '../dist/markings.js';
test('solid/dashed lines retain authored extents and an arrow has a shaft and symmetric head',()=>{
  assert.deepEqual(markings([]),[]);
  const [line]=markings([{kind:'line',position:[1,2,3],length:10,angle:Math.PI/2}]);
  assert.deepEqual(line.position,[1,2,3]);assert.equal(line.height,10);assert.equal(line.width,0.15);
  assert.ok(Math.abs(line.up[0]-1)<1e-15);assert.ok(Math.abs(line.up[2])<1e-15);
  const d=markings([{kind:'line',position:[0,0,0],length:10,dash:[3,1]}]);
  assert.deepEqual(d.map(v=>v.height),[3,3,2]);assert.deepEqual(d.map(v=>v.position[2]),[-3.5,0.5,4]);
  const a=markings([{kind:'arrow',position:[0,0,0],length:4,width:2}]);
  assert.equal(a.length,3);assert.equal(a[0].height,4);assert.equal(a[0].width,0.4);
  assert.equal(a[1].position[0],-a[2].position[0]);assert.equal(a[1].height,a[2].height);
  for(const v of [...d,...a]){assert.equal(v.mode,'over');assert.deepEqual(v.direction,[0,-1,0]);assert.ok(Math.abs(Math.hypot(...v.up)-1)<1e-15);assert.equal(v.depth,2);}
});
test('marking data is independently owned and hostile settings cannot enter the renderer',()=>{
  const position=[1,2,3],color=[0.8,0.6,0.2];const result=markings([{kind:'arrow',position}],{color});
  position.fill(99);color.fill(0);result[0].color.fill(1);
  assert.deepEqual(result[1].color,[0.8,0.6,0.2]);assert.equal(result[1].position[1],2);
  const base={kind:'line',position:[0,0,0]};
  for(const change of [{kind:'unknown'},{length:0},{length:Infinity},{width:NaN},{width:1e20},{position:[]},{position:[NaN,0,0]},{position:[1e20,0,0]},{dash:[]},{dash:[0,1]},{dash:[NaN,1]},{length:10000,dash:[.001,.001]},{kind:'arrow',dash:[1,1]}])assert.throws(()=>markings([{...base,...change}]),e=>e.code==='failed'&&/https:/.test(e.message));
  for(const settings of [{opacity:NaN},{opacity:2},{depth:0},{color:[]},{color:[1,Infinity,0]}])assert.throws(()=>markings([base],settings));
  for (const setting of [{length:Number.MIN_VALUE},{width:Number.MIN_VALUE}]) assert.throws(()=>markings([{...base,...setting}]));
  assert.throws(()=>markings([base],{depth:Number.MIN_VALUE}));
  assert.throws(()=>markings([{...base,length:1.0000000000000003e-37,dash:[5e-38,5e-38]}]));
  assert.equal(markings(Array.from({length:4096},()=>base)).length,4096);
  assert.throws(()=>markings(Array.from({length:4097},()=>base)));
  assert.equal(markings([{...base,length:1e-30,width:1e-30}],{depth:1e-30})[0].height,1e-30);
  const extreme=markings([{kind:'arrow',position:[1e6,-1e6,1e6],length:10000,width:1000,angle:1e20}],{depth:1000,opacity:0,color:[0,0,0]});
  assert.ok(extreme.flatMap(v=>[...v.position,...v.up,v.height,v.width]).every(Number.isFinite));
});
