import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';

export const sampleAssetCommit='edc7c9e67c639d230715049ee31f9a96a6babbbe';
export const sampleAssetBase=`https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/${sampleAssetCommit}/Models/`;
export const productionAssets=[
  {name:'TextureTransformMultiTest',path:'TextureTransformMultiTest/glTF-Binary/TextureTransformMultiTest.glb',kind:'transform',attribution:'Ed Mackey / Analytical Graphics, Inc., 2020, CC BY 4.0',readme:`${sampleAssetBase}TextureTransformMultiTest/README.md`},
  {name:'AnisotropyBarnLamp',path:'AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp.gltf',kind:'ktx2',attribution:'Eric Chadwick / Wayfair, LLC, 2023, CC BY 4.0',readme:`${sampleAssetBase}AnisotropyBarnLamp/README.md`},
];
const pins=[
  ['TextureTransformMultiTest/glTF-Binary/TextureTransformMultiTest.glb',388264,'569aedb53822d5721e7e06af5983348683d4b2ffb1d469338ad4f02bf6a74911'],
  ['AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp.gltf',6979,'71a528dfc329c6df9f3651d2fdbaf4ea5ee5e8dab668596f126bc7c2425c4543'],
  ['AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp.bin',409580,'50f196f7613c3cf40886c0058c8f4a51f6118d5654879f41bb2fcdb5ba989871'],
  ['AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp_anisotropy.ktx2',1017986,'4f2ee6ad27b50eb1497c73369d42154234c23d06292d4163cb61c0e65a02c68a'],
  ['AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp_basecolor.ktx2',2127072,'9887c98d487f2415f9221f37c14f185edfded7c9438e83ce75a753ae27a4ae53'],
  ['AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp_normalbump.ktx2',91214,'c04db9be21ca5f2d57c86854b9608c240e13b47e7d7329b696b62a79b262f839'],
  ['AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp_occlusionroughnessmetal.ktx2',1572895,'73a1ba6dfa0fbf1b1edc158b119623acbff894d62ce5ac3edaa20bedfe812383'],
];

/** Download complete, unmodified files only when absent; never accept a changed cache. */
export async function cachedProductionAssets(){
  const root=resolve('test-results/gltf-production-assets'),files=[];
  for(const [path,bytes,sha256] of pins){
    const cache=resolve(root,...path.split('/'));let data;
    try{data=await readFile(cache);}catch(error){
      if(error.code!=='ENOENT')throw error;const response=await fetch(sampleAssetBase+path);assert.ok(response.ok,'Asset download failed: '+path);
      const declared=Number(response.headers.get('content-length')??bytes);assert.ok(declared<=8*1024*1024,'Production fixture exceeds download limit');data=Buffer.from(await response.arrayBuffer());
      assert.equal(data.length,bytes,'Asset byte count changed: '+path);assert.equal(createHash('sha256').update(data).digest('hex'),sha256,'Asset digest changed: '+path);await mkdir(dirname(cache),{recursive:true});await writeFile(cache,data);
    }
    assert.equal(data.length,bytes,'Cached asset byte count changed: '+path);assert.equal(createHash('sha256').update(data).digest('hex'),sha256,'Cached asset digest changed: '+path);
    files.push({path,url:sampleAssetBase+path,bytes,sha256,data});
  }
  await writeFile(resolve(root,'source-manifest.json'),JSON.stringify({commit:sampleAssetCommit,models:productionAssets,files:files.map(({data,...entry})=>entry)},null,2)+'\n');return files;
}
