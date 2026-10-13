import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TransformStore} from '../packages/core/dist/extension.js';
import {meshWorldMatrix as pointsMatrix} from '../packages/points/dist/index.js';
import {meshWorldMatrix as linesMatrix} from '../packages/lines/dist/index.js';
import {meshWorldMatrix as textMatrix} from '../packages/text/dist/index.js';

test('attached point, line and text overlays retain mesh matrices and follow ancestor visibility', async () => {
  const store=await TransformStore.create(8),engine=new Engine({width:64,height:64},store,{backend:'webgl2',add(){},remove(){},render(){},dispose(){}});
  const parent=engine.createMesh(),child=engine.createMesh(parent),unrelated=engine.createMesh();parent.position.x=2;child.position.y=3;store.tick(false);
  try{
    for(const matrix of [pointsMatrix,linesMatrix,textMatrix]){
      assert.deepEqual([...matrix(engine,child)], [...child.matrix]);parent.visible=false;assert.equal(matrix(engine,child),null,'Hidden ancestors must hide attached overlays');parent.visible=true;
      child.visible=false;assert.equal(matrix(engine,child),null);child.visible=true;unrelated.visible=false;assert.ok(matrix(engine,child));
      const subarray=Float32Array.prototype.subarray;let views=0;
      try{Float32Array.prototype.subarray=function(...args){if(this===store.matrices)views++;return subarray.apply(this,args);};for(let i=0;i<120;i++)assert.equal(matrix(engine,child),child.matrix);}
      finally{Float32Array.prototype.subarray=subarray;}
      assert.equal(views,0);child.position.x=4;store.tick(false);assert.equal(matrix(engine,child)[12],6);
    }
    child.dispose();for(const matrix of [pointsMatrix,linesMatrix,textMatrix])assert.equal(matrix(engine,child),null);
  }finally{engine.dispose();}
});
