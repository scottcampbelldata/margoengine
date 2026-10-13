import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sphere} from '../packages/margoengine/dist/index.js';

test('Stage sphere packing remains byte-identical across radii and minimum/maximum segment counts',()=>{
  for(const [radius,segments,digest] of [
    [.125,3,'ae418155f74191414916cbdecbd0f0e1187830260247880565131d35c38a74b4'],
    [1,5,'eabb3e8abf03079a446a2ba4bb373ff45ff8c49a2508b59b25e84e122a138d78'],
    [2.5,32,'aad79561e838ac5b5e2025b55e21444253a30b4f4ca3a37180a8b127acf691b3'],
    [.7,128,'3c60c29bbf93b87abf7035f13a00736d6ee73dc42649cc36b035224b98691157'],
    [1,256,'890134d9788d8a8571888a49d71a8afbe610fa6125ece8c62668a6fc64ae90d6'],
  ]){
    const geometry=sphere(radius,segments),hash=createHash('sha256');
    for(const array of [geometry.vertices,geometry.indices,geometry.bounds])hash.update(new Uint8Array(array.buffer,array.byteOffset,array.byteLength));
    assert.equal(hash.digest('hex'),digest);
  }
  for(const radius of [0,-1,NaN,Infinity,1e40])assert.throws(()=>sphere(radius),/radius/);
  for(const segments of [2,3.5,257,NaN])assert.throws(()=>sphere(1,segments),/segments/);
});

test('Stage sphere evaluates latitude trigonometry once per ring',()=>{
  const sin=Math.sin,cos=Math.cos;let sine=0,cosine=0;
  try{
    Math.sin=value=>{sine++;return sin(value);};Math.cos=value=>{cosine++;return cos(value);};
    sphere(1,32);
  }finally{Math.sin=sin;Math.cos=cos;}
  assert.equal(sine,578);assert.equal(cosine,578);
});
