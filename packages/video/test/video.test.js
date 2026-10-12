import test from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';import {Video} from '../dist/index.js';import {optionalGPU} from '../../../tests/support/optional-gpu.js';
test('video imports external frames without uploads and reuses frequency bins',()=>{
 const h=optionalGPU(),dom=new JSDOM('<video></video>'),old=globalThis.HTMLVideoElement;globalThis.HTMLVideoElement=dom.window.HTMLVideoElement;
 try{const source=dom.window.document.querySelector('video');Object.defineProperties(source,{videoWidth:{value:8},readyState:{value:2}});let connections=0,disconnections=0;
 const node={connect(){connections++;},disconnect(){disconnections++;}},analyser={fftSize:0,connect(){},disconnect(){},getByteFrequencyData(array){array[0]=42;}},audio={createMediaElementSource(){return node;},createAnalyser(){return analyser;},destination:{}};
 const video=new Video(source,{audio,fftSize:32});h.engine.use(video);h.frame();assert.equal(video.import(h.engine.gpu).source,source);assert.equal(video.sampleFrequency(),video.frequencies);assert.equal(video.frequencies[0],42);assert.equal(connections,2);
 video.onDeviceRestored(h.engine);h.frame();video.dispose();assert.equal(disconnections,2);assert.ok(h.resources.every(r=>r.destroyed));assert.equal(source.paused,true);assert.throws(()=>video.import(h.engine.gpu),/disposed/);
 assert.throws(()=>new Video(source,{fftSize:17}),/FFT/);
 }finally{globalThis.HTMLVideoElement=old;dom.window.close();}
});
test('multiple overlays share one audible media route and release only their own analysis branch',()=>{
 const dom=new JSDOM('<video></video>'),old=globalThis.HTMLVideoElement;globalThis.HTMLVideoElement=dom.window.HTMLVideoElement;
 try{
  const source=dom.window.document.querySelector('video'),destination={},connections=[],disconnections=[];let created=0;
  const node={connect(target){connections.push(target);},disconnect(target){disconnections.push(target);}},audio={destination,createMediaElementSource(){created++;return node;},createAnalyser(){return {connect(){assert.fail('Analysis must not create another audible route');},disconnect(){},getByteFrequencyData(){}};}};
  const first=new Video(source,{audio}),second=new Video(source,{audio});assert.equal(created,1);assert.equal(connections.filter(v=>v===destination).length,1);
  assert.throws(()=>new Video(source,{audio:{...audio}}),/different AudioContext/);
  first.dispose();assert.equal(disconnections.includes(destination),false);second.dispose();assert.equal(disconnections.filter(v=>v===destination).length,1);
  const third=new Video(source,{audio});assert.equal(created,1);assert.equal(connections.filter(v=>v===destination).length,2);third.dispose();
 }finally{globalThis.HTMLVideoElement=old;dom.window.close();}
});
