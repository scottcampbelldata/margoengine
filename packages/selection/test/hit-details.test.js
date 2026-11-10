import test from 'node:test';
import assert from 'node:assert/strict';
import { HitDetails } from '../dist/hit-details.js';
import { Picking } from '../dist/index.js';
test('detailed picker is optional and retains the standard picking protocol',async()=>{
 const p=new HitDetails();assert.ok(p instanceof Picking);assert.equal(p.options.capture,false);
 p.dispose();p.dispose();await assert.rejects(p.pick(0,0),/disposed/);
});
