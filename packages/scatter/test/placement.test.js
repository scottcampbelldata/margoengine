import test from 'node:test';
import assert from 'node:assert/strict';
import {PlacementLayout, spacePlacements, clearPlacements, instanceTransforms, groundTransforms, placementBounds} from '../dist/index.js';

test('footprint spacing respects instance scale and visible gaps in any scene', () => {
  const candidates = [[10,-4,1,0],[11,-4,1,1],[12.3,-4,1,2],[15,-4,2,3],[16.8,-4,2,4],[10,0,0.5,5]];
  const before = structuredClone(candidates), placed = spacePlacements(candidates,1);
  assert.deepEqual(placed,[candidates[0],candidates[2],candidates[4],candidates[5]]);
  assert.deepEqual(candidates,before); assert.deepEqual(spacePlacements(candidates,1),placed);
  for (let i = 0; i < placed.length; i++) for (let j = 0; j < i; j++) {
    assert.ok(Math.hypot(placed[i][0]-placed[j][0],placed[i][1]-placed[j][1]) >= placed[i][2]+placed[j][2]+0.3);
  }
  assert.deepEqual(spacePlacements([[0,0,1,0],[2,0,1,0]],1,0),[[0,0,1,0],[2,0,1,0]],'Touching footprints are allowed with zero gap');
  assert.deepEqual(spacePlacements([],1),[]);
});

test('exclusions reject scaled footprints crossing edges and respect rectangle corners', () => {
  const candidates = [[1,1,1,0],[2.4,1,1,0],[3,1,1,0],[3.1,1,1,0],[2.8,2.8,1,0],[2.6,2.6,1,0],[3.5,1,2,0]];
  const before = structuredClone(candidates), exclusions = [[0,0,2,2]], boundsBefore = structuredClone(exclusions);
  assert.deepEqual(clearPlacements(candidates,1,exclusions),[candidates[3],candidates[4]]);
  assert.deepEqual(clearPlacements(candidates,1,[]),candidates);
  assert.deepEqual(candidates,before); assert.deepEqual(exclusions,boundsBefore);
  for (const bounds of [[0,0,0,2],[2,0,1,2],[0,2,2,1],[0,0,Infinity,2],[NaN,0,2,2],[0,0],[,,,],[1e9,0,1e9+1,2]]) {
    assert.throws(()=>clearPlacements([],1,[bounds]),/exclusion/);
  }
  assert.throws(()=>clearPlacements([[1,1,0,0]],1,exclusions),/placement/);
  assert.throws(()=>clearPlacements([],0,exclusions),/radius/);
});

test('spacing rejects invalid footprints and candidates even when they would be culled', () => {
  for (const radius of [0,-1,NaN,Infinity]) assert.throws(()=>spacePlacements([],radius),/radius/);
  for (const gap of [-1,NaN,Infinity]) assert.throws(()=>spacePlacements([],1,gap),/gap/);
  for (const candidate of [[0,0,0,0],[0,0,-1,0],[NaN,0,1,0],[0,Infinity,1,0],[0,0,1,NaN],[0,0,1],[,,,]]) {
    assert.throws(()=>spacePlacements([[0,0,1,0],candidate],1),/placement/);
  }
  assert.throws(()=>spacePlacements([[0,0,2,0]],Number.MAX_VALUE),/placement/);
});

test('circle exclusions include scaled footprints and optional clearance gaps',()=>{
 const candidates=[[1.6,0,1,0],[1.9,0,1,0],[3,0,2,0]];
 assert.deepEqual(clearPlacements(candidates,1,[[0,0,0.5]],0.3),[candidates[1],candidates[2]]);
 assert.throws(()=>clearPlacements([],1,[[0,0,-1]]),/circle/);
 assert.throws(()=>clearPlacements([],1,[],NaN),/gap/);
});

test('one layout reserves accepted assets and rejects later overlaps of any asset type', () => {
  const house = [[-3,-4,3,4]], layout = new PlacementLayout(house);
  house[0][2] = 100;
  assert.deepEqual(layout.place([[0,0,1,0],[4,0,1,0],[5,0,1,0]],1),[[5,0,1,0]],'House and whole rock footprint stay separate');
  assert.deepEqual(layout.place([[5,0,1,0],[6,0,1,0],[8,0,1,0],[8.5,0,1,0]],1),[[8,0,1,0]],'Ferns cannot stack on rocks or other crowns');
  assert.deepEqual(layout.place([[8,0,1,0],[11,0,1,0]],1),[[11,0,1,0]],'Later rock/bush calls respect earlier ferns');
  assert.equal(layout.exclusions.length,4); assert.deepEqual(layout.exclusions[0],[-3,-4,3,4]);
  const before = structuredClone(layout.exclusions);
  assert.throws(()=>layout.place([[1e39,0,1,0]],1),/exclusion/);
  assert.deepEqual(layout.exclusions,before,'Invalid input must not reserve space');
});

test('ground transforms sample world height and preserve yaw, scale and footprint bounds',()=>{
 const placements=[[2,3,2,Math.PI/2]],height=(x,z)=>x+z;
 const matrices=groundTransforms(placements,height,-0.2);
 assert.deepEqual(matrices,instanceTransforms([[2,4.8,3,2,Math.PI/2]]));
 assert.deepEqual(Array.from(matrices.slice(12,16)),[2,Math.fround(4.8),3,1]);
 assert.deepEqual(placementBounds(placements,1),[[0,1,4,5]]);
 assert.throws(()=>groundTransforms(placements,()=>NaN),/finite/);
 assert.throws(()=>instanceTransforms([[0,0,0,0,0]]),/placement/);
});
