import test from 'node:test';
import assert from 'node:assert/strict';
import { PrecipitationCover } from '../dist/cover.js';
import { GLTFWeather } from '../dist/gltf.js';

function capture(){
 const weather={occlusion:{}},passes=[];
 return {name:'capture',options:{weather},passes,
  setup(){weather.occlusion={buffer:{},view:{}};},
  registerPasses(g){g.add({name:'sky:weather-fx:cover',order:5.9,execute(){}});g.add({name:'sky:weather-fx:lens',order:6.6,execute(){}});},
  onPreUpdate(d){passes.push(d);},onDeviceRestored(){this.setup();},dispose(){weather.occlusion=undefined;},
 };
}

test('the capture runs before core and imported surfaces on their first frame, without installing lens effects',()=>{
 const source=capture(),cover=new PrecipitationCover(source),passes=[];
 cover.setup({sceneOf(){}});cover.registerPasses({add(p){passes.push(p);}});
 assert.deepEqual(passes.map(p=>p.name),['weather:cover-map','weather:cover-surfaces']);
 assert.ok(passes[0].order < -1);assert.ok(passes[1].order > -1 && passes[1].order < 0);
 cover.onPreUpdate(0.25);assert.deepEqual(source.passes,[0.25]);
 cover.dispose();assert.deepEqual(cover.bindings(),[]);
 assert.throws(()=>cover.onPreUpdate(0),{code:'disposed'});
});

test('the same depth test masks wetness, rings, snow colour and vertex depth in both shader groups',()=>{
 const cover=new PrecipitationCover(capture());cover.setup({sceneOf(){}});
 const source='weather_puddle_surface(i.position,n,c,r,m,true,u);weather_snow_at(i.position.xz,n.y,c);weather_snow_depth(p.xz,n.y,u);';
 for(const group of [0,2]){
  const shader=cover.shader(source,group);
  assert.match(shader,new RegExp(`@group\\(${group}\\) @binding\\(162\\)`));
  assert.match(shader,/v.a.x=0.0;v.a.y=0.0/);
  assert.match(shader,/weather_cover_snow\(i.position,/);
  assert.match(shader,/weather_cover_depth\(p.xyz,/);
  assert.match(shader,/p.y\+2e-2>=/);
  // Edge texels: the highest occluder of the four texels around the receiver (regression, batch 236 job 2).
  assert.match(shader,/k<4;k\+\+\)\{d=min\(d,textureLoad\(weatherCoverMap,clamp\(/);
  assert.equal(cover.shader(source,group),shader);
 }
 const effect=new GLTFWeather({cover});effect.setup({gpu:{createBuffer:()=>({}),queue:{writeBuffer(){}}}});
 assert.deepEqual(effect.bindings().map(b=>b.binding),[160,162,163]);
 cover.dispose();assert.equal(cover.shader(source,0),source);
 assert.deepEqual(effect.bindings().map(b=>b.binding),[160]);
});

test('bias and capture ownership reject invalid setup',()=>{
 assert.throws(()=>new PrecipitationCover(capture(),{bias:-1}),RangeError);
 const source=capture();source.setup();
 assert.throws(()=>new PrecipitationCover(source).setup({}),{code:'attached'});
});

test('model preparation before the first capture still compiles the covered shader',()=>{
 const cover=new PrecipitationCover(capture());
 assert.deepEqual(cover.bindings(),[]);
 assert.match(cover.shader('weather_snow_at(i.position.xz,n.y,c);',2),/weather_cover_snow\(i.position,/);
});
