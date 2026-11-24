import test from 'node:test';
import assert from 'node:assert/strict';
import React, {StrictMode} from 'react';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><body></body>',{url:'http://localhost'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(document,'hidden',{value:false,configurable:true});
const {render,act,cleanup}=await import('@testing-library/react');
const {Engine}=await import('@margoengine/core/extension');
const {Context}=await import('../dist/internal.js');
const {advanceFrames,bridgeFrames,FrameCallbacks}=await import('../dist/frame-priority.js');
const {PerformanceMonitor,usePerformanceMonitor}=await import('@margoengine/react/performance');
test('StrictMode monitor hooks measure committed samples, update callbacks and release all frame listeners',async()=>{
  const engine=await Engine.create(document.createElement('canvas'),{backend:'webgl2',fallback:()=>({backend:'webgl2',add(){},remove(){},render(){},dispose(){}})});
  const frames={elapsed:0,last:null,mode:'always',callbacks:new FrameCallbacks()},value={engine,frames};
  const release=bridgeFrames(engine,frames),events=[];let snapshot,measured=50;
  function Child(){snapshot=usePerformanceMonitor({onChange:s=>events.push(s.factor)});return null;}
  const tree=label=>React.createElement(StrictMode,null,React.createElement(Context.Provider,{value},React.createElement(PerformanceMonitor,{ms:10,iterations:1,step:0.5,sample:()=>measured,onChange:()=>events.push(label)},React.createElement(Child))));
  let view;
  try {
    await act(async()=>{view=render(tree('old'));});
    assert.equal(frames.callbacks.size,1);
    await act(async()=>advanceFrames(frames,engine,0.016));assert.equal(snapshot.factor,0.5);
    await act(async()=>view.rerender(tree('new')));
    await act(async()=>advanceFrames(frames,engine,0.016));assert.equal(snapshot.factor,0);
    measured=10;await act(async()=>{advanceFrames(frames,engine,0.016);advanceFrames(frames,engine,0.016);});assert.equal(snapshot.factor,1);
    assert.deepEqual(events,['old',0.5,'new',0,'new',0.5,'new',1]);
    await act(async()=>view.unmount());assert.equal(frames.callbacks.size,0);
  } finally {cleanup();release();engine.dispose();}
});
