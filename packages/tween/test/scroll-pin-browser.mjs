import assert from 'node:assert/strict';
import {openBrowser} from '../../../scripts/browser.js';
const app=await openBrowser({startPath:'/packages/tween/test/scroll-pin-browser.html',port:'free'}),{page}=app,errors=[];
page.on('pageerror',error=>errors.push(error.message));
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<=1,`${actual} vs ${expected}`);
try {
  await page.waitForFunction(()=>window.ready,null,{timeout:60000});
  const scroll=top=>page.evaluate(y=>new Promise(resolve=>{window.scrollTo({top:y,behavior:'instant'});requestAnimationFrame(()=>requestAnimationFrame(resolve));}),top);
  const state=()=>page.evaluate(()=>window.fixture.state());
  await scroll(600);
  near((await state()).pinTop,0);
  await scroll(1030);
  await page.waitForFunction(()=>!window.fixture.link.snapping && Math.abs(window.scrollY-1100)<=1,null,{timeout:10000});
  const middle=await state();
  near(middle.pinTop,0);near(middle.x,5);
  await scroll(1700);
  near((await state()).pinTop,-100);
  // Element scrolling pins relative to its content box, including the border.
  await page.evaluate(()=>window.fixture.source.scrollTo({top:360,behavior:'instant'}));
  await page.waitForFunction(()=>!window.fixture.innerLink.snapping && Math.abs(window.fixture.source.scrollTop-400)<=1,null,{timeout:10000});
  const inner=await state();near(inner.inner,5);near(inner.innerTop,0);
  await page.evaluate(()=>{window.fixture.source.style.width='70%';window.fixture.innerLink.refresh();});
  near((await state()).innerTop,0);
  await scroll(1100);
  await page.evaluate(()=>window.fixture.refresh());
  near((await state()).pinTop,0);
  await page.evaluate(()=>window.fixture.stop());
  assert.equal(await page.evaluate(()=>window.fixture.pin.getAttribute('style')),await page.evaluate(()=>window.fixture.originalStyle));
  assert.equal(await page.evaluate(()=>window.fixture.pin.parentNode.tagName),'BODY');
  const held=(await state()).x;
  await scroll(0);
  assert.equal((await state()).x,held);
  assert.deepEqual(errors,[]);
  console.log('scroll pin: window/element pin positions, label/interval snap, refresh and abort restoration pass');
} finally {await app.close();}
