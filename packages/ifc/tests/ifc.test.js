import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {IfcAPI} from 'web-ifc';
import {parseIFC} from '../dist/index.js';
import {createMeshes} from '@margoengine/loaders';
import {headlessEngine} from '../../exporters/tests/helpers.js';
const data=new Uint8Array(await readFile(new URL('./fixtures/wall.ifc',import.meta.url)));
const api=new IfcAPI();await api.Init();
test('real web-ifc extracts a placed millimeter wall in meters with BIM IDs',async()=>{
  const result=parseIFC(api,data);assert.equal(result.schema,'IFC4');
  assert.equal(result.products.length,1);assert.equal(result.products[0].expressID,25);assert.equal(result.products[0].type,'IfcWall');assert.equal(result.products[0].name,'Test wall');
  assert.equal(result.products[0].globalId,'1kTvXnbbzCWw8lcMd1dR4o');assert.equal(result.indices.length,36);assert.equal(result.groups[0].objectId,'25');
  const bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
  for(let i=0;i<result.positions.length;i++){const a=i%3;bounds[a]=Math.min(bounds[a],result.positions[i]);bounds[a+3]=Math.max(bounds[a+3],result.positions[i]);}
  const extents=bounds.slice(3).map((v,i)=>v-bounds[i]).sort((a,b)=>a-b);
  for(let i=0;i<3;i++)assert.ok(Math.abs(extents[i]-[0.2,3,4][i])<1e-5,JSON.stringify(bounds));
  assert.equal(api.IsModelOpen(0),false);
  const engine=await headlessEngine();const loaded=createMeshes(engine,result);assert.equal(loaded.meshes.length,1);assert.equal(loaded.meshes[0].name,'Test wall');loaded.dispose();assert.equal(engine.meshes.size,0);engine.dispose();
});
test('IFC validates input, limits and aborts, and closes models after callback failures',()=>{
  assert.throws(()=>parseIFC(api,data,{maxBytes:1}),/maxBytes/);
  assert.throws(()=>parseIFC(api,data,{maxVertices:-1}),/limits/);
  assert.throws(()=>parseIFC(api,new TextEncoder().encode('bad file')),/STEP/);
  assert.throws(()=>parseIFC(api,data,{signal:AbortSignal.abort()}),/aborted/);
  const opened=[],open=api.OpenModel.bind(api);api.OpenModel=(...args)=>{const id=open(...args);opened.push(id);return id;};
  assert.throws(()=>parseIFC(api,data,{maxTriangles:1}),/limit/);assert.ok(opened.every(id=>!api.IsModelOpen(id)));
  const get=api.GetGeometry.bind(api);api.GetGeometry=()=>{throw new Error('geometry failure');};
  assert.throws(()=>parseIFC(api,data),/geometry failure/);assert.ok(opened.every(id=>!api.IsModelOpen(id)));api.GetGeometry=get;api.OpenModel=open;
});
