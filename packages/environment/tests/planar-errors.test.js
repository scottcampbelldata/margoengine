import test from 'node:test';
import assert from 'node:assert/strict';
import {Reflector} from '../dist/reflector.js';
import {Refractor} from '../dist/refractor.js';

test('planar surfaces refuse the native preview with a code and actionable help link',()=>{
  for(const Surface of [Reflector,Refractor]){
    const surface=new Surface();
    assert.throws(()=>surface.setup({backend:'webgl2'}),error=>
      error.code==='unsupported'&&error.message.includes('https://margoengine.com/errors#unsupported'));
    surface.dispose();
  }
});
