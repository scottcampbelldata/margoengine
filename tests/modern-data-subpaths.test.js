import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

async function nativeClosure(specifier){
 const seen=new Set(),sources=[];
 const visit=async url=>{
  if(seen.has(url))return;seen.add(url);
  const code=await readFile(new URL(url),'utf8');sources.push(code);
  for(const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])([^'"]+)\1/g)){
   const dependency=match[2];
   assert.ok(dependency.startsWith('.'),'Data import unexpectedly requires a runtime package: '+dependency);
   await visit(new URL(dependency,url).href);
  }
 };
 await visit(import.meta.resolve(specifier));return sources.join('\n');
}

test('native asset and splat data entries require no GPU renderer or shaders',async()=>{
 for(const specifier of ['@margoengine/gltf-pro/asset','@margoengine/splats/data']){
  const code=await nativeClosure(specifier);
  for(const marker of ['@fragment','@compute','createBuffer','createRenderPipeline','PBRModel','project-sort'])assert.ok(!code.includes(marker),marker+' entered '+specifier);
 }
});

test('data entries preserve public root identities without exposing parser internals',async()=>{
 const [pbr,asset,splats,data]=await Promise.all([import('@margoengine/gltf-pro'),import('@margoengine/gltf-pro/asset'),import('@margoengine/splats'),import('@margoengine/splats/data')]);
 assert.deepEqual(Object.keys(asset),['GLTFAsset']);assert.equal(asset.GLTFAsset,pbr.GLTFAsset);
 assert.deepEqual(Object.keys(data).sort(),['parseSplat','validateSplats']);
 assert.equal(data.parseSplat,splats.parseSplat);assert.equal(data.validateSplats,splats.validateSplats);
});
