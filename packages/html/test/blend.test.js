import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { HTMLBlend } from '../dist/blend.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('HTMLBlend punches zero RGBA with scene depth, shares canvas ownership and restores styles and alpha', () => {
  const h=optionalGPU(),dom=new JSDOM('<body><canvas width="128" height="96" style="position:absolute;z-index:8;pointer-events:auto"></canvas></body>');
  const canvas=dom.window.document.querySelector('canvas');
  h.engine.canvas=canvas;
  let configuration={device:h.engine.gpu,format:'rgba8unorm',alphaMode:'opaque',colorSpace:'display-p3'};
  canvas.getContext=()=>({getConfiguration:()=>configuration,configure:(value)=>{configuration=value;}});
  const a=HTMLBlend.attach(h.engine),b=HTMLBlend.attach(h.engine,{name:'second-mask'});
  assert.equal(configuration.alphaMode,'premultiplied');
  assert.equal(configuration.colorSpace,'display-p3');
  assert.equal(canvas.style.pointerEvents,'none');
  const element=dom.window.document.createElement('button');
  Object.defineProperties(element,{offsetWidth:{get:()=>200},offsetHeight:{get:()=>100}});
  const object=a.add3D(element,{position:[0,0,0.5]});
  h.frame();
  assert.equal(object.onScreen,true);
  assert.ok(h.counts.render>0);
  const pipeline=h.pipelines.at(-1);
  assert.equal(pipeline.fragment.targets[0].blend,undefined,'Replace all RGBA, including alpha');
  assert.equal(pipeline.depthStencil.depthWriteEnabled,true);
  a.dispose();
  assert.equal(element.isConnected,false);
  assert.equal(canvas.style.pointerEvents,'none','Second renderer retains ownership');
  b.dispose();
  assert.equal(canvas.style.position,'absolute');
  assert.equal(canvas.style.zIndex,'8');
  assert.equal(canvas.style.pointerEvents,'auto');
  assert.equal(configuration.alphaMode,'opaque');
  assert.ok(h.resources.every(r=>r.destroyed));
  dom.window.close();
});

test('HTMLBlend refuses an opaque preview before changing DOM or canvas styles',()=>{
  const h=optionalGPU(),dom=new JSDOM('<body><canvas></canvas></body>');
  h.engine.gpu=undefined;
  h.engine.canvas=dom.window.document.querySelector('canvas');
  h.engine.canvas.getContext=()=>({getContextAttributes:()=>({alpha:false})});
  assert.throws(()=>HTMLBlend.attach(h.engine),{code:'unsupported'});
  assert.equal(h.engine.canvas.style.zIndex,'');
  assert.equal(dom.window.document.querySelector('[data-margoengine-labels]'),null);
  dom.window.close();
});
