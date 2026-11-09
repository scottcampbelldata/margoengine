import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('audio PCM claims distinguish offline rendering from live device output',()=>{
 const claims=readFileSync(new URL('../../../docs/whitepaper/claims.md',import.meta.url),'utf8');
 for(const id of [603,605,607,608,610]){
  const row=claims.split('\n').find(line=>line.startsWith(`| LIM-${id} |`));
  assert.ok(row,`LIM-${id} exists`);
  assert.match(row,/real browser Web Audio offline rendering/,`LIM-${id} states its PCM proof scope`);
  assert.doesNotMatch(row,/audio(?: and devices|\/devices|\/device execution)/);
  assert.match(row,/device output.*unmeasured/i,`LIM-${id} states the device evidence gap`);
 }
});
