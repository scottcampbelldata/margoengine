import test from 'node:test';
import assert from 'node:assert/strict';
import {stepLocomotion} from '../src/motion.ts';

test('locomotion reuses buffers, normalizes diagonals, follows ground and bounds the island', () => {
  const straight = new Float32Array(8), diagonal = new Float32Array(8), input = new Float32Array([0,1,0,0,0]);
  const ground = (x,z) => 2 + x*0.02 + z*0.01;
  for (let i=0;i<120;i++) stepLocomotion(straight,input,1/60,ground);
  input[0] = 1;
  for (let i=0;i<120;i++) stepLocomotion(diagonal,input,1/60,ground);
  assert.ok(Math.abs(Math.hypot(diagonal[0],diagonal[2])-Math.abs(straight[2]))<1e-4);
  assert.ok(Math.abs(diagonal[1]-ground(diagonal[0],diagonal[2]))<1e-6);
  const buffer = diagonal.buffer; input[2]=100;input[3]=100;input[4]=1;
  for(let i=0;i<3000;i++) stepLocomotion(diagonal,input,0.1,ground);
  assert.equal(diagonal.buffer,buffer); assert.ok(diagonal.every(Number.isFinite));
  assert.ok(Math.abs(diagonal[0])<=69 && Math.abs(diagonal[2])<=69); assert.equal(diagonal[5],Math.fround(0.9));
  input.fill(0); for(let i=0;i<120;i++) stepLocomotion(diagonal,input,1/60,ground);
  assert.ok(diagonal[7]<1e-6);
});

test('heading takes the shortest turn across the angular seam and a zero tick leaves motion unchanged', () => {
  const state=new Float32Array([0,2,0,Math.PI-0.01,0,0.3,0,0]);
  const input=new Float32Array([-0.01,1,0,0,0]);
  const before=state.slice(); stepLocomotion(state,input,0,()=>2);assert.deepEqual(state,before);
  stepLocomotion(state,input,1/60,()=>2);assert.ok(Math.abs(state[3]-before[3])<0.02);
});
