import test from 'node:test';
import assert from 'node:assert/strict';
import {randomPlacements, radialPlacements, PlacementLayout} from '../dist/index.js';

test('shared candidates stay in their supplied rectangle or ring and are deterministic', () => {
  const bounds = [10,20,20,30], centers = [[0,0],[10,10]], before = structuredClone(centers);
  const box = randomPlacements(20,bounds,[0.5,1],731), ring = radialPlacements(centers,4,[2,3],[0.5,1],731);
  assert.deepEqual(box,randomPlacements(20,bounds,[0.5,1],731)); assert.deepEqual(ring,radialPlacements(centers,4,[2,3],[0.5,1],731)); assert.equal(ring.length,8); assert.deepEqual(centers,before);
  for (const [x,z,s,yaw] of box) assert.ok(x>=10&&x<=20&&z>=20&&z<=30&&s>=0.5&&s<=1&&yaw>=0&&yaw<2*Math.PI);
  for (let i = 0; i < ring.length; i++) {const [x,z] = ring[i], [a,b] = centers[Math.floor(i/4)]; assert.ok(Math.hypot(x-a,z-b)>=2&&Math.hypot(x-a,z-b)<=3);}
  const layout = new PlacementLayout(); assert.ok(layout.place(ring,1).length<ring.length);
  assert.throws(()=>randomPlacements(-1,bounds,[1,1]),/count/); assert.throws(()=>randomPlacements(1,bounds,[0,1]),/scale/);
  assert.throws(()=>radialPlacements([[NaN,0]],1,[1,2],[1,1]),/center/); assert.throws(()=>radialPlacements([],1,[2,1],[1,1]),/distance/);
});
