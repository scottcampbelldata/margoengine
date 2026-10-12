import test from 'node:test';
import assert from 'node:assert/strict';
import {generateRockMesh,generateFernMesh,contactAO,radialAO} from '../dist/index.js';
import {icosahedronGeometry} from '@margoengine/geometry';

test('deformed rocks have continuous smooth normals without collapsing their UV seams',()=>{
 const rock=generateRockMesh(),original=icosahedronGeometry(1,2),seams=new Map();let smoothFaces=0,uvSeams=0;
 assert.deepEqual(rock.uvs,original.uvs);assert.deepEqual(rock.indices,original.indices);
 for(let v=0;v<rock.positions.length/3;v++){
  const key=Array.from(rock.positions.slice(v*3,v*3+3)).join(','),n=rock.normals.slice(v*3,v*3+3),uv=rock.uvs.slice(v*2,v*2+2);
  assert.ok(Math.abs(Math.hypot(...n)-1)<1e-6);
  const old=seams.get(key);if(old){assert.deepEqual(n,old.n);if(uv.some((value,i)=>value!==old.uv[i]))uvSeams++;}else seams.set(key,{n,uv});
 }
 for(let t=0;t<rock.indices.length;t+=3){const a=rock.indices[t]*3,b=rock.indices[t+1]*3;if(Math.hypot(...[0,1,2].map(k=>rock.normals[a+k]-rock.normals[b+k]))>0.01)smoothFaces++;}
 assert.ok(smoothFaces>170);assert.ok(uvSeams>0);assert.deepEqual(rock,generateRockMesh());
 assert.ok(rock.tangents.every(Number.isFinite));assert.equal(generateFernMesh().indices.length,7*5*6);
});

test('contact and radial occlusion stay bounded and reject invalid sampling data',()=>{
 assert.equal(contactAO(-1,0),0.2);assert.equal(contactAO(0.6,0),1);
 assert.equal(radialAO(0,0,0,[0,0,0],2),0.25);assert.equal(radialAO(4,0,0,[0,0,0],2),1);
 assert.throws(()=>contactAO(NaN,0),/height/);assert.throws(()=>radialAO(0,0,0,[0,0,0],0),/volume/);
});
