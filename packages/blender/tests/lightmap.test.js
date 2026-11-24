import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeMargoLightmaps, parseMargoLightmap, loadMargoLightmap } from '../dist/lightmap.js';
import { decodeMargo } from '../dist/index.js';
const bytes = await readFile(new URL('./fixtures/lightmap.margo', import.meta.url));
const truth = JSON.parse(await readFile(new URL('./fixtures/lightmap-truth.json', import.meta.url), 'utf8'));
test('Cycles diffuse illumination imports as physical irradiance without albedo or pi baked in', async () => {
  const [map] = await decodeMargoLightmaps(bytes);
  assert.equal(map.node, 0);
  assert.equal(map.lightmap.width, truth.size);
  assert.equal(map.lightmap.height, truth.size);
  for(let p=0;p<map.lightmap.data.length;p+=4)
    for(let c=0;c<3;c++) assert.ok(Math.abs(map.lightmap.data[p+c]/255*map.lightmap.scale-truth.irradiance[c]) <= map.lightmap.scale/255, `texel ${p/4} channel ${c}`);
  const asset = decodeMargo(bytes), vertices=asset.geometry[0][0].vertices;
  assert.ok(Array.from(vertices).some((_,i)=> i%20===14 && vertices[i]!==vertices[i-2]), 'UV1 differs from UV0');
});
test('generated UV1 is exported for a source with only UV0', async () => {
  const generated = await readFile(new URL('./fixtures/lightmap-generated.margo', import.meta.url));
  const [map] = await decodeMargoLightmaps(generated);
  assert.equal(map.lightmap.width,16);
  assert.ok(map.lightmap.data.some(v=>v>0));
  const vertices=decodeMargo(generated).geometry[0][0].vertices;
  assert.ok(Array.from(vertices).some((v,i)=>i%20===14 && v!==0));
});
test('lightmap loaders honor abort and reject local URL loading before GPU work', async()=>{
  const signal=AbortSignal.abort(new Error('cancel lightmap'));
  await assert.rejects(decodeMargoLightmaps(bytes,{signal}),/cancel lightmap/);
  await assert.rejects(parseMargoLightmap({},bytes,{signal}),/cancel lightmap/);
  await assert.rejects(loadMargoLightmap({},'file:///scene.margo'),/HTTP\(S\)/);
});
test('the packaged lightmap entry shares its owning lightmap API instead of bundling a second texture runtime', async()=>{
  const code=await readFile(new URL('../dist/lightmap.js',import.meta.url),'utf8');
  assert.match(code,/from\s*["']@margoengine\/lightmap\/imported["']/);
});
