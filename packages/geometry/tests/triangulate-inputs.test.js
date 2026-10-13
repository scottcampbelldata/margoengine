import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {triangulate} from '../dist/index.js';

test('invalid triangulation dimensions reject without blocking the caller',()=>{
 const module=new URL('../dist/index.js',import.meta.url).href;
 const child=spawnSync(process.execPath,['--input-type=module','--eval',`import assert from 'node:assert/strict';import {triangulate} from ${JSON.stringify(module)};for(const dim of [0,-1,1,2.5,NaN,Infinity,'2',null])assert.throws(()=>triangulate([0,0,1,0,0,1],[],dim),RangeError);`],{timeout:1500,encoding:'utf8',maxBuffer:64*1024});
 assert.equal(child.error,undefined,'Invalid input did not return within the subprocess timeout');
 assert.equal(child.status,0,child.stderr);
});

test('triangulation preserves empty input and coordinates with dimensions above two',()=>{
 const flat=[0,0,2,0,2,2,0,2],expected=triangulate(flat);
 for(const dim of [2,3,4]){
  assert.deepEqual(triangulate([],[],dim),[]);
  const coordinates=[];for(let i=0;i<flat.length;i+=2)coordinates.push(flat[i],flat[i+1],...Array(dim-2).fill(99));
  assert.deepEqual(triangulate(coordinates,[],dim),expected);
 }
});

test('invalid triangulation hole boundaries reject without blocking the caller',()=>{
 const module=new URL('../dist/index.js',import.meta.url).href;
 const child=spawnSync(process.execPath,['--input-type=module','--eval',`import assert from 'node:assert/strict';import {triangulate} from ${JSON.stringify(module)};for(const holes of [[Infinity],[-Infinity],[NaN],[-1],[1.5],[5],[3,2]])assert.throws(()=>triangulate([0,0,1,0,1,1,0,1],holes),RangeError);`],{timeout:1500,encoding:'utf8',maxBuffer:64*1024});
 assert.equal(child.error,undefined,'Invalid hole boundary did not return within the subprocess timeout');
 assert.equal(child.status,0,child.stderr);
});
