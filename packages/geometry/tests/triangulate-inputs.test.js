import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {triangulate} from '../dist/index.js';

// Invalid input must throw instead of looping, so the calls run in a child process the parent can kill. Starting a
// Node child can take many seconds on a loaded machine, so the kill timeout only catches a hang; the 1.5 s budget is
// checked on the CPU time the calls themselves use, measured inside the child (not affected by machine load).
function rejectsQuickly(body){
 const module=new URL('../dist/index.js',import.meta.url).href;
 const child=spawnSync(process.execPath,['--input-type=module','--eval',`import assert from 'node:assert/strict';import {triangulate} from ${JSON.stringify(module)};const start=process.cpuUsage();${body}const used=process.cpuUsage(start);console.log((used.user+used.system)/1000);`],{timeout:120_000,encoding:'utf8',maxBuffer:64*1024});
 assert.equal(child.error,undefined,`Invalid input did not return within 120 s: ${child.error?.message}`);
 assert.equal(child.status,0,child.stderr);
 const ms=Number(child.stdout.trim());
 assert.ok(ms<1500,`Invalid input took ${ms} ms of CPU time to reject`);
}

test('invalid triangulation dimensions reject without blocking the caller',()=>{
 rejectsQuickly(`for(const dim of [0,-1,1,2.5,NaN,Infinity,'2',null])assert.throws(()=>triangulate([0,0,1,0,0,1],[],dim),RangeError);`);
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
 rejectsQuickly(`for(const holes of [[Infinity],[-Infinity],[NaN],[-1],[1.5],[5],[3,2]])assert.throws(()=>triangulate([0,0,1,0,1,1,0,1],holes),RangeError);`);
});
