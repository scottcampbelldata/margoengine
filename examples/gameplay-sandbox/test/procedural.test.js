import test from 'node:test';
import assert from 'node:assert/strict';
import {MATERIALS, CABIN_POSITION} from '../src/procedural/meshes.ts';
import {generateCabinMesh, ROOF_PITCH} from '@margoengine/procedural';
import {SHRUB_CANDIDATES, FERN_CANDIDATES, ROCK_CANDIDATES, CABIN_EXCLUSIONS, TREE_POSITIONS} from '../src/procedural/placement.ts';
import {pbrVertexStream as vertexStream, footprintRadius} from '@margoengine/geometry';
import {PlacementLayout, instanceTransforms} from '@margoengine/scatter';
import {terrainHeight, ISLAND_SIZE} from '../src/scene.ts';
import {heightfieldGeometry} from '@margoengine/terrain';
import {createProceduralSettlement} from '../src/procedural/index.ts';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';
import {generateShrubMesh, generateFernMesh, generateRockMesh, contactAO} from '@margoengine/procedural';

test('landscape uses recomputed Y-up normals after height displacement', () => {
  const data = heightfieldGeometry(terrainHeight,{size: [ISLAND_SIZE,ISLAND_SIZE], resolution: 32}); let varied = false;
  for (let i = 0; i < data.normals.length; i += 3) {
    assert.ok(data.normals[i+1] > 0.2);
    assert.ok(Math.abs(Math.hypot(...data.normals.subarray(i,i+3))-1)<1e-6);
    if (Math.abs(data.normals[i])+Math.abs(data.normals[i+2])>0.1) varied = true;
  }
  assert.ok(varied,'Terrain slope contributes to its lighting normals');
});

function check(data) {
  assert.ok(data.positions instanceof Float32Array); assert.ok(data.indices instanceof Uint32Array);
  const vertices = vertexStream(data), count = data.positions.length/3;
  assert.equal(vertices.byteLength/count,80); assert.ok(vertices.every(Number.isFinite));
  for (let v = 0; v < count; v++) {
    const n = data.normals.subarray(v*3,v*3+3), t = data.tangents.subarray(v*4,v*4+4);
    assert.ok(Math.abs(Math.hypot(...n)-1)<1e-5); assert.ok(Math.abs(Math.hypot(...t.subarray(0,3))-1)<1e-5);
    assert.ok(Math.abs(n[0]*t[0]+n[1]*t[1]+n[2]*t[2])<1e-5); assert.ok(Math.abs(t[3])===1);
  }
  for (let i = 0; i < data.indices.length; i += 3) {
    const [a,b,c] = data.indices.subarray(i,i+3); assert.ok(Math.max(a,b,c)<count);
    const p = data.positions, u = [0,1,2].map(k=>p[b*3+k]-p[a*3+k]), v = [0,1,2].map(k=>p[c*3+k]-p[a*3+k]);
    assert.ok(Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])>1e-9,'Nondegenerate triangle');
  }
}

test('cabin has hard face normals, UV-derived tangent frames, recessed openings and a grounded 35 degree roof', () => {
  const cabin = generateCabinMesh(terrainHeight,CABIN_POSITION);
  for (const data of [cabin.siding,cabin.roof,cabin.foundation,cabin.glass]) check(data);
  for (const data of [cabin.roof,cabin.foundation,cabin.glass]) {
    for (let i = 0; i < data.indices.length; i += 3) {
      const ids = data.indices.subarray(i,i+3);
      for (const v of ids) for (let k = 0; k < 3; k++) assert.equal(data.normals[v*3+k],data.normals[ids[0]*3+k]);
    }
  }
  const corners = new Map(); let hardCorners = 0;
  for (let v = 0; v < cabin.siding.positions.length/3; v++) {
    const key = Array.from(cabin.siding.positions.subarray(v*3,v*3+3)).join(','), n = Array.from(cabin.siding.normals.subarray(v*3,v*3+3));
    if (corners.has(key) && Math.abs(corners.get(key).reduce((sum,value,k)=>sum+value*n[k],0))<1e-5) hardCorners++;
    else corners.set(key,n);
  }
  assert.ok(hardCorners>100,'Architectural corners retain split face normals');
  assert.ok(cabin.floor>3); assert.equal(MATERIALS.siding.roughness,0.88);
  assert.ok(Array.from(cabin.roof.normals).some(n=>Math.abs(n-Math.cos(ROOF_PITCH))<1e-6));
  // Door and front window are true gaps in the outer siding plane.
  for (let i = 0; i < cabin.siding.indices.length; i += 3) {
    const ids = cabin.siding.indices.subarray(i,i+3), p = cabin.siding.positions;
    const x = ids.reduce((s,v)=>s+p[v*3]/3,0), y = ids.reduce((s,v)=>s+p[v*3+1]/3,0), z = ids.reduce((s,v)=>s+p[v*3+2]/3,0);
    if (Math.abs(z-4.11)<1e-5 && y<3.1) {
      assert.ok(!(x>0.455 && x<1.345 && y>0.13 && y<2.17),'Door opening');
      assert.ok(!(x>-1.89 && x<-1.11 && y>1.36 && y<2.34),'Window opening');
    }
  }
  const p = cabin.glass.positions;
  assert.equal(p.length/3,6*24,'Six recessed panes');
  assert.ok(Array.from(p).some((v,i)=>i%3===2&&Math.abs(v-4.03)<1e-5),'Pane lies 8 cm behind siding');
  assert.ok(Math.max(...Array.from(cabin.roof.positions).filter((_v,i)=>i%3===0))>=3.51,'Roof overhang is at least 40 cm beyond siding');
  assert.ok(Math.max(...Array.from(cabin.roof.positions).filter((_v,i)=>i%3===2))>=4.51);
  assert.throws(()=>generateCabinMesh(()=>NaN),/terrain/);
});

test('settlement uploads baked AO and calibrated materials, registers shadows and adds no frame callback', () => {
  const h = optionalGPU(), casters = [];
  const {scatter, exclusions, porchLightPosition} = createProceduralSettlement(h.engine,{add:(source,options)=>casters.push({source,options})},terrainHeight);
  assert.equal(scatter.batches.length,12); assert.deepEqual(casters,[{source:scatter,options:undefined}]);
  assert.deepEqual(porchLightPosition,[CABIN_POSITION[0]+0.9,generateCabinMesh(terrainHeight,CABIN_POSITION).floor+2.35,CABIN_POSITION[1]+5.3]);
  assert.ok(exclusions.length>30,'Landscape rocks reserve the building and plant footprints');
  assert.equal(scatter.batches.find(b=>b.name.includes('fern crowns')).instances,8);
  assert.equal(scatter.batches.find(b=>b.name.includes('fieldstones')).instances,2);
  const colors = [], materials = [];
  for (const buffer of h.resources) {
    if (buffer.usage!==40) continue;
    const values = new Float32Array(buffer.data);
    if (buffer.size%80===0 && scatter.batches.some(b=>b.vertices*80===buffer.size)) {
      for (let i = 19; i < values.length; i += 20) colors.push(values[i]);
    }
    if (buffer.size===128) materials.push(Array.from(values.subarray(16,24)));
  }
  assert.ok(colors.every(ao=>ao>=0.19&&ao<=1)); assert.ok(colors.some(ao=>ao<0.3)); assert.ok(colors.some(ao=>ao===1));
  const glass = materials.find(m=>Math.abs(m[4]-0.15)<1e-6);
  assert.deepEqual(glass.slice(0,3),MATERIALS.glass.color.map(Math.fround)); assert.equal(glass[5],0);
  const uploads=h.resources.filter(b=>b.usage===40);
  assert.deepEqual(Array.from(new Float32Array(uploads[7].data).subarray(24,27)),[1.5,1.08,0.45].map(Math.fround));
  assert.deepEqual(Array.from(new Float32Array(uploads[9].data).subarray(24,27)),[2,1.6,0.8].map(Math.fround));
  const fern = scatter.batches.findIndex(b=>b.name.includes('fern crowns'));
  const transformBuffer = h.resources.filter(b=>b.usage===40)[fern*2+1];
  assert.equal(new Float32Array(transformBuffer.data)[22],1,'Ribbon fronds are double sided');
  scatter.dispose(); assert.ok(h.resources.every(r=>r.destroyed));
});

test('ferns curve and taper, fieldstones deform, and vertex colors bake contact occlusion', () => {
  const fern = generateFernMesh(), rock = generateRockMesh(); check(fern); check(rock);
  assert.equal(fern.indices.length,7*5*6);
  const p = fern.positions;
  assert.ok(Math.hypot(p[0]-p[3],p[1]-p[4],p[2]-p[5])>10*Math.hypot(p[30]-p[33],p[31]-p[34],p[32]-p[35]),'Frond tapers towards tip');
  assert.ok(p[31]-p[25]<p[7]-p[1],'Parabolic sag reduces upward slope towards tip');
  assert.equal(contactAO(-1,0),0.2); assert.equal(contactAO(0,0),0.2); assert.equal(contactAO(0.6,0),1);
  const vertices = vertexStream(fern,(_x,y)=>contactAO(y,0));
  assert.equal(vertices[16],1); assert.equal(vertices[19],Math.fround(0.2));
  assert.ok(vertices.some((v,i)=>i%20===19&&v>0.8));
  assert.throws(()=>vertexStream(fern,()=>NaN),/occlusion/);
  const radii = [];
  for (let i = 0; i < rock.positions.length; i += 3) radii.push(Math.hypot(rock.positions[i]/1.15,rock.positions[i+1]/0.72,rock.positions[i+2]/0.82));
  assert.ok(Math.max(...radii)-Math.min(...radii)>0.15,'Boulders break the pristine sphere silhouette');
});

test('fixed placements stay inland, leave the porch access open and sink roots into the heightfield', () => {
  assert.equal(TREE_POSITIONS.length,10);
  for (const [x,z] of TREE_POSITIONS) {assert.ok(terrainHeight(x,z)>1.2); assert.ok(Math.abs(x+10)>3.5 || Math.abs(z-23)>5.5);}
  const points = TREE_POSITIONS.map(([x,z],i)=>[x,terrainHeight(x,z)-0.2,z,0.9+(i%3)*0.1,i*2.399963]);
  const matrices = instanceTransforms(points); assert.ok(matrices.every(Number.isFinite));
  for (let i = 0; i < points.length; i++) {assert.equal(matrices[i*16+15],1); assert.ok(Math.abs(matrices[i*16+13]-terrainHeight(points[i][0],points[i][2])+0.2)<1e-6);}
  assert.deepEqual(matrices,instanceTransforms(points));
});

test('shrubs keep visible gaps at their actual scaled footprint and stay clear of the cabin and porch', () => {
  const mesh = generateShrubMesh(); check(mesh); const radius = footprintRadius(mesh);
  const shrubs = new PlacementLayout(CABIN_EXCLUSIONS).place(SHRUB_CANDIDATES,radius);
  assert.deepEqual(shrubs,new PlacementLayout(CABIN_EXCLUSIONS).place(SHRUB_CANDIDATES,radius),'Placement is stable across device restoration');
  assert.ok(shrubs.length>=15 && shrubs.length<=45,'Scattered undergrowth, not a continuous hedge');
  assert.ok(radius<0.9,'Compact individual shrub footprint');
  for (let i = 0; i < shrubs.length; i++) {
    const [x,z,scale,yaw] = shrubs[i], r = radius*scale;
    assert.ok(scale>=0.55 && scale<=0.9 && Number.isFinite(yaw));
    assert.ok(!(Math.abs(x+10)<3.2+r+0.3 && Math.abs(z-23)<4.2+r+0.3),'Cabin clearance');
    assert.ok(!(x>-10.35-r-0.3 && x<-7.85+r+0.3 && z>27-r-0.3 && z<33+r+0.3),'Porch and approach clearance');
    for (let j = 0; j < i; j++) assert.ok(Math.hypot(x-shrubs[j][0],z-shrubs[j][1])>=r+radius*shrubs[j][2]+0.3,'Bush silhouettes cannot overlap');
  }
  assert.throws(()=>new PlacementLayout().place(SHRUB_CANDIDATES,NaN),/radius/);
});

test('fixed rocks clear the whole foundation and fern crowns clear rocks at their scaled mesh footprint', () => {
  const rock = generateRockMesh(), fern = generateFernMesh(), rr = footprintRadius(rock), fr = footprintRadius(fern);
  const layout = new PlacementLayout(CABIN_EXCLUSIONS), rocks = layout.place(ROCK_CANDIDATES,rr), ferns = layout.place(FERN_CANDIDATES,fr);
  assert.equal(rocks.length,2); assert.equal(ferns.length,8);
  const restored = new PlacementLayout(CABIN_EXCLUSIONS);
  assert.deepEqual(rocks,restored.place(ROCK_CANDIDATES,rr)); assert.deepEqual(ferns,restored.place(FERN_CANDIDATES,fr));
  const distance = ([x,z],[minX,minZ,maxX,maxZ]) => Math.hypot(Math.max(minX-x,0,x-maxX),Math.max(minZ-z,0,z-maxZ));
  for (const [x,z,scale] of rocks) for (const bounds of CABIN_EXCLUSIONS) assert.ok(distance([x,z],bounds)>rr*scale);
  for (const [x,z,scale] of ferns) {
    for (const bounds of CABIN_EXCLUSIONS) assert.ok(distance([x,z],bounds)>fr*scale);
    for (const [rx,rz,rs] of rocks) assert.ok(Math.hypot(x-rx,z-rz)>fr*scale+rr*rs,'Whole fern crowns stay beside the rock, not through it');
  }
  const sr = footprintRadius(generateShrubMesh()), bushes = layout.place(SHRUB_CANDIDATES,sr);
  const all = [...rocks.map(p=>[p,rr]),...ferns.map(p=>[p,fr]),...bushes.map(p=>[p,sr])];
  for (let i = 0; i < all.length; i++) for (let j = 0; j < i; j++) {
    const [a,ar] = all[i], [b,br] = all[j];
    assert.ok(Math.hypot(a[0]-b[0],a[1]-b[1])>=ar*a[2]+br*b[2]+0.3,'Asset families share occupied space');
  }
  const foundation = generateCabinMesh(terrainHeight,CABIN_POSITION).foundation.positions;
  for (let i = 0; i < foundation.length; i += 3) assert.ok(CABIN_EXCLUSIONS.some(bounds=>distance([foundation[i]-10,foundation[i+2]+23],bounds)===0),'Exclusions include the protruding stone supports and steps');
});
