import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {cachedProductionAssets,sampleAssetBase,sampleAssetCommit} from './gltf-production-assets.js';

export {sampleAssetBase,sampleAssetCommit};
export const lobeProductionAssets=[
  {name:'SheenChair',path:'SheenChair/glTF-Binary/SheenChair.glb',lobe:'sheen',camera:[2,1.5,3],attribution:'Eric Chadwick / Wayfair, LLC, 2020, CC0 1.0'},
  {name:'SpecularTest',path:'SpecularTest/glTF-Binary/SpecularTest.glb',lobe:'specular',camera:[0,0,5],ambient:2,attribution:'Ed Mackey / Analytical Graphics, Inc., 2021, CC BY 4.0'},
  {name:'CompareIridescence',path:'CompareIridescence/glTF-Binary/CompareIridescence.glb',lobe:'iridescence',camera:[0,0,5],ambient:1,attribution:'Eric Chadwick and DGG / Public, 2024, CC0 1.0; glTF mark / Khronos Group, 2017'},
  {name:'AnisotropyBarnLamp',path:'AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp.gltf',lobe:'anisotropy',camera:[2,1.2,3],attribution:'Eric Chadwick / Wayfair, LLC, 2023, CC BY 4.0'},
].map(value=>({...value,readme:sampleAssetBase+value.name+'/README.md'}));
const pins=[
  ['SheenChair/glTF-Binary/SheenChair.glb',4125648,'f0af2a2b102d28d540236306ae19f8fb36842df76bd38cf76f063f9bd2853399'],
  ['SpecularTest/glTF-Binary/SpecularTest.glb',223376,'cf789c68c3ab4b74877da3c5992c612c213f9c901ed4fafbf9be362f434e48d9'],
  ['CompareIridescence/glTF-Binary/CompareIridescence.glb',214756,'abda6e8bcb13ad04534c90bc4ce9b21e80f2d8b74ac4d911800269f0009ff073'],
];

/** Complete, unmodified upstream assets, pinned by both source commit and bytes. */
export async function cachedLobeAssets(){
  const root=resolve('test-results/materials-lobe-assets'),files=[];
  for(const [path,bytes,sha256] of pins){
    const cache=resolve(root,...path.split('/'));let data;
    try{data=await readFile(cache);}catch(error){
      if(error.code!=='ENOENT')throw error;
      const response=await fetch(sampleAssetBase+path);assert.ok(response.ok,'Lobe asset download failed: '+path);
      assert.ok(Number(response.headers.get('content-length')??bytes)<=8*1024*1024,'Lobe fixture exceeds download limit');data=Buffer.from(await response.arrayBuffer());
      assert.equal(data.length,bytes,'Lobe fixture size changed: '+path);assert.equal(createHash('sha256').update(data).digest('hex'),sha256,'Lobe fixture digest changed: '+path);
      await mkdir(dirname(cache),{recursive:true});await writeFile(cache,data);
    }
    assert.equal(data.length,bytes,'Cached lobe fixture size changed: '+path);assert.equal(createHash('sha256').update(data).digest('hex'),sha256,'Cached lobe fixture digest changed: '+path);
    files.push({path,url:sampleAssetBase+path,bytes,sha256,data});
  }
  files.push(...(await cachedProductionAssets()).filter(file=>file.path.startsWith('AnisotropyBarnLamp/')));
  await writeFile(resolve(root,'source-manifest.json'),JSON.stringify({commit:sampleAssetCommit,models:lobeProductionAssets,files:files.map(({data,...entry})=>entry)},null,2)+'\n');
  return files;
}
