import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeMargo } from '../dist/index.js';
import { MargoNodeMaterial, parseMargoNodes, loadMargoNodes } from '../dist/nodes.js';
const bytes=await readFile(new URL('./fixtures/nodes.margo',import.meta.url));
const asset=decodeMargo(bytes), graph=asset.document.materials[0].extras['margo:nodes'];
export const fixtureGraph=graph;
test('Blender exports a connected live graph without texture sections or baked images',()=>{
  assert.equal(asset.images.length,0);
  for(const op of ['mix','ramp','noise','math'])assert.ok(graph.nodes.some(n=>n.op===op),op);
  const live=new MargoNodeMaterial(graph), source=live.extension.wgsl;
  assert.match(source,/s\.base=/);assert.match(source,/s\.roughness=/);assert.match(source,/s\.emissive\*=/);
  assert.match(live.extension.declarations,/bnTexture4/);
  assert.match(live.extension.declarations,/bnRamp/);
});
test('exported socket animation seeks, clamps, rewinds and allows stable runtime overrides',()=>{
  const live=new MargoNodeMaterial(graph), key='Amount/outputs/0', factors=live.extension.factors, code=live.extension.wgsl;
  for(const [seconds,expected] of [[-1,.25],[0,.25],[.25,.375],[.5,.5],[1,.75],[100,.75],[0,.25]]){
    live.seek(seconds);assert.equal(live.get(key)[0],expected);
  }
  live.set(key,.9).seek(.5);assert.ok(Math.abs(live.get(key)[0]-.9)<1e-6);
  live.reset(key).seek(.5);assert.equal(live.get(key)[0],.5);
  assert.equal(live.extension.factors,factors);assert.equal(live.extension.wgsl,code);
  assert.throws(()=>live.set(key,[1,2,3]),/socket value/);
  assert.throws(()=>live.set(key,NaN),/socket value/);
  assert.throws(()=>live.get('missing'),/unknown socket/);
  assert.throws(()=>live.seek(Infinity),/seek time/);
});
test('untrusted graph bounds, cycles, injected enums, parameter values and animation samples reject',()=>{
  const mutate=fn=>{const g=structuredClone(graph);fn(g);assert.throws(()=>new MargoNodeMaterial(g),e=>e.code==='unsupported'&&/re-export/.test(e.message));};
  mutate(g=>g.version=2);mutate(g=>g.nodes[0].inputs=[{link:0}]);
  mutate(g=>g.nodes.find(n=>n.op==='math').operation='ADD);discard;');
  mutate(g=>g.parameters['Amount/outputs/0'].value=[NaN]);
  mutate(g=>g.parameters['Amount/outputs/0'].samples=[[0]]);
  mutate(g=>g.times=[0,0]);mutate(g=>g.bounds=[[1,1,1],[0,0,0]]);
  mutate(g=>g.nodes.find(n=>n.op==='noise').dimensions='3);discard;');
  mutate(g=>g.nodes.find(n=>n.op==='ramp').stops[0][0]={link:0});
});
test('caller mutation cannot change shader structure or retained animation data',()=>{
  const g=structuredClone(graph),live=new MargoNodeMaterial(g);
  g.parameters['Amount/outputs/0'].samples[0][0]=999;
  live.seek(0);assert.equal(live.get('Amount/outputs/0')[0],.25);
});
test('loaders reject abort and local URLs before resources are created',async()=>{
  const signal=AbortSignal.abort(new Error('cancel live nodes'));
  await assert.rejects(parseMargoNodes({},bytes,{signal}),/cancel live nodes/);
  await assert.rejects(loadMargoNodes({},'https://example.invalid/nodes',{signal}),/cancel live nodes/);
  await assert.rejects(loadMargoNodes({},'file:///nodes.margo'),/HTTP\(S\)/);
});
