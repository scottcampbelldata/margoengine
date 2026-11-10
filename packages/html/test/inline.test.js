import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { inlineResources, resourceInliner } from '../dist/inline.js';
import { HTMLTexture } from '../dist/texture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('resource inlining copies styles and live forms, resolves CSS/image/font URLs and deduplicates fetches',async()=>{
  const dom=new JSDOM(`<head><style>
    @font-face {font-family:Panel;src:url('/fonts/panel.woff2') format('woff2');font-weight:400}
    @font-face {font-family:Unused;src:url('/unused.woff2')}
    </style></head><body><div style="font-family:Panel;background-image:url('/images/panel.png')">
    <img src="/images/panel.png" srcset="/other.png 2x"><textarea>old</textarea><input type=checkbox checked>
    </div></body>`,{url:'https://app.example/page/index.html'});
  const element=dom.window.document.querySelector('div'),textarea=element.querySelector('textarea');
  textarea.value='current';element.querySelector('input').checked=false;
  const original=element.outerHTML,fetches=[],prior=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    fetches.push({url,options});
    return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':url.endsWith('.woff2')?'font/woff2':'image/png'}});
  };
  try {
    const copy=await inlineResources(element);
    assert.equal(element.outerHTML,original,'Live tree was mutated');
    assert.equal(copy.isConnected,false);
    assert.match(copy.querySelector('img').getAttribute('src'),/^data:image\/png;base64,AQID$/);
    assert.equal(copy.querySelector('img').hasAttribute('srcset'),false);
    assert.match(copy.style.backgroundImage,/data:image\/png;base64,AQID/);
    assert.match(copy.querySelector('style').textContent,/data:font\/woff2;base64,AQID/);
    assert.equal(copy.querySelector('textarea').textContent,'current','Regression: old textarea text must not be appended to live value');
    assert.equal(copy.querySelector('input').hasAttribute('checked'),false);
    assert.deepEqual(fetches.map(f=>f.url).sort(),['https://app.example/fonts/panel.woff2','https://app.example/images/panel.png']);
    assert.ok(fetches.every(f=>f.options.mode==='cors'&&f.options.credentials==='same-origin'&&f.options.signal));
  } finally {globalThis.fetch=prior;dom.window.close();}
});

test('explicit font CSS, CSS quoting, SVG image fragments and data URLs are preserved correctly',async()=>{
  const dom=new JSDOM('<body><div style="font-family:Panel"><svg><image href="/image.svg#part"/></svg><img src="data:image/png;base64,AQID"></div></body>',{url:'https://app.example/'});
  const element=dom.window.document.querySelector('div'),prior=globalThis.fetch,urls=[];
  globalThis.fetch=async url=>{urls.push(url);return new Response('abc',{headers:{'content-type':'image/svg+xml'}});};
  try {
    const copy=await inlineResources(element,{fontCSS:`@font-face {font-family:Panel;src:url("font)name.woff2") format("woff2");}`});
    assert.equal(copy.querySelector('image').getAttribute('href'),'data:image/svg+xml;base64,YWJj#part');
    assert.equal(copy.querySelector('img').getAttribute('src'),'data:image/png;base64,AQID');
    assert.deepEqual(urls.sort(),['https://app.example/font)name.woff2','https://app.example/image.svg']);
  } finally {globalThis.fetch=prior;dom.window.close();}
});

test('failed and cancelled resources reject instead of producing a partial snapshot',async()=>{
  const dom=new JSDOM('<body><div><img src="/fail.png"></div></body>',{url:'https://app.example/'}),
    element=dom.window.document.querySelector('div'),prior=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response('',{status:403});
    await assert.rejects(inlineResources(element),error=>error.code==='failed'&&/403.*CORS/.test(error.message));
    const stopped=new AbortController(),reason=new Error('cancelled snapshot');stopped.abort(reason);
    await assert.rejects(resourceInliner({signal:stopped.signal})(element,new AbortController().signal),error=>error===reason);
    globalThis.fetch=(_url,{signal})=>new Promise((_resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('mock fetch failed to observe its signal')),1000);
      signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
    });
    await assert.rejects(inlineResources(element,{timeout:1}),{name:'TimeoutError'});
    await assert.rejects(inlineResources(element,{timeout:0}),RangeError);
  } finally {globalThis.fetch=prior;dom.window.close();}
});

test('imported font sheets resolve from their own URLs, stop cycles and ignore URL-looking string content',async()=>{
  const dom=new JSDOM('<body><div style="font-family:Panel"></div></body>',{url:'https://app.example/page/'}),
    element=dom.window.document.querySelector('div'),prior=globalThis.fetch,urls=[];
  element.style.content='"url(/not-an-image.png)"';
  globalThis.fetch=async url=>{
    urls.push(url);
    return url.endsWith('/font.woff2')?new Response('font',{headers:{'content-type':'font/woff2'}}):
      new Response(url.endsWith('/a.css')?'@import "nested/b.css";':
        '@import "../a.css"; @font-face {font-family:Panel;src:url("../font.woff2")}');
  };
  try {
    const copy=await inlineResources(element,{fontCSS:'@import url("/css/a.css");'});
    assert.match(copy.querySelector('style').textContent,/data:font\/woff2/);
    assert.deepEqual(urls,['https://app.example/css/a.css','https://app.example/css/nested/b.css','https://app.example/css/font.woff2']);
    assert.match(copy.style.content,/not-an-image/);
  } finally {globalThis.fetch=prior;dom.window.close();}
});

test('removing an HTML surface cancels pending preparation without reporting expected cancellation as a page error',async()=>{
  const h=optionalGPU(),dom=new JSDOM('<body><canvas></canvas></body>');
  h.engine.canvas=dom.window.document.querySelector('canvas');
  let signal;
  const textures=HTMLTexture.attach(h.engine,{rasterizer:'foreign-object',prepare:(_element,removal)=>{
    signal=removal;
    return new Promise((_resolve,reject)=>removal.addEventListener('abort',()=>reject(removal.reason),{once:true}));
  }});
  const surface=textures.add(dom.window.document.createElement('div'),{width:1,height:1});
  h.frame();assert.equal(surface.busy,true);surface.remove();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(signal.aborted,true);assert.equal(surface.draws,0);
  textures.dispose();dom.window.close();
});
