import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../packages/core/dist/engine.js';
import {TransformStore} from '../packages/core/dist/kernel.js';

test('HiDPI desktop MSAA avoids supersampling while phones retain DPR 2', async () => {
  const density=Object.getOwnPropertyDescriptor(globalThis,'devicePixelRatio');
  const navigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  try {
    for(const {ua,dpr,backend,css,expected} of [
      {ua:'Desktop',dpr:2,backend:'webgpu',css:[1440,900],expected:[1440,900]},
      {ua:'Desktop',dpr:1,backend:'webgpu',css:[1440,900],expected:[1440,900]},
      {ua:'Desktop',dpr:0.75,backend:'webgpu',css:[1440,900],expected:[1080,675]},
      {ua:'iPhone Mobile',dpr:3,backend:'webgpu',css:[390,844],expected:[780,1688]},
      {ua:'Android',dpr:1,backend:'webgpu',css:[390,844],expected:[390,844]},
      {ua:'Desktop',dpr:2,backend:'webgl2',css:[1440,900],expected:[1440,900]},
      {ua:'iPhone Mobile',dpr:3,backend:'webgl2',css:[390,844],expected:[780,1688]},
    ]) {
      Object.defineProperty(globalThis,'devicePixelRatio',{configurable:true,value:dpr});
      Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:ua}});
      const canvas={width:1,height:1,clientWidth:css[0],clientHeight:css[1]};
      const renderer={backend,add(){},remove(){},render(){},dispose(){}};
      const engine=new Engine(canvas,await TransformStore.create(1),renderer,undefined,null);
      try {engine.render();assert.deepEqual([canvas.width,canvas.height],expected,`${ua} DPR ${dpr} ${backend}`);}
      finally {engine.dispose();}
    }
  } finally {
    if(density)Object.defineProperty(globalThis,'devicePixelRatio',density);else delete globalThis.devicePixelRatio;
    if(navigator)Object.defineProperty(globalThis,'navigator',navigator);else delete globalThis.navigator;
  }
});
