import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';

// Hash is an internal parser utility. Compile its real source without exposing
// another public package export or rebuilding the workspace in a unit test.
const url=new URL('../packages/machinery/src/cad-parser.ts',import.meta.url);
let source=await readFile(url,'utf8');
source=source.replace("'@margoengine/core'",JSON.stringify(import.meta.resolve('@margoengine/core')));
source=source.replace(/'(\.\.\/\.\.\/shared\/[^']+)'/g,(_,path)=>JSON.stringify(new URL(path,url).href));
const {code}=await transformWithOxc(source,'cad-parser.ts',{loader:'ts',target:'es2022'});
const {hash}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));

test('CAD hashing uses only the supplied typed-array view',()=>{
 const backing=new Float32Array([91,1,2,3,92]),view=backing.subarray(1,4),copy=Float32Array.from(view);
 assert.equal(hash(view),hash(copy));const expected=hash(view);backing[0]=-9;backing[4]=-12;assert.equal(hash(view),expected);
 backing[2]=7;assert.notEqual(hash(view),expected);assert.equal(hash(backing.subarray(2,2)),hash(new Float32Array()));
});
