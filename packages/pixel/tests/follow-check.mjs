import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context=await openBrowser({startPath:'/packages/pixel/tests/follow-check.html',port:'free'});
try {
  const errors=[]; context.page.on('pageerror',e=>errors.push(e.message));
  await context.page.waitForFunction(()=>window.ready,null,{timeout:60000});
  const result=await context.page.evaluate(()=>window.check());
  assert.deepEqual(result.checks,[0,0,0,0,0,0]);
  assert.deepEqual(result.position,[16,12]);
  assert.equal(result.validation,null); assert.deepEqual(result.errors,[]); assert.deepEqual(errors,[]);
  console.log('ok pixel follow: tracking, flash, fade, split views and disposal');
} finally { await context.close(); }
