import test from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';import {HTML} from '../dist/index.js';import {optionalGPU} from '../../../tests/support/optional-gpu.js';
test('HTML shares rendered depth, projects anchors, bounds capacity and removes DOM/resources',async()=>{
 const h=optionalGPU(),dom=new JSDOM('<body><canvas width="128" height="96"></canvas></body>');h.engine.canvas=dom.window.document.querySelector('canvas');
 const overlay=new HTML({capacity:1});h.engine.use(overlay);const label=overlay.add(dom.window.document.createElement('span'),{position:[0,0,0.5]});h.frame();await new Promise(resolve=>setImmediate(resolve));assert.equal(label.onScreen,true);assert.equal(h.counts.compute,1);assert.throws(()=>overlay.add(dom.window.document.createElement('span')),/capacity/);
 overlay.remove(label);assert.equal(label.element.isConnected,false);overlay.onDeviceRestored();h.frame();await new Promise(resolve=>setImmediate(resolve));overlay.dispose();assert.equal(dom.window.document.querySelector('[data-margoengine-labels]'),null);assert.ok(h.resources.every(r=>r.destroyed));dom.window.close();
});
