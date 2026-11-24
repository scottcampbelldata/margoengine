import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { HTMLTextureGL } from '../dist/texture-gl.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('HTMLTextureGL attaches to preview without a GPU and retains surface lifecycle and pointer hit routing', () => {
  const h = optionalGPU(), dom = new JSDOM('<body><canvas></canvas></body>');
  h.engine.canvas = dom.window.document.querySelector('canvas');
  h.engine.gpu = undefined;
  const textures = HTMLTextureGL.attach(h.engine, {rasterizer:'foreign-object'});
  const surface = textures.add(dom.window.document.createElement('button'), {width:2,height:1});
  assert.equal(textures.size,1);
  assert.equal(surface.element.parentElement.style.opacity,'0');
  surface.remove();
  assert.equal(textures.size,0);
  assert.equal(surface.element.isConnected,false);
  textures.dispose();
  assert.throws(()=>textures.add(dom.window.document.createElement('div')), {code:'disposed'});
  dom.window.close();
});
