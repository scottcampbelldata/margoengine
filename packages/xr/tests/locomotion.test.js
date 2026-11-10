import assert from 'node:assert/strict';
import test from 'node:test';
import { SmoothLocomotion } from '../dist/locomotion.js';
const identity=()=>new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
function fixture(options={}) {
  const prev=globalThis.XRRigidTransform;
  globalThis.XRRigidTransform=class {constructor(position,orientation){this.position=position;this.orientation=orientation;}};
  const frameListeners=new Set(), eyeListeners=new Set(),offsets=[];
  const space={getOffsetReferenceSpace(t){offsets.push(t);return space;}};
  const session=new EventTarget();
  const host={session,referenceSpace:space,onFrame(fn){frameListeners.add(fn);return()=>frameListeners.delete(fn);},
    onEye(fn){eyeListeners.add(fn);return()=>eyeListeners.delete(fn);},useReferenceSpace(s){this.referenceSpace=s;}};
  const player=SmoothLocomotion.attach(host,options);
  const viewer={transform:{matrix:identity(),position:{x:3,y:1.7,z:4}}};
  const left={handedness:'left',gamepad:{connected:true,axes:[0,0,0,-1]}},right={handedness:'right',gamepad:{connected:true,axes:[0,0,0,0]}};
  const state={delta:.1,frame:{session},viewer,inputs:[{source:left,grip:viewer},{source:right,grip:viewer}]};
  return {player,host,state,left,right,offsets,frameListeners,eyeListeners,
    step(){for(const fn of frameListeners)fn(state);},
    dispose(){player.dispose();globalThis.XRRigidTransform=prev;}};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
test('standard thumbstick forward advances at metres per second independently of head height',()=>{
 const f=fixture();try{f.step();near(f.offsets[0].position.x,0);near(f.offsets[0].position.z,.2);near(f.offsets[0].position.y,0);}finally{f.dispose();}
});
test('dead zone suppresses drift and remaps the remaining radial interval',()=>{
 const f=fixture({deadZone:.2});try{f.left.gamepad.axes=[0,0,.1,.1];f.step();assert.equal(f.offsets.length,0);
 f.left.gamepad.axes=[0,0,.6,0];f.step();near(f.offsets[0].position.x,-.1);}finally{f.dispose();}
});
test('diagonal input never moves faster than axial input',()=>{
 const f=fixture();try{f.left.gamepad.axes=[0,0,1,-1];f.step();const p=f.offsets[0].position;near(Math.hypot(p.x,p.z),.2);}finally{f.dispose();}
});
test('head yaw rotates travel while vertical head direction cannot introduce NaNs',()=>{
 const f=fixture();try{f.state.viewer.transform.matrix.set([0,0,-1,0,0,1,0,0,1,0,0,0,0,0,0,1]);f.step();near(f.offsets[0].position.x,.2);
 f.state.viewer.transform.matrix[8]=0;f.state.viewer.transform.matrix[10]=0;f.step();assert.equal(f.offsets.length,1);}finally{f.dispose();}
});
test('controller-oriented travel uses the moving hand grip',()=>{
 const f=fixture({direction:'controller'});try{f.state.inputs[0].grip={transform:{matrix:identity()}};
 f.state.viewer.transform.matrix[8]=1;f.state.viewer.transform.matrix[10]=0;f.step();near(f.offsets[0].position.z,.2);}finally{f.dispose();}
});
test('smooth right turn rotates about tracked feet and keeps room-scale translation',()=>{
 const f=fixture();try{f.left.gamepad.axes.fill(0);f.right.gamepad.axes[2]=1;f.step();const t=f.offsets[0];near(t.orientation.y,Math.sin(Math.PI/40));
 const a=Math.PI/20,c=Math.cos(a),s=Math.sin(a);near(t.position.x,3-c*3-s*4);near(t.position.z,4+s*3-c*4);}finally{f.dispose();}
});
test('teleport and snap turning coexist with subsequent smooth motion',()=>{
 const f=fixture();try{f.step();f.player.teleport([5,2,6]);f.player.turn(.4);assert.equal(f.offsets.length,3);
 f.state.viewer.transform.position={x:5,y:3.7,z:6};f.step();near(f.offsets.at(-1).position.y,0);}finally{f.dispose();}
});
test('lost tracking, disconnected input and invalid axes do not move',()=>{
 const f=fixture();try{f.left.gamepad.connected=false;f.step();assert.equal(f.offsets.length,0);
 f.left.gamepad.connected=true;f.left.gamepad.axes[3]=NaN;f.step();assert.equal(f.offsets.length,0);
 f.state.viewer=null;f.step();assert.equal(f.offsets.length,0);}finally{f.dispose();}
});
test('long frames are clamped and nonfinite deltas do no work',()=>{
 const f=fixture();try{f.state.delta=12;f.step();near(f.offsets[0].position.z,.2);f.state.delta=NaN;f.step();assert.equal(f.offsets.length,1);}finally{f.dispose();}
});
test('comfort ramps with movement and fades when disabled',()=>{
 const f=fixture();try{f.step();const before=f.player.comfort;assert.ok(before>0&&before<1);f.player.enabled=false;f.step();assert.ok(f.player.comfort<before);assert.equal(f.offsets.length,1);}finally{f.dispose();}
});
test('abort and double disposal remove every subscription and terminal operations reject',()=>{
 const signal=new AbortController(),f=fixture({signal:signal.signal});try{signal.abort();f.player.dispose();assert.equal(f.frameListeners.size,0);assert.equal(f.eyeListeners.size,0);assert.throws(()=>f.player.turn(.1),/disposed/);}finally{f.dispose();}
});
test('invalid options fail before any subscription',()=>{
 let subs=0;const host={onFrame(){subs++;}};
 for(const options of [{speed:NaN},{deadZone:1},{axes:[2,2]},{fade:-1},{fieldOfView:4},{direction:'up'}])assert.throws(()=>SmoothLocomotion.attach(host,options));
 assert.equal(subs,0);
});

test('vertical turn-stick input cannot make horizontal drift turn the viewer',()=>{
 const f=fixture();try{f.left.gamepad.axes.fill(0);f.right.gamepad.axes=[0,0,.1,1];f.step();assert.equal(f.offsets.length,0);}finally{f.dispose();}
});
test('zero movement speeds keep the comfort view open',()=>{
 const f=fixture({speed:0,turnSpeed:0});try{f.step();assert.equal(f.offsets.length,0);assert.equal(f.player.comfort,0);}finally{f.dispose();}
});
test('session end removes hooks before a new reference-space origin can be used',()=>{
 const f=fixture();try{f.player.teleport([5,2,6]);f.host.session.dispatchEvent(new Event('end'));assert.equal(f.frameListeners.size,0);assert.equal(f.eyeListeners.size,0);assert.throws(()=>f.player.teleport([0,0,0]),/disposed/);}finally{f.dispose();}
});
test('a zero-length frame keeps the comfort vignette while the stick is held, even with fade 0',()=>{
 const f=fixture({fade:0});try{f.step();assert.equal(f.player.comfort,1);f.state.delta=0;f.step();assert.equal(f.player.comfort,1);
 f.state.delta=NaN;f.step();assert.equal(f.player.comfort,1);assert.equal(f.offsets.length,1);}finally{f.dispose();}
});
