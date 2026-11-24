import assert from 'node:assert/strict';
import test from 'node:test';
import { AreaPicking } from '../dist/area.js';
test('area queries validate shapes and allocation budgets before touching the GPU',async()=>{
 for(const maxPixels of [0,-1,NaN,Infinity,1.1])assert.throws(()=>new AreaPicking({maxPixels}),RangeError);
 const picker=new AreaPicking();assert.throws(()=>picker.rect({x:0,y:0,width:NaN,height:1}),RangeError);
 await assert.rejects(picker.polygon([[0,0],[1,1]]),RangeError);
 const controller=new AbortController();controller.abort('cancelled');await assert.rejects(picker.polygon([[0,0],[1,0],[1,1]],undefined,controller.signal),e=>e==='cancelled');
 picker.dispose();await assert.rejects(picker.rect({x:0,y:0,width:1,height:1}),/disposed/);
});
