import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const revision='edc7c9e67c639d230715049ee31f9a96a6babbbe';
const source=`https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/${revision}/Models/Avocado/glTF-Draco/`;
const files=[
  ['Avocado.gltf',3083,'63ec45999c1df77adc3837857c95d16dde7aee062b4a1d4475ca968514ec8609'],
  ['Avocado.bin',8724,'535123a66a19c0427298d0bbe81b0ba5efa6d8155b7c659e11c23d8c6d6fe2c6'],
  ['Avocado_baseColor.png',3158729,'385dce948c3b9e8bc93e1c930d796e72b02cbd474b121a160d577de95ebbb48f'],
  ['Avocado_normal.png',3271114,'25783c211761b7e32497fdd3e2490f3bac05b738e5e2bc62fc5b78a270bb4e50'],
  ['Avocado_roughnessMetallic.png',1655059,'33ee80f7ccfd36825acfbd5ef0a51326bea49e33efed852dca44798798bd6901'],
];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Complete, unmodified Draco asset; large CC0 textures stay in the ignored test cache. */
export async function ensurePBRBoxAssets(){
  const directory=fileURLToPath(new URL('../../test-results/pbr-box-avocado/',import.meta.url));
  await mkdir(directory,{recursive:true});
  await Promise.all(files.map(async([name,size,hash])=>{
    const path=join(directory,name);let bytes;
    try{bytes=await readFile(path);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(bytes?.byteLength===size&&digest(bytes)===hash)return;
    const response=await fetch(source+name,{signal:AbortSignal.timeout(60000)});
    assert.ok(response.ok,`Avocado fixture download failed: ${name} (${response.status})`);
    bytes=Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.byteLength,size,`Avocado fixture size changed: ${name}`);
    assert.equal(digest(bytes),hash,`Avocado fixture hash changed: ${name}`);
    await writeFile(path,bytes);
  }));
  return {directory,url:'/test-results/pbr-box-avocado/Avocado.gltf',revision,files:files.map(([name,size,sha256])=>({name,size,sha256}))};
}
