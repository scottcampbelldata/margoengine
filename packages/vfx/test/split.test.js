import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {VFX} from '../dist/index.js';import {VFX as Base} from '../dist/base.js';import {trace,configs} from './traces.js';
const entries=Object.fromEntries(await Promise.all(['obstacles','wrap','sort','texture'].map(async name=>[name,(await import(`../dist/${name}.js`))[name]])));
const fixtures=JSON.parse(await readFile(new URL('./fixtures/traces.json',import.meta.url),'utf8'));

test('full and feature-only particles record exactly the GPU work, WGSL and uploads of the pre-split build',()=>{
 for(const [name,config] of Object.entries(configs)){
  assert.equal(trace(VFX,name).digest(),fixtures[name].digest,name);
  assert.equal(trace(Base,name,Object.fromEntries(config.features.map(feature=>[feature,entries[feature]]))).digest(),fixtures[name].digest,name+' (base entry)');
 }
});

test('options that need a missing feature throw instead of drawing something else',()=>{
 assert.throws(()=>new Base({obstacles:[]}),/VFX obstacles needs obstacles from @margoengine\/vfx\/obstacles/);
 assert.throws(()=>new Base({emissionExtent:[1,1,1],wrap:true}),/VFX wrap needs wrap/);
 assert.throws(()=>new Base({sort:true}),/VFX sort needs sort/);
 assert.throws(()=>new Base({texture:{width:1,height:1,data:new Uint8Array(4)}}),/VFX texture needs texture/);
 assert.doesNotThrow(()=>new Base({wrap:false,sort:false}));
 assert.throws(()=>new Base({sort:1},{sort:entries.sort}),/sort or wrap/,'Shared validation still runs');
});
