import assert from 'node:assert/strict';
import test from 'node:test';
import { performanceSessionOptions, XRPerformance } from '../dist/performance.js';
function fixture({compat=false,foveation=.25,features=['camera-access']}={}){
 const session=new EventTarget();session.enabledFeatures=features;
 const layer={fixedFoveation:foveation},gl={};
 const host={session,projectionLayer:compat?{baseLayer:layer}:layer,layerBinding:{device:compat?{gl}:{},binding:{}}};
 return {session,layer,host,gl};
}
test('performance negotiation preserves options and merges camera features without mutation',()=>{
 const base={referenceSpace:'local-floor',requiredFeatures:['hand-tracking'],optionalFeatures:['camera-access','anchors'],init:{custom:true},framebufferScale:.75};
 const result=performanceSessionOptions({cameraAccess:'required'},base);
 assert.equal(result.framebufferScale,.75);assert.deepEqual(result.requiredFeatures,['hand-tracking','camera-access']);
 assert.deepEqual(result.optionalFeatures,['anchors']);assert.deepEqual(base.optionalFeatures,['camera-access','anchors']);assert.deepEqual(result.init,{custom:true});
 const optional=performanceSessionOptions({cameraAccess:'optional',framebufferScale:.5},{requiredFeatures:['camera-access']});
 assert.deepEqual(optional.requiredFeatures,['camera-access']);assert.deepEqual(optional.optionalFeatures,[]);assert.equal(optional.framebufferScale,.5);
 assert.equal(performanceSessionOptions().framebufferScale,undefined);
});
test('invalid scale and camera request fail before session work',()=>{
 for(const framebufferScale of [0,-1,NaN,Infinity,1e308,1e-100])assert.throws(()=>performanceSessionOptions({framebufferScale}),RangeError);
 assert.throws(()=>performanceSessionOptions({cameraAccess:true}),TypeError);
});
for(const compat of [false,true])test(`foveation targets the ${compat?'base WebGL':'native projection'} layer and restores it`,()=>{
 const f=fixture({compat}),performance=XRPerformance.attach(f.host,{fixedFoveation:.8});
 assert.equal(f.layer.fixedFoveation,.8);performance.fixedFoveation=0;assert.equal(performance.fixedFoveation,0);
 for(const value of [-.1,1.1,NaN,Infinity])assert.throws(()=>{performance.fixedFoveation=value;},RangeError);
 performance.dispose();performance.dispose();assert.equal(f.layer.fixedFoveation,.25);assert.throws(()=>performance.fixedFoveation,/disposed/);
});
test('unsupported foveation remains observable and rejects explicit writes',()=>{
 const f=fixture({foveation:null}),performance=XRPerformance.attach(f.host);
 assert.equal(performance.fixedFoveation,null);assert.throws(()=>{performance.fixedFoveation=.5;},/no fixed foveation/);performance.dispose();
});
test('abort restores active foveation while session end never writes a destroyed layer',()=>{
 const f=fixture(),controller=new AbortController(),performance=XRPerformance.attach(f.host,{fixedFoveation:.8,signal:controller.signal});
 controller.abort();assert.equal(f.layer.fixedFoveation,.25);assert.throws(()=>performance.fixedFoveation,/disposed/);
 const other=fixture();XRPerformance.attach(other.host,{fixedFoveation:.9});other.host.session=null;
 Object.defineProperty(other.layer,'fixedFoveation',{get(){return .9;},set(){throw new Error('destroyed layer write');}});
 assert.doesNotThrow(()=>other.session.dispatchEvent(new Event('end')));
});
test('camera textures are borrowed from the active compatibility context',t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'XRWebGLBinding');
 t.after(()=>previous?Object.defineProperty(globalThis,'XRWebGLBinding',previous):delete globalThis.XRWebGLBinding);
 const f=fixture({compat:true}),texture={},camera={width:640,height:480};let calls=0,created=0;
 globalThis.XRWebGLBinding=class {
  constructor(session,gl){assert.equal(session,f.session);assert.equal(gl,f.gl);created++;}
  getCameraImage(value){assert.equal(value,camera);calls++;return texture;}
 };
 const performance=XRPerformance.attach(f.host),image=performance.cameraImage({camera});
 assert.equal(image.texture,texture);assert.equal(image.context,f.gl);assert.equal(image.camera,camera);
 performance.cameraImage({camera});assert.equal(created,1);assert.equal(calls,2);assert.equal(performance.cameraImage({camera:null}),null);performance.dispose();
});
test('native WebGPU raw camera access and missing browser permission fail explicitly',()=>{
 const f=fixture(),performance=XRPerformance.attach(f.host);
 assert.throws(()=>performance.cameraImage({camera:{width:1,height:1}}),/WebGL textures/);performance.dispose();
 const other=fixture({compat:true,features:[]}),denied=XRPerformance.attach(other.host);
 assert.throws(()=>denied.cameraImage({camera:null}),/no camera-access feature/);denied.dispose();
});
test('native session end never restores a layer even when a structural host retains the old session',()=>{const f=fixture();XRPerformance.attach(f.host,{fixedFoveation:.8});Object.defineProperty(f.layer,'fixedFoveation',{get(){return .8;},set(){throw new Error('write after end');}});assert.doesNotThrow(()=>f.session.dispatchEvent(new Event('end')));});
